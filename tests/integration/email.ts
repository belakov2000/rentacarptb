// Имейли: успех, отказ на Brevo, изтекло време, изгубен отговор след приемане, повторни опити, изчерпване, лог и дублиране.
import { eq, sql } from "drizzle-orm";
import { bookingBody, check, contractData, finish, freshDb, mail, O, setContext, schema } from "./harness.ts";
import { stores } from "./stubs/blobs.ts";
import { MAX_ATTEMPTS, sendLogged, dueEmails } from "../../server/email.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import retryFn from "../../netlify/functions/email-retry.mts";
import customerEmailsFn from "../../netlify/functions/customer-emails.mts";

setContext("deploy-preview");
const t = await freshDb("email");
t.use();
const log = async (key: string) => (await t.db.select().from(schema.emailLog).where(eq(schema.emailLog.dedupeKey, key)))[0];
const due = async () => t.q("update email_log set next_attempt_at = now() - interval '1 minute', at = at - interval '5 minutes' where status in ('failed','unknown','queued')");
const msg = (to = "client@example.com") => ({ to, toName: "Тест", subject: "Тема", html: "<p>Тест</p>" });
const sentTo = (to: string) => mail.sent.filter((m) => m.to === to).length;
const reset = () => { mail.fail = null; mail.network = null; };

// 1. Успешен имейл
let r = await sendLogged("test", "ok:1", null, msg("ok@example.com"));
let row = await log("ok:1");
check("Успешен имейл: sent, 1 опит, маскиран адрес", r.result === "sent" && row.status === "sent" && row.attempts === 1 && !!row.sentAt && row.recipient === "ok***@example.com", `${row.status}, ${row.recipient}`);
r = await sendLogged("test", "ok:1", null, msg("ok@example.com"));
check("Повторно извикване със същия ключ не праща второ писмо", r.result === "duplicate" && sentTo("ok@example.com") === 1, r.result);
const par = await Promise.all(Array.from({ length: 8 }, () => sendLogged("test", "par:1", null, msg("par@example.com"))));
check("8 едновременни извиквания → 1 писмо", sentTo("par@example.com") === 1 && par.filter((x) => x.result === "sent").length === 1, par.map((x) => x.result).join(","));

// 2. Отказ на Brevo (HTTP грешка) – грешката се записва без ключ, връзки и адреси
mail.fail = () => 'Brevo 503 key=xkeysib-SECRET123abc see https://site.example/api/bookings/aaaa/manage?key=' + "f".repeat(64) + " for client@example.com";
r = await sendLogged("test", "fail:1", null, msg("fail@example.com"));
row = await log("fail:1");
check("Отказ на Brevo → failed с насрочен повторен опит", r.result === "failed" && row.status === "failed" && !!row.nextAttemptAt && row.nextAttemptAt > new Date(), row.status);
check("Грешката в лога е без ключ, тайна връзка и имейл", !/xkeysib|SECRET|https?:|f{64}|client@example/.test(row.error) && row.error.includes("503"), row.error);
reset();

// 3. Изчерпване на опитите
mail.fail = () => "Brevo error 500";
for (let i = 0; i < 10; i++) { await t.q("update email_log set next_attempt_at = now() - interval '1 minute' where dedupe_key='fail:1'"); await sendLogged("test", "fail:1", null, msg("fail@example.com")); }
row = await log("fail:1");
const dueNow = (await dueEmails(["test"])).filter((x: any) => x.dedupeKey === "fail:1");
check(`Изчерпване: спира след ${MAX_ATTEMPTS} опита`, row.attempts === MAX_ATTEMPTS && row.status === "failed" && dueNow.length === 0 && mail.calls > 0, `опити ${row.attempts}, в опашката: ${dueNow.length}`);
reset();

// 4. Изтекло време (Brevo не е отговорил) → unknown, не се повтаря до клиент
mail.network = () => "timeout";
r = await sendLogged("customer-received", "to:1", null, msg("timeout@example.com"));
row = await log("to:1");
check("Изтекло време → unknown (неясен резултат), не sent", r.result === "uncertain" && row.status === "unknown" && !row.sentAt && /timeout/i.test(row.error), `${row.status}: ${row.error}`);
reset();

// 5. Brevo приема писмото, но отговорът се губи – клиентско писмо: не се праща второ копие
mail.network = (m) => (m.to === "lost@example.com" ? "lost" : null);
r = await sendLogged("customer-received", "lost:1", null, msg("lost@example.com"));
reset();
await due();
await retryFn();
await retryFn();
row = await log("lost:1");
check("Изгубен отговор (клиент): 1 доставено писмо, без автоматично повторение", sentTo("lost@example.com") === 1 && row.status === "unknown", `доставени: ${sentTo("lost@example.com")}, статус ${row.status}`);

// 6. Нова заявка при недостъпен Brevo: резервацията се пази, писмата се опитват отново
mail.fail = () => "Brevo error 503: temporary";
const res = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bookingBody("Down", "2028-07-01", "10:00", "2028-07-02", "10:00", { requestKey: "email-down-0001", contract: contractData("2028-07-01", "10:00", "2028-07-02", "10:00") })) }), { params: {} } as any);
const j = await res.json();
const [bk] = await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, j.id));
check("Brevo недостъпен: заявката е записана (201, notify=failed)", res.status === 201 && j.notify === "failed" && !!bk, `HTTP ${res.status}`);
check("…договорът е свързан със записаната резервация (няма осиротял)", stores.get("deploypreview-contracts")!.has(j.id) && !!bk, "");
check("…писмото до фирмата чака в mail-outbox", stores.get("deploypreview-mail-outbox")!.has(`owner-new/${j.id}`), "");
check("…в лога: owner-new и customer-received са failed", (await log(`owner-new:${j.id}`)).status === "failed" && (await log(`customer-received:${j.id}`)).status === "failed", "");
// Повторно изпращане на формата при недостъпен Brevo → същата резервация, без нови писма
const again = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bookingBody("Down", "2028-07-01", "10:00", "2028-07-02", "10:00", { requestKey: "email-down-0001" })) }), { params: {} } as any);
const cnt = (await t.q("select count(*)::int n from bookings where email='test-down@example.com'")).rows[0].n;
check("Повторен опит от клиента не създава нова резервация", (await again.json()).id === j.id && cnt === 1, `резервации: ${cnt}`);
// Brevo се възстановява
reset();
await due();
const before = mail.sent.length;
await retryFn();
await due();
await retryFn();
const ownerMails = mail.sent.slice(before).filter((m) => m.subject.includes("ТЕСТ Down"));
check("Повторният опит изпраща писмото до фирмата веднъж, с договора", ownerMails.length === 1 && ownerMails[0].attachments === 1 && (await log(`owner-new:${j.id}`)).status === "sent", `писма: ${ownerMails.length}`);
check("…и потвърждението до клиента веднъж", sentTo("test-down@example.com") === 1 && (await log(`customer-received:${j.id}`)).status === "sent", "");
check("…mail-outbox е изчистен след изпращане", !stores.get("deploypreview-mail-outbox")!.has(`owner-new/${j.id}`), "");

// 7. Изгубен отговор за писмото до фирмата: повтаря се с отбелязана тема
mail.network = (m) => (m.subject.includes("ТЕСТ Lost") ? "lost" : null);
const res2 = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bookingBody("Lost", "2028-08-01", "10:00", "2028-08-02", "10:00", { requestKey: "email-lost-0001" })) }), { params: {} } as any);
const j2 = await res2.json();
reset();
check("Изгубен отговор (фирма): заявката е записана, notify=failed, статус unknown", res2.status === 201 && j2.notify === "failed" && (await log(`owner-new:${j2.id}`)).status === "unknown", "");
await due();
await retryFn();
const lostOwner = mail.sent.filter((m) => m.subject.includes("ТЕСТ Lost"));
check("…повторното писмо до фирмата е с „[Повторно известие]“ (възможно 2 копия)", lostOwner.length === 2 && lostOwner[1].subject.startsWith("[Повторно известие]") && !lostOwner[0].subject.startsWith("["), lostOwner.map((m) => m.subject.slice(0, 40)).join(" | "));
await due(); await retryFn();
check("…и не се праща трето копие", mail.sent.filter((m) => m.subject.includes("ТЕСТ Lost")).length === 2, "");

// 8. Отказ при решение: решението е записано, писмото се повтаря веднъж
const [b2] = await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, j2.id));
mail.fail = (m) => (m.to === "test-lost@example.com" ? "Brevo error 502" : null);
const page = await (await bookingsFn(new Request(`${O}/api/bookings/${b2.id}/manage?key=${b2.adminToken}`, { method: "POST", body: new URLSearchParams({ action: "confirm" }) }), { params: { id: b2.id } } as any)).text();
reset();
check("Отказ при писмото за решение: статусът е записан, страницата предупреждава", page.includes("не беше изпратен") && page.includes("Ще опитаме отново") && (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, b2.id)))[0].status === "confirmed", "");
await due(); await retryFn(); await due(); await retryFn();
check("…писмото за решение е изпратено веднъж при повторния опит", mail.sent.filter((m) => m.to === "test-lost@example.com" && /потвърдена/.test(m.subject)).length === 1, "");

// 9. Напомняния (customer-emails): неясен резултат не се повтаря
await t.q(`update bookings set start_date = (now() at time zone 'Europe/Sofia' + interval '20 hours')::date, start_time = to_char(now() at time zone 'Europe/Sofia' + interval '20 hours', 'HH24:MI'), end_date = (now() + interval '3 days')::date, decided_at = now() - interval '2 days' where id = $1`, [b2.id]);
mail.network = (m) => (m.to === "test-lost@example.com" ? "lost" : null);
await customerEmailsFn();
reset();
await t.q("update bookings set pickup_reminder_at = null where id=$1", [b2.id]); // дори колоната да се нулира
await customerEmailsFn();
const reminders = mail.sent.filter((m) => m.to === "test-lost@example.com" && /Утре/.test(m.subject)).length;
check("Напомняне с изгубен отговор не се праща второ копие", reminders === 1 && (await log(`pickup24:${b2.id}`)).status === "unknown", `напомняния: ${reminders}`);

// 10. Всички грешки и опити са в лога
const stat = (await t.q("select status, count(*)::int n from email_log group by 1 order by 1")).rows.map((x: any) => `${x.status}:${x.n}`).join(", ");
const noPlain = (await t.q("select count(*)::int n from email_log where recipient ~ '^[^*]+@' ")).rows[0].n;
check("Лог: всички състояния са видими, адресите са маскирани", /failed/.test(stat) && /unknown/.test(stat) && /sent/.test(stat) && noPlain === 0, stat);
await finish();
