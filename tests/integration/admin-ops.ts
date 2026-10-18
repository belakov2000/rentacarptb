// Административни операции: createdAt / сортиране / странициране / Europe/Sofia, блокирани периоди и неактивни автомобили
// (публична наличност), приключване и удължаване на наем, едновременни конфликтни действия, напомняния, клиенти и права
// за договори и снимки. Само синтетични данни; имейлите и Netlify Identity се симулират (harness.ts).
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { bookingBody, check, contractData, cookieJar, fakeJwt, finish, freshDb, identity, mail, O, setContext, schema, withQuote } from "./harness.ts";
import { stores } from "./stubs/blobs.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import adminBookingsFn from "../../netlify/functions/admin-bookings.mts";
import fleetFn from "../../netlify/functions/admin-fleet.mts";
import customersFn from "../../netlify/functions/admin-customers.mts";
import contractsFn from "../../netlify/functions/admin-contracts.mts";
import settingsFn from "../../netlify/functions/admin-settings.mts";
import dashboardFn from "../../netlify/functions/admin-dashboard.mts";
import authFn from "../../netlify/functions/admin-auth.mts";
import availabilityFn from "../../netlify/functions/availability.mts";
import customerEmailsFn from "../../netlify/functions/customer-emails.mts";
import { findConflict } from "../../server/conflicts.ts";
import { extendRental, returnRental } from "../../server/booking-actions.ts";
import { sofiaLocal, sofiaToday, sofiaToUtc } from "../../db/hours.ts";
import { addDays } from "../../db/slots.ts";

setContext("deploy-preview");
const t = await freshDb("adminops");
t.use();
const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
const count = async (sql: string, p: unknown[] = []) => (await t.q(sql, p)).rows[0].n as number;
const avail = async (carId: string) => ((await (await availabilityFn()).json()).cars[carId] || []).map((p: string[]) => p.join(" "));
let k = 0;
const uniq = () => `k${Date.now().toString(36)}${++k}xx`;

// ===== Вход =====
identity.users.set("admin@example.com", { id: "1", email: "admin@example.com", password: "admin-pass-123", roles: ["admin"] });
identity.users.set("user@example.com", { id: "2", email: "user@example.com", password: "user-pass-123", roles: [] });
type Jar = ReturnType<typeof cookieJar>;
async function raw(path: string, opt: { method?: string; body?: unknown; origin?: string | null; jar?: Jar | null; fn?: any } = {}) {
  const jar = opt.jar === null ? cookieJar() : opt.jar || adm;
  setContext("deploy-preview", { cookies: jar, ip: "203.0.113.9" });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opt.origin !== null) headers.Origin = opt.origin ?? O;
  const id = path.split("?")[0].split("/")[4] || "";
  const r = await (opt.fn || adminBookingsFn)(new Request(O + path, { method: opt.method || "GET", headers, body: opt.body ? JSON.stringify(opt.body) : undefined }), { ip: "203.0.113.9", params: id ? { id } : {} } as any);
  setContext("deploy-preview");
  return r as Response;
}
async function req(path: string, opt: Parameters<typeof raw>[1] = {}) {
  const r = await raw(path, opt);
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
let adm: Jar = cookieJar();
await req("/api/admin/login", { fn: authFn, method: "POST", body: { email: "admin@example.com", password: "admin-pass-123" }, jar: adm });
const usr = cookieJar(); const utok = fakeJwt("user@example.com"); identity.tokens.set(utok, "user@example.com"); usr.set({ name: "nf_jwt", value: utok });
const post = (id: string, body: unknown) => req(`/api/admin/bookings/${id}`, { method: "POST", body });

async function request(s: string, carId: string, d1: string, t1: string, d2: string, t2: string, extra: Record<string, unknown> = {}) {
  const r = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await withQuote(bookingBody(s, d1, t1, d2, t2, { carId, car: carId, requestKey: `ops-${s}-${uniq()}`, ...extra }))) }), { params: {} } as any);
  const j = await r.json();
  return { status: r.status, id: j.id as string };
}
async function insert(extra: Partial<typeof schema.bookings.$inferInsert> & { carId: string }) {
  const id = crypto.randomUUID().replace(/-/g, "");
  await t.db.insert(schema.bookings).values({ id, viewToken: "1".repeat(64), adminToken: "2".repeat(64), name: "ТЕСТ " + id.slice(0, 4), email: `i-${id.slice(0, 6)}@example.com`, phone: "+359888000111", car: extra.carId, pickup: "п", dropoff: "в", status: "confirmed", ...extra });
  return id;
}

// ===== 1. createdAt, сортиране, странициране, Europe/Sofia =====
{
  const html = readFileSync("admin/index.html", "utf8");
  const src = /const fmtDT=d=>\{[\s\S]*?\};\n/.exec(html)![0];
  const fmtDT = new Function(src + "return fmtDT;")();
  check("1.1 формат по Europe/Sofia, лятно време (EEST, +3)", fmtDT("2026-10-16T14:29:00Z") === "16.10.2026, 17:29 ч.", fmtDT("2026-10-16T14:29:00Z"));
  check("1.2 зимно време (EET, +2)", fmtDT("2026-12-01T15:29:00Z") === "01.12.2026, 17:29 ч.", fmtDT("2026-12-01T15:29:00Z"));
  check("1.3 смяна на времето 25.10.2026: 00:30 UTC → 03:30, 01:30 UTC → 03:30", fmtDT("2026-10-25T00:30:00Z") === "25.10.2026, 03:30 ч." && fmtDT("2026-10-25T01:30:00Z") === "25.10.2026, 03:30 ч.", "");
  check("1.4 без дата → „Няма данни“ (без измислена стойност)", fmtDT(null) === "Няма данни" && fmtDT("") === "Няма данни" && fmtDT("невалидна") === "Няма данни", "");
  check("1.5 сървър: sofiaLocal / sofiaToUtc през DST", sofiaLocal("2026-03-29T01:30:00Z").join(" ") === "2026-03-29 04:30" && new Date(sofiaToUtc("2026-10-16", "17:29")).toISOString() === "2026-10-16T14:29:00.000Z" && new Date(sofiaToUtc("2026-12-01", "17:29")).toISOString() === "2026-12-01T15:29:00.000Z", "");
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 55; i++) await insert({ carId: "punto", status: "rejected", name: `СОРТ ${String(i).padStart(2, "0")}`, createdAt: new Date(base + i * 3600_000), startDate: addDays("2027-01-01", 55 - i), endDate: addDays("2027-01-02", 55 - i) });
  const p1 = await req("/api/admin/bookings?status=closed&q=СОРТ");
  const p2 = await req("/api/admin/bookings?status=closed&q=СОРТ&page=2");
  const asc = await req("/api/admin/bookings?status=closed&q=СОРТ&sort=created_asc");
  const pick = await req("/api/admin/bookings?status=closed&q=СОРТ&sort=pickup_asc");
  check("1.6 по подразбиране най-новите първо (createdAt), страница от 50", p1.json.sort === "created_desc" && p1.json.rows.length === 50 && p1.json.total === 55 && p1.json.rows[0].name === "СОРТ 54", `${p1.json.rows[0]?.name} ${p1.json.total}`);
  check("1.7 странициране: страница 2 – останалите 5, без повторения", p2.json.rows.length === 5 && p2.json.rows.at(-1).name === "СОРТ 00" && !p2.json.rows.some((r: any) => p1.json.rows.some((x: any) => x.id === r.id)), "");
  check("1.8 сортиране „най-старите първо“ и по получаване – отделно от създаването", asc.json.rows[0].name === "СОРТ 00" && pick.json.rows[0].name === "СОРТ 54", `${asc.json.rows[0]?.name} / ${pick.json.rows[0]?.name}`);
  const one = p1.json.rows[0];
  check("1.9 createdAt в списъка е оригиналният момент от сървъра", new Date(one.createdAt).toISOString() === new Date(base + 54 * 3600_000).toISOString(), one.createdAt);
  const d = await req(`/api/admin/bookings/${one.id}`);
  check("1.10 детайли: createdAt отделно от получаване/връщане и решение", new Date(d.json.booking.createdAt).getTime() === base + 54 * 3600_000 && d.json.booking.startDate !== null && d.json.booking.decidedAt === null, "");
  const s1 = await req("/api/admin/bookings?status=all&q=%2B359888000111");
  check("1.11 търсене по телефон", s1.json.total >= 55, String(s1.json.total));
}

// ===== 2. Блокирани периоди, буфер, неактивни автомобили, публична наличност =====
{
  const blk = (carId: string, b: Record<string, unknown>) => req(`/api/admin/cars/${carId}/blocks`, { fn: fleetFn, method: "POST", body: { kind: "service", idempotencyKey: uniq(), ...b } });
  const key = uniq();
  const b1 = await req("/api/admin/cars/ka/blocks", { fn: fleetFn, method: "POST", body: { startDate: "2028-05-10", startTime: "08:00", endDate: "2028-05-12", endTime: "12:00", kind: "service", note: "смяна на ремък", idempotencyKey: key } });
  const b1dup = await req("/api/admin/cars/ka/blocks", { fn: fleetFn, method: "POST", body: { startDate: "2028-05-10", startTime: "08:00", endDate: "2028-05-12", endTime: "12:00", kind: "service", idempotencyKey: key } });
  check("2.1 нов блокиран период; повторно изпращане със същия ключ не създава втори", b1.status === 201 && b1dup.status === 200 && b1dup.json.duplicate === true && (await count("select count(*)::int n from car_blocks where car_id='ka'")) === 1, `${b1.status}/${b1dup.status}`);
  check("2.2 публичната наличност показва блока (без причина)", (await avail("ka")).includes("2028-05-10 2028-05-12 08:00 12:00") && !JSON.stringify(await (await availabilityFn()).json()).includes("ремък"), "");
  const r1 = await request("B1", "ka", "2028-05-12", "12:30", "2028-05-13", "12:00");
  const r2 = await request("B2", "ka", "2028-05-12", "13:00", "2028-05-13", "12:00");
  check("2.3 нова заявка в буфера (12:30 след край 12:00) → 409; от 13:00 → приета", r1.status === 409 && r2.status === 201, `${r1.status}/${r2.status}`);
  // чакаща заявка, създадена преди блока, не може да бъде потвърдена
  const pend = await request("B3", "ka", "2028-05-20", "10:00", "2028-05-21", "10:00");
  const b2 = await blk("ka", { startDate: "2028-05-20", startTime: "00:00", endDate: "2028-05-20", endTime: "18:00", kind: "personal" });
  const c = await post(pend.id, { action: "confirm" });
  check("2.4 блок върху чакаща заявка е разрешен и я показва; потвърждаването ѝ → busy (блок)", b2.status === 201 && b2.json.pendingOverlap.some((p: any) => p.id === pend.id) && c.status === 409 && c.json.error === "busy" && c.json.can.conflict.kind === "block", `${c.status} ${c.json.error}`);
  const confirmed = await request("B4", "ka", "2028-06-01", "10:00", "2028-06-03", "10:00");
  await post(confirmed.id, { action: "confirm" });
  const over = await blk("ka", { startDate: "2028-06-03", startTime: "10:30", endDate: "2028-06-04", endTime: "10:00" });
  check("2.5 блок върху потвърден наем (в буфера) → 409 booking_conflict с резервацията; тя остава потвърдена", over.status === 409 && over.json.error === "booking_conflict" && over.json.conflict.id === confirmed.id && (await row(confirmed.id)).status === "confirmed", over.json.error);
  const bad = await blk("ka", { startDate: "2028-06-10", startTime: "10:00", endDate: "2028-06-10", endTime: "09:00" });
  const badKind = await blk("ka", { startDate: "2028-06-10", endDate: "2028-06-11", kind: "ремонт" });
  const ovl = await blk("ka", { startDate: "2028-05-11", endDate: "2028-05-11" });
  check("2.6 проверки на сървъра: край преди начало, непозната причина, застъпване с друг блок", bad.json.error === "period" && badKind.json.error === "kind" && ovl.json.error === "block_overlap", `${bad.json.error}/${badKind.json.error}/${ovl.json.error}`);
  const cancel = await req(`/api/admin/cars/ka/blocks/${b1.json.block.id}`, { fn: fleetFn, method: "POST", body: { action: "cancel" } });
  const cancel2 = await req(`/api/admin/cars/ka/blocks/${b1.json.block.id}`, { fn: fleetFn, method: "POST", body: { action: "cancel" } });
  const blRow = (await t.q("select cancelled_at, cancelled_by from car_blocks where id=$1", [b1.json.block.id])).rows[0];
  check("2.7 отмяна: остава в историята (cancelled_at/by), наличността се освобождава; повторна отмяна → 409", cancel.status === 200 && cancel2.status === 409 && !!blRow.cancelled_at && blRow.cancelled_by === "admin@example.com" && !(await avail("ka")).includes("2028-05-10 2028-05-12 08:00 12:00"), "");
  const det = await req("/api/admin/cars/ka", { fn: fleetFn });
  check("2.8 история на автомобила: кой и какво", det.json.history.some((e: any) => e.action === "car.block.create" && e.actor === "admin@example.com") && det.json.history.some((e: any) => e.action === "car.block.cancel"), "");
  // Неактивен автомобил
  const gConf = await request("G1", "golf", "2028-07-01", "10:00", "2028-07-02", "10:00");
  await post(gConf.id, { action: "confirm" });
  const gPend = await request("G2", "golf", "2028-07-10", "10:00", "2028-07-11", "10:00");
  const off = await req("/api/admin/cars/golf", { fn: fleetFn, method: "POST", body: { status: "inactive" } });
  const newReq = await request("G3", "golf", "2028-08-01", "10:00", "2028-08-02", "10:00");
  const confPend = await post(gPend.id, { action: "confirm" });
  const av = await avail("golf");
  check("2.9 деактивиране: нова заявка → 409, чакаща не се потвърждава (car_inactive), публично – зает", off.status === 200 && newReq.status === 409 && confPend.json.error === "car_inactive" && av.some((p: string) => p.startsWith(sofiaToday())), `${newReq.status} ${confPend.json.error}`);
  check("2.10 деактивирането не променя съществуващите резервации", (await row(gConf.id)).status === "confirmed" && (await row(gPend.id)).status === "pending" && off.json.upcoming.confirmed === 1 && off.json.upcoming.pending === 1, "");
  await req("/api/admin/cars/golf", { fn: fleetFn, method: "POST", body: { status: "active", inspectionDue: addDays(sofiaToday(), 5), insuranceDue: "" } });
  const list = await req("/api/admin/cars", { fn: fleetFn });
  const golf = list.json.cars.find((c: any) => c.id === "golf");
  const dash = await req("/api/admin/dashboard", { fn: dashboardFn });
  check("2.11 активиране и срок за преглед → предупреждение на таблото; активност ≠ заетост", golf.status === "active" && golf.occupancy === "free" && golf.next.id === gConf.id && dash.json.carDue.some((x: any) => x.carId === "golf" && x.kind === "inspection"), golf.occupancy);
  const badDate = await req("/api/admin/cars/golf", { fn: fleetFn, method: "POST", body: { serviceDue: "16.10.2026" } });
  check("2.12 невалидна дата за срок → 400", badDate.status === 400, String(badDate.status));
}

// ===== 3. Приключване на наема, реално връщане, просрочване, буфер =====
{
  const today = sofiaToday();
  const handed = new Date(Date.now() - 3 * 864e5);
  const late = await insert({ carId: "ibiza", startDate: addDays(today, -3), startTime: "10:00", endDate: addDays(today, -1), endTime: "10:00", handedOverAt: handed, handedOverBy: "admin@example.com", total: "50 €", totalCents: 5000, decidedAt: handed });
  await customerEmailsFn();
  const dash = await req("/api/admin/dashboard", { fn: dashboardFn });
  check("3.1 просрочен наем: в „просрочени“ и „текущи“; не се приключва автоматично", dash.json.counts.overdue >= 1 && dash.json.lists.overdue.some((r: any) => r.id === late) && dash.json.lists.active.some((r: any) => r.id === late) && (await row(late)).returnedAt === null, "");
  const nowL = sofiaLocal(new Date());
  const c1 = await findConflict("ibiza", nowL[0], nowL[0], nowL[1], nowL[1]);
  check("3.2 просрочен наем държи автомобила зает до момента (без отбелязано връщане)", c1?.kind === "booking" && (c1 as any).id === late, JSON.stringify(c1));
  const view = await req("/api/admin/bookings?view=overdue");
  check("3.3 филтър „просрочени“ отваря същите записи като таблото", view.json.total === dash.json.counts.overdue && view.json.rows.some((r: any) => r.id === late), `${view.json.total}/${dash.json.counts.overdue}`);
  const fut = await post(late, { action: "return", returnedAt: new Date(Date.now() + 3600_000).toISOString() });
  const early = await post(late, { action: "return", returnedAt: new Date(handed.getTime() - 60_000).toISOString() });
  check("3.4 връщане в бъдещето или преди предаването → 400", fut.status === 400 && early.status === 400, `${fut.status}/${early.status}`);
  const retAt = new Date(Date.now() - 30 * 60_000);
  const ret = await post(late, { action: "return", returnedAt: retAt.toISOString(), note: "драскотина на броня" });
  const again = await post(late, { action: "return" });
  const r = await row(late);
  check("3.5 „Приключи наема“: реален момент, администратор, бележка; договорените дати остават; повторно → 409", ret.status === 200 && again.status === 409 && r.returnedAt!.getTime() === retAt.getTime() && r.returnedBy === "admin@example.com" && r.returnNote === "драскотина на броня" && r.endDate === addDays(today, -1) && r.status === "confirmed", `${ret.status}/${again.status}`);
  const rl = sofiaLocal(retAt);
  const plus = (m: number) => sofiaLocal(new Date(retAt.getTime() + m * 60_000));
  const in30 = await findConflict("ibiza", plus(30)[0], plus(30)[0], plus(30)[1], plus(30)[1] < plus(30)[1] ? plus(30)[1] : plus(30)[1]);
  const in61 = await findConflict("ibiza", plus(61)[0], plus(61)[0], plus(61)[1], plus(61)[1]);
  check("3.6 автомобилът е свободен 60 мин. след реалното връщане (30 мин. – зает, 61 мин. – свободен)", in30?.kind === "booking" && in61 === null, `${rl.join(" ")} ${JSON.stringify(in30)} ${JSON.stringify(in61)}`);
  check("3.7 наличност: периодът свършва при реалното връщане", (await avail("ibiza")).includes(`${addDays(today, -3)} ${rl[0]} 10:00 ${rl[1]}`), (await avail("ibiza")).join("|"));
  const pays = await count("select count(*)::int n from payments where booking_id=$1", [late]);
  const ev = (await t.q("select action, details from booking_events where booking_id=$1 and action='booking.return'", [late])).rows;
  check("3.8 приключването не създава плащания; събитие с договорения край", pays === 0 && ev.length === 1 && ev[0].details.agreedEnd === `${addDays(today, -1)} 10:00` && !JSON.stringify(ev).includes("драскотина"), "");
  const noHand = await insert({ carId: "ibiza", startDate: addDays(today, 10), endDate: addDays(today, 12), startTime: "10:00", endTime: "10:00" });
  const nh = await post(noHand, { action: "return" });
  const same = await insert({ carId: "ibiza", startDate: addDays(today, 20), endDate: addDays(today, 21), startTime: "10:00", endTime: "10:00", handedOverAt: new Date(Date.now() - 5_000) });
  const minute = new Date(Math.floor((Date.now() - 5_000) / 60_000) * 60_000 - 1);
  const sm = await post(same, { action: "return", returnedAt: minute.toISOString() });
  check("3.9a връщане в същата минута като предаването (полето е до минута) → записва се моментът на предаването", sm.status === 200 && (await row(same)).returnedAt!.getTime() === (await row(same)).handedOverAt!.getTime(), String(sm.status));
  check("3.9 без отбелязано предаване не може да се приключи", nh.status === 409 && (await row(noHand)).returnedAt === null, String(nh.status));
  // Депозит и финанси след приключване
  await t.q("insert into payments (id, booking_id, amount_cents, method, kind, status, paid_at, idempotency_key, created_by) values ($1,$2,10000,'cash','security','received',now(),$3,'admin@example.com'),($4,$2,2000,'cash','deposit','received',now(),$5,'admin@example.com')", ["p".repeat(32), late, uniq(), "q".repeat(32), uniq()]);
  const d = await req(`/api/admin/bookings/${late}`);
  const dash2 = await req("/api/admin/dashboard", { fn: dashboardFn });
  check("3.10 финанси: договорена 50 €, получено 20 €, остатък 30 €, депозит 100 € държан", d.json.finance.agreedCents === 5000 && d.json.finance.rentalNet === 2000 && d.json.finance.balanceState === "due" && d.json.finance.balanceCents === 3000 && d.json.finance.securityHeld === 10000, JSON.stringify(d.json.finance));
  check("3.11 неприключен депозит остава задача на таблото", dash2.json.lists.deposit_open.some((x: any) => x.id === late), "");
  const canc = await insert({ carId: "punto", status: "cancelled", startDate: "2028-09-01", endDate: "2028-09-02", total: "80 €", totalCents: 8000 });
  const dc = await req(`/api/admin/bookings/${canc}`);
  check("3.12 отменена резервация: цената не се представя като дълг → „Изисква уточняване“", dc.json.finance.balanceState === "review" && dc.json.finance.balanceCents === null, dc.json.finance.balanceState);
}

// ===== 4. Удължаване =====
let EXT = "";
{
  mail.sent.length = 0;
  // Без доставка: сървърната сума е само наемът 2 × 25 € = 50 € (с доставката от contractData сървърът добавя 5 км × 1 €)
  const cd = { ...contractData("2028-10-02", "10:00", "2028-10-04", "10:00"), del: null };
  const r = await request("E1", "passat", "2028-10-02", "10:00", "2028-10-04", "10:00", { contract: cd, total: "50 €" });
  EXT = r.id;
  await post(EXT, { action: "confirm" });
  const v1 = (await t.q("select blob_key, sign_status from contract_versions where booking_id=$1 and version=1", [EXT])).rows[0];
  const v1bytes = stores.get("deploypreview-contracts")!.get(v1.blob_key)!.etag;
  const q = await post(EXT, { action: "extend_quote", newEndDate: "2028-10-06", newEndTime: "10:00" });
  check("4.1 изчисление: 25 €/ден × 2 дни = 50 €, нова обща сума 100 € (без повторна отстъпка)", q.json.quote.auto === true && q.json.quote.dailyCents === 2500 && q.json.quote.addedDays === 2 && q.json.quote.addedCents === 5000 && q.json.quote.newTotalCents === 10000 && q.json.conflict === null, JSON.stringify(q.json.quote));
  check("4.2 изчислението само показва – нищо не е променено", (await row(EXT)).endDate === "2028-10-04" && (await count("select count(*)::int n from booking_extensions")) === 0, "");
  const wrong = await post(EXT, { action: "extend", newEndDate: "2028-10-06", newEndTime: "10:00", confirmCents: 4000, idempotencyKey: uniq() });
  check("4.3 потвърдена сума различна от изчислената → 409 changed, без запис", wrong.status === 409 && wrong.json.error === "changed" && (await row(EXT)).endDate === "2028-10-04", wrong.json.error);
  const key = uniq();
  const e1 = await post(EXT, { action: "extend", newEndDate: "2028-10-06", newEndTime: "10:00", confirmCents: 5000, idempotencyKey: key });
  const e1dup = await post(EXT, { action: "extend", newEndDate: "2028-10-06", newEndTime: "10:00", confirmCents: 5000, idempotencyKey: key });
  const b = await row(EXT);
  check("4.4 удължаване: нов край, нова обща сума 100,00 €; повторно изпращане → без второ удължаване", e1.status === 200 && e1dup.json.duplicate === true && b.endDate === "2028-10-06" && b.totalCents === 10000 && b.total === "100,00 €" && (await count("select count(*)::int n from booking_extensions where booking_id=$1", [EXT])) === 1, `${e1.status} ${b.total}`);
  const ext = (await t.q("select *, old_end_date::text old_end_date, new_end_date::text new_end_date from booking_extensions where booking_id=$1", [EXT])).rows[0];
  check("4.5 история: стари и нови дати и суми, начин на изчисление", ext.old_end_date === "2028-10-04" && ext.new_end_date === "2028-10-06" && ext.old_total_cents === 5000 && ext.new_total_cents === 10000 && ext.added_cents === 5000 && ext.calc === "auto" && ext.created_by === "admin@example.com", "");
  const vers = (await t.q("select version, sign_status, blob_key from contract_versions where booking_id=$1 order by version", [EXT])).rows;
  check("4.6 нова версия на договора (v2, „очаква подписване“); v1 е непроменена", vers.length === 2 && vers[1].sign_status === "awaiting" && ext.contract_version === 2 && stores.get("deploypreview-contracts")!.get(v1.blob_key)!.etag === v1bytes && vers[0].blob_key === v1.blob_key, vers.map((v: any) => v.version + v.sign_status).join());
  check("4.7 без имейл до клиента, когато опцията не е избрана; плащане не е създадено", e1.json.email === "none" && !mail.sent.some((m) => /удължен/i.test(m.subject)) && (await count("select count(*)::int n from payments where booking_id=$1", [EXT])) === 0, "");
  const part = await post(EXT, { action: "extend_quote", newEndDate: "2028-10-06", newEndTime: "15:00" });
  const noAmt = await post(EXT, { action: "extend", newEndDate: "2028-10-06", newEndTime: "15:00", confirmCents: null, idempotencyKey: uniq() });
  check("4.8 непълен ден → ръчна сума; без въведена сума → отказ", part.json.quote.auto === false && part.json.quote.reason === "partial_day" && noAmt.status === 400 && noAmt.json.error === "amount", `${part.json.quote.reason} ${noAmt.json.error}`);
  const man = await post(EXT, { action: "extend", newEndDate: "2028-10-06", newEndTime: "15:00", amount: "12,50", confirmCents: 1250, notify: true, idempotencyKey: uniq() });
  const b2 = await row(EXT);
  check("4.9 ръчна сума с потвърждение и имейл: нова сума 112,50 €, точно едно писмо", man.status === 200 && b2.totalCents === 11250 && man.json.email === "sent" && mail.sent.filter((m) => /удължен/i.test(m.subject)).length === 1, `${man.status} ${b2.total}`);
  const other = await request("E2", "passat", "2028-10-07", "10:00", "2028-10-08", "10:00");
  await post(other.id, { action: "confirm" });
  const busy = await post(EXT, { action: "extend", newEndDate: "2028-10-07", newEndTime: "09:30", amount: "10", confirmCents: 1000, idempotencyKey: uniq() });
  const busyQ = await post(EXT, { action: "extend_quote", newEndDate: "2028-10-07", newEndTime: "09:30" });
  check("4.10 удължаване в буфера преди друга потвърдена резервация → 409 busy, без промяна", busy.status === 409 && busy.json.error === "busy" && busy.json.conflict.id === other.id && busyQ.json.conflict?.id === other.id && (await row(EXT)).endTime === "15:00", busy.json.error);
  const back = await post(EXT, { action: "extend", newEndDate: "2028-10-05", newEndTime: "10:00", amount: "0", confirmCents: 0, idempotencyKey: uniq() });
  const hours = await post(EXT, { action: "extend", newEndDate: "2028-10-06", newEndTime: "22:00", amount: "1", confirmCents: 100, idempotencyKey: uniq() });
  check("4.11 нов край преди сегашния или извън работното време → 400", back.json.error === "end" && hours.json.error === "hours", `${back.json.error}/${hours.json.error}`);
  const ev = (await t.q("select details from booking_events where booking_id=$1 and action='booking.extend' order by id", [EXT])).rows;
  check("4.12 събития: стар и нов край и сума при всяко удължаване", ev.length === 2 && ev[0].details.from.endDate === "2028-10-04" && ev[1].details.to.endTime === "15:00" && ev[1].details.calc === "manual", "");
  const cancelled = await insert({ carId: "punto", status: "cancelled", startDate: "2028-11-01", endDate: "2028-11-02", startTime: "10:00", endTime: "10:00" });
  const ec = await post(cancelled, { action: "extend_quote", newEndDate: "2028-11-03", newEndTime: "10:00" });
  check("4.13 отменена резервация не може да се удължи", ec.status === 409, String(ec.status));
}

// ===== 5. Едновременни конфликтни действия =====
{
  const [a, b] = [await request("C1", "punto", "2029-01-10", "10:00", "2029-01-12", "10:00"), await request("C2", "punto", "2029-01-11", "10:00", "2029-01-13", "10:00")];
  const rs = await Promise.all([post(a.id, { action: "confirm" }), post(b.id, { action: "confirm" })]);
  check("5.1 две застъпващи се заявки потвърдени едновременно → точно една", rs.filter((r) => r.status === 200).length === 1 && (await count("select count(*)::int n from bookings where id in ($1,$2) and status='confirmed'", [a.id, b.id])) === 1, rs.map((r) => r.status).join());
  const c = await request("C3", "punto", "2029-02-10", "10:00", "2029-02-12", "10:00");
  const [cr, br] = await Promise.all([post(c.id, { action: "confirm" }), req("/api/admin/cars/punto/blocks", { fn: fleetFn, method: "POST", body: { startDate: "2029-02-11", endDate: "2029-02-11", kind: "service", idempotencyKey: uniq() } })]);
  const okC = cr.status === 200, okB = br.status === 201;
  check("5.2 потвърждаване и блокиране едновременно → само едното успява", okC !== okB, `${cr.status}/${br.status}`);
  const bb = await Promise.all([1, 2].map(() => req("/api/admin/cars/punto/blocks", { fn: fleetFn, method: "POST", body: { startDate: "2029-03-01", endDate: "2029-03-02", kind: "other", idempotencyKey: uniq() } })));
  check("5.3 два застъпващи се блока едновременно → точно един", bb.filter((r) => r.status === 201).length === 1, bb.map((r) => r.status).join());
  const x = await request("C4", "punto", "2029-04-01", "10:00", "2029-04-03", "10:00");
  await post(x.id, { action: "confirm" });
  const y = await request("C5", "punto", "2029-04-04", "10:00", "2029-04-05", "10:00");
  const [er, yr] = await Promise.all([
    post(x.id, { action: "extend", newEndDate: "2029-04-04", newEndTime: "12:00", amount: "10", confirmCents: 1000, idempotencyKey: uniq() }),
    post(y.id, { action: "confirm" }),
  ]);
  check("5.4 удължаване и потвърждаване на заявка в новия период едновременно → само едното", (er.status === 200) !== (yr.status === 200), `${er.status}/${yr.status}`);
  const z = await request("C6", "punto", "2029-05-01", "10:00", "2029-05-03", "10:00");
  await post(z.id, { action: "confirm" });
  const ks = await Promise.all([uniq(), uniq()].map((key) => post(z.id, { action: "extend", newEndDate: "2029-05-04", newEndTime: "10:00", amount: "5", confirmCents: 500, idempotencyKey: key })));
  check("5.5 две удължавания едновременно (различни ключове) → едно, второто 409", ks.filter((r) => r.status === 200).length === 1 && (await count("select count(*)::int n from booking_extensions where booking_id=$1", [z.id])) === 1, ks.map((r) => r.status).join());
  const today = sofiaToday();
  const h = await insert({ carId: "ka", startDate: addDays(today, -2), endDate: today, startTime: "09:00", endTime: "19:00", handedOverAt: new Date(Date.now() - 864e5) });
  const rr = await Promise.all([post(h, { action: "return" }), post(h, { action: "return" }), returnRental(h, { actor: "other@example.com" })]);
  const okCount = rr.filter((r: any) => r.status === 200 || r.ok === true).length;
  check("5.6 три едновременни приключвания → точно едно, едно събитие", okCount === 1 && (await count("select count(*)::int n from booking_events where booking_id=$1 and action='booking.return'", [h])) === 1, String(okCount));
  const keyS = uniq();
  const same = await Promise.all([1, 2].map(() => extendRental(z.id, { actor: "admin@example.com", newEndDate: "2029-05-05", newEndTime: "10:00", manualAmountCents: 500, confirmCents: 500, idempotencyKey: keyS })));
  check("5.7 едно и също удължаване, изпратено два пъти едновременно → едно удължаване", (await count("select count(*)::int n from booking_extensions where idempotency_key=$1", [keyS])) === 1 && same.some((r: any) => r.ok), "");
}

// ===== 6. Напомняния =====
{
  const sent = (id: string, kind: string) => mail.sent.filter((m) => m.to === `r-${id}@example.com` && m.subject.includes(kind));
  const tomorrow = addDays(sofiaToday(), 1), after = addDays(sofiaToday(), 2);
  const setR = (o: Record<string, { enabled: boolean; hours: number }>) => req("/api/admin/settings", { fn: settingsFn, method: "POST", body: { reminders: { pickup24: { enabled: true, hours: 24 }, handover: { enabled: true, hours: 3 }, return24: { enabled: true, hours: 24 }, returnSoon: { enabled: true, hours: 3 }, ...o } } });
  const g = await req("/api/admin/settings", { fn: settingsFn });
  check("6.1 по подразбиране: сегашните напомняния включени, 24 ч. и 3 ч.; часова зона и буфер", g.json.reminders.value.pickup24.enabled && g.json.reminders.value.pickup24.hours === 24 && g.json.reminders.value.returnSoon.hours === 3 && g.json.timezone === "Europe/Sofia" && g.json.bufferMinutes === 60 && !JSON.stringify(g.json).includes("test-only-not-a-real-key"), "");
  const bad = await setR({ pickup24: { enabled: true, hours: 500 } });
  const order = await setR({ return24: { enabled: true, hours: 12 }, returnSoon: { enabled: true, hours: 12 } });
  check("6.2 невалидни часове / ред → 400, нищо не е записано", bad.status === 400 && order.status === 400 && (await count("select count(*)::int n from settings where key='reminders'")) === 0, `${bad.status}/${order.status}`);
  const mk = async (s: Partial<typeof schema.bookings.$inferInsert>) => {
    const id = await insert({ carId: "passat", startDate: tomorrow, startTime: "12:00", endDate: after, endTime: "12:00", decidedAt: new Date(Date.now() - 10 * 864e5), ...s });
    await t.q("update bookings set email=$2 where id=$1", [id, `r-${id}@example.com`]);
    return id;
  };
  // Изключено напомняне: не се изпраща и не се отбелязва; при включване в срок – изпраща се веднъж
  await setR({ pickup24: { enabled: false, hours: 72 } });
  const a = await mk({});
  await customerEmailsFn();
  check("6.3 изключено напомняне преди получаване → не се изпраща", sent(a, "получ").length === 0 && sent(a, "Утре").length === 0 && (await row(a)).pickupReminderAt === null, "");
  const saved = await setR({ pickup24: { enabled: true, hours: 72 } });
  await customerEmailsFn();
  await customerEmailsFn();
  check("6.4 включено (72 ч.) → изпратено точно веднъж при две изпълнения; настройката се ползва от сървъра", saved.status === 200 && mail.sent.filter((m) => m.to === `r-${a}@example.com`).length === 1 && !!(await row(a)).pickupReminderAt, String(mail.sent.filter((m) => m.to === `r-${a}@example.com`).length));
  const logged = await count("select count(*)::int n from email_log where booking_id=$1 and kind='pickup24'", [a]);
  check("6.5 запис в историята на писмата (email_log)", logged === 1, String(logged));
  await setR({ pickup24: { enabled: true, hours: 12 } });
  const b = await mk({ startDate: addDays(sofiaToday(), 3), endDate: addDays(sofiaToday(), 4) });
  await customerEmailsFn();
  check("6.6 смяна на часовете (12 ч.) → напомнянето не е изпратено предварително", mail.sent.filter((m) => m.to === `r-${b}@example.com`).length === 0, "");
  const c = await mk({ status: "cancelled" });
  const rj = await mk({ status: "rejected" });
  await setR({ pickup24: { enabled: true, hours: 72 }, return24: { enabled: true, hours: 72 } });
  await customerEmailsFn();
  check("6.7 отменена и отказана резервация → без напомняния", mail.sent.filter((m) => m.to === `r-${c}@example.com` || m.to === `r-${rj}@example.com`).length === 0, "");
  // Удължаване: старото напомняне за връщане не се изпраща отново, а новото е с отделен ключ за новия край
  const e = await mk({ carId: "rem-only", startDate: addDays(sofiaToday(), -5), startTime: "08:00", endDate: tomorrow, endTime: "12:00", handedOverAt: new Date() });
  await customerEmailsFn();
  const first = mail.sent.filter((m) => m.to === `r-${e}@example.com` && /връщане|наем/i.test(m.subject)).length;
  const x = await extendRental(e, { actor: "admin@example.com", newEndDate: after, newEndTime: "12:00", manualAmountCents: 0, confirmCents: 0, idempotencyKey: uniq() });
  check("6.8 удължаването изчиства напомнянията за връщане", (x as any).ok && (await row(e)).returnReminderAt === null, "");
  await customerEmailsFn();
  await customerEmailsFn();
  const keys = (await t.q("select dedupe_key from email_log where booking_id=$1 and kind='return24' order by id", [e])).rows.map((r: any) => r.dedupe_key);
  check("6.9 след удължаване: едно напомняне за новия край (нов ключ), старото не е повторено", first === 1 && keys.length === 2 && keys[1].endsWith(`${after}T12:00`) && keys[0] === `return24:${e}`, `first=${first} ` + keys.join(" | "));
  const before = mail.sent.length;
  await returnRental(e, { actor: "admin@example.com" });
  await t.q("update bookings set return_soon_at=null where id=$1", [e]);
  await setR({ returnSoon: { enabled: true, hours: 6 }, return24: { enabled: true, hours: 72 } });
  await customerEmailsFn();
  check("6.10 приключил наем → без напомняне за връщане", !mail.sent.slice(before).some((m) => m.to === `r-${e}@example.com` && !/отзив|Благодарим/i.test(m.subject)), "");
  // Исторически резервации не получават писма наведнъж
  const old = await mk({ startDate: addDays(sofiaToday(), -20), endDate: addDays(sofiaToday(), -18) });
  await customerEmailsFn();
  check("6.11 стари резервации не получават писма наведнъж", mail.sent.filter((m) => m.to === `r-${old}@example.com`).length === 0, "");
  const job = await req("/api/admin/settings", { fn: settingsFn });
  check("6.12 състояние на автоматичната задача се записва", !!job.json.jobs.find((j: any) => j.key === "customer-emails").last?.at && job.json.reminders.updatedBy === "admin@example.com", "");
  await setR({});
}

// ===== 7. Клиенти: само изрично свързване =====
{
  const a = await insert({ carId: "ka", status: "rejected", name: "Иван Петров", email: "ivan@example.com", phone: "+359 888 123 456" });
  const b = await insert({ carId: "ka", status: "rejected", name: "Мария Петрова", email: "ivan@example.com", phone: "0888999000" });
  const c = await insert({ carId: "ka", status: "rejected", name: "Иван Петров", email: "drug@example.com", phone: "0888 123 456" });
  const mk = await req("/api/admin/customers", { fn: customersFn, method: "POST", body: { fromBooking: a } });
  const id = mk.json.customer.id;
  check("7.1 профил от резервация: свързана е само тя", mk.status === 201 && mk.json.bookings.length === 1 && mk.json.bookings[0].id === a && (await row(b)).customerId === null && (await row(c)).customerId === null, "");
  const m = Object.fromEntries(mk.json.matches.map((x: any) => [x.id, x.match]));
  check("7.2 възможни съвпадения се показват отделно с причината (имейл / име), без автоматично свързване", m[b]?.join() === "email" && m[c]?.includes("name") && !m[a], JSON.stringify(m));
  const twice = await req("/api/admin/customers", { fn: customersFn, method: "POST", body: { fromBooking: a } });
  check("7.3 повторно създаване от свързана резервация → 409", twice.status === 409, String(twice.status));
  const l = await req(`/api/admin/customers/${id}`, { fn: customersFn, method: "POST", body: { action: "link", bookingId: b } });
  const mk2 = await req("/api/admin/customers", { fn: customersFn, method: "POST", body: { fromBooking: c } });
  const steal = await req(`/api/admin/customers/${id}`, { fn: customersFn, method: "POST", body: { action: "link", bookingId: c } });
  check("7.4 изрично свързване; резервация на друг профил не се „открадва“", l.status === 200 && (await row(b)).customerId === id && steal.status === 409 && (await row(c)).customerId === mk2.json.customer.id, `${l.status}/${steal.status}`);
  const s = await req("/api/admin/customers?q=888%20123", { fn: customersFn });
  const s2 = await req("/api/admin/customers?q=IVAN@", { fn: customersFn });
  check("7.5 търсене по телефон (цифри) и имейл", s.json.customers.some((x: any) => x.id === id) && s2.json.customers.some((x: any) => x.id === id), "");
  const up = await req(`/api/admin/customers/${id}`, { fn: customersFn, method: "POST", body: { action: "update", note: "предпочита дизел" } });
  check("7.6 вътрешна бележка + история на промените", up.json.customer.note === "предпочита дизел" && up.json.events.some((e: any) => e.action === "customer.update" && e.actor === "admin@example.com"), "");
  const un = await req(`/api/admin/customers/${id}`, { fn: customersFn, method: "POST", body: { action: "unlink", bookingId: b } });
  check("7.7 премахване на връзката", un.status === 200 && (await row(b)).customerId === null, "");
  check("7.8 списъкът не съдържа номера или снимки на документи", !/egn|idn|documents/i.test(JSON.stringify((await req("/api/admin/customers", { fn: customersFn })).json)), "");
}

// ===== 8. Права за договори и снимки =====
{
  const doc = "a".repeat(64), foreign = "b".repeat(64), missing = "c".repeat(64);
  stores.get("deploypreview-documents") || stores.set("deploypreview-documents", new Map());
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  await (await import("./stubs/blobs.ts")).getStore("deploypreview-documents").set(doc, jpg);
  await (await import("./stubs/blobs.ts")).getStore("deploypreview-documents").set(foreign, jpg);
  const msg = `ТЕСТ\n\nСНИМКИ НА ДОКУМЕНТИТЕ\nЛична карта – лице: ${O}/api/documents/${doc}\nКнижка: ${O}/api/documents/${missing}\nЧужд: https://evil.example/api/documents/${foreign}`;
  const r = await request("D1", "ibiza", "2029-06-01", "10:00", "2029-06-02", "10:00", { message: msg, contract: contractData("2029-06-01", "10:00", "2029-06-02", "10:00") });
  const b = await row(r.id);
  check("8.1 снимките от заявката се записват като ключове от същия сайт (чуждият адрес – не)", Array.isArray(b.documents) && (b.documents as any[]).length === 2 && !(b.documents as any[]).some((d) => d.id === foreign), JSON.stringify(b.documents));
  const anon = await raw(`/api/admin/contracts/${r.id}/file?v=1`, { fn: contractsFn, jar: null });
  const user = await raw(`/api/admin/contracts/${r.id}/document/${doc}`, { fn: contractsFn, jar: usr });
  check("8.2 без вход → 401, без роля admin → 403 (договор и снимка)", anon.status === 401 && user.status === 403, `${anon.status}/${user.status}`);
  const f = await raw(`/api/admin/contracts/${r.id}/file?v=1`, { fn: contractsFn });
  check("8.3 администратор: изтегляне на версия, no-store, като прикачен файл", f.status === 200 && /wordprocessingml/.test(f.headers.get("content-type") || "") && f.headers.get("cache-control") === "private, no-store" && /attachment/.test(f.headers.get("content-disposition") || ""), String(f.status));
  const img = await raw(`/api/admin/contracts/${r.id}/document/${doc}`, { fn: contractsFn });
  const audited = await count("select count(*)::int n from booking_events where booking_id=$1 and action='document.view'", [r.id]);
  check("8.4 снимка на тази резервация → jpeg; отварянето е в историята", img.status === 200 && img.headers.get("content-type") === "image/jpeg" && audited === 1, String(img.status));
  const other = await raw(`/api/admin/contracts/${r.id}/document/${foreign}`, { fn: contractsFn });
  const miss = await req(`/api/admin/contracts/${r.id}/document/${missing}`, { fn: contractsFn });
  const missV = await req(`/api/admin/contracts/${r.id}/file?v=9`, { fn: contractsFn });
  check("8.5 снимка извън резервацията → 404; липсващ файл → 404 missing (без празно изтегляне)", other.status === 404 && miss.status === 404 && miss.json.error === "missing" && missV.status === 404, `${other.status}/${miss.json.error}/${missV.status}`);
  const vkey = (await t.q("select blob_key from contract_versions where booking_id=$1", [r.id])).rows[0].blob_key;
  stores.get("deploypreview-contracts")!.delete(vkey);
  const gone = await req(`/api/admin/contracts/${r.id}/file?v=1`, { fn: contractsFn });
  const det = await req(`/api/admin/contracts/${r.id}`, { fn: contractsFn });
  check("8.6 изтрит файл на версия → 404 missing и „файлът липсва“ в детайлите", gone.json.error === "missing" && det.json.versions[0].available === false && det.json.documents.find((d: any) => d.id === missing).available === false, "");
  check("8.7 нова версия: „очаква подписване“; детайлите не съдържат ключове за достъп", det.json.versions[0].signStatus === "awaiting" && !JSON.stringify(det.json).includes("2".repeat(64)), det.json.versions[0].signStatus);
  await t.q("insert into contract_versions (booking_id, version, blob_key, file_name, created_by) values ($1, 2, 'versions/x/old.docx', 'old.docx', 'system')", [r.id]);
  const det2 = await req(`/api/admin/contracts/${r.id}`, { fn: contractsFn });
  check("8.8 версия без данни (исторически запис) → signStatus unknown („Няма записани данни за подписване“)", det2.json.versions[1].signStatus === "unknown", det2.json.versions[1].signStatus);
  const list = await req(`/api/admin/contracts?q=${r.id.slice(0, 12)}`, { fn: contractsFn });
  check("8.9 търсене в договорите по номер на резервация", list.json.rows.length === 1 && list.json.rows[0].id === r.id && list.json.rows[0].documentsCount === 2, JSON.stringify(list.json.rows.map((x: any) => [x.id, x.documentsCount, x.versions])));
  const csrf = await req("/api/admin/cars/ka", { fn: fleetFn, method: "POST", body: { status: "inactive" }, origin: "https://evil.example" });
  check("8.10 промяна от чужд сайт → 403", csrf.status === 403 && (await t.q("select status from cars where id='ka'")).rows[0].status === "active", String(csrf.status));
  const badDetail = await req(`/api/admin/bookings/${r.id}`);
  check("8.11 детайлите на резервацията не съдържат токени и ключове на снимките", !JSON.stringify(badDetail.json).includes(doc) && !("adminToken" in badDetail.json.booking), "");
}

// ===== 9. Начално табло спрямо реалните статуси =====
{
  const today = sofiaToday();
  const pk = await insert({ carId: "ka", startDate: today, startTime: "23:58", endDate: addDays(today, 3), endTime: "10:00" });
  const rt = await insert({ carId: "golf", startDate: addDays(today, -2), startTime: "10:00", endDate: today, endTime: "23:59", handedOverAt: new Date(Date.now() - 864e5) });
  const pend = await insert({ carId: "punto", status: "pending", startDate: addDays(today, 5), endDate: addDays(today, 6) });
  const canc = await insert({ carId: "punto", status: "cancelled", startDate: today, endDate: today });
  const d = await req("/api/admin/dashboard", { fn: dashboardFn });
  const has = (k: string, id: string) => d.json.lists[k].some((r: any) => r.id === id);
  check("9.1 получаване днес (планирано, без предаване) и връщане днес (с предаване, без връщане)", has("pickup_today", pk) && !d.json.lists.pickup_today.find((r: any) => r.id === pk).handedOverAt && has("return_today", rt) && has("active", rt) && !has("overdue", rt), "");
  check("9.2 чакаща е в „чакащи“, отменената – никъде", has("pending", pend) && !Object.values(d.json.lists).flat().some((r: any) => r.id === canc), "");
  for (const v of ["pending", "pickup_today", "return_today", "active"]) {
    const l = await req(`/api/admin/bookings?view=${v}`);
    check(`9.3 показател „${v}“ отваря същите записи (${d.json.counts[v]})`, l.json.total === d.json.counts[v], `${l.json.total}/${d.json.counts[v]}`);
  }
  const anon = await req("/api/admin/dashboard", { fn: dashboardFn, jar: null });
  check("9.4 таблото изисква вход", anon.status === 401, String(anon.status));
  // Календар: същите правила като проверката
  const cal = await req(`/api/admin/calendar?from=2028-10-01&days=14`, { fn: fleetFn });
  const evs = cal.json.events.filter((e: any) => e.carId === "passat");
  const conf = evs.find((e: any) => e.id === EXT);
  check("9.5 календар: потвърдена резервация с крайния час след удължаване и буфер 60 мин.", conf && conf.type === "booking" && conf.to.join(" ") === "2028-10-06 15:00" && conf.bufferUntil.join(" ") === "2028-10-06 16:00", JSON.stringify(conf));
  const cal2 = await req(`/api/admin/calendar?from=2028-05-01&days=31`, { fn: fleetFn });
  const types = new Set(cal2.json.events.filter((e: any) => e.carId === "ka").map((e: any) => e.type));
  check("9.6 календар: блокирани периоди и чакащи заявки са отделни типове; отменените не се показват", types.has("block") && types.has("pending") && !cal2.json.events.some((e: any) => e.type === "block" && e.from[0] === "2028-05-10"), [...types].join());
  const badCal = await req(`/api/admin/calendar?from=2028-05-01&days=90`, { fn: fleetFn });
  check("9.7 календар: невалиден период → 400", badCal.status === 400, String(badCal.status));
}

await finish();
