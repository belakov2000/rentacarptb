import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookingEvents, bookingExtensions, bookings, cars } from "../db/schema.js";
import { endTimeOf, minutes, startTimeOf } from "../db/slots.js";
import { withinHours } from "../db/hours.js";
import { euros } from "../db/money.js";
import type { ContractData } from "../contract/index.js";
import { findConflict, lock, type Conflict } from "./conflicts.js";
import { contractDataKey, contracts, saveContract } from "./contracts.js";
import { queueEmail } from "./email.js";
import { closedKey, decisionKey, extendedKey, sendClosed, sendDecision, sendExtended } from "./notify.js";

// Действия по вече потвърдена резервация – общи за страницата от имейла (/api/bookings/:id/manage) и за админ панела.
//   cancel   – предварителна отмяна; възможна веднага след потвърждаването, докато автомобилът не е предаден
//   no_show  – „Клиентът не се яви“; възможно чак след часа за получаване (Europe/Sofia), докато автомобилът не е предаден
//   handover – отбелязва действителното предаване; след него отмяна и неявяване не са възможни
// Изтичането на часа за получаване НЕ означава, че наемът е започнал – започнал е само при отбелязано предаване.
// Промяната е условна (status = confirmed и без предаване) – повторно или едновременно действие не променя статуса
// втори път и не праща второ писмо. Записът не се изтрива: остава с краен статус, причина, време и извършител,
// а в booking_events – история. Отменената резервация не блокира автомобила: наличността и проверката за застъпване
// броят само status = confirmed (заедно с буфера), затова периодът се освобождава веднага.
type Booking = typeof bookings.$inferSelect;
export type Action = "cancel" | "no_show" | "handover";
export const REASONS = ["customer", "owner", "other"] as const;
export const REASON_BG: Record<string, string> = { customer: "Клиентът се отказа", owner: "Отмяна от собственика", other: "Друга причина", no_show: "Клиентът не се яви" };
export const STATUS_LABEL: Record<string, string> = { pending: "Очаква потвърждение", confirmed: "Потвърдена", rejected: "Отказана", cancelled: "Отменена", no_show: "Неявяване" };

// Текущото местно време в Пловдив като „гггг-мм-дд чч:мм“ (лятното часово време се отчита от Intl)
export function sofiaNow(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
export const pickupAt = (b: Pick<Booking, "startDate" | "startTime" | "pickup">) => (b.startDate ? `${b.startDate} ${startTimeOf(b.startTime, b.pickup)}` : "");
export const pickupPassed = (b: Pick<Booking, "startDate" | "startTime" | "pickup">, now = new Date()) => !!b.startDate && pickupAt(b) <= sofiaNow(now);

export function allowed(b: Booking, now = new Date()) {
  const open = b.status === "confirmed" && !b.handedOverAt;
  const running = b.status === "confirmed" && !b.returnedAt;
  return {
    cancel: open, no_show: open && pickupPassed(b, now), handover: open,
    // Приключване – само при отбелязано реално предаване; удължаване – за потвърдена резервация с дати, докато не е приключена
    return: running && !!b.handedOverAt, extend: running && !!b.startDate && !!b.endDate,
  };
}

export type Result = { ok: true; booking: Booking; email: "sent" | "queued" | "none" } | { ok: false; error: "not_found" | "state" | "too_early" | "reason"; booking?: Booking };

export async function act(id: string, action: Action, o: { actor: string; reason?: string; note?: string; notify?: boolean; now?: Date }): Promise<Result> {
  const now = o.now || new Date();
  const reason = action === "no_show" ? "no_show" : action === "cancel" ? String(o.reason || "") : "";
  if (action === "cancel" && !(REASONS as readonly string[]).includes(reason)) return { ok: false, error: "reason" };
  const note = action === "handover" ? "" : String(o.note || "").trim().slice(0, 1000);
  const notify = action !== "handover" && !!o.notify;
  const out = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
    if (!b) return { ok: false as const, error: "not_found" as const };
    const can = allowed(b, now);
    if (!can[action]) return { ok: false as const, error: action === "no_show" && can.cancel ? ("too_early" as const) : ("state" as const), booking: b };
    const set =
      action === "handover"
        ? { handedOverAt: now, handedOverBy: o.actor, updatedAt: now }
        : { status: action === "cancel" ? "cancelled" : "no_show", closedAt: now, closedBy: o.actor, closeReason: reason, closeNote: note, updatedAt: now };
    const [u] = await tx
      .update(bookings)
      .set(set)
      .where(and(eq(bookings.id, id), eq(bookings.status, "confirmed"), isNull(bookings.handedOverAt)))
      .returning();
    if (!u) return { ok: false as const, error: "state" as const, booking: b };
    // Без лични данни и без бележката в историята – бележката е в close_note
    await tx.insert(bookingEvents).values({
      bookingId: id, actor: o.actor, action: `booking.${action}`,
      details: action === "handover" ? {} : { reason, notify, from: "confirmed", to: u.status, hasNote: !!note },
    });
    if (notify) await queueEmail(tx, "customer-closed", closedKey(id), id, u.email);
    return { ok: true as const, booking: u };
  });
  if (!out.ok) return out;
  // Писмото до клиента – веднъж, след успешната промяна (dedupe по резервация); при грешка се опитва отново от email-retry
  let email: "sent" | "queued" | "none" = "none";
  if (notify) {
    const r = await sendClosed(out.booking).catch(() => ({ result: "failed" as const }));
    email = r.result === "sent" || r.result === "duplicate" ? "sent" : "queued";
  }
  return { ok: true, booking: out.booking, email };
}

// ===== Решение по чакаща заявка (pending → confirmed / rejected) =====
// Общо за страницата от имейла до фирмата и за админ панела („Резервации → Чакащи → Управление“).
//   confirm – само ако заявката има дати, часът за получаване още не е минал (Europe/Sofia), автомобилът е активен и няма
//             потвърдена резервация или активен блокиран период, които се застъпват (с буфера BUFFER_MIN).
//             Проверката е в транзакция със заключване на автомобила – две конфликтни заявки не могат да бъдат потвърдени едновременно.
//   reject  – винаги възможен, докато заявката е pending (и за стари заявки без дати или с минали дати).
// Промяната е условна (status = pending): повторно или едновременно действие (от админа и от имейла) не презаписва вече взето
// решение и не праща второ писмо. message – съобщение до клиента (само от страницата в имейла, влиза в писмото);
// internalNote – вътрешна бележка, НЕ се изпраща на клиента. Не се създават плащания, възстановявания или събития към Meta.
export type Decision = "confirm" | "reject";
export type DecideError = "not_found" | "state" | "no_dates" | "expired" | "car_inactive" | "busy";
export type DecideResult =
  | { ok: true; booking: Booking; email: "sent" | "queued" | "uncertain" | "none" }
  | { ok: false; error: DecideError; booking?: Booking; conflict?: Conflict };

// Може ли чакащата заявка да бъде потвърдена по дати (без проверка за заетост) – за бутона и за съобщението в панела
export function confirmBlock(b: Pick<Booking, "status" | "startDate" | "endDate" | "startTime" | "pickup">, now = new Date()): DecideError | "" {
  if (b.status !== "pending") return "state";
  if (!b.startDate || !b.endDate) return "no_dates";
  if (pickupPassed(b, now)) return "expired";
  return "";
}

export async function decide(
  id: string,
  decision: Decision,
  o: { actor: string; internalNote?: string; message?: string; notify?: boolean; now?: Date },
): Promise<DecideResult> {
  const now = o.now || new Date();
  const internalNote = String(o.internalNote || "").trim().slice(0, 1000);
  const message = String(o.message || "").trim().slice(0, 1000);
  const notify = !!o.notify;
  const out = await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(bookings).where(eq(bookings.id, id));
    if (!cur) return { ok: false as const, error: "not_found" as const };
    // Заключване на автомобила преди заключването на реда – същият ред като при всяко потвърждаване, без взаимно блокиране
    if (decision === "confirm" && cur.carId) await lock(tx, "car:" + cur.carId);
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
    if (b.status !== "pending") return { ok: false as const, error: "state" as const, booking: b };
    if (decision === "confirm") {
      const blocked = confirmBlock(b, now);
      if (blocked) return { ok: false as const, error: blocked, booking: b };
      if (b.carId) {
        const [car] = await tx.select({ status: cars.status }).from(cars).where(eq(cars.id, b.carId));
        if (car && car.status !== "active") return { ok: false as const, error: "car_inactive" as const, booking: b };
      }
      const c = await findConflict(b.carId, b.startDate!, b.endDate!, b.startTime, b.endTime, b.id, tx);
      if (c) return { ok: false as const, error: "busy" as const, booking: b, conflict: c };
    }
    const [u] = await tx
      .update(bookings)
      .set({ status: decision === "confirm" ? "confirmed" : "rejected", note: message, decidedAt: now, decidedBy: o.actor, decisionNote: internalNote, updatedAt: now })
      .where(and(eq(bookings.id, id), eq(bookings.status, "pending")))
      .returning();
    if (!u) return { ok: false as const, error: "state" as const, booking: b };
    // Без лични данни и без текста на бележката в историята – бележката е в decision_note
    await tx.insert(bookingEvents).values({
      bookingId: id, actor: o.actor, action: `booking.${decision}`,
      details: { notify, from: "pending", to: u.status, hasNote: !!internalNote, hasMessage: !!message },
    });
    if (notify) await queueEmail(tx, "customer-decision", decisionKey(id), id, u.email);
    return { ok: true as const, booking: u };
  });
  if (!out.ok) return out;
  let email: "sent" | "queued" | "uncertain" | "none" = "none";
  if (notify) {
    const r = await sendDecision(out.booking).catch(() => ({ result: "failed" as const }));
    email = r.result === "sent" || r.result === "duplicate" ? "sent" : r.result === "uncertain" ? "uncertain" : "queued";
  }
  return { ok: true, booking: out.booking, email };
}

// Линкът от имейла до собственика важи до 30 дни след края на наема (без дати – 60 дни след заявката).
// След това управлението е само след вход в админ панела. Токенът не става безсрочен.
export function linkExpired(b: Pick<Booking, "endDate" | "createdAt">, now = new Date()) {
  const until = b.endDate ? Date.parse(`${b.endDate}T23:59:59Z`) + 30 * 864e5 : new Date(b.createdAt).getTime() + 60 * 864e5;
  return now.getTime() > until;
}

// ===== Приключване на наема (реално връщане) =====
// Само за потвърдена резервация с отбелязано предаване и без отбелязано връщане. Записва се реалният момент на връщане
// (въведен от администратора, не по-рано от предаването и не в бъдещето), администраторът и вътрешна бележка.
// Договорените дати не се променят. Заетостта на автомобила свършва при реалното връщане + буфера (server/conflicts.ts busySpan):
// по-ранно връщане освобождава автомобила по-рано, а по-късно (просрочено) го държи зает до отбелязването.
// Не се създават плащания или възстановявания – гаранционният депозит и остатъкът остават видими, докато не бъдат въведени.
// Старите резервации НЕ се приключват автоматично – само с това действие.
export async function returnRental(id: string, o: { actor: string; at?: Date | null; note?: string; now?: Date }) {
  const now = o.now || new Date();
  const at = o.at || now;
  const note = String(o.note || "").trim().slice(0, 1000);
  if (at.getTime() > now.getTime() + 5 * 60_000) return { ok: false as const, error: "returned_at" as const };
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
    if (!b) return { ok: false as const, error: "not_found" as const };
    if (!allowed(b, now).return) return { ok: false as const, error: "state" as const, booking: b };
    // Полето в панела е с точност до минута: връщане в същата минута като предаването се записва като момента на предаването
    let returnedAt = at;
    if (at.getTime() < b.handedOverAt!.getTime()) {
      if (b.handedOverAt!.getTime() - at.getTime() >= 60_000) return { ok: false as const, error: "returned_at" as const, booking: b };
      returnedAt = b.handedOverAt!;
    }
    const [u] = await tx
      .update(bookings)
      .set({ returnedAt, returnedBy: o.actor, returnNote: note, updatedAt: now })
      .where(and(eq(bookings.id, id), eq(bookings.status, "confirmed"), isNotNull(bookings.handedOverAt), isNull(bookings.returnedAt)))
      .returning();
    if (!u) return { ok: false as const, error: "state" as const, booking: b };
    await tx.insert(bookingEvents).values({
      bookingId: id, actor: o.actor, action: "booking.return",
      details: { returnedAt: returnedAt.toISOString(), agreedEnd: `${b.endDate} ${endTimeOf(b.endTime, b.dropoff)}`, hasNote: !!note },
    });
    return { ok: true as const, booking: u };
  });
}

// ===== Удължаване на наема =====
// Нов край на наема след повторна проверка на заетостта (резервации, блокирани периоди и буфер) в транзакция със заключване
// на автомобила – същото заключване като при потвърждаване и при блокиране.
// Сума: договорената крайна дневна цена (наемът от договора / броя дни – след вече приложената отстъпка) × добавени цели дни.
// Миналата част не се преизчислява и ценовият клас не се сменя. Автоматично изчисление само ако данните са пълни и съвпадат
// (договор с текущите дати, цяла дневна цена в центове, без детско столче, определена обща сума, нов край в същия час);
// иначе администраторът въвежда сумата изрично. И в двата случая сумата се потвърждава от администратора
// (confirmCents трябва да съвпада с показаната). Удължаването не е плащане – не се създават плащания.
// История: booking_extensions (стари и нови дати и суми) и booking_events. Договорът получава нова версия (старите остават).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Брой дни като на сайта: всеки започнат период от 24 часа е ден
export const rentalDays = (d1: string, t1: string, d2: string, t2: string) => {
  const ms = Date.parse(`${d2}T${t2}:00Z`) - Date.parse(`${d1}T${t1}:00Z`);
  return ms < 0 ? -1 : Math.max(1, Math.ceil(ms / 864e5 - 1e-9));
};
export type ManualReason = "no_contract" | "contract_mismatch" | "child_seat" | "rate" | "partial_day" | "no_total";
export type ExtQuote = {
  auto: boolean; reason?: ManualReason; oldDays: number; newDays: number; addedDays: number; dailyCents: number | null;
  addedCents: number | null; oldTotalCents: number | null; newTotalCents: number | null;
};
export function quoteExtension(b: Booking, cd: ContractData | null, newEndDate: string, newEndTime: string): ExtQuote {
  const st = startTimeOf(b.startTime, b.pickup), et = endTimeOf(b.endTime, b.dropoff);
  const oldDays = rentalDays(b.startDate!, st, b.endDate!, et), newDays = rentalDays(b.startDate!, st, newEndDate, newEndTime);
  const oldTotalCents = b.totalCents != null && !b.totalReview ? b.totalCents : null;
  const base = { oldDays, newDays, addedDays: newDays - oldDays, oldTotalCents };
  const manual = (reason: ManualReason): ExtQuote => ({ ...base, auto: false, reason, dailyCents: null, addedCents: null, newTotalCents: null });
  if (!cd || cd.rent == null || !cd.days) return manual("no_contract");
  if (cd.d1 !== b.startDate || cd.d2 !== b.endDate || cd.t1 !== st || cd.t2 !== et || cd.days !== oldDays) return manual("contract_mismatch");
  if (cd.seat || cd.seatDay) return manual("child_seat");
  const rentCents = Math.round(cd.rent * 100);
  if (rentCents % cd.days) return manual("rate");
  if (newEndTime !== et) return manual("partial_day");
  if (oldTotalCents == null) return manual("no_total");
  const dailyCents = rentCents / cd.days;
  const addedCents = dailyCents * base.addedDays;
  return { ...base, auto: true, dailyCents, addedCents, newTotalCents: oldTotalCents + addedCents };
}
export const readContractData = async (id: string) => ((await contracts().get(contractDataKey(id), { type: "json" }).catch(() => null)) as ContractData | null) || null;

export type ExtendError = "not_found" | "state" | "end" | "hours" | "busy" | "amount" | "changed" | "key" | "car_inactive";
export async function extendRental(
  id: string,
  o: { actor: string; newEndDate: string; newEndTime: string; manualAmountCents?: number | null; confirmCents: number | null; notify?: boolean; note?: string; idempotencyKey: string; now?: Date },
) {
  const now = o.now || new Date();
  if (!DATE_RE.test(o.newEndDate) || !TIME_RE.test(o.newEndTime)) return { ok: false as const, error: "end" as const };
  if (!withinHours(o.newEndDate, o.newEndTime)) return { ok: false as const, error: "hours" as const };
  const note = String(o.note || "").trim().slice(0, 1000);
  const notify = !!o.notify;
  const cd = await readContractData(id);
  const out = await db.transaction(async (tx) => {
    const [same] = await tx.select().from(bookingExtensions).where(eq(bookingExtensions.idempotencyKey, o.idempotencyKey));
    if (same) return same.bookingId === id ? { ok: true as const, duplicate: true, ext: same, booking: null as Booking | null } : { ok: false as const, error: "key" as const };
    const [cur] = await tx.select().from(bookings).where(eq(bookings.id, id));
    if (!cur) return { ok: false as const, error: "not_found" as const };
    if (cur.carId) await lock(tx, "car:" + cur.carId);
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
    if (!allowed(b, now).extend) return { ok: false as const, error: "state" as const, booking: b };
    const oldEndTime = endTimeOf(b.endTime, b.dropoff);
    if (minutes(o.newEndDate, o.newEndTime) <= minutes(b.endDate!, oldEndTime)) return { ok: false as const, error: "end" as const, booking: b };
    const c = await findConflict(b.carId, b.startDate!, o.newEndDate, b.startTime || startTimeOf("", b.pickup), o.newEndTime, b.id, tx);
    if (c) return { ok: false as const, error: "busy" as const, booking: b, conflict: c };
    const q = quoteExtension(b, cd, o.newEndDate, o.newEndTime);
    const addedCents = q.auto ? q.addedCents! : o.manualAmountCents ?? null;
    if (addedCents == null || addedCents < 0) return { ok: false as const, error: "amount" as const, booking: b, quote: q };
    // Администраторът потвърждава точно показаната сума – ако междувременно е променена, нищо не се записва
    if (o.confirmCents !== addedCents) return { ok: false as const, error: "changed" as const, booking: b, quote: q };
    const newTotalCents = q.oldTotalCents != null ? q.oldTotalCents + addedCents : null;
    const dropoff = b.dropoff.replace(/^\d{2}\.\d{2}\.\d{4}(\s+\d{2}:\d{2})?/, `${o.newEndDate.split("-").reverse().join(".")} ${o.newEndTime}`);
    const [u] = await tx
      .update(bookings)
      .set({
        endDate: o.newEndDate, endTime: o.newEndTime, dropoff, updatedAt: now,
        ...(newTotalCents != null ? { totalCents: newTotalCents, total: euros(newTotalCents) } : {}),
        // Напомнянията за връщане и молбата за отзив се отнасят до новия край
        returnReminderAt: null, returnSoonAt: null, reviewRequestAt: null,
      })
      .where(and(eq(bookings.id, id), eq(bookings.status, "confirmed"), isNull(bookings.returnedAt), eq(bookings.endDate, b.endDate!)))
      .returning();
    if (!u) return { ok: false as const, error: "state" as const, booking: b };
    const [ext] = await tx
      .insert(bookingExtensions)
      .values({
        bookingId: id, oldEndDate: b.endDate!, oldEndTime, newEndDate: o.newEndDate, newEndTime: o.newEndTime,
        oldTotalCents: q.oldTotalCents, newTotalCents, addedCents, dailyCents: q.dailyCents, addedDays: q.addedDays,
        calc: q.auto ? "auto" : "manual", notify, note, idempotencyKey: o.idempotencyKey, createdBy: o.actor,
      })
      .returning();
    await tx.insert(bookingEvents).values({
      bookingId: id, actor: o.actor, action: "booking.extend",
      details: {
        extension: ext.id, from: { endDate: b.endDate, endTime: oldEndTime, totalCents: q.oldTotalCents, total: b.total },
        to: { endDate: o.newEndDate, endTime: o.newEndTime, totalCents: newTotalCents }, addedCents, calc: ext.calc, notify, hasNote: !!note,
      },
    });
    if (notify) await queueEmail(tx, "customer-extended", extendedKey(id, ext.id), id, u.email);
    return { ok: true as const, duplicate: false, ext, booking: u };
  });
  if (!out.ok || out.duplicate) return out;
  // Нова версия на договора с новия край и новата сума за наема (предишните версии остават непроменени)
  let contractVersion: number | null = null;
  if (cd) {
    try {
      const next: ContractData = { ...cd, d2: o.newEndDate, t2: o.newEndTime, days: rentalDays(cd.d1, cd.t1, o.newEndDate, o.newEndTime), rent: cd.rent != null ? (Math.round(cd.rent * 100) + out.ext.addedCents) / 100 : cd.rent };
      contractVersion = (await saveContract(id, next, o.actor, `Удължаване до ${o.newEndDate.split("-").reverse().join(".")} ${o.newEndTime}`)).version;
      await db.update(bookingExtensions).set({ contractVersion }).where(eq(bookingExtensions.id, out.ext.id));
    } catch (e) {
      console.error("Contract version for the extension failed", (e as Error)?.message);
    }
  }
  let email: "sent" | "queued" | "none" = "none";
  if (notify) {
    const r = await sendExtended(out.booking!, out.ext).catch(() => ({ result: "failed" as const }));
    email = r.result === "sent" || r.result === "duplicate" ? "sent" : "queued";
  }
  return { ...out, contractVersion, email, contract: !!cd };
}
