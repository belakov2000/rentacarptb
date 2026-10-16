// Буфер в календара (пресичане на действителния 60-минутен интервал с всяка дата, и през полунощ) и наличността около него;
// историческо предаване и връщане, въведени след факта (момент на събитието отделно от момента на въвеждане).
// Само синтетични данни; имейлите и Netlify Identity се симулират (harness.ts). Реални резервации не се засягат.
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { check, cookieJar, finish, freshDb, identity, mail, O, setContext, schema } from "./harness.ts";
import adminBookingsFn from "../../netlify/functions/admin-bookings.mts";
import paymentsFn from "../../netlify/functions/admin-payments.mts";
import fleetFn from "../../netlify/functions/admin-fleet.mts";
import dashboardFn from "../../netlify/functions/admin-dashboard.mts";
import authFn from "../../netlify/functions/admin-auth.mts";
import availabilityFn from "../../netlify/functions/availability.mts";
import customerEmailsFn from "../../netlify/functions/customer-emails.mts";
import { findConflict } from "../../server/conflicts.ts";
import { sofiaToUtc } from "../../db/hours.ts";

setContext("deploy-preview");
const t = await freshDb("historical");
t.use();
const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
identity.users.set("admin@example.com", { id: "1", email: "admin@example.com", password: "admin-pass-123", roles: ["admin"] });
const adm = cookieJar();
async function req(path: string, opt: { method?: string; body?: unknown; fn?: any } = {}) {
  setContext("deploy-preview", { cookies: adm, ip: "203.0.113.5" });
  const id = path.split("?")[0].split("/")[4] || "";
  const r = await (opt.fn || adminBookingsFn)(new Request(O + path, { method: opt.method || "GET", headers: { "Content-Type": "application/json", Origin: O }, body: opt.body ? JSON.stringify(opt.body) : undefined }), { ip: "203.0.113.5", params: id ? { id } : {} } as any);
  setContext("deploy-preview");
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
await req("/api/admin/login", { fn: authFn, method: "POST", body: { email: "admin@example.com", password: "admin-pass-123" } });
let n = 0;
async function insert(v: Partial<typeof schema.bookings.$inferInsert>) {
  const id = (++n).toString(16).padStart(32, "e");
  await t.db.insert(schema.bookings).values({ id, viewToken: "1".repeat(64), adminToken: "2".repeat(64), name: "ТЕСТ Синтетична " + n, email: `hist-${n}@example.com`, phone: "+359000000000", car: "Тестова", carId: "golf", pickup: "п", dropoff: "в", status: "confirmed", decidedAt: new Date(Date.UTC(2026, 9, 1)), ...v });
  return id;
}

// ===== 1. Буфер в календара =====
const html = readFileSync("admin/index.html", "utf8");
const src = /const MIN=\(dd,tt\)=>[\s\S]*?\nfunction bufSegs\(e,day\)\{[\s\S]*?return out\}\n/.exec(html)![0];
const bufSegs = new Function(src + "return bufSegs;")();
const days = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = new Date(Date.parse(d + "T00:00:00Z") + 864e5).toISOString().slice(0, 10)) out.push(d); return out; };
const withBuf = (e: any) => days("2026-09-25", "2026-10-15").filter((d) => bufSegs(e, d).length);
// A57C00: 05.10 12:00 – 07.10 12:00 (както при ръчната проверка)
const A = { from: ["2026-10-05", "12:00"], to: ["2026-10-07", "12:00"], bufferFrom: ["2026-10-05", "11:00"], bufferUntil: ["2026-10-07", "13:00"] };
check("1.1 буферът е само в деня на началото и на края (не от 29.09)", JSON.stringify(withBuf(A)) === JSON.stringify(["2026-10-05", "2026-10-07"]), withBuf(A).join(","));
check("1.2 текстът е точният интервал: 11:00–12:00 и 12:00–13:00", bufSegs(A, "2026-10-05")[0] === "11:00–12:00" && bufSegs(A, "2026-10-07")[0] === "12:00–13:00" && !bufSegs(A, "2026-09-29").length && !bufSegs(A, "2026-10-06").length, "");
const M = { from: ["2026-10-10", "00:30"], to: ["2026-10-11", "23:30"], bufferFrom: ["2026-10-09", "23:30"], bufferUntil: ["2026-10-12", "00:30"] };
check("1.3 през полунощ: 09.10 23:30–24:00, 10.10 00:00–00:30, 11.10 23:30–24:00, 12.10 00:00–00:30", JSON.stringify(["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"].map((d) => bufSegs(M, d))) === JSON.stringify([["23:30–24:00"], ["00:00–00:30"], ["23:30–24:00"], ["00:00–00:30"]]) && withBuf(M).length === 4, JSON.stringify(withBuf(M)));
const Z = { from: ["2026-10-10", "01:00"], to: ["2026-10-10", "23:00"], bufferFrom: ["2026-10-10", "00:00"], bufferUntil: ["2026-10-11", "00:00"] };
check("1.4 буфер, който свършва точно в 00:00 – не се показва в следващия ден", JSON.stringify(withBuf(Z)) === JSON.stringify(["2026-10-10"]) && bufSegs(Z, "2026-10-10").join() === "00:00–01:00,23:00–24:00", JSON.stringify(withBuf(Z)));
check("1.5 събитие без буфер (чакаща заявка) – без буфер", !withBuf({ from: ["2026-10-05", "12:00"], to: ["2026-10-07", "12:00"] }).length, "");
// Сървърът подава на календара същите краища като проверката за наличност
const bk = await insert({ carId: "punto", startDate: "2027-03-05", startTime: "12:00", endDate: "2027-03-07", endTime: "23:30" });
const cal = await req("/api/admin/calendar?from=2027-02-26&days=14", { fn: fleetFn });
const ev = cal.json.events.find((e: any) => e.id === bk);
check("1.6 календар (сървър): буфер 11:00 на 05.03 и до 00:30 на 08.03", ev && ev.bufferFrom.join(" ") === "2027-03-05 11:00" && ev.bufferUntil.join(" ") === "2027-03-08 00:30", JSON.stringify(ev && [ev.bufferFrom, ev.bufferUntil]));
check("1.7 календар: буферните дни от сървъра са само 05.03, 07.03 и 08.03", JSON.stringify(days("2027-02-26", "2027-03-11").filter((d) => bufSegs(ev, d).length)) === JSON.stringify(["2027-03-05", "2027-03-07", "2027-03-08"]), "");
// Наличност: същите граници (засегнат беше само изгледът в панела)
const c1 = await findConflict("punto", "2027-03-08", "2027-03-09", "00:29", "10:00");
const c2 = await findConflict("punto", "2027-03-08", "2027-03-09", "00:30", "10:00");
const c3 = await findConflict("punto", "2027-03-01", "2027-03-05", "10:00", "11:00");
const c4 = await findConflict("punto", "2027-03-01", "2027-03-05", "10:00", "11:01");
const c5 = await findConflict("punto", "2027-02-26", "2027-03-04", "10:00", "23:59");
check("1.8 наличност през полунощ: 08.03 00:29 – заето, 00:30 – свободно", c1?.kind === "booking" && c2 === null, `${c1?.kind}/${c2}`);
check("1.9 наличност преди началото: връщане до 11:00 – свободно, 11:01 – заето; дни преди това – свободни", c3 === null && c4?.kind === "booking" && c5 === null, `${c3}/${c4?.kind}/${c5}`);
const av = (await (await availabilityFn()).json()).cars.punto;
check("1.10 публичната наличност: само действителният период (буферът се прилага от сайта)", JSON.stringify(av) === JSON.stringify([["2027-03-05", "2027-03-07", "12:00", "23:30"]]), JSON.stringify(av));
// Публичният сайт: същото правило за деня (dayPart / dayBusy в index.html)
const site = readFileSync("index.html", "utf8");
const mn = (d: string, tt: string) => Date.parse(`${d}T${tt}:00Z`) / 6e4;
const iv = (b: string[]) => [mn(b[0], b[2]), mn(b[1], b[3])];
const BUF = 60, BOOK = ["2027-03-05", "2027-03-07", "12:00", "23:30"];
const dayPart = (ds: string) => { const [S, E] = iv(BOOK); return S - BUF <= mn(ds, "23:59") && mn(ds, "00:00") < E + BUF; };
check("1.11 сайтът: правилото за частично зает ден е непроменено и отбелязва само 05.03–08.03", site.includes('const dayPart=(c,ds)=>BOOKED[c.id].some(b=>{const[S,E]=iv(b);return S-BUF<=mn(ds,"23:59")&&mn(ds,"00:00")<E+BUF});') && JSON.stringify(days("2027-02-26", "2027-03-11").filter(dayPart)) === JSON.stringify(["2027-03-05", "2027-03-06", "2027-03-07", "2027-03-08"]), "");

// ===== 2. Историческо предаване и връщане (синтетичен сценарий) =====
mail.sent.length = 0;
const H = await insert({ carId: "golf", startDate: "2026-10-15", startTime: "14:30", endDate: "2026-10-15", endTime: "23:59", total: "25 €", totalCents: 2500, pickup: "15.10.2026 14:30, офис", dropoff: "15.10.2026 23:59, офис" });
const hoAt = new Date(sofiaToUtc("2026-10-15", "14:30")), retAt = new Date(sofiaToUtc("2026-10-15", "23:59"));
const fut = await req(`/api/admin/bookings/${H}`, { method: "POST", body: { action: "handover", handedOverAt: new Date(Date.now() + 3600_000).toISOString() } });
const bad = await req(`/api/admin/bookings/${H}`, { method: "POST", body: { action: "handover", handedOverAt: "вчера" } });
check("2.1 предаване в бъдещето или невалиден момент → 400, нищо не е записано", fut.status === 400 && fut.json.error === "handed_over_at" && bad.status === 400 && (await row(H)).handedOverAt === null, `${fut.status}/${bad.status}`);
const ho = await req(`/api/admin/bookings/${H}`, { method: "POST", body: { action: "handover", handedOverAt: hoAt.toISOString() } });
const h1 = await row(H);
check("2.2 предаване на 15.10.2026 14:30: моментът на събитието и моментът на въвеждане са отделни", ho.status === 200 && h1.handedOverAt!.getTime() === hoAt.getTime() && h1.handedOverBy === "admin@example.com" && !!h1.handoverRecordedAt && h1.handoverRecordedAt.getTime() > hoAt.getTime() + 3600_000, `${h1.handedOverAt?.toISOString()} / ${h1.handoverRecordedAt?.toISOString()}`);
const evH = (await t.q("select actor, details from booking_events where booking_id=$1 and action='booking.handover'", [H])).rows[0];
check("2.3 история: кой, кога е въведено, действителен момент, „след факта“", evH.actor === "admin@example.com" && evH.details.at === hoAt.toISOString() && evH.details.afterTheFact === true && !!evH.details.recordedAt, JSON.stringify(evH.details));
const again = await req(`/api/admin/bookings/${H}`, { method: "POST", body: { action: "handover" } });
check("2.4 повторно предаване → 409", again.status === 409, String(again.status));
const pay = (body: Record<string, unknown>) => req("/api/admin/payments", { fn: paymentsFn, method: "POST", body: { bookingId: H, method: "cash", status: "received", idempotencyKey: "hist-" + Math.random().toString(36).slice(2, 12), ...body } });
check("2.5 предаването не създава плащания", (await t.q("select count(*)::int n from payments where booking_id=$1", [H])).rows[0].n === 0, "");
const p1 = await pay({ kind: "final", amount: "25", paidAt: new Date(sofiaToUtc("2026-10-15", "14:31")).toISOString() });
const p2 = await pay({ kind: "security", amount: "100", paidAt: new Date(sofiaToUtc("2026-10-15", "14:32")).toISOString() });
check("2.6 получени 25 € наем и 100 € гаранционен депозит в брой (въведени ръчно)", p1.status === 201 && p2.status === 201 && p2.json.finance.rentalNet === 2500 && p2.json.finance.securityHeld === 10000, `${p1.status}/${p2.status}`);
const early = await req(`/api/admin/bookings/${H}`, { method: "POST", body: { action: "return", returnedAt: new Date(hoAt.getTime() - 3600_000).toISOString() } });
const futR = await req(`/api/admin/bookings/${H}`, { method: "POST", body: { action: "return", returnedAt: new Date(Date.now() + 3600_000).toISOString() } });
check("2.7 връщане преди предаването или в бъдещето → 400", early.status === 400 && futR.status === 400 && (await row(H)).returnedAt === null, `${early.status}/${futR.status}`);
const ret = await req(`/api/admin/bookings/${H}`, { method: "POST", body: { action: "return", returnedAt: retAt.toISOString(), note: "синтетичен сценарий" } });
const h2 = await row(H);
check("2.8 връщане в 23:59 същия ден: записан момент, кой и кога е въведено", ret.status === 200 && h2.returnedAt!.getTime() === retAt.getTime() && h2.returnedBy === "admin@example.com" && !!h2.returnRecordedAt && h2.returnRecordedAt.getTime() > retAt.getTime(), `${h2.returnedAt?.toISOString()} / ${h2.returnRecordedAt?.toISOString()}`);
check("2.9 приключването не създава плащания", (await t.q("select count(*)::int n from payments where booking_id=$1", [H])).rows[0].n === 2, "");
const secId = p2.json.payments.find((p: any) => p.kind === "security").id;
const rf = await pay({ kind: "refund", amount: "100", refundOf: secId, paidAt: new Date(sofiaToUtc("2026-10-15", "23:59")).toISOString() });
const d = await req(`/api/admin/bookings/${H}`);
const f = d.json.finance;
check("2.10 очаквано: приключен наем, нетен приход 25 €, остатък 0 €, задържан депозит 0 €", rf.status === 201 && !!d.json.booking.returnedAt && f.rentalNet === 2500 && f.balanceState === "paid" && f.balanceCents === 0 && f.securityReceived === 10000 && f.securityRefunded === 10000 && f.securityHeld === 0, JSON.stringify(f));
const dash = await req("/api/admin/dashboard", { fn: dashboardFn });
check("2.11 таблото: не е текущ/просрочен наем и няма неприключен депозит", !["active", "overdue", "deposit_open", "no_handover"].some((k) => dash.json.lists[k].some((r: any) => r.id === H)), "");
const cal2 = await req("/api/admin/calendar?from=2026-10-14&days=3", { fn: fleetFn });
const ev2 = cal2.json.events.find((e: any) => e.id === H);
check("2.12 календар: от 15.10 14:30 до реалното връщане 23:59, буфер до 16.10 00:59", ev2 && ev2.returned && ev2.from.join(" ") === "2026-10-15 14:30" && ev2.to.join(" ") === "2026-10-15 23:59" && ev2.bufferUntil.join(" ") === "2026-10-16 00:59", JSON.stringify(ev2 && [ev2.from, ev2.to, ev2.bufferUntil]));
const before = mail.sent.length;
await customerEmailsFn();
const remind = (await t.q("select kind from email_log where booking_id=$1 and kind in ('pickup24','handover','return24','returnSoon')", [H])).rows;
check("2.13 стари напомняния (преди получаване / връщане) не се изпращат", remind.length === 0 && !mail.sent.slice(before).some((m) => m.to === h2.email && !/отзив|Благодарим/i.test(m.subject)), JSON.stringify(remind));
check("2.14 при предаването и връщането не са изпратени писма", !mail.sent.slice(0, before).some((m) => m.to === h2.email), "");
// Без отбелязано предаване връщане не може да се въведе
const N = await insert({ startDate: "2026-10-10", endDate: "2026-10-11", startTime: "10:00", endTime: "10:00" });
const nr = await req(`/api/admin/bookings/${N}`, { method: "POST", body: { action: "return", returnedAt: new Date(sofiaToUtc("2026-10-11", "10:00")).toISOString() } });
check("2.15 връщане без предаване → 409; предаване не се приема без данни", nr.status === 409 && (await row(N)).handedOverAt === null && (await row(N)).returnedAt === null, String(nr.status));
// Предаване от линка в имейла (без момент) – както досега, моментът е „сега“
const L = await insert({ startDate: "2026-10-16", endDate: "2026-10-18", startTime: "10:00", endTime: "10:00" });
const lr = await req(`/api/admin/bookings/${L}`, { method: "POST", body: { action: "handover" } });
const l1 = await row(L);
check("2.16 предаване без посочен момент → сега (моментът на събитието = моментът на въвеждане)", lr.status === 200 && Math.abs(l1.handedOverAt!.getTime() - l1.handoverRecordedAt!.getTime()) < 1000, "");
await finish();
