// Решение по чакаща заявка (потвърждаване / отказ) от админ панела и от линка в имейла – обща сървърна логика;
// адрес по документа (област, община, град / село) във формата → сървъра → договора → писмото до фирмата.
// Само синтетични данни; имейлите и Netlify Identity се симулират (harness.ts). Не се свързва с реални данни.
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { bookingBody, check, contractData, cookieJar, fakeJwt, finish, freshDb, identity, mail, O, setContext, schema } from "./harness.ts";
import { stores } from "./stubs/blobs.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import adminBookingsFn from "../../netlify/functions/admin-bookings.mts";
import authFn from "../../netlify/functions/admin-auth.mts";
import availabilityFn from "../../netlify/functions/availability.mts";
import retryFn from "../../netlify/functions/email-retry.mts";
import { decide, sofiaNow } from "../../server/booking-actions.ts";
import { contractDataKey, saveContract } from "../../server/contracts.ts";
import { addressError, buildContract, docAddress, parseContract } from "../../contract/index.ts";

setContext("deploy-preview");
const t = await freshDb("decide");
t.use();
const call = (url: string, init: RequestInit = {}, id = "") => bookingsFn(new Request(url, init), { params: id ? { id } : {} } as any);
const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
const events = async (id: string) => (await t.q("select action, actor, details from booking_events where booking_id = $1 order by id", [id])).rows;
const decisionMails = (to: string) => mail.sent.filter((m) => m.to === to && /потвърдена|не може да бъде потвърдена/i.test(m.subject));
const busy = async (carId: string) => ((await (await availabilityFn()).json()).cars[carId] || []).map((p: string[]) => p.join(" "));
let k = 0;
async function request(d1: string, t1: string, d2: string, t2: string, extra: Record<string, unknown> = {}) {
  const n = "D" + ++k;
  const r = await call(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bookingBody(n, d1, t1, d2, t2, { requestKey: `decide-${n}-key`, ...extra })) });
  const j = await r.json();
  return { status: r.status, id: j.id as string, json: j };
}
// Стара чакаща заявка, записана директно (без дати или с минали дати)
async function oldPending(extra: Record<string, unknown> = {}) {
  const id = (++k).toString(16).padStart(32, "b");
  await t.db.insert(schema.bookings).values({
    id, viewToken: "1".repeat(64), adminToken: id + id, name: "ТЕСТ Стара " + k, email: `old-${k}@example.com`, phone: "0000", lang: "bg", car: "Ford Ka", carId: "ka",
    pickup: "по уговорка", dropoff: "по уговорка", total: "", payment: "", status: "pending", ...extra,
  });
  return id;
}
async function manage(id: string, fields?: Record<string, string>) {
  const b = await row(id);
  const url = `${O}/api/bookings/${id}/manage?key=${b.adminToken}`;
  const r = fields ? await call(url, { method: "POST", body: new URLSearchParams(fields) }, id) : await call(url, {}, id);
  return { status: r.status, html: await r.text() };
}

// ===== Админ: вход =====
identity.users.set("admin@example.com", { id: "1", email: "admin@example.com", password: "admin-pass-123", roles: ["admin"] });
identity.users.set("user@example.com", { id: "2", email: "user@example.com", password: "user-pass-123", roles: [] });
async function req(path: string, opt: { method?: string; body?: unknown; origin?: string | null; jar?: ReturnType<typeof cookieJar>; fn?: any } = {}) {
  const jar = opt.jar || cookieJar();
  setContext("deploy-preview", { cookies: jar, ip: "203.0.113.7" });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opt.origin !== null) headers.Origin = opt.origin ?? O;
  const id = path.split("?")[0].split("/")[4] || "";
  const r = await (opt.fn || adminBookingsFn)(new Request(O + path, { method: opt.method || "GET", headers, body: opt.body ? JSON.stringify(opt.body) : undefined }), { ip: "203.0.113.7", params: id ? { id } : {} } as any);
  setContext("deploy-preview");
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const adm = cookieJar();
await req("/api/admin/login", { fn: authFn, method: "POST", body: { email: "admin@example.com", password: "admin-pass-123" }, jar: adm });
// Потребител без роля не получава сесия при вход – валиден токен от Identity без роля "admin"
const usr = cookieJar(); const utok = fakeJwt("user@example.com"); identity.tokens.set(utok, "user@example.com"); usr.set({ name: "nf_jwt", value: utok });
const post = (id: string, body: unknown, o: { jar?: ReturnType<typeof cookieJar>; origin?: string | null } = {}) => req(`/api/admin/bookings/${id}`, { method: "POST", body, jar: o.jar ?? adm, origin: o.origin });

// ===== 1–6. Потвърждаване от админ панела =====
const A = (await request("2028-03-06", "10:00", "2028-03-08", "10:00")).id;
const aEmail = (await row(A)).email;
const pendingList = await req("/api/admin/bookings?status=pending", { jar: adm });
const det = await req(`/api/admin/bookings/${A}`, { jar: adm });
check("1. „Чакащи“: заявката е в списъка; подробностите разрешават потвърждаване и отказ", pendingList.json.rows.some((r: any) => r.id === A) && det.json.can.confirm === true && det.json.can.reject === true && det.json.can.block === "", JSON.stringify(det.json.can));
const nA = mail.sent.length;
const ok1 = await post(A, { action: "confirm", note: "ВЪТРЕШНО-потв-1", notify: true });
const a1 = await row(A);
check("2. потвърждаване с имейл: confirmed, решено от администратора, вътрешната бележка е записана", ok1.status === 200 && a1.status === "confirmed" && a1.decidedBy === "admin@example.com" && !!a1.decidedAt && a1.decisionNote === "ВЪТРЕШНО-потв-1" && a1.note === "" && ok1.json.email === "sent", `${ok1.status} ${a1.status}`);
const am = decisionMails(aEmail);
check("3. точно 1 писмо до клиента „потвърдена“, без вътрешната бележка", am.length === 1 && mail.sent.length === nA + 1 && /потвърдена/.test(am[0].subject) && !am[0].html.includes("ВЪТРЕШНО"), String(am.length));
check("4. потвърдената заявка заема автомобила", (await busy("passat")).some((p: string) => p.startsWith("2028-03-06")), "");
const evA = await events(A);
check("5. история: създадена → потвърдена от администратора (с имейл, без текста на бележката)", evA.map((e: any) => e.action).join() === "booking.created,booking.confirm" && evA[1].actor === "admin@example.com" && evA[1].details.notify === true && evA[1].details.hasNote === true && !JSON.stringify(evA).includes("ВЪТРЕШНО"), evA.map((e: any) => e.action).join());
const pays = (await t.q("select count(*)::int n from payments")).rows[0].n;
check("6. потвърждаването не създава плащания или възстановявания", pays === 0, String(pays));

// ===== 7–9. Повторно действие и действие от имейла след решение в панела =====
const again = await post(A, { action: "confirm", notify: true });
const rej = await post(A, { action: "reject", notify: true });
check("7. повторно „Потвърди“ и последващо „Откажи“ → 409 state, без промяна и без второ писмо", again.status === 409 && again.json.error === "state" && rej.status === 409 && rej.json.error === "state" && (await row(A)).status === "confirmed" && decisionMails(aEmail).length === 1, `${again.status}/${rej.status}`);
const viaMail = await manage(A, { action: "reject", note: "късно" });
check("8. „Откажи“ от стария линк в имейла не презаписва решението от панела", (await row(A)).status === "confirmed" && /вече е обработена/.test(viaMail.html) && decisionMails(aEmail).length === 1 && (await row(A)).decidedBy === "admin@example.com", "");
const viewAfter = await manage(A);
check("9. страницата от имейла не твърди, че клиентът е уведомен по имейл", /Клиентът вижда статуса на сайта/.test(viewAfter.html) && !/уведомен по имейл/.test(viewAfter.html), "");

// ===== 10–12. Отказ от админ панела, без имейл =====
const R = (await request("2028-03-13", "10:00", "2028-03-15", "10:00", { carId: "golf" })).id;
const rEmail = (await row(R)).email;
const nR = mail.sent.length;
const r1 = await post(R, { action: "reject", note: "ВЪТРЕШНО-отказ", notify: false });
const rr = await row(R);
check("10. отказ без имейл: rejected, решено от администратора, бележката не е съобщение до клиента", r1.status === 200 && rr.status === "rejected" && rr.decidedBy === "admin@example.com" && rr.decisionNote === "ВЪТРЕШНО-отказ" && rr.note === "" && r1.json.email === "none", rr.status);
check("11. без писмо до клиента и без запис за повторен опит", mail.sent.length === nR && decisionMails(rEmail).length === 0 && (await t.q("select count(*)::int n from email_log where dedupe_key = $1", [`customer-decision:${R}`])).rows[0].n === 0, "");
await retryFn();
check("12. email-retry не праща писмо за отказ без имейл; историята пази „без имейл“", decisionMails(rEmail).length === 0 && (await events(R))[1].details.notify === false, "");
const S = (await request("2028-03-20", "10:00", "2028-03-22", "10:00", { carId: "golf" })).id;
const sEmail = (await row(S)).email;
await post(S, { action: "reject", notify: true });
check("12a. отказ с имейл: 1 писмо „не може да бъде потвърдена“, без вътрешна бележка", decisionMails(sEmail).length === 1 && /не може да бъде потвърдена/.test(decisionMails(sEmail)[0].subject), "");
const C0 = (await request("2028-03-27", "10:00", "2028-03-29", "10:00", { carId: "ibiza" })).id;
const c0Email = (await row(C0)).email;
await post(C0, { action: "confirm", notify: false });
check("12b. потвърждаване без имейл: confirmed, без писмо", (await row(C0)).status === "confirmed" && decisionMails(c0Email).length === 0, "");

// ===== 13–15. Права и same-origin =====
const P = (await request("2028-04-03", "10:00", "2028-04-05", "10:00", { carId: "punto" })).id;
const noLogin = await post(P, { action: "confirm", notify: true }, { jar: cookieJar() });
const noRole = await post(P, { action: "confirm", notify: true }, { jar: usr });
const cross = await post(P, { action: "reject", notify: true }, { origin: "https://evil.example" });
const noOrigin = await post(P, { action: "reject", notify: true }, { origin: null });
check("13. без вход 401, без роля 403, чужд или липсващ Origin 403 – без промяна", noLogin.status === 401 && noRole.status === 403 && cross.status === 403 && noOrigin.status === 403 && (await row(P)).status === "pending", `${noLogin.status}/${noRole.status}/${cross.status}/${noOrigin.status}`);
const bad = await post(P, { action: "approve" });
check("14. непознато действие → 400", bad.status === 400 && (await row(P)).status === "pending", String(bad.status));
const det2 = await req(`/api/admin/bookings/${P}`, { jar: adm });
check("15. подробностите са без токените за достъп", !("adminToken" in det2.json.booking) && !JSON.stringify(det2.json).includes((await row(P)).adminToken), "");

// ===== 16–19. Застъпване, буфер и блокирани периоди =====
// Потвърдена резервация връща автомобила в 10:00; буферът е 60 минути
const X = (await request("2028-05-01", "10:00", "2028-05-03", "10:00", { carId: "ka" })).id;
await post(X, { action: "confirm", notify: false });
const inBuffer = (await request("2028-05-03", "10:30", "2028-05-04", "10:00", { carId: "ka" }));
check("16a. нова заявка в буфера след връщането → отказана още при изпращане (409)", inBuffer.status === 409, String(inBuffer.status));
// Заявка, записана преди потвърждаването на X (затова още не е била заета) – вече се застъпва
const Y = await oldPending({ carId: "ka", startDate: "2028-05-02", endDate: "2028-05-05", startTime: "10:00", endTime: "10:00" });
const y1 = await post(Y, { action: "confirm", notify: true });
check("16. застъпваща се заявка → 409 busy с информация за конфликта, остава pending, без писмо", y1.status === 409 && y1.json.error === "busy" && y1.json.can?.conflict?.id === X && (await row(Y)).status === "pending" && decisionMails((await row(Y)).email).length === 0, JSON.stringify(y1.json.error));
const Yb = await oldPending({ carId: "ka", startDate: "2028-05-03", endDate: "2028-05-04", startTime: "10:59", endTime: "10:00" });
const Yc = await oldPending({ carId: "ka", startDate: "2028-05-03", endDate: "2028-05-04", startTime: "11:00", endTime: "10:00" });
const yb = await post(Yb, { action: "confirm" });
const yc = await post(Yc, { action: "confirm" });
check("17. буфер 60 мин: получаване в 10:59 след връщане в 10:00 → busy; в 11:00 → потвърдена", yb.status === 409 && yb.json.error === "busy" && yc.status === 200 && (await row(Yc)).status === "confirmed", `${yb.status}/${yc.status}`);
await t.db.insert(schema.carBlocks).values({ carId: "punto", startDate: "2028-06-10", endDate: "2028-06-12", reason: "сервиз", createdBy: "test" });
const Z = await oldPending({ carId: "punto", startDate: "2028-06-12", endDate: "2028-06-14", startTime: "10:00", endTime: "10:00" });
const z1 = await post(Z, { action: "confirm" });
const viaMailBlocked = await manage(Z, { action: "confirm" });
check("18. блокиран период (сервиз) → потвърждаването е отказано в панела и от имейла", z1.status === 409 && z1.json.error === "busy" && z1.json.can?.conflict?.kind === "block" && /датите вече са заети/.test(viaMailBlocked.html) && (await row(Z)).status === "pending", JSON.stringify(z1.json.can?.conflict));
await t.q("update car_blocks set cancelled_at = now() where car_id = 'punto'");
const z2 = await post(Z, { action: "confirm" });
check("19. отменен блокиран период не пречи → потвърдена", z2.status === 200 && (await row(Z)).status === "confirmed", String(z2.status));
await t.q("update cars set status = 'inactive' where id = 'ibiza'");
const In = await oldPending({ carId: "ibiza", startDate: "2028-07-01", endDate: "2028-07-03", startTime: "10:00", endTime: "10:00" });
const in1 = await post(In, { action: "confirm" });
await t.q("update cars set status = 'active' where id = 'ibiza'");
check("19a. неактивен автомобил → 409 car_inactive", in1.status === 409 && in1.json.error === "car_inactive" && (await row(In)).status === "pending", in1.json.error);

// ===== 20–23. Едновременни действия =====
// Две застъпващи се заявки, потвърждавани едновременно – от панела и от имейла
const G1 = await oldPending({ carId: "golf", startDate: "2028-08-01", endDate: "2028-08-04", startTime: "10:00", endTime: "10:00" });
const G2 = await oldPending({ carId: "golf", startDate: "2028-08-03", endDate: "2028-08-06", startTime: "10:00", endTime: "10:00" });
const [g1, g2] = await Promise.all([post(G1, { action: "confirm", notify: true }), manage(G2, { action: "confirm" })]);
const s1 = (await row(G1)).status, s2 = (await row(G2)).status;
check("20. две застъпващи се заявки едновременно (панел + имейл) → потвърдена е само едната", [s1, s2].filter((x) => x === "confirmed").length === 1 && [s1, s2].filter((x) => x === "pending").length === 1, `${s1}/${s2} ${g1.status}`);
const many = await Promise.all([1, 2, 3, 4].map(() => oldPending({ carId: "punto", startDate: "2028-09-01", endDate: "2028-09-03", startTime: "10:00", endTime: "10:00" })));
const rs = await Promise.all(many.map((id) => decide(id, "confirm", { actor: "t", notify: false })));
check("21. 4 едновременни потвърждавания на един и същ период → 1 успешно, 3 busy", rs.filter((r) => r.ok).length === 1 && rs.filter((r) => !r.ok && r.error === "busy").length === 3, rs.map((r) => (r.ok ? "ok" : r.error)).join());
const H = (await request("2028-10-02", "10:00", "2028-10-04", "10:00", { carId: "passat" })).id;
const hEmail = (await row(H)).email;
const [h1, h2, h3] = await Promise.all([post(H, { action: "confirm", notify: true }), post(H, { action: "reject", notify: true }), manage(H, { action: "reject" })]);
const hRow = await row(H);
check("22. едновременни „Потвърди“ (панел), „Откажи“ (панел) и „Откажи“ (имейл) → едно решение, 1 писмо", ["confirmed", "rejected"].includes(hRow.status) && decisionMails(hEmail).length === 1 && [h1.status, h2.status].filter((s) => s === 200).length + (/(потвърдена|отказана)\. Клиентът получи имейл/.test(h3.html) ? 1 : 0) === 1, `${hRow.status} ${h1.status}/${h2.status}`);
const hEv = (await events(H)).filter((e: any) => /confirm|reject/.test(e.action));
check("23. в историята има точно едно решение", hEv.length === 1, String(hEv.length));

// ===== 24–27. Стари заявки: без дати и с минали дати =====
const N = await oldPending();
const nDet = await req(`/api/admin/bookings/${N}`, { jar: adm });
const n1 = await post(N, { action: "confirm" });
const nPage = await manage(N);
check("24. без дати: потвърждаването не е възможно – ясно съобщение в панела и в имейла", nDet.json.can.confirm === false && nDet.json.can.block === "no_dates" && n1.status === 409 && n1.json.error === "no_dates" && /няма записани дати/.test(nPage.html) && !/value="confirm"/.test(nPage.html) && /value="reject"/.test(nPage.html), nDet.json.can.block);
const n2 = await post(N, { action: "reject", notify: true });
check("25. стара заявка без дати може да бъде отказана", n2.status === 200 && (await row(N)).status === "rejected", String(n2.status));
const today = sofiaNow().slice(0, 10), past = new Date(Date.parse(today) - 3 * 864e5).toISOString().slice(0, 10), past2 = new Date(Date.parse(today) - 1 * 864e5).toISOString().slice(0, 10);
const E = await oldPending({ startDate: past, endDate: past2, startTime: "10:00", endTime: "10:00" });
const e1 = await post(E, { action: "confirm" });
const eMail = await manage(E, { action: "confirm" });
check("26. минал час за получаване: 409 expired в панела, съобщение в имейла, остава pending", e1.status === 409 && e1.json.error === "expired" && /вече е минал/.test(eMail.html) && (await row(E)).status === "pending", e1.json.error);
const e2 = await manage(E, { action: "reject", note: "" });
check("27. стара заявка с минали дати може да бъде отказана от имейла", (await row(E)).status === "rejected" && (await row(E)).decidedBy === "owner-link" && /Резервацията е отказана/.test(e2.html), (await row(E)).status);
const en = await call(`${O}/api/bookings/${N}/manage?key=${(await row(N)).adminToken}&lang=en`, {}, N);
const E2 = await oldPending();
const enPage = await (await call(`${O}/api/bookings/${E2}/manage?key=${(await row(E2)).adminToken}&lang=de`, {}, E2)).text();
check("27a. DE: съобщението за липсващи дати е преведено", /keine gespeicherten Abhol- und Rückgabedaten/.test(enPage) && en.status === 200, "");

// ===== 28. Пълна верига от имейла (потвърждаване) – все още работи =====
const F = (await request("2028-11-06", "10:00", "2028-11-08", "10:00", { carId: "ibiza" })).id;
const fOk = await manage(F, { action: "confirm", note: "Ще ви чакаме" });
const fRow = await row(F);
check("28. „Потвърди“ от имейла: confirmed, owner-link, съобщението до клиента е в писмото", fRow.status === "confirmed" && fRow.decidedBy === "owner-link" && /Резервацията е потвърдена\. Клиентът получи имейл\./.test(fOk.html) && decisionMails(fRow.email)[0]?.html.includes("Ще ви чакаме"), "");

// ===== 29–37. Адрес по документа =====
const contracts = () => stores.get("deploypreview-contracts")!;
const cdOf = (id: string) => JSON.parse(strFromU8(new Uint8Array(contracts().get(contractDataKey(id))!.data)));
const docXml = (id: string) => strFromU8(unzipSync(contracts().get(id)!.data)["word/document.xml"]);
const ownerMailOf = (name: string) => mail.sent.find((m) => /Нова заявка за наем/.test(m.subject) && m.subject.includes(name));
const withAddr = (a: Record<string, unknown>) => ({ ...contractData("2029-01-08", "10:00", "2029-01-10", "10:00"), ...a });
async function addrRequest(a: Record<string, unknown>, car = "passat") {
  const r = await request("2029-01-08", "10:00", "2029-01-10", "10:00", { carId: car, contract: withAddr(a) });
  return { ...r, name: `ТЕСТ D${k}` };
}
const v1 = await addrRequest({ citizen: "България", idt: "id", region: "Пловдив", municipality: "Марица", placeType: "village", city: "Труд", addr: "ул. Тестова 7" });
const vd = cdOf(v1.id);
check("29. село: заявката е приета, данните на договора пазят област, община и вида", v1.status === 201 && vd.region === "Пловдив" && vd.municipality === "Марица" && vd.placeType === "village" && vd.city === "Труд" && vd.addr === "ул. Тестова 7", JSON.stringify([vd.region, vd.placeType, vd.city]));
check("30. договор: „обл. Пловдив, общ. Марица, с. Труд, ул. Тестова 7“", docXml(v1.id).includes("обл. Пловдив, общ. Марица, с. Труд, ул. Тестова 7"), "");
// Етап 1 (защита на данните): адресът по документа вече НЕ е в известителното писмо – остава в договора (30) и в панела
const om = ownerMailOf(v1.name);
check("31. писмо до фирмата: без адреса по документа, договорът остава прикачен", !!om && !om.html.includes("Адрес по документа") && !om.html.includes("ул. Тестова 7") && om.attachments === 1, "");
const c1 = await addrRequest({ citizen: "BG", idt: "id", region: "обл. Пловдив", municipality: "община Пловдив", placeType: "city", city: "гр. Пловдив", addr: "бул. Тестов 1, вх. А, ап. 2" }, "golf");
check("32. град с написани представки: „гр.“, „обл.“ и „общ.“ не се дублират", c1.status === 201 && docXml(c1.id).includes("обл. Пловдив, общ. Пловдив, гр. Пловдив, бул. Тестов 1, вх. А, ап. 2") && !/гр\. гр\.|обл\. обл\.|общ\. общ\./.test(docXml(c1.id) + ownerMailOf(c1.name)!.html), "");
const f1 = await addrRequest({ citizen: "Germany", idt: "pass", region: "", municipality: "", placeType: "city", city: "München", addr: "Leopoldstraße 12" }, "ibiza");
check("33. чуждестранен адрес (паспорт, латиница, без област и община) се приема", f1.status === 201 && docXml(f1.id).includes("гр. München, Leopoldstraße 12") && !docXml(f1.id).includes("обл. ,"), String(f1.status));
const f2 = await addrRequest({ citizen: "Romania", idt: "id", region: "Județul Cluj", municipality: "", placeType: "village", city: "Florești", addr: "Strada Test 3" }, "punto");
check("33a. чужда лична карта: общината не е задължителна, „Județul Cluj“ се приема", f2.status === 201 && docXml(f2.id).includes("обл. Județul Cluj, с. Florești, Strada Test 3"), String(f2.status));
const noReg = await addrRequest({ citizen: "България", idt: "id", region: "", municipality: "Марица", placeType: "village", city: "Труд", addr: "ул. Тестова 7" }, "ka");
const noType = await addrRequest({ citizen: "BG", idt: "id", region: "Пловдив", municipality: "Марица", placeType: "town", city: "Труд", addr: "ул. Тестова 7" }, "ka");
const noCity = await addrRequest({ citizen: "BG", idt: "pass", placeType: "city", city: "", addr: "ул. Тестова 7" }, "ka");
check("34. сървърна проверка: българска лична карта без област, невалиден вид, без населено място → 400 address", noReg.status === 400 && noReg.json.error === "address" && noType.status === 400 && noCity.status === 400, `${noReg.status}/${noType.status}/${noCity.status}`);
check("34a. addressError: правилата (стара форма без placeType се приема)", addressError({ city: "Пловдив", addr: "x" }) === "" && addressError({ placeType: "city", citizen: "bg", idt: "id", city: "Пловдив", addr: "x" }) === "admin_areas" && addressError({ placeType: "city", citizen: "bg", idt: "pass", city: "Пловдив", addr: "x" }) === "", "");

// Стари заявки и договори – без вида на населеното място
const o1 = await addrRequest({ citizen: "BG", idt: "id", city: "Пловдив", addr: "ул. Стара 1" }, "ka");
const od = cdOf(o1.id);
check("35. стара страница (без placeType): приета, договорът е „Пловдив, ул. Стара 1“ без измислено „гр.“", o1.status === 201 && docXml(o1.id).includes("Пловдив, ул. Стара 1") && !docXml(o1.id).includes("гр. Пловдив, ул. Стара 1") && !("placeType" in od) && !("region" in od), String(o1.status));
// Запис на договор отпреди новите полета → поправка на километрите го генерира наново със същия адрес
const legacy = { ...parseContract(contractData("2029-01-08", "10:00", "2029-01-10", "10:00"), "ТЕСТ Стар договор", "ka")!, city: "с. Труд", addr: "ул. Стара 2" };
delete (legacy as any).region; delete (legacy as any).municipality; delete (legacy as any).placeType;
const L = await oldPending({ startDate: "2029-02-01", endDate: "2029-02-03", startTime: "10:00", endTime: "10:00" });
await saveContract(L, legacy as any, "customer", "Заявка от сайта");
const before = docXml(L);
await manage(L, { action: "km", kmDel: "9", kmDelRate: "1" });
const after = docXml(L);
check("36. стар договор: историческият адрес „с. Труд, ул. Стара 2“ не се променя при ново генериране", before.includes("с. Труд, ул. Стара 2") && after.includes("с. Труд, ул. Стара 2") && !after.includes("с. с.") && after.includes("9 км"), "");
check("37. docAddress: стари данни без вид → „град, адрес“; нови → с представки", docAddress({ city: "Пловдив", addr: "ул. 1" }) === "Пловдив, ул. 1" && docAddress({ region: "Пловдив", municipality: "Марица", placeType: "village", city: "Труд", addr: "ул. 1" }) === "обл. Пловдив, общ. Марица, с. Труд, ул. 1" && buildContract(parseContract(withAddr({ placeType: "city", city: "Sofia", addr: "a" }), "x", "ka")!).length > 1000, "");
const meta = mail.sent.filter((m) => /facebook|meta/i.test(m.to));
check("38. нищо не се изпраща към Meta от сървъра", meta.length === 0, "");

await finish();
