// Отмяна на потвърдена резервация, „Клиентът не се яви“ и предаване на автомобила – от линка в имейла и от админ панела.
// Само синтетични данни; имейлите и Netlify Identity се симулират (harness.ts).
import { eq } from "drizzle-orm";
import { bookingBody, check, cookieJar, fakeJwt, finish, freshDb, identity, mail, O, setContext, schema } from "./harness.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import availabilityFn from "../../netlify/functions/availability.mts";
import adminBookingsFn from "../../netlify/functions/admin-bookings.mts";
import authFn from "../../netlify/functions/admin-auth.mts";
import retryFn from "../../netlify/functions/email-retry.mts";
import { act, sofiaNow } from "../../server/booking-actions.ts";

setContext("deploy-preview");
const t = await freshDb("cancel");
t.use();
const call = (url: string, init: RequestInit = {}, id = "") => bookingsFn(new Request(url, init), { params: id ? { id } : {} } as any);
const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
let k = 0;
async function confirmed(d1: string, d2: string, carId = "passat", t1 = "10:00", t2 = "10:00") {
  const n = "C" + ++k;
  const r = await call(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bookingBody(n, d1, t1, d2, t2, { carId, requestKey: `cancel-${n}-key` })) });
  const { id } = await r.json();
  await manage(id, { action: "confirm" });
  return id as string;
}
// Потвърдена резервация, записана директно (напр. с час за получаване, който вече е минал)
async function inserted(d1: string, d2: string, extra: Record<string, unknown> = {}) {
  const id = (++k).toString(16).padStart(32, "e");
  await t.db.insert(schema.bookings).values({
    id, viewToken: "v".repeat(0) + id + id, adminToken: (id + id).replace(/e/g, "a"), name: "ТЕСТ Записана " + k, email: `stored-${k}@example.com`, phone: "0000",
    lang: "bg", car: "Ford Ka", carId: "ka", pickup: `${d1} 10:00`, dropoff: `${d2} 10:00`, total: "40 €", startDate: d1, endDate: d2, startTime: "10:00", endTime: "10:00",
    payment: "cash", status: "confirmed", decidedAt: new Date(), ...extra,
  });
  return id;
}
async function manage(id: string, fields?: Record<string, string>, key?: string) {
  const b = await row(id);
  const url = `${O}/api/bookings/${id}/manage?key=${key ?? b.adminToken}`;
  const r = fields ? await call(url, { method: "POST", body: new URLSearchParams(fields) }, id) : await call(url, {}, id);
  return { status: r.status, html: await r.text() };
}
const stepOf = (html: string) => /name="step" value="([a-f0-9]{64})"/.exec(html)?.[1] || "";
// Две стъпки: първата показва потвърждение, втората изпълнява
async function twoStep(id: string, f: Record<string, string>) {
  const first = await manage(id, f);
  const step = stepOf(first.html);
  const second = await manage(id, { ...f, step });
  return { first, second, step };
}
const busy = async (carId: string) => {
  const j = await (await availabilityFn()).json();
  return (j.cars[carId] || []).map((p: string[]) => p.join(" "));
};
const closedMails = (to: string) => mail.sent.filter((m) => m.to === to && /отменена|неявяване/i.test(m.subject));
const events = async (id: string) => (await t.q("select action, actor, details from booking_events where booking_id = $1 order by id", [id])).rows;

// ===== 1–9. Потвърждение → отмяна дни преди наема (от имейла) =====
const A = await confirmed("2027-06-01", "2027-06-03");
const a0 = await row(A);
check("1. потвърдена резервация блокира автомобила", a0.status === "confirmed" && (await busy("passat")).some((p: string) => p.startsWith("2027-06-01")), "");
const g = await manage(A);
check("2. страницата за управление показва статус и „Отмени резервацията“, неявяването още не е достъпно", g.status === 200 && /Потвърдена/.test(g.html) && /Отмени резервацията/.test(g.html) && /Достъпно след часа за получаване: 01\.06\.2027 10:00/.test(g.html) && !/value="no_show"/.test(g.html), "");
await manage(A); await manage(A);
check("3. отварянето на линка (GET) не променя статуса", (await row(A)).status === "confirmed", "");
const pre = await manage(A, { action: "cancel", reason: "customer", note: "ВЪТРЕШНО-тест-123", notify: "1" });
check("4. първа стъпка: въпрос „Да отменим ли…“ и ясно, че ще се изпрати имейл; без промяна", /Да отменим ли резервацията\? Автомобилът ще бъде освободен за нови резервации\./.test(pre.html) && /Ще бъде изпратен имейл до клиента \(te\*\*\*@example\.com\)/.test(pre.html) && (await row(A)).status === "confirmed", "");
const forged = await manage(A, { action: "cancel", reason: "customer", notify: "1", step: "0".repeat(64) });
check("5. подправен токен за стъпката → без промяна", (await row(A)).status === "confirmed" && /остарял/.test(forged.html), "");
const n0 = mail.sent.length;
const done = await manage(A, { action: "cancel", reason: "customer", note: "ВЪТРЕШНО-тест-123", notify: "1", step: stepOf(pre.html) });
const a1 = await row(A);
check("6. отмяна дни преди наема: статус, причина, време, извършител", a1.status === "cancelled" && a1.closeReason === "customer" && a1.closedBy === "owner-link" && !!a1.closedAt && a1.closeNote === "ВЪТРЕШНО-тест-123" && /Резервацията е отменена/.test(done.html), a1.status);
const cm = closedMails(a1.email);
check("7. точно 1 писмо до клиента: номер, автомобил, период, нов статус, без вътрешната бележка и без обещание за възстановяване",
  cm.length === 1 && mail.sent.length === n0 + 1 && cm[0].html.includes(A.slice(0, 6).toUpperCase()) && cm[0].html.includes("Volkswagen Passat") && cm[0].html.includes("2027-06-01 10:00") && cm[0].html.includes("Отменена") && !cm[0].html.includes("ВЪТРЕШНО") && !/възстанов|депозит/i.test(cm[0].html), `${cm.length}`);
check("8. автомобилът е освободен (наличност), записът остава", !(await busy("passat")).some((p: string) => p.startsWith("2027-06-01")) && !!(await row(A)), "");
const ev = await events(A);
check("9. история: създадена → потвърдена → отменена (без лични данни и без бележката)", ev.map((e: any) => e.action).join() === "booking.created,booking.confirm,booking.cancel" && ev[2].actor === "owner-link" && ev[2].details.reason === "customer" && !JSON.stringify(ev).includes("ВЪТРЕШНО"), ev.map((e: any) => e.action).join());

// ===== 10–13. Повторни действия, стар „Потвърди“, освободен период =====
const again = await manage(A, { action: "cancel", reason: "customer", notify: "1", step: stepOf(pre.html) });
check("10. повторно натискане на същия формуляр → без промяна и без второ писмо", closedMails(a1.email).length === 1 && (await row(A)).closedAt!.getTime() === a1.closedAt!.getTime() && /не е възможно/.test(again.html), "");
await manage(A, { action: "confirm" });
check("11. стар линк „Потвърди“ не възстановява отменена резервация", (await row(A)).status === "cancelled", (await row(A)).status);
const B = await confirmed("2027-06-01", "2027-06-03");
check("12. нова резервация за освободения период се потвърждава", (await row(B)).status === "confirmed", (await row(B)).status);
const nB = mail.sent.length;
const bNo = await twoStep(B, { action: "cancel", reason: "other", note: "", notify: "0" });
check("13. отмяна без известие: на потвърждението пише „Няма да бъде изпратен имейл“, писмо не се изпраща", /Няма да бъде изпратен имейл до клиента/.test(bNo.first.html) && (await row(B)).status === "cancelled" && (await row(B)).closeReason === "other" && mail.sent.length === nB && /Не е изпратен имейл/.test(bNo.second.html), "");

// ===== 14–18. Неявяване и отмяна след часа за получаване =====
const C = await confirmed("2027-07-01", "2027-07-03");
const early = await manage(C, { action: "no_show", notify: "1" });
check("14. „Клиентът не се яви“ преди часа за получаване → забранено", (await row(C)).status === "confirmed" && /достъпно едва след часа за получаване/.test(early.html), "");
const tooEarly = await act(C, "no_show", { actor: "test", notify: true, now: new Date("2027-07-01T06:59:00Z") }); // 09:59 лятно време
const onTime = await act(C, "no_show", { actor: "test", notify: false, now: new Date("2027-07-01T07:00:00Z") }); // 10:00 лятно време
check("15. граница по Europe/Sofia: 09:59 → отказ, 10:00 → неявяване", !tooEarly.ok && tooEarly.error === "too_early" && onTime.ok && (await row(C)).status === "no_show" && (await row(C)).closeReason === "no_show", "");
check("16. sofiaNow отчита лятното и зимното часово време", sofiaNow(new Date("2027-07-01T07:00:00Z")) === "2027-07-01 10:00" && sofiaNow(new Date("2027-01-15T08:00:00Z")) === "2027-01-15 10:00", "");
const today = sofiaNow().slice(0, 10), past = new Date(Date.parse(today) - 2 * 864e5).toISOString().slice(0, 10), later = new Date(Date.parse(today) + 3 * 864e5).toISOString().slice(0, 10);
const D = await inserted(past, later);
const dg = await manage(D);
check("17. часът за получаване е минал, автомобилът не е предаден: и двете действия са достъпни", /value="no_show"/.test(dg.html) && /value="cancel"/.test(dg.html), "");
const nD = mail.sent.length;
const dNo = await twoStep(D, { action: "no_show", note: "не вдига", notify: "1" });
const dRow = await row(D);
check("18. неявяване (от имейла) с известие: статус, писмо „Закрита – неявяване“, освободен автомобил", dRow.status === "no_show" && /Да отбележим ли, че клиентът не се яви/.test(dNo.first.html) && closedMails(dRow.email).length === 1 && mail.sent.length === nD + 1 && closedMails(dRow.email)[0].html.includes("неявяване") && !closedMails(dRow.email)[0].html.includes("не вдига") && !(await busy("ka")).some((p: string) => p.startsWith(past)), "");
const E = await inserted(past, later);
await twoStep(E, { action: "cancel", reason: "owner", notify: "0" });
check("19. отмяна след началния час, когато автомобилът не е предаден", (await row(E)).status === "cancelled" && (await row(E)).closeReason === "owner", "");

// ===== 20–23. Започнал наем (предаден автомобил) е защитен =====
const F = await inserted(past, later);
const fh = await twoStep(F, { action: "handover" });
const f1 = await row(F);
check("20. „Автомобилът е предаден“ на две стъпки: записани време и извършител, статусът остава потвърден", /Да отбележим ли, че автомобилът е предаден/.test(fh.first.html) && !!f1.handedOverAt && f1.handedOverBy === "owner-link" && f1.status === "confirmed", "");
const fc = await manage(F, { action: "cancel", reason: "customer", notify: "1" });
const fx = await act(F, "cancel", { actor: "t", reason: "customer", notify: true });
const fn = await act(F, "no_show", { actor: "t", notify: true });
check("21. започнал наем: отмяна и неявяване са отказани (страница и сървър)", (await row(F)).status === "confirmed" && /не е възможно/.test(fc.html) && !fx.ok && fx.error === "state" && !fn.ok && fn.error === "state", "");
check("22. страницата показва, че наемът е започнал, без бутони за отмяна", /Автомобилът е предаден/.test((await manage(F)).html) && !/value="cancel"/.test((await manage(F)).html), "");
check("23. започналият наем продължава да блокира автомобила", (await busy("ka")).some((p: string) => p.startsWith(past)), "");

// ===== 24–25. Едновременни действия =====
const G = await confirmed("2027-08-01", "2027-08-03", "golf");
const gEmail = (await row(G)).email;
const all = await Promise.all([1, 2, 3, 4, 5].map(() => act(G, "cancel", { actor: "t", reason: "customer", notify: true })));
check("24. 5 едновременни отмени → 1 успешна, 1 писмо", all.filter((r) => r.ok).length === 1 && closedMails(gEmail).length === 1 && (await row(G)).status === "cancelled", `успешни: ${all.filter((r) => r.ok).length}`);
const H = await confirmed("2027-08-10", "2027-08-12", "golf");
const mix = await Promise.all([act(H, "cancel", { actor: "t", reason: "owner", notify: false }), act(H, "handover", { actor: "t" })]);
const h1 = await row(H);
check("25. едновременни „отмени“ и „предаден“ → само едното, без смесено състояние", mix.filter((r) => r.ok).length === 1 && ((h1.status === "cancelled" && !h1.handedOverAt) || (h1.status === "confirmed" && !!h1.handedOverAt)), `${h1.status}/${!!h1.handedOverAt}`);

// ===== 26–29. Токени =====
const I = await confirmed("2027-09-01", "2027-09-03", "ibiza");
const iRow = await row(I);
const viewAsAdmin = await manage(I, { action: "cancel", reason: "customer", notify: "1" }, iRow.viewToken);
const invalid = await manage(I, undefined, "f".repeat(64));
check("26. клиентският токен и невалиден ключ не дават достъп до управлението", viewAsAdmin.status === 404 && invalid.status === 404 && (await row(I)).status === "confirmed", `${viewAsAdmin.status}/${invalid.status}`);
const st = await call(`${O}/api/bookings/${I}?t=${iRow.viewToken}`, { method: "POST" }, I);
check("27. клиентската страница за статус не приема действия", (await row(I)).status === "confirmed" && st.status !== 200 || (await row(I)).status === "confirmed", String(st.status));
const J = await inserted("2026-01-10", "2026-01-12");
const exp = await manage(J);
const expPost = await manage(J, { action: "cancel", reason: "customer", notify: "1", step: "0".repeat(64) });
check("28. изтекъл линк (30 дни след края): страница с вход в админ панела, без промяна", exp.status === 410 && /Линкът е изтекъл/.test(exp.html) && exp.html.includes(`/admin/bookings/${J}`) && expPost.status === 410 && (await row(J)).status === "confirmed", String(exp.status));
const ownerMail = mail.sent.find((m) => m.to !== iRow.email && m.subject.includes("ТЕСТ C" + k));
check("29. писмото до фирмата има бутон „Управление на резервацията“", mail.sent.some((m) => /Нова заявка за наем/.test(m.subject) && m.html.includes("Управление на резервацията")), ownerMail ? "" : "");

// ===== 30–36. Админ панел =====
identity.users.set("admin@example.com", { id: "1", email: "admin@example.com", password: "admin-pass-123", roles: ["admin"] });
identity.users.set("user@example.com", { id: "2", email: "user@example.com", password: "user-pass-123", roles: [] });
async function req(fn: any, path: string, opt: { method?: string; body?: unknown; origin?: string | null; jar?: ReturnType<typeof cookieJar> } = {}) {
  const jar = opt.jar || cookieJar();
  setContext("deploy-preview", { cookies: jar, ip: "203.0.113.9" });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opt.origin !== null) headers.Origin = opt.origin ?? O;
  const id = path.split("?")[0].split("/")[4] || "";
  const r = await fn(new Request(O + path, { method: opt.method || "GET", headers, body: opt.body ? JSON.stringify(opt.body) : undefined }), { ip: "203.0.113.9", params: id ? { id } : {} } as any);
  setContext("deploy-preview");
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const adm = cookieJar(); await req(authFn, "/api/admin/login", { method: "POST", body: { email: "admin@example.com", password: "admin-pass-123" }, jar: adm });
// Потребител без роля не получава сесия при вход – валиден токен от Identity без роля "admin"
const usr = cookieJar(); const utok = fakeJwt("user@example.com"); identity.tokens.set(utok, "user@example.com"); usr.set({ name: "nf_jwt", value: utok });
const list = await req(adminBookingsFn, "/api/admin/bookings?status=confirmed", { jar: adm });
check("30. админ: списък на потвърдените резервации (вкл. записани по-рано)", list.status === 200 && list.json.rows.some((r: any) => r.id === I) && list.json.rows.some((r: any) => r.id === J) && list.json.rows.every((r: any) => r.status === "confirmed"), String(list.json.rows?.length));
const det = await req(adminBookingsFn, `/api/admin/bookings/${J}`, { jar: adm });
check("31. админ: подробности без токените за достъп; управление и на резервация с изтекъл имейл линк", det.status === 200 && det.json.can.cancel === true && !("adminToken" in det.json.booking) && !("viewToken" in det.json.booking) && !JSON.stringify(det.json).includes((await row(J)).adminToken), "");
const noLogin = await req(adminBookingsFn, `/api/admin/bookings/${I}`, { method: "POST", body: { action: "cancel", reason: "customer" } });
const noRole = await req(adminBookingsFn, `/api/admin/bookings/${I}`, { method: "POST", body: { action: "cancel", reason: "customer" }, jar: usr });
const cross = await req(adminBookingsFn, `/api/admin/bookings/${I}`, { method: "POST", body: { action: "cancel", reason: "customer" }, jar: adm, origin: "https://evil.example" });
check("32. админ: без вход 401, без роля 403, чужд Origin 403 – без промяна", noLogin.status === 401 && noRole.status === 403 && cross.status === 403 && (await row(I)).status === "confirmed", `${noLogin.status}/${noRole.status}/${cross.status}`);
const admEarly = await req(adminBookingsFn, `/api/admin/bookings/${I}`, { method: "POST", body: { action: "no_show", notify: true }, jar: adm });
check("33. админ: неявяване преди часа → 409 too_early", admEarly.status === 409 && admEarly.json.error === "too_early", String(admEarly.status));
const nI = mail.sent.length;
const admCancel = await req(adminBookingsFn, `/api/admin/bookings/${J}`, { method: "POST", body: { action: "cancel", reason: "owner", note: "админ бележка", notify: true }, jar: adm });
const jRow = await row(J);
check("34. админ: отмяна → извършител е имейлът на администратора, 1 писмо, история", admCancel.status === 200 && jRow.status === "cancelled" && jRow.closedBy === "admin@example.com" && mail.sent.length === nI + 1 && admCancel.json.events.some((e: any) => e.action === "booking.cancel" && e.actor === "admin@example.com"), `${admCancel.status} ${jRow.closedBy}`);
const admAgain = await req(adminBookingsFn, `/api/admin/bookings/${J}`, { method: "POST", body: { action: "cancel", reason: "owner", notify: true }, jar: adm });
check("35. админ: повторно → 409, без второ писмо", admAgain.status === 409 && mail.sent.length === nI + 1, String(admAgain.status));
const badReason = await req(adminBookingsFn, `/api/admin/bookings/${I}`, { method: "POST", body: { action: "cancel", reason: "x" }, jar: adm });
check("36. админ: невалидна причина → 400", badReason.status === 400 && (await row(I)).status === "confirmed", String(badReason.status));

// ===== 37–38. Неуспешно писмо → един повторен опит =====
const K = await confirmed("2027-10-01", "2027-10-03", "ibiza");
const kEmail = (await row(K)).email;
mail.fail = (m) => (m.to === kEmail ? "temporary" : null);
const kr = await act(K, "cancel", { actor: "t", reason: "customer", notify: true });
mail.fail = null;
check("37. писмото не мина: отмяната е записана, писмото чака повторен опит", kr.ok && kr.email === "queued" && (await row(K)).status === "cancelled" && closedMails(kEmail).length === 0, "");
await t.q("update email_log set next_attempt_at = now() - interval '1 minute' where dedupe_key = $1", [`customer-closed:${K}`]);
await retryFn(); await retryFn();
check("38. email-retry изпраща писмото точно веднъж", closedMails(kEmail).length === 1, String(closedMails(kEmail).length));

// ===== 39–42. EN / DE на страницата за управление =====
const L = await confirmed("2027-11-02", "2027-11-04", "punto");
const lRow = await row(L);
const leftover = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, "\n").split("\n").map((x) => x.trim())
  .filter((x) => /[А-я]/.test(x) && ![lRow.name, lRow.car, lRow.pickup, lRow.dropoff, lRow.total].some((d) => x.includes(d)));
for (const lang of ["en", "de"]) {
  const pg = await manage(L, undefined, lRow.adminToken + "&lang=" + lang);
  check(`39. ${lang.toUpperCase()}: страницата за управление е преведена (без български извън данните)`, pg.status === 200 && pg.html.includes(`<html lang="${lang}">`) && leftover(pg.html).length === 0 && pg.html.includes(lang === "en" ? "Cancel booking" : "Buchung stornieren"), leftover(pg.html).slice(0, 3).join(" | "));
}
const enAsk = await call(`${O}/api/bookings/${L}/manage?key=${lRow.adminToken}&lang=en`, { method: "POST", body: new URLSearchParams({ action: "cancel", reason: "owner", notify: "1" }) }, L);
const enHtml = await enAsk.text();
check("40. EN: потвърждението на английски, „Назад“ пази езика", /Cancel the booking\? The car will be released for new bookings\./.test(enHtml) && /An email will be sent to the customer/.test(enHtml) && enHtml.includes("&amp;lang=en") && leftover(enHtml).length === 0, leftover(enHtml).slice(0, 3).join(" | "));
const deDone = await call(`${O}/api/bookings/${L}/manage?key=${lRow.adminToken}&lang=de`, { method: "POST", body: new URLSearchParams({ action: "cancel", reason: "owner", notify: "0", step: stepOf(enHtml) }) }, L);
const deHtml = await deDone.text();
check("41. DE: резултатът след отмяна на немски, статусът е обновен", (await row(L)).status === "cancelled" && /Die Buchung wurde storniert\. Das Fahrzeug ist für neue Buchungen freigegeben\./.test(deHtml) && /Storniert/.test(deHtml) && leftover(deHtml).length === 0, leftover(deHtml).slice(0, 3).join(" | "));
const bg = await manage(L);
check("42. BG остава по подразбиране, превключвателят пази ключа", bg.html.includes('<html lang="bg">') && /Резервацията е отменена/.test(bg.html) && bg.html.includes(`key=${lRow.adminToken}&amp;lang=en`), "");

// ===== 43. Цялата верига от линка в писмото до фирмата =====
{
  const body = bookingBody("FLOW", "2027-12-06", "10:00", "2027-12-08", "10:00", { carId: "golf", requestKey: "cancel-flow-key-1" });
  const r = await call(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const { id } = await r.json();
  const owner = mail.sent.find((m) => /Нова заявка за наем/.test(m.subject) && m.subject.includes("ТЕСТ FLOW"));
  const link = owner && [...owner.html.matchAll(/href="([^"]+)"[^>]*>Управление на резервацията</g)].map((x) => x[1].replace(/&amp;/g, "&"))[0];
  const path = link ? new URL(link).pathname + new URL(link).search : "";
  const open = (init: RequestInit = {}) => call(O + path, init, id);
  const step1 = await (await open({ method: "POST", body: new URLSearchParams({ action: "confirm" }) })).text();
  const afterConfirm = (await (await availabilityFn()).json()).cars.golf?.some((p: string[]) => p[0] === "2027-12-06");
  const view = await (await open()).text();
  const ask = await (await open({ method: "POST", body: new URLSearchParams({ action: "cancel", reason: "customer", notify: "1" }) })).text();
  const done = await (await open({ method: "POST", body: new URLSearchParams({ action: "cancel", reason: "customer", notify: "1", step: stepOf(ask) }) })).text();
  const cust = closedMails("test-flow@example.com");
  const afterCancel = (await (await availabilityFn()).json()).cars.golf?.some((p: string[]) => p[0] === "2027-12-06");
  check("43. заявка → писмо до фирмата → „Потвърди“ → „Управление“ от същото писмо → отмяна → писмо до клиента → свободен автомобил",
    r.status === 201 && !!link && /Резервацията е потвърдена/.test(step1) && afterConfirm === true && /Отмени резервацията/.test(view) && /Да отменим ли/.test(ask) &&
    /Резервацията е отменена/.test(done) && cust.length === 1 && !afterCancel && (await row(id)).status === "cancelled",
    `линк ${link ? "има" : "няма"}, заето след потвърждение ${afterConfirm}, писма до клиента ${cust.length}, заето след отмяна ${!!afterCancel}`);
}

await finish();
