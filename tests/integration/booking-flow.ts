// Процесът на резервация от край до край: всички първоначални проверки (25) + едновременни потвърждения,
// повторни заявки и откази при изпращане на имейли. Резултатите се сравняват с първоначалния отчет.
import { eq, sql } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { bookingBody, check, contractData, finish, freshDb, mail, O, setContext, schema, withQuote } from "./harness.ts";
import { stores } from "./stubs/blobs.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import retryFn from "../../netlify/functions/email-retry.mts";
import { BUFFER_MIN, minutes, overlaps } from "../../db/slots.ts";

setContext("deploy-preview");
const t = await freshDb("flow");
t.use();
const C = () => stores.get("deploypreview-contracts")!;
const call = (url: string, init: RequestInit = {}, id = "") => bookingsFn(new Request(url, init), { params: id ? { id } : {} } as any);
const create = async (body: any) => { const r = await call(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await withQuote(body)) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
const manage = async (id: string, action?: string, extra: Record<string, string> = {}) => {
  const b = await row(id);
  const url = `${O}/api/bookings/${id}/manage?key=${b.adminToken}`;
  const r = action ? await call(url, { method: "POST", body: new URLSearchParams({ action, ...extra }) }, id) : await call(url, {}, id);
  return { status: r.status, html: await r.text() };
};
const req = (s: string, d1: string, t1: string, d2: string, t2: string, withContract = false) =>
  bookingBody(s, d1, t1, d2, t2, { requestKey: `flow-${s}-key`, ...(withContract ? { contract: contractData(d1, t1, d2, t2) } : {}) });
const cnt = async () => (await t.q("select count(*)::int n from bookings")).rows[0].n;

// 1–4. Нова заявка, имейли, статус
let n0 = mail.sent.length;
const A = await create(req("A", "2027-03-01", "10:00", "2027-03-03", "10:00", true));
const a = await row(A.json.id);
// Сумата е сървърната: 2 дни × 25 € + доставка 5 км × 1,00 € (симулиран маршрут) = 55 €; „50 €“ от браузъра не се приема
check("1. Нова заявка се записва (със сървърната сума)", A.status === 201 && a.status === "pending" && a.total === "55 €" && a.totalCents === 5500 && a.priceCheckStatus === "server", `HTTP ${A.status}, total_cents ${a.totalCents}`);
const m = mail.sent.slice(n0);
check("2. Имейли при нова заявка (фирма с договор + клиент)", m.length === 2 && m[0].attachments === 1 && m[1].to === "test-a@example.com", m.map((x) => x.subject.slice(0, 30)).join(" | "));
const st = await call(`${O}/api/bookings/${a.id}?t=${a.viewToken}`, {}, a.id);
check("3. Страница за статус на клиента", st.status === 200 && (await st.json()).status === "pending", "");
check("4. Статус с грешен ключ се отказва", (await call(`${O}/api/bookings/${a.id}?t=${"0".repeat(64)}`, {}, a.id)).status === 404, "");
// 5–6. Договор
const c = await call(`${O}/api/bookings/${a.id}/contract?key=${a.adminToken}`, {}, a.id);
const doc = strFromU8(unzipSync(new Uint8Array(await c.arrayBuffer()))["word/document.xml"]);
check("5. Договор: генериране и отваряне", c.status === 200 && doc.includes("ТЕСТ A") && doc.includes("РВ8991XE"), "");
check("6. Договор с грешен ключ се отказва", (await call(`${O}/api/bookings/${a.id}/contract?key=${"0".repeat(64)}`, {}, a.id)).status === 404, "");
// 7–8. Страница за управление и версии на договора
const page = await manage(a.id);
check("7. Страница за управление (GET не променя нищо)", page.status === 200 && page.html.includes('value="confirm"') && (await row(a.id)).status === "pending", "");
await manage(a.id, "km", { kmDel: "12", kmDelRate: "1" });
const vers = (await t.q("select count(*)::int n from contract_versions where booking_id=$1", [a.id])).rows[0].n;
check("8. Договор: поправката на км пази стара версия (беше FAIL)", vers === 2 && [...C().keys()].filter((k) => k.startsWith(`versions/${a.id}/`)).length === 2, `версии: ${vers}`);
// 9–10. Конфликтни заявки и едновременно потвърждение
const B = await create(req("B", "2027-03-03", "10:30", "2027-03-05", "10:00"));
check("9. Конфликтна заявка се приема като чакаща, докато A не е потвърдена", B.status === 201, "");
n0 = mail.sent.length;
await Promise.all([manage(a.id, "confirm"), manage(B.json.id, "confirm")]);
const both = (await t.q("select count(*)::int n from bookings where car_id='passat' and status='confirmed'")).rows[0].n;
check("10. Едновременно потвърждение на две конфликтни резервации (беше FAIL)", both === 1 && mail.sent.length - n0 === 1, `потвърдени: ${both}, имейли: ${mail.sent.length - n0}`);
const winner = (await row(a.id)).status === "confirmed" ? a.id : B.json.id, loser = winner === a.id ? B.json.id : a.id;
// 11–12. Предупреждение и отказ на второто потвърждение
check("11. Предупреждение за заето на страницата на другата заявка", (await manage(loser)).html.includes("Внимание: автомобилът вече е потвърден"), "");
const second = await manage(loser, "confirm");
check("12. Конфликтната заявка не може да бъде потвърдена", second.html.includes("датите вече са заети") && (await row(loser)).status === "pending", "");
// Нататък по оригиналния сценарий A е потвърдената; ако B е спечелила, A и B се разменят само в тестовата база
if (winner !== a.id) { await t.q("update bookings set status='pending' where id=$1", [B.json.id]); await t.q("update bookings set status='confirmed' where id=$1", [a.id]); }
// 13–17. Буфер 60 минути
const D = await create(req("D", "2027-03-03", "10:59", "2027-03-04", "10:00"));
const E = await create(req("E", "2027-03-03", "11:00", "2027-03-04", "10:00"));
const F = await create(req("F", "2027-02-27", "10:00", "2027-03-01", "09:00"));
const G = await create(req("G", "2027-02-27", "10:00", "2027-03-01", "09:01"));
check("13. Буфер: получаване 59 мин след връщане – отказ", D.status === 409, `HTTP ${D.status}`);
check("14. Буфер: получаване точно 60 мин след връщане – разрешено", E.status === 201, `HTTP ${E.status}`);
check("15. Буфер: връщане точно 60 мин преди получаване – разрешено", F.status === 201, `HTTP ${F.status}`);
check("16. Буфер: връщане 59 мин преди получаване – отказ", G.status === 409, `HTTP ${G.status}`);
check("17. overlaps (db/slots.ts) с буфер 60", BUFFER_MIN === 60 && overlaps(minutes("2027-03-01", "10:00"), minutes("2027-03-03", "10:00"), minutes("2027-03-03", "10:59"), minutes("2027-03-04", "10:00")) && !overlaps(minutes("2027-03-01", "10:00"), minutes("2027-03-03", "10:00"), minutes("2027-03-03", "11:00"), minutes("2027-03-04", "10:00")), "");
// 18–20. Повторно натискане, отказ, клиентска страница
n0 = mail.sent.length;
const again = await manage(a.id, "confirm");
check("18. Повторно „Потвърди“ не праща втори имейл", again.html.includes("вече е обработена") && mail.sent.length === n0, "");
n0 = mail.sent.length;
await manage(E.json.id, "reject", { note: "тест" });
await manage(E.json.id, "reject", { note: "тест" });
check("19. Отказ: статус и един имейл до клиента", (await row(E.json.id)).status === "rejected" && mail.sent.length - n0 === 1, `имейли: ${mail.sent.length - n0}`);
const e = await row(E.json.id);
const st2 = await (await call(`${O}/api/bookings/${e.id}?t=${e.viewToken}`, {}, e.id)).json();
check("20. Клиентската страница показва отказа", st2.status === "rejected" && st2.note === "тест", JSON.stringify(st2));
// 21. Повторно изпращане (беше FAIL)
const c0 = await cnt();
const dup = req("H", "2027-05-01", "10:00", "2027-05-02", "10:00");
const hs = await Promise.all([create(dup), create(dup), create(dup)]);
check("21. Повторно изпращане на същата заявка не създава дубликат (беше FAIL)", (await cnt()) - c0 === 1 && new Set(hs.map((h) => h.json.id)).size === 1, `нови: ${(await cnt()) - c0}`);
// 22–23. Отказ на имейла до фирмата
const c1 = await cnt();
mail.fail = (x) => (x.to.startsWith("test-") ? null : "Brevo error 503");
const X = await create(req("X", "2027-06-01", "10:00", "2027-06-02", "10:00", true));
mail.fail = null;
check("22. Отказ на имейла до фирмата: заявката е записана и се опитва отново (ново поведение)", X.status === 201 && X.json.notify === "failed" && (await cnt()) === c1 + 1, `HTTP ${X.status}, notify=${X.json.notify}`);
check("23. Няма осиротял договор: договорът принадлежи на записана резервация (беше FAIL)", C().has(X.json.id) && !!(await row(X.json.id)), "");
// 24. Отказ на имейла до клиента при решение
const Y = await create(req("Y", "2027-07-01", "10:00", "2027-07-02", "10:00"));
mail.fail = (x) => (x.to === "test-y@example.com" ? "Brevo error 503" : null);
const ry = await manage(Y.json.id, "confirm");
mail.fail = null;
check("24. Отказ на имейла до клиента: решението е записано, фирмата е уведомена", (await row(Y.json.id)).status === "confirmed" && ry.html.includes("не беше изпратен"), "");
// 25. Лог на имейлите (беше FAIL)
const logged = (await t.q("select status, count(*)::int n from email_log group by 1")).rows.map((r: any) => `${r.status}:${r.n}`).join(", ");
check("25. Грешките в имейлите се записват в email_log (беше FAIL)", /failed/.test(logged) && /sent/.test(logged), logged);
// Допълнително: повторните опити довършват неизпратеното веднъж
await t.q("update email_log set next_attempt_at = now() - interval '1 minute', at = at - interval '5 minutes' where status in ('failed','queued')");
n0 = mail.sent.length;
await retryFn(); await retryFn();
const resent = mail.sent.slice(n0);
check("26. email-retry изпраща неизпратените веднъж (фирма за X, клиент за Y)", resent.filter((x) => x.subject.includes("ТЕСТ X")).length === 1 && resent.filter((x) => x.to === "test-y@example.com").length === 1, `писма: ${resent.length}`);
// Допълнително: стара страница без requestKey
const old = bookingBody("Old", "2027-08-01", "10:00", "2027-08-02", "10:00");
const c2 = await cnt();
await Promise.all([create(old), create(old)]);
check("27. Стара страница без ключ: двоен клик → 1 резервация", (await cnt()) - c2 === 1, "");
await finish();
