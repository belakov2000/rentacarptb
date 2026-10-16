import { and, asc, desc, eq, gte, isNull, like, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookingEvents, bookings, carBlocks, cars } from "../db/schema.js";
import { addDays, BUFFER_MIN, endTimeOf, minutes, shiftLocal, startTimeOf } from "../db/slots.js";
import { sofiaLocal, sofiaToday } from "../db/hours.js";
import { activeBlocksIn, busySpan, confirmedIn, findConflict, lock, SPAN_COLS } from "./conflicts.js";

// Автопарк в админ панела: активност (status на автомобила) е отделно от заетостта по дати.
//  • Неактивен автомобил не приема нови заявки от сайта и чакащите заявки за него не могат да бъдат потвърдени;
//    съществуващите резервации остават непроменени. В публичната наличност е показан като зает.
//  • Блокиран период (сервиз, лична употреба, друга причина) заема автомобила със същия буфер като резервацията –
//    в публичната наличност, при нова заявка и при потвърждаване (server/conflicts.ts).
//  • Блокиране върху потвърдена резервация (с буфера) или върху друг активен блокиран период се отказва и
//    конфликтът се показва; резервацията не се отменя. Проверката е в транзакция със заключване на автомобила –
//    същото заключване като при потвърждаване и удължаване, затова едновременните действия се изпълняват едно след друго.
//  • Отмяната на блокиран период не го изтрива (cancelledAt, cancelledBy). Всички промени – в booking_events.
export const BLOCK_KINDS = ["service", "personal", "other"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CAR_RE = /^[a-z0-9-]{1,40}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const local = (now: Date) => sofiaLocal(now);

export async function listCars(now = new Date()) {
  const today = sofiaToday(now);
  const n = minutes(...local(now));
  const all = await db.select().from(cars).orderBy(asc(cars.sort), asc(cars.id));
  const rows = await db.select({ id: bookings.id, name: bookings.name, phone: bookings.phone, status: bookings.status, ...SPAN_COLS })
    .from(bookings).where(confirmedIn(addDays(today, -1), "9999-12-31"));
  const pend = await db.select({ id: bookings.id, carId: bookings.carId, startDate: bookings.startDate }).from(bookings)
    .where(and(eq(bookings.status, "pending"), gte(bookings.startDate, today)));
  const blocks = await db.select().from(carBlocks).where(and(isNull(carBlocks.cancelledAt), gte(carBlocks.endDate, addDays(today, -1)))).orderBy(asc(carBlocks.startDate));
  return all.map((c) => {
    const mine = rows.map((r) => ({ r, s: busySpan(r, now) })).filter((x) => x.r.carId === c.id && x.s);
    const cur = mine.find((x) => minutes(...x.s!.from) <= n && n < minutes(...x.s!.to));
    const next = mine.filter((x) => minutes(...x.s!.from) > n).sort((a, b) => minutes(...a.s!.from) - minutes(...b.s!.from))[0];
    const bl = blocks.filter((b) => b.carId === c.id && minutes(b.endDate, endTimeOf(b.endTime)) > n);
    const curBlock = bl.find((b) => minutes(b.startDate, startTimeOf(b.startTime)) <= n);
    const ref = (x: typeof cur) => x && { id: x.r.id, name: x.r.name, phone: x.r.phone, from: x.s!.from, to: x.s!.to, handedOver: !!x.r.handedOverAt, overdue: x.s!.overdue };
    return {
      ...c,
      occupancy: cur ? "booking" : curBlock ? "block" : "free",
      current: ref(cur) || null, currentBlock: curBlock || null, next: ref(next) || null,
      blocks: bl, pendingUpcoming: pend.filter((p) => p.carId === c.id).length,
    };
  });
}

export async function carHistory(carId: string) {
  return db.select().from(bookingEvents)
    .where(and(isNull(bookingEvents.bookingId), like(bookingEvents.action, "car.%"), sql`${bookingEvents.details}->>'carId' = ${carId}`))
    .orderBy(desc(bookingEvents.at)).limit(100);
}
export const carBlocksAll = (carId: string) => db.select().from(carBlocks).where(eq(carBlocks.carId, carId)).orderBy(asc(carBlocks.startDate));

export type BlockError = "not_found" | "invalid" | "kind" | "period" | "booking_conflict" | "block_overlap" | "key";
export async function createBlock(carId: string, body: any, actor: string) {
  if (!CAR_RE.test(carId)) return { ok: false as const, error: "not_found" as const };
  const startDate = str(body?.startDate, 10), endDate = str(body?.endDate, 10);
  const startTime = str(body?.startTime, 5) || "00:00", endTime = str(body?.endTime, 5) || "23:59";
  const kind = body?.kind, note = str(body?.note, 500), key = str(body?.idempotencyKey, 100);
  if (!/^[\w-]{8,100}$/.test(key)) return { ok: false as const, error: "key" as const };
  if (!(BLOCK_KINDS as readonly string[]).includes(kind)) return { ok: false as const, error: "kind" as const };
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || !TIME_RE.test(startTime) || !TIME_RE.test(endTime)) return { ok: false as const, error: "invalid" as const };
  if (minutes(endDate, endTime) <= minutes(startDate, startTime)) return { ok: false as const, error: "period" as const };
  return db.transaction(async (tx) => {
    const [same] = await tx.select().from(carBlocks).where(eq(carBlocks.idempotencyKey, key));
    if (same) return same.carId === carId ? { ok: true as const, duplicate: true, block: same } : { ok: false as const, error: "key" as const };
    await lock(tx, "car:" + carId);
    const [car] = await tx.select({ id: cars.id }).from(cars).where(eq(cars.id, carId));
    if (!car) return { ok: false as const, error: "not_found" as const };
    const c = await findConflict(carId, startDate, endDate, startTime, endTime, "", tx);
    if (c) return { ok: false as const, error: c.kind === "booking" ? ("booking_conflict" as const) : ("block_overlap" as const), conflict: c };
    const [block] = await tx.insert(carBlocks).values({ carId, startDate, startTime, endDate, endTime, kind, reason: note, createdBy: actor, idempotencyKey: key }).returning();
    await tx.insert(bookingEvents).values({ bookingId: null, actor, action: "car.block.create", details: { carId, block: block.id, kind, from: `${startDate} ${startTime}`, to: `${endDate} ${endTime}`, hasNote: !!note } });
    return { ok: true as const, duplicate: false, block };
  });
}

export async function cancelBlock(carId: string, blockId: number, actor: string) {
  return db.transaction(async (tx) => {
    await lock(tx, "car:" + carId);
    const [u] = await tx.update(carBlocks).set({ cancelledAt: new Date(), cancelledBy: actor })
      .where(and(eq(carBlocks.id, blockId), eq(carBlocks.carId, carId), isNull(carBlocks.cancelledAt))).returning();
    if (!u) return { ok: false as const, error: "state" as const };
    await tx.insert(bookingEvents).values({ bookingId: null, actor, action: "car.block.cancel", details: { carId, block: blockId, kind: u.kind, from: `${u.startDate} ${u.startTime}`, to: `${u.endDate} ${u.endTime}` } });
    return { ok: true as const, block: u };
  });
}

// Активност и срокове. Регистрационният номер, марката и цените не се променят оттук (те са и в договора и на сайта).
export async function updateCar(carId: string, body: any, actor: string) {
  const set: Record<string, unknown> = {};
  if (body?.status !== undefined) {
    if (body.status !== "active" && body.status !== "inactive") return { ok: false as const, error: "status" as const };
    set.status = body.status;
  }
  for (const [k, col] of [["inspectionDue", "inspectionDue"], ["insuranceDue", "insuranceDue"], ["serviceDue", "serviceDue"]] as const) {
    if (body?.[k] === undefined) continue;
    if (body[k] !== null && body[k] !== "" && !DATE_RE.test(String(body[k]))) return { ok: false as const, error: "date" as const };
    set[col] = body[k] || null;
  }
  if (body?.note !== undefined) set.note = str(body.note, 1000);
  if (!Object.keys(set).length) return { ok: false as const, error: "invalid" as const };
  return db.transaction(async (tx) => {
    await lock(tx, "car:" + carId);
    const [cur] = await tx.select().from(cars).where(eq(cars.id, carId)).for("update");
    if (!cur) return { ok: false as const, error: "not_found" as const };
    const changed = Object.fromEntries(Object.entries(set).filter(([k, v]) => (cur as any)[k] !== v).map(([k, v]) => [k, { from: k === "note" ? !!(cur as any)[k] : (cur as any)[k], to: k === "note" ? !!v : v }]));
    if (!Object.keys(changed).length) return { ok: true as const, car: cur };
    const [u] = await tx.update(cars).set({ ...set, updatedBy: actor, updatedAt: new Date() }).where(eq(cars.id, carId)).returning();
    await tx.insert(bookingEvents).values({ bookingId: null, actor, action: "car.update", details: { carId, changed } });
    return { ok: true as const, car: u };
  });
}

// ===== Календар: автомобили × дни =====
// Същите правила като сървърната проверка: потвърдените резервации заемат автомобила за busySpan (с реалното връщане /
// просрочен наем), блокираните периоди – за своя интервал; около двете има буфер BUFFER_MIN минути.
// Чакащите заявки се показват отделно като непотвърдени – не заемат автомобила. Отменени и отказани не се показват.
export async function calendar(from: string, days: number, now = new Date()) {
  const to = addDays(from, days - 1);
  const carRows = await db.select({ id: cars.id, brand: cars.brand, model: cars.model, reg: cars.reg, status: cars.status }).from(cars).orderBy(asc(cars.sort), asc(cars.id));
  const conf = await db.select({ id: bookings.id, name: bookings.name, ...SPAN_COLS }).from(bookings).where(confirmedIn(addDays(from, -1), addDays(to, 1)));
  const pend = await db.select({ id: bookings.id, name: bookings.name, ...SPAN_COLS }).from(bookings)
    .where(and(eq(bookings.status, "pending"), lte(bookings.startDate, to), gte(bookings.endDate, from)));
  const blocks = await db.select().from(carBlocks).where(activeBlocksIn(addDays(from, -1), addDays(to, 1)));
  const events: any[] = [];
  for (const r of conf) {
    const s = busySpan(r, now);
    if (!s) continue;
    events.push({
      type: "booking", id: r.id, carId: r.carId, name: r.name, from: s.from, to: s.to, bufferFrom: shiftLocal(s.from, -BUFFER_MIN), bufferUntil: shiftLocal(s.to, BUFFER_MIN),
      agreedEnd: [r.endDate, endTimeOf(r.endTime, r.dropoff)], handedOver: !!r.handedOverAt, returned: !!r.returnedAt, overdue: s.overdue,
    });
  }
  for (const r of pend)
    if (r.startDate && r.endDate)
      events.push({ type: "pending", id: r.id, carId: r.carId, name: r.name, from: [r.startDate, startTimeOf(r.startTime, r.pickup)], to: [r.endDate, endTimeOf(r.endTime, r.dropoff)] });
  for (const b of blocks) {
    const f: [string, string] = [b.startDate, startTimeOf(b.startTime)], t: [string, string] = [b.endDate, endTimeOf(b.endTime)];
    events.push({ type: "block", id: b.id, carId: b.carId, kind: b.kind, note: b.reason, createdBy: b.createdBy, from: f, to: t, bufferFrom: shiftLocal(f, -BUFFER_MIN), bufferUntil: shiftLocal(t, BUFFER_MIN) });
  }
  const end = (e: any) => e.bufferUntil || e.to, start = (e: any) => e.bufferFrom || e.from;
  return { from, to, days, today: sofiaToday(now), buffer: BUFFER_MIN, cars: carRows, events: events.filter((e) => start(e)[0] <= to && end(e)[0] >= from) };
}
