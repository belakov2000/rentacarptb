// Отделният публичен тестов сайт (rentacarptb-borica-test): контекст production на ДРУГ Netlify сайт, BORICA_FORCE_TEST=1,
// само BORICA_TEST_* (ключове, генерирани за теста), БЕЗ BREVO_API_KEY. Проверява, че целият двуетапен процес и платежната връзка
// минават през админ панела, без нито едно писмо към Brevo, и че се ползва само тестовият терминал / адрес на БОРИКА.
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { adminJar, bookingBody, check, contractData, finish, freshDb, http, mail, O, quoteFor, schema, setContext, syntheticJpeg } from "./harness.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import adminBookingsFn from "../../netlify/functions/admin-bookings.mts";
import adminCardFn from "../../netlify/functions/admin-card-payments.mts";
import documentsFn from "../../netlify/functions/documents.mts";
import payFn from "../../netlify/functions/pay.mts";
import retryFn from "../../netlify/functions/email-retry.mts";
import availabilityFn from "../../netlify/functions/availability.mts";
import { terminalConfig } from "../../server/card-pay.ts";
import { siteOrigin, statusView } from "../../server/stage.ts";

// Средата на тестовия сайт: без ключ за пощата и без разрешение за писма извън production (тук контекстът е production)
delete process.env.BREVO_API_KEY;
delete process.env.MAIL_OUTSIDE_PRODUCTION;
for (const k of Object.keys(process.env)) if (k.startsWith("BORICA_")) delete process.env[k];
const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const m = pair(), bk = pair();
Object.assign(process.env, { BORICA_FORCE_TEST: "1", BORICA_TEST_TERMINAL: "VTEST001", BORICA_TEST_MERCHANT: "0000000000", BORICA_TEST_CURRENCY: "EUR", BORICA_TEST_PRIVATE_KEY: m.privateKey, BORICA_TEST_BORICA_PUBLIC_KEY: bk.publicKey });
process.env.URL = O;
setContext("production");
const t = await freshDb("test_site");
t.use();
const outbound: string[] = [];
const prev = http.handler;
http.handler = async (url, init) => { if (/brevo|3dsgate/.test(url)) outbound.push(url); return prev ? prev(url, init) : null; };

const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
const jar = adminJar();
const admin = async (fn: any, path: string, body?: object) => {
  setContext("production", { cookies: jar, ip: "203.0.113.9" });
  const r = await fn(new Request(`${O}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json", Origin: O }, body: JSON.stringify(body) } : {}), { ip: "203.0.113.9", params: { id: path.split("/")[4]?.split("?")[0] } } as any);
  setContext("production");
  return { status: r.status, headers: r.headers, json: (await r.json().catch(() => ({}))) as any };
};
let k = 0;
const upload = async () => {
  const r = await documentsFn(new Request(`${O}/api/documents`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: syntheticJpeg() }), { params: {}, ip: `203.0.113.${60 + k++}` } as any);
  return String(((await r.json()) as any).url).split("/").pop()!;
};

const cfg: any = terminalConfig();
check("1. Тестов сайт (production + BORICA_FORCE_TEST=1): тестов терминал и тестов адрес на БОРИКА", cfg.ok && cfg.t.mode === "test" && cfg.t.gateway === "https://3dsgate-dev.borica.bg/cgi-bin/cgi_link");
check("2. Опцията за карта се показва във формата", (await (await availabilityFn()).json()).cardPayment === true);

// Кратка заявка с плащане с карта
const body: any = bookingBody("TSITE", "2029-05-04", "10:00", "2029-05-07", "10:00", { carId: "golf", car: "golf", payment: "card", requestKey: "test-site-key-1", flow: 2, drivers: { requesterDrives: true }, contract: contractData("2029-05-04", "10:00", "2029-05-07", "10:00") });
Object.assign(body, { emailConfirmation: body.email, termsAccepted: true, phone: "+359877000777", requester: { first: "ТЕСТ", middle: "Тестов", last: "Сайт", birthDate: "1990-01-01", phoneCountry: "BG", citizen: "България" } });
const q = await quoteFor(body);
const cr = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, quote: q.json.quote, quoteTotalCents: q.json.totalCents }) }), { params: {} } as any);
const cj: any = await cr.json();
check("3. Заявката е записана въпреки липсата на ключ за пощата (сайтът показва резервното известие)", cr.status === 201 && cj.notify === "failed", `${cr.status} ${JSON.stringify(cj).slice(0, 80)}`);
let b = await row(cj.id);

// Първо одобрение от админ панела (без да се разчита на имейла до собственика)
let a = await admin(adminBookingsFn, `/api/admin/bookings/${b.id}`, { action: "confirm", notify: true });
b = await row(b.id);
check("4. Първо одобрение от админ панела → етап „документи“", a.status === 200 && b.stage === "docs", `${a.status} ${b.stage}`);
const cv = await admin(adminBookingsFn, `/api/admin/bookings/${b.id}?view=customer`);
check("5. Админът отваря страницата на клиента за документите (връзката не идва по имейл)", cv.status === 303 && cv.headers.get("Location") === `${O}/?b=${b.id}&t=${b.viewToken}#blagodarim`);
const drv = { name: "ТЕСТ Тестов Сайт", citizen: "България", idt: "id", idn: "TEST0001", egn: "0000000000", idd: "2020-01-01", idp: "МВР ТЕСТ", region: "Пловдив", municipality: "Пловдив", placeType: "city", city: "Пловдив", addr: "ул. Тестова 1", dln: "DL0001", dld: "2021-02-02", dlp: "МВР ТЕСТ", photos: { idf: await upload(), idb: await upload(), dlf: await upload(), dlb: await upload() } };
const sd = await bookingsFn(new Request(`${O}/api/bookings/${b.id}/documents?t=${b.viewToken}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ drivers: [drv], documentsConsent: true }) }), { params: { id: b.id } } as any);
b = await row(b.id);
check("6. Документите са подадени → „очакват проверка“", sd.status === 200 && b.stage === "review", `${sd.status} ${b.stage}`);
a = await admin(adminBookingsFn, `/api/admin/bookings/${b.id}`, { action: "confirm", notify: true });
b = await row(b.id);
check("7. Окончателно потвърждение от админ панела", a.status === 200 && b.status === "confirmed" && b.stage === "done", `${a.status} ${b.status}`);
check("8. Страницата на клиента показва „Очаква плащане“", (statusView(b) as any).card?.state === "awaiting");

// Платежната връзка от админ панела
const sl = await admin(adminCardFn, `/api/admin/card-payments`, { bookingId: b.id, action: "send_link" });
const url = String(sl.json.url || "");
check("9. Админ: „Изпрати връзка“ показва връзката, писмото не е изпратено (няма ключ)", sl.status === 200 && /\/pay\/[a-f0-9]{32}\?k=[a-f0-9]{64}$/.test(url) && sl.json.email === "failed", `${sl.json.email}`);
check("9b. Връзката е към адреса на тестовия сайт (process.env.URL)", url.startsWith(siteOrigin() + "/pay/") && siteOrigin() === O);
const k2 = url.split("k=")[1];
const pg = await payFn(new Request(url), { params: { id: b.id } } as any);
const html = await pg.text();
check("10. Страницата за плащане работи с тестовия терминал (ТЕСТОВА СРЕДА)", pg.status === 200 && /ТЕСТОВА СРЕДА/.test(html) && /Сума за плащане с карта/.test(html));
const st = await payFn(new Request(`${O}/pay/${b.id}?k=${k2}`, { method: "POST", headers: { Origin: O }, body: new URLSearchParams({ cardholder: "Test Site", address: "Plovdiv, ul. Test 1" }) }), { params: { id: b.id } } as any);
const sh = await st.text();
check("11. Подписаният формуляр е към ТЕСТОВИЯ адрес на БОРИКА, терминал VTEST001", st.status === 200 && sh.includes('action="https://3dsgate-dev.borica.bg/cgi-bin/cgi_link"') && sh.includes('name="TERMINAL" value="VTEST001"') && !sh.includes("3dsgate.borica.bg/cgi"));

// Писма: нито едно не излиза; повторните опити също не изпращат
await t.q("update email_log set next_attempt_at = now() - interval '1 minute', at = at - interval '5 minutes'");
await retryFn();
const log = (await t.q("select kind, status, error from email_log")).rows as any[];
check("12. Нито едно писмо не е изпратено към Brevo (и след повторните опити)", mail.calls === 0 && mail.sent.length === 0 && !outbound.some((u) => u.includes("brevo")), `${mail.calls} заявки към Brevo`);
check("13. Писмата са записани като неуспешни с причина „BREVO_API_KEY is not set“ – без адреси в грешката", log.length >= 5 && log.every((r) => r.status !== "sent" && (r.status === "queued" || /BREVO_API_KEY is not set/.test(r.error))) && !log.some((r) => /@/.test(r.error)), log.map((r) => `${r.kind}:${r.status}`).join(", "));
check("14. Нито една заявка към БОРИКА от сървъра (статус се проверява само при отворен опит)", outbound.filter((u) => u.includes("3dsgate")).every((u) => u.startsWith("https://3dsgate-dev.")));

http.handler = prev;
await finish();
