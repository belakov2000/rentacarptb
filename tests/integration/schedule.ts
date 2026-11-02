// График на автоматичните писма: customer-emails и email-retry на всеки 15 минути (:00, :15, :30, :45).
// Изпълненията се симулират с подменен часовник – всяко писмо тръгва при първото изпълнение след срока си, точно веднъж,
// не по-рано и най-много 15 мин след срока. Незабавните писма (нова заявка, одобрение, отказ) не чакат графика.
// Само синтетични данни; имейлите се симулират (harness.ts).
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { bookingBody, check, contractData, finish, freshDb, mail, O, setContext, schema, withQuote } from "./harness.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import customerEmailsFn, { config as customerEmailsConfig } from "../../netlify/functions/customer-emails.mts";
import retryFn, { config as retryConfig } from "../../netlify/functions/email-retry.mts";
import { sofiaToUtc } from "../../db/hours.ts";

setContext("deploy-preview");
const t = await freshDb("schedule");
t.use();
const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
const logOf = async (id: string, kind: string) => (await t.db.select().from(schema.emailLog).where(eq(schema.emailLog.bookingId, id))).filter((r: any) => r.kind === kind);
const MIN = 60_000, STEP = 15 * MIN;

// ===== 1. Графикът =====
const SCHEDULE = "*/15 * * * *";
const settingsSrc = readFileSync("netlify/functions/admin-settings.mts", "utf8");
check("1.1 customer-emails и email-retry: на всеки 15 мин, в една и съща минута (:00, :15, :30, :45)", customerEmailsConfig.schedule === SCHEDULE && retryConfig.schedule === SCHEDULE, `${customerEmailsConfig.schedule} / ${retryConfig.schedule}`);
check("1.2 панелът показва същия график като функциите", settingsSrc.includes(`{ key: "customer-emails", schedule: "${SCHEDULE}"`) && settingsSrc.includes(`{ key: "email-retry", schedule: "${SCHEDULE}"`), "");
check("1.3 панелът изписва „на всеки 15 минути“ за този график", readFileSync("admin/index.html", "utf8").includes(`j.schedule==="${SCHEDULE}"?"на всеки 15 минути"`), "");

// ===== Подменен часовник: Date.now() и new Date() връщат симулирания момент =====
const RealDate = Date;
let fake: number | null = null;
class FakeDate extends RealDate {
  constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(fake ?? RealDate.now()); }
  static now() { return fake ?? RealDate.now(); }
}
// Едно изпълнение по графика: двете функции в същата минута
async function tick(at: number) {
  fake = at;
  (globalThis as any).Date = FakeDate;
  try { await customerEmailsFn(); await retryFn(); } finally { (globalThis as any).Date = RealDate; fake = null; }
}
// Всички изпълнения по графика от from до to (включително), подравнени на :00/:15/:30/:45
async function ticks(from: number, to: number) {
  for (let at = Math.ceil(from / STEP) * STEP; at <= to; at += STEP) await tick(at);
}
const firstTick = (due: number) => Math.ceil(due / STEP) * STEP;
const iso = (ms: number) => new RealDate(ms).toISOString().slice(0, 16);

let n = 0;
async function insert(v: Partial<typeof schema.bookings.$inferInsert>) {
  const id = (++n).toString(16).padStart(32, "d");
  await t.db.insert(schema.bookings).values({
    id, viewToken: "1".repeat(64), adminToken: "2".repeat(64), name: "ТЕСТ График " + n, email: `sched-${n}@example.com`, phone: "+359000000000",
    lang: "bg", car: "Тестова", carId: "golf", pickup: "п", dropoff: "в", total: "50 €", payment: "cash", status: "confirmed",
    decidedAt: new RealDate(Date.UTC(2030, 0, 1)), ...v,
  });
  return id;
}
const H = 3600_000;

// ===== 2. Напомняния при потвърдена резервация (24 ч преди получаване и връщане, отзив 2 ч след края) =====
// Часове извън :00/:15/:30/:45 – закъснението се вижда; второ получаване точно на изпълнение – без закъснение
const R = await insert({ startDate: "2030-06-10", startTime: "10:05", endDate: "2030-06-12", endTime: "18:10" });
const R0 = await insert({ startDate: "2030-06-10", startTime: "10:00", endDate: "2030-06-12", endTime: "10:00", carId: "punto" });
const start = sofiaToUtc("2030-06-10", "10:05"), end = sofiaToUtc("2030-06-12", "18:10"), start0 = sofiaToUtc("2030-06-10", "10:00");
const cases = [
  { name: "напомняне 24 ч преди получаване", id: R, kind: "pickup24", due: start - 24 * H },
  { name: "напомняне 24 ч преди получаване (срокът е точно :00)", id: R0, kind: "pickup24", due: start0 - 24 * H },
  { name: "напомняне 24 ч преди връщане", id: R, kind: "return24", due: end - 24 * H },
  { name: "молба за отзив 2 ч след края", id: R, kind: "review", due: end + 2 * H },
];
for (const c of cases) {
  const before = (await logOf(c.id, c.kind)).length;
  await ticks(c.due - 45 * MIN, c.due - 1);
  const early = (await logOf(c.id, c.kind)).length - before;
  await ticks(c.due, c.due + 60 * MIN);
  const logs = await logOf(c.id, c.kind);
  const sentAt = logs[0]?.sentAt?.getTime();
  const delay = sentAt != null ? (sentAt - c.due) / MIN : NaN;
  check(`2. ${c.name}: не по-рано, точно веднъж, при първото изпълнение след срока (до 15 мин)`,
    early === 0 && logs.length === 1 && logs[0].status === "sent" && sentAt === firstTick(c.due) && delay >= 0 && delay < 15,
    `срок ${iso(c.due)}, изпратено ${sentAt != null ? iso(sentAt) : "—"} (+${delay} мин), записи ${logs.length}`);
}
const toR = mail.sent.filter((m) => m.to === "sched-1@example.com");
check("2.5 клиентът получава точно 3 писма (без дубликати при всички изпълнения)", toR.length === 3, `${toR.length}`);
// Неуспешно напомняне: опитва се отново при следващото изпълнение, 15 мин по-късно, и тръгва веднъж
const F = await insert({ startDate: "2030-06-20", startTime: "10:05", endDate: "2030-06-22", endTime: "10:05", carId: "passat" });
const fDue = sofiaToUtc("2030-06-20", "10:05") - 24 * H;
mail.fail = (m) => (m.to === "sched-3@example.com" ? "Brevo 503" : null);
await tick(firstTick(fDue));
const fFailed = (await logOf(F, "pickup24"))[0];
mail.fail = null;
await ticks(firstTick(fDue) + STEP, firstTick(fDue) + 60 * MIN);
const fSent = (await logOf(F, "pickup24"))[0];
check("2.6 неуспешно напомняне: повторен опит при следващото изпълнение (+15 мин), изпратено веднъж",
  fFailed?.status === "failed" && fSent?.status === "sent" && fSent.sentAt?.getTime() === firstTick(fDue) + STEP && mail.sent.filter((m) => m.to === "sched-3@example.com").length === 1,
  `${fFailed?.status} → ${fSent?.status} ${fSent?.sentAt ? iso(fSent.sentAt.getTime()) : ""}`);

// ===== 3. Двуетапни заявки: напомняне за документите (15 мин) и RENTY10 (2 ч) =====
const inv = Date.UTC(2030, 6, 1, 9, 2); // 09:02 UTC – между две изпълнения
const D = await insert({ status: "pending", stage: "docs", docsInvitedAt: new RealDate(inv), marketingConsent: true, startDate: "2030-07-05", startTime: "10:00", endDate: "2030-07-07", endTime: "10:00", carId: "ka" });
await ticks(inv, inv + 15 * MIN - 1);
check("3.1 преди 15 мин след поканата няма напомняне", !(await row(D)).docsReminderAt, "");
await ticks(inv + 15 * MIN, inv + 50 * MIN);
const dRem = (await row(D)).docsReminderAt?.getTime();
const remLog = await logOf(D, "customer-docs-reminder");
check("3.2 напомнянето за документите тръгва 15–30 мин след поканата, веднъж",
  dRem === firstTick(inv + 15 * MIN) && (dRem! - inv) / MIN >= 15 && (dRem! - inv) / MIN < 30 && remLog.length === 1 && remLog[0].status === "sent",
  `покана ${iso(inv)}, напомняне ${dRem ? iso(dRem) : "—"} (+${dRem ? (dRem - inv) / MIN : "—"} мин)`);
await ticks(inv + 2 * H - 30 * MIN, inv + 2 * H - 1);
check("3.3 преди 2 ч след поканата няма RENTY10", !(await row(D)).couponSentAt, "");
await ticks(inv + 2 * H, inv + 2 * H + 45 * MIN);
const dCp = (await row(D)).couponSentAt?.getTime();
check("3.4 RENTY10 тръгва 2:00–2:15 ч след поканата, веднъж",
  dCp === firstTick(inv + 2 * H) && (dCp! - inv) / MIN >= 120 && (dCp! - inv) / MIN < 135 && (await logOf(D, "customer-coupon")).length === 1,
  `RENTY10 ${dCp ? iso(dCp) : "—"} (+${dCp ? (dCp - inv) / MIN : "—"} мин)`);
// Повторен опит от email-retry: напомнянето за документите се проваля и тръгва при първото изпълнение след паузата (5 мин)
const inv2 = Date.UTC(2030, 6, 2, 9, 2);
const D2 = await insert({ status: "pending", stage: "docs", docsInvitedAt: new RealDate(inv2), startDate: "2030-07-06", startTime: "10:00", endDate: "2030-07-08", endTime: "10:00", carId: "golf" });
mail.fail = (m) => (m.to === "sched-5@example.com" ? "Brevo 503" : null);
await tick(firstTick(inv2 + 15 * MIN));
const r2f = (await logOf(D2, "customer-docs-reminder"))[0];
mail.fail = null;
await ticks(firstTick(inv2 + 15 * MIN) + STEP, firstTick(inv2 + 15 * MIN) + 90 * MIN);
const r2s = (await logOf(D2, "customer-docs-reminder"))[0];
check("3.5 email-retry: неуспешното писмо тръгва при първото изпълнение след паузата (+15 мин), веднъж",
  r2f?.status === "failed" && r2s?.status === "sent" && r2s.sentAt?.getTime() === firstTick(r2f.nextAttemptAt!.getTime()) && mail.sent.filter((m) => m.to === "sched-5@example.com").length === 1,
  `пауза до ${r2f?.nextAttemptAt ? iso(r2f.nextAttemptAt.getTime()) : "—"}, изпратено ${r2s?.sentAt ? iso(r2s.sentAt.getTime()) : "—"}`);
// Тесен прозорец (приетото поведение): получаването е преди първото изпълнение след срока → напомнянето се пропуска
const inv3 = Date.UTC(2030, 6, 3, 9, 2); // 12:02 българско време
const D3 = await insert({ status: "pending", stage: "docs", docsInvitedAt: new RealDate(inv3), startDate: "2030-07-03", startTime: "12:20", endDate: "2030-07-04", endTime: "12:20", carId: "punto" });
await ticks(inv3, inv3 + 60 * MIN);
check("3.6 получаване 18 мин след поканата: напомнянето (срок 12:17, изпълнение 12:30) не се изпраща след получаването",
  !(await row(D3)).docsReminderAt && (await logOf(D3, "customer-docs-reminder")).length === 0, "");

// ===== 4. Незабавните писма не чакат графика (без нито едно изпълнение) =====
const call = (url: string, init: RequestInit = {}, id = "") => bookingsFn(new Request(url, init), { params: id ? { id } : {} } as any);
const create = async (s: string) => {
  const r = await call(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await withQuote(bookingBody(s, "2028-05-03", "10:00", "2028-05-05", "10:00", { requestKey: `sched-${s}-key`, carId: s === "Y" ? "golf" : "passat", contract: contractData("2028-05-03", "10:00", "2028-05-05", "10:00") }))) });
  return (await r.json()).id as string;
};
const manage = async (id: string, action: string, extra: Record<string, string> = {}) => {
  const b = await row(id);
  await call(`${O}/api/bookings/${id}/manage?key=${b.adminToken}`, { method: "POST", body: new URLSearchParams({ action, ...extra }) }, id);
};
let m0 = mail.sent.length;
const X = await create("X");
const newMails = mail.sent.slice(m0);
check("4.1 нова заявка: писмата до фирмата и клиента тръгват веднага", newMails.length === 2 && newMails.some((m) => m.to === "test-x@example.com"), newMails.map((m) => m.subject.slice(0, 30)).join(" | "));
m0 = mail.sent.length;
await manage(X, "confirm");
check("4.2 потвърждение: писмото до клиента тръгва веднага", (await row(X)).status === "confirmed" && mail.sent.slice(m0).some((m) => m.to === "test-x@example.com"), (await row(X)).status);
const Y = await create("Y");
m0 = mail.sent.length;
await manage(Y, "reject", { note: "тест" });
check("4.3 отказ: писмото до клиента тръгва веднага", (await row(Y)).status === "rejected" && mail.sent.slice(m0).some((m) => m.to === "test-y@example.com"), (await row(Y)).status);

await finish();
