// Плащане с карта онлайн (БОРИКА): конфигурация по среди, сума и отстъпка, защитени връзки, подпис и проверки на отговора,
// дублирани и едновременни отговори, отказ, прекъснато плащане, проверка за статус, достъп до админ действията и писмата.
// „БОРИКА“ тук е симулирана: отговорите се подписват с ключ, генериран само за теста. Не се свързва с реалния платежен сървър.
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { adminJar, check, finish, freshDb, http, mail, O, schema, setContext } from "./harness.ts";
import { loadPrivateKey, loadPublicKey, MAC_REQUEST, MAC_RESPONSE, macString, signMac, verifyMac } from "../../server/borica.ts";
import { applyResult, breakdown, cardAvailable, terminalConfig } from "../../server/card-pay.ts";
import { breakdownRows } from "../../mail/card.ts";
import { decide } from "../../server/booking-actions.ts";
import { statusView } from "../../server/stage.ts";
import payFn from "../../netlify/functions/pay.mts";
import backrefFn from "../../netlify/functions/borica-backref.mts";
import cardStatusFn from "../../netlify/functions/card-status.mts";
import adminCardFn from "../../netlify/functions/admin-card-payments.mts";
import adminPaymentsFn from "../../netlify/functions/admin-payments.mts";
import availabilityFn from "../../netlify/functions/availability.mts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import retryFn from "../../netlify/functions/email-retry.mts";

setContext("deploy-preview");
const t = await freshDb("card_payment");
t.use();

// ===== Ключове само за теста =====
const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const merchantTest = pair(), merchantLive = pair(), boricaTest = pair(), boricaLive = pair(), attacker = pair();
const TEST_ENV = { BORICA_TEST_TERMINAL: "V6200750", BORICA_TEST_MERCHANT: "9200203803", BORICA_TEST_CURRENCY: "EUR", BORICA_TEST_PRIVATE_KEY: merchantTest.privateKey.replace(/\n/g, "\\n"), BORICA_TEST_BORICA_PUBLIC_KEY: Buffer.from(boricaTest.publicKey).toString("base64") };
const LIVE_ENV = { BORICA_LIVE_TERMINAL: "V9999999", BORICA_LIVE_MERCHANT: "9200203803", BORICA_LIVE_CURRENCY: "EUR", BORICA_LIVE_PRIVATE_KEY: merchantLive.privateKey, BORICA_LIVE_BORICA_PUBLIC_KEY: boricaLive.publicKey };
const ALL = [...Object.keys(TEST_ENV), ...Object.keys(LIVE_ENV), "BORICA_LIVE_ENABLED", "BORICA_TEST_PRIVATE_KEY_PASSPHRASE", "BORICA_FORCE_TEST"];
const env = (o: Record<string, string>) => { for (const k of ALL) delete process.env[k]; Object.assign(process.env, o); };

// ===== Симулиран сървър на БОРИКА за „Проверка за статус“ (TRTYPE=90) =====
const bank = { calls: 0, reply: null as null | ((req: URLSearchParams) => Record<string, string> | "down") };
const prevHandler = http.handler;
http.handler = async (url, init) => {
  if (url.startsWith("https://3dsgate")) {
    bank.calls++;
    if (!url.startsWith("https://3dsgate-dev.borica.bg/")) throw new Error("live gateway called from a test environment");
    const req = new URLSearchParams(String(init.body));
    const r = bank.reply?.(req);
    if (!r || r === "down") throw new TypeError("fetch failed");
    return Response.json(r);
  }
  return prevHandler ? prevHandler(url, init) : null;
};
const sign = (f: Record<string, string>, key = boricaTest.privateKey) => ({ ...f, P_SIGN: signMac(macString(MAC_RESPONSE, f), loadPrivateKey(key)!) });
const respFor = (form: Record<string, string>, o: Record<string, string> = {}, key?: string) =>
  sign({ ACTION: "0", RC: "00", APPROVAL: "S12345", TERMINAL: form.TERMINAL, TRTYPE: "1", AMOUNT: form.AMOUNT, CURRENCY: form.CURRENCY, ORDER: form.ORDER, RRN: "612345678901", INT_REF: "97E2F39EFCA1CAF1", PARES_STATUS: "Y", ECI: "05", TIMESTAMP: "20261112102530", TRAN_DATE: "20261112122530", NONCE: form.NONCE, STATUSMSG: "Approved", CARD_BRAND: "VISA", ...o }, key);

// ===== Резервации =====
const rnd = () => crypto.randomUUID().replace(/-/g, "");
const LINES = [{ code: "rent", cents: 7500, qty: 3, unitCents: 2500 }, { code: "seats", cents: 900, qty: 3, unitCents: 300 }, { code: "delivery", cents: 500, km: 5, rate: 1 }];
let n = 0;
async function booking(o: Record<string, unknown> = {}, lines: any[] = LINES) {
  n++;
  const total = lines.reduce((s, l) => s + l.cents, 0);
  const d1 = `2029-0${(n % 9) + 1}-10`, d2 = `2029-0${(n % 9) + 1}-13`;
  const [b] = await t.db.insert(schema.bookings).values({
    id: rnd(), viewToken: rnd() + rnd(), adminToken: rnd() + rnd(), status: "confirmed", stage: "done", name: `ТЕСТ Карта ${n}`, email: `card${n}@example.com`, phone: "+359000000000", lang: "bg",
    car: "Volkswagen Golf", carId: "golf", startDate: d1, endDate: d2, startTime: "10:00", endTime: "10:00", pickup: `${d1} 10:00`, dropoff: `${d2} 10:00`, payment: "card",
    total: (total / 100).toFixed(2).replace(".", ",") + " €", totalCents: total, totalReview: "", priceCheckStatus: "server", priceCheck: { server: { days: 3, lines, totalCents: total, depositCents: 10000 } }, ...o,
  }).returning();
  return b;
}
const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
const attempts = async (id: string) => t.db.select().from(schema.cardPayments).where(eq(schema.cardPayments.bookingId, id));
const pays = async (id: string) => t.db.select().from(schema.payments).where(eq(schema.payments.bookingId, id));
const page = async (id: string, k: string, form?: Record<string, string>, origin: string | null = O) => {
  const r = await payFn(new Request(`${O}/pay/${id}?k=${k}`, form ? { method: "POST", headers: origin ? { Origin: origin } : {}, body: new URLSearchParams(form) } : {}), { params: { id } } as any);
  return { status: r.status, html: await r.text(), headers: r.headers };
};
const fieldsIn = (html: string) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")]));
const backref = async (f: Record<string, string>) => {
  const r = await backrefFn(new Request(`${O}/api/payments/borica/backref`, { method: "POST", body: new URLSearchParams(f) }));
  return { status: r.status, html: await r.text() };
};
const tokenFrom = (html: string) => /\/pay\/([a-f0-9]{32})\?k=([a-f0-9]{64})/.exec(html)?.slice(1) as [string, string] | undefined;
const HOLDER = { cardholder: "Ivan Ivanov", address: "Plovdiv, bul. Dunav 10" };
const lastMail = (re: RegExp) => mail.sent.filter((m) => re.test(m.subject)).at(-1);
const mailsTo = (to: string, re: RegExp) => mail.sent.filter((m) => m.to === to && re.test(m.subject)).length;

// ===== 1. Конфигурация по среди =====
env({});
check("1.1 Без настройки: плащането с карта е недостъпно, /api/availability не показва опцията", !cardAvailable() && (await (await availabilityFn()).json()).cardPayment === false, String(terminalConfig().ok ? "" : terminalConfig().reason));
env({ ...LIVE_ENV, BORICA_LIVE_ENABLED: "1" });
check("1.2 Preview с настроени САМО реални ключове: недостъпно – BORICA_LIVE_* не се четат извън production", !cardAvailable());
env({ ...TEST_ENV, ...LIVE_ENV, BORICA_LIVE_ENABLED: "1" });
let cfg: any = terminalConfig();
check("1.3 Preview: тестовият терминал и тестовият адрес на БОРИКА", cfg.ok && cfg.t.mode === "test" && cfg.t.terminal === "V6200750" && cfg.t.gateway === "https://3dsgate-dev.borica.bg/cgi-bin/cgi_link");
setContext("production");
env({ ...TEST_ENV });
check("1.4 Production само с тестови ключове: недостъпно (тестовите не се ползват в production)", !cardAvailable());
env({ ...TEST_ENV, ...LIVE_ENV });
check("1.5 Production без BORICA_LIVE_ENABLED=1: недостъпно (реалните плащания не са включени)", !cardAvailable() && (terminalConfig() as any).reason === "disabled");
env({ ...TEST_ENV, ...LIVE_ENV, BORICA_LIVE_ENABLED: "1" });
cfg = terminalConfig();
check("1.6 Production с BORICA_LIVE_ENABLED=1: реалният терминал и адрес", cfg.ok && cfg.t.mode === "live" && cfg.t.terminal === "V9999999" && cfg.t.gateway === "https://3dsgate.borica.bg/cgi-bin/cgi_link");
env({ ...TEST_ENV, ...LIVE_ENV, BORICA_LIVE_ENABLED: "1", BORICA_FORCE_TEST: "1" });
cfg = terminalConfig();
check("1.6b Отделен тестов сайт (production + BORICA_FORCE_TEST=1): само тестовият терминал и адрес, реалните ключове не се ползват", cfg.ok && cfg.t.mode === "test" && cfg.t.terminal === "V6200750" && cfg.t.gateway.startsWith("https://3dsgate-dev."));
delete process.env.BORICA_FORCE_TEST;
setContext("unknown-context");
check("1.7 Неизвестна среда: недостъпно", !cardAvailable());
setContext("deploy-preview");
env({ ...TEST_ENV, BORICA_TEST_CURRENCY: "BGN" });
check("1.8 Терминал в друга валута (BGN): недостъпно – сумите не се преобразуват", !cardAvailable() && (terminalConfig() as any).reason === "currency");
env({ ...TEST_ENV, BORICA_TEST_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----" });
check("1.9 Невалиден частен ключ: недостъпно", !cardAvailable() && (terminalConfig() as any).reason === "key");
const enc = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "only-for-tests" } });
env({ ...TEST_ENV, BORICA_TEST_PRIVATE_KEY: enc.privateKey, BORICA_TEST_PRIVATE_KEY_PASSPHRASE: "only-for-tests" });
check("1.10 Частен ключ с парола от BORICA_TEST_PRIVATE_KEY_PASSPHRASE", cardAvailable());
env({ ...TEST_ENV, BORICA_TEST_TERMINAL: "" });
check("1.11 Липсващ терминал: недостъпно", !cardAvailable() && (terminalConfig() as any).reason === "missing");

// ===== 2. Без настройки: заявката с карта се отказва ясно; връзката показва недостъпност; нищо не е платено =====
env({});
const reqBody = { name: "ТЕСТ", email: "nocard@example.com", phone: "+359877000777", lang: "bg", car: "golf", carId: "golf", startDate: "2029-10-01", endDate: "2029-10-03", startTime: "10:00", endTime: "10:00", payment: "card", pickup: "x", dropoff: "y", message: "ТЕСТ", flow: 2 };
let r: any = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) }), { params: {} } as any);
check("2.1 Заявка с „Плащане с карта“ без настройки → 409 card_unavailable с ясно съобщение", r.status === 409 && (await r.json()).error === "card_unavailable");

// ===== 3. Окончателно потвърждение → защитена връзка по имейл =====
env({ ...TEST_ENV, ...LIVE_ENV, BORICA_LIVE_ENABLED: "1" });
const A = await booking({ status: "pending", stage: null });
const dr = await decide(A.id, "confirm", { actor: "owner-link", notify: true });
const linkMail = lastMail(/Връзка за плащане с карта/);
const tk = linkMail && tokenFrom(linkMail.html);
check("3.1 След потвърждението клиентът получава писмо с връзка за плащане за тази резервация", dr.ok && !!linkMail && linkMail.to === A.email && !!tk && tk[0] === A.id, linkMail?.subject);
check("3.2 Писмото: наем 75 €, отстъпка −7,50 €, услуги без отстъпка, 81,50 € за плащане и отделен депозит 100 €",
  !!linkMail && /75,00 €/.test(linkMail.html) && /−7,50 €/.test(linkMail.html) && /81,50 €/.test(linkMail.html) && /без отстъпка/.test(linkMail.html) && /депозит от 100 € не е включен/.test(linkMail.html));
const [, TOK] = tk || ["", ""];
const links0 = await t.db.select().from(schema.cardPaymentLinks).where(eq(schema.cardPaymentLinks.bookingId, A.id));
check("3.3 В базата е само хешът на ключа от връзката, със срок 48 ч.", links0.length === 1 && links0[0].tokenHash !== TOK && /^[a-f0-9]{64}$/.test(links0[0].tokenHash) && Math.abs(links0[0].expiresAt.getTime() - Date.now() - 48 * 3600_000) < 60_000 && !!links0[0].sentAt);
const decisionMail = lastMail(/потвърдена/);
check("3.4 Писмото за потвърждение споменава отделната връзка за плащане с карта", !!decisionMail && /С карта онлайн – 10% отстъпка от наема/.test(decisionMail.html) && /защитена връзка/.test(decisionMail.html));
check("3.5 Страницата на клиента показва „Очаква плащане“", (statusView(await row(A.id)) as any).card?.state === "awaiting");

// ===== 4. Достъп до връзката =====
let p = await page(A.id, TOK);
check("4.1 Валидна връзка: разбивка, сума 81,50 €, депозитът не е включен, тестов банер, без Referer", p.status === 200 && /Наем: 3 дни × 25,00 €/.test(p.html) && /81,50 €/.test(p.html) && /не е включен в онлайн плащането/.test(p.html) && /ТЕСТОВА СРЕДА/.test(p.html) && p.headers.get("Referrer-Policy") === "same-origin" && /noindex/.test(p.headers.get("X-Robots-Tag") || ""));
check("4.2 Грешен ключ → 410", (await page(A.id, "a".repeat(64))).status === 410);
const B = await booking();
check("4.3 Ключ от друга резервация → 410", (await page(B.id, TOK)).status === 410);
check("4.4 Невалиден формат → 410", (await page(A.id, "x")).status === 410 && (await page("zz", TOK)).status === 410);
await t.q("update card_payment_links set expires_at = now() - interval '1 minute' where booking_id = $1", [A.id]);
check("4.5 Изтекла връзка → 410", (await page(A.id, TOK)).status === 410);
await t.q("update card_payment_links set expires_at = now() + interval '1 day' where booking_id = $1", [A.id]);
check("4.6 GET не създава опит за плащане", (await attempts(A.id)).length === 0);

// ===== 5. Начало на плащане =====
p = await page(A.id, TOK, HOLDER, null);
check("5.1 POST без Origin (CSRF) → 403, без опит", p.status === 403 && (await attempts(A.id)).length === 0);
let xs = await payFn(new Request(`${O}/pay/${A.id}?k=${TOK}`, { method: "POST", headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" }, body: new URLSearchParams(HOLDER) }), { params: { id: A.id } } as any);
check("5.1b Origin: null от чужд сайт (Sec-Fetch-Site: cross-site) → 403", xs.status === 403 && (await attempts(A.id)).length === 0);
xs = await payFn(new Request(`${O}/pay/${A.id}?k=${TOK}`, { method: "POST", headers: { Origin: "https://evil.example" }, body: new URLSearchParams(HOLDER) }), { params: { id: A.id } } as any);
check("5.1c Origin от друг сайт → 403", xs.status === 403 && (await attempts(A.id)).length === 0);
p = await page(A.id, TOK, { cardholder: "Иван Иванов", address: "Пловдив" });
check("5.2 Име на кирилица → формулярът с грешка, без опит", p.status === 200 && /на латиница/.test(p.html) && (await attempts(A.id)).length === 0);
p = await page(A.id, TOK, { ...HOLDER, amount: "0.01", AMOUNT: "0.01" } as any);
const F = fieldsIn(p.html);
const merchantPub = loadPublicKey(merchantTest.publicKey)!;
check("5.3 Подписан формуляр към тестовия адрес на БОРИКА: терминал V6200750, MID 9200203803, 81.50 EUR (сумата от браузъра се игнорира)",
  p.status === 200 && p.html.includes('action="https://3dsgate-dev.borica.bg/cgi-bin/cgi_link"') && F.TERMINAL === "V6200750" && F.MERCHANT === "9200203803" && F.AMOUNT === "81.50" && F.CURRENCY === "EUR" && F.TRTYPE === "1" && /^\d{6}$/.test(F.ORDER), JSON.stringify({ T: F.TERMINAL, A: F.AMOUNT }));
check("5.4 P_SIGN е валиден подпис с тестовия частен ключ (не с реалния)", verifyMac(macString(MAC_REQUEST["1"], F), F.P_SIGN, merchantPub) && !verifyMac(macString(MAC_REQUEST["1"], F), F.P_SIGN, loadPublicKey(merchantLive.publicKey)!));
check("5.5 M_INFO: име на латиница, имейл и адрес; AD.CUST_BOR_ORDER_ID = ORDER + номер на резервацията",
  JSON.parse(Buffer.from(F.M_INFO, "base64").toString()).cardholderName === "IVAN IVANOV" && F["AD.CUST_BOR_ORDER_ID"] === `${F.ORDER}PTB${A.id.slice(0, 6).toUpperCase()}`);
check("5.6 Формулярът не съдържа частния ключ", !p.html.includes("PRIVATE KEY") && !p.html.includes(merchantTest.privateKey.split("\n")[1]));
let at = await attempts(A.id);
check("5.7 Записан е един опит: redirected, 8150 цента, EUR, тестов режим", at.length === 1 && at[0].status === "redirected" && at[0].amountCents === 8150 && at[0].currency === "EUR" && at[0].mode === "test" && at[0].nonce === F.NONCE);
bank.reply = (q) => sign({ ACTION: "3", RC: "-40", TERMINAL: "V6200750", TRTYPE: "90", ORDER: q.get("ORDER")!, TRAN_TRTYPE: "1", CURRENCY: "USD", TIMESTAMP: "20261112102000", NONCE: q.get("NONCE")! });
p = await page(A.id, TOK, HOLDER);
check("5.8 Повторно натискане, докато плащането е в процес → „Има започнато плащане“, без втори опит", p.status === 409 && /Има започнато плащане/.test(p.html) && (await attempts(A.id)).length === 1);
const par = await Promise.all(Array.from({ length: 5 }, () => page(A.id, TOK, HOLDER)));
check("5.9 5 едновременни натискания → пак един опит", par.every((x) => x.status === 409) && (await attempts(A.id)).length === 1);
check("5.10 Връщане на сайта без отговор от банката не е плащане", !(await row(A.id)).cardPaidAt && (await pays(A.id)).length === 0);

// ===== 6. Отговори на BACKREF, които НЕ трябва да отбелязват плащане =====
let br = await backref(respFor(F, {}, attacker.privateKey));
check("6.1 Подпис с чужд ключ → отказ, без плащане", br.status === 400 && !(await row(A.id)).cardPaidAt);
br = await backref({ ...respFor(F), AMOUNT: "1.00" });
check("6.2 Променена сума след подписа → невалиден подпис, без плащане", br.status === 400 && !(await row(A.id)).cardPaidAt);
br = await backref(respFor(F, { AMOUNT: "1.00" }));
check("6.3 Подписан отговор с друга сума → не се записва (amount_mismatch)", br.status === 200 && !(await row(A.id)).cardPaidAt && (await t.q("select 1 from booking_events where action='card.amount_mismatch'")).rows.length === 1);
br = await backref(respFor(F, { CURRENCY: "BGN" }));
check("6.4 Подписан отговор с друга валута → без плащане", !(await row(A.id)).cardPaidAt);
br = await backref(respFor(F, { TERMINAL: "V0000001" }));
check("6.5 Друг терминал → отказ", br.status === 400 && !(await row(A.id)).cardPaidAt);
br = await backref(respFor(F, { NONCE: "0".repeat(32) }));
check("6.6 Друг NONCE → отказ", br.status === 400 && !(await row(A.id)).cardPaidAt);
br = await backref(respFor(F, { ORDER: F.ORDER === "000001" ? "000002" : "000001" }));
check("6.7 Непозната поръчка → отказ", br.status === 400 && !(await row(A.id)).cardPaidAt);
br = await backref(respFor(F, { TRTYPE: "12" }));
check("6.8 Друг тип трансакция → отказ", br.status === 400 && !(await row(A.id)).cardPaidAt);
br = await backref(respFor(F, { ACTION: "1", RC: "00" }));
check("6.9 ACTION 1 (дублирана) с RC 00 не е плащане", !(await row(A.id)).cardPaidAt && /още не е потвърден/.test(br.html));
br = await backref(respFor(F, { ACTION: "3", RC: "-19", STATUSMSG: "Authentication failed" }));
check("6.10 Отрицателен RC → „не е потвърден“, опитът остава отворен", /още не е потвърден/.test(br.html) && (await attempts(A.id))[0].status === "redirected");
env({});
br = await backref(respFor(F));
check("6.11 Отговор при липсваща конфигурация → 503, без плащане (не се отбелязва като платено)", br.status === 503 && !(await row(A.id)).cardPaidAt);
env({ ...TEST_ENV });
check("6.12 Нито един от горните отговори не е създал плащане или писмо за плащане", (await pays(A.id)).length === 0 && mailsTo(A.email, /Потвърждение за плащане/) === 0);

// ===== 7. Успешно плащане и повторни известия =====
const okResp = respFor(F, { CARDHOLDERINFO: "Info from issuer" });
br = await backref(okResp);
const a1 = await row(A.id);
at = await attempts(A.id);
check("7.1 Проверен успешен отговор → „Плащането е успешно“; CARDHOLDERINFO е показано", br.status === 200 && /Плащането е успешно/.test(br.html) && /Info from issuer/.test(br.html));
check("7.2 Резервацията е платена; статусът остава „потвърдена“; договорената сума е 81,50 € с ред за отстъпката",
  !!a1.cardPaidAt && a1.cardPaymentId === at[0].id && a1.status === "confirmed" && a1.totalCents === 8150 && a1.total === "81,50 €" && (a1.priceCheck as any).server.lines.some((l: any) => l.code === "card_discount" && l.cents === -750));
const P1 = await pays(A.id);
check("7.3 Плащането е в „Плащания“: получено, с карта, 8150, RRN", P1.length === 1 && P1[0].status === "received" && P1[0].method === "card" && P1[0].amountCents === 8150 && P1[0].txnId === "612345678901" && /ТЕСТ/.test(P1[0].note));
const cm = lastMail(/Потвърждение за плащане с карта/);
check("7.4 Имейл до клиента: номер, автомобил, дати, разбивка, платена сума, валута, дата и референция, депозит, „не е фактура“",
  !!cm && cm.to === A.email && cm.html.includes(A.id.slice(0, 6).toUpperCase()) && /Volkswagen Golf/.test(cm.html) && cm.html.includes(A.pickup) && cm.html.includes(A.dropoff) && /−7,50 €/.test(cm.html) && /81,50 €/.test(cm.html) && />EUR</.test(cm.html)
  && /12\.11\.2026 12:25:30/.test(cm.html) && /612345678901/.test(cm.html) && /S12345/.test(cm.html) && /депозит от 100 € не е включен/.test(cm.html) && /не е фактура, касов бон или банков документ/.test(cm.html) && /\+359877748693/.test(cm.html));
const om = lastMail(/Платено с карта/);
check("7.5 Известие до собственика с [ТЕСТ], сумата и връзка към панела", !!om && /\[ТЕСТ\]/.test(om.subject) && /81,50 €/.test(om.subject) && /admin\/bookings\//.test(om.html));
check("7.6 Писмото до клиента не обещава нови условия за анулиране или възстановяване", !!cm && !/анулир|възстанов|refund|cancel/i.test(cm.html));
const sentBefore = mail.sent.length;
br = await backref(okResp);
await Promise.all(Array.from({ length: 5 }, () => backref(okResp)));
check("7.7 Повторни и едновременни известия: едно плащане, без нови писма", br.status === 200 && (await pays(A.id)).length === 1 && mail.sent.length === sentBefore && mailsTo(A.email, /Потвърждение за плащане/) === 1);
p = await page(A.id, TOK);
check("7.8 Връзката след плащане показва потвърждението, без нов формуляр", p.status === 200 && /Плащането вече е получено/.test(p.html) && !/<form/.test(p.html));
p = await page(A.id, TOK, HOLDER);
check("7.9 POST след плащане не създава нов опит", (await attempts(A.id)).length === 1 && /вече е получено/.test(p.html));
check("7.10 Страницата на клиента: „Платено“", (statusView(await row(A.id)) as any).card?.state === "paid");

// ===== 8. RENTY10 и 10% за карта не се комбинират =====
const R10 = await booking({}, [...LINES, { code: "discount", cents: -750 }]);
const bdR = breakdown(R10)!;
check("8.1 С RENTY10: отстъпка за карта 0, сумата е сумата по резервацията (8150), услугите – без отстъпка", bdR.renty10Cents === 750 && bdR.cardDiscountCents === 0 && bdR.payCents === 8150 && bdR.extrasCents === 1400);
check("8.2 Разбивката обяснява, че отстъпките не се комбинират", breakdownRows(bdR, "bg").some((x) => /не се комбинират/.test(x[2])) && breakdownRows(bdR, "en").some((x) => /not combined/.test(x[2])) && breakdownRows(bdR, "de").some((x) => /nicht kombiniert/.test(x[2])));
const bdA = breakdown(B)!;
check("8.3 Без RENTY10: 10% само от наема (750), не от доставката и столчетата", bdA.cardDiscountCents === 750 && bdA.payCents === 8900 - 750 && bdA.depositCents === 10000);
const odd = await booking({}, [{ code: "rent", cents: 2333, qty: 1, unitCents: 2333 }]);
check("8.4 Закръгляне до цент: 10% от 23,33 € = 2,33 €", breakdown(odd)!.cardDiscountCents === 233 && breakdown(odd)!.payCents === 2100);
const manual = await booking({ totalCents: 9999 });
check("8.5 Сума, различна от сървърната разбивка (ръчна промяна / удължаване) → без автоматично плащане", breakdown(manual) === null);
const legacy = await booking({ priceCheckStatus: "match" });
check("8.6 Стара резервация без сървърна цена → без автоматично плащане", breakdown(legacy) === null);

// ===== 9. Отказ, прекъснато плащане и проверка за статус =====
const C = await booking();
const jar = adminJar();
const adminCall = async (method: string, body?: object, query = "", origin: string | null = O, j = jar) => {
  setContext("deploy-preview", { cookies: j, ip: "203.0.113.9" });
  const res = await adminCardFn(new Request(`${O}/api/admin/card-payments${query}`, method === "POST" ? { method, headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) } : {}), {} as any);
  setContext("deploy-preview");
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};
let ar = await adminCall("POST", { bookingId: C.id, action: "send_link" });
const ctk = tokenFrom(ar.json.url || "")!;
check("9.1 Админ: „Изпрати връзка“ → нова връзка и писмо до клиента", ar.status === 200 && !!ctk && mailsTo(C.email, /Връзка за плащане/) === 1);
p = await page(C.id, ctk[1], HOLDER);
const FC = fieldsIn(p.html);
br = await backref(respFor(FC, { ACTION: "2", RC: "05", STATUSMSG: "Do not Honour", APPROVAL: "" }));
check("9.2 Отказ от издателя (ACTION 2, RC 05) → „Плащането е отказано“, без плащане", /Плащането е отказано/.test(br.html) && (await attempts(C.id))[0].status === "declined" && !(await row(C.id)).cardPaidAt && (await pays(C.id)).length === 0);
p = await page(C.id, ctk[1], HOLDER);
const FC2 = fieldsIn(p.html);
check("9.3 След окончателен отказ е възможен нов опит с нов ORDER и NONCE", p.status === 200 && !!FC2.ORDER && FC2.ORDER !== FC.ORDER && FC2.NONCE !== FC.NONCE && (await attempts(C.id)).length === 2);
// Клиентът затваря браузъра: BACKREF не идва. Проверка за статус – първо „в процес“, после успех
bank.reply = (q) => sign({ ACTION: "3", RC: "-40", STATUSMSG: "Client side transaction form in progress", TERMINAL: "V6200750", TRTYPE: "90", ORDER: q.get("ORDER")!, TRAN_TRTYPE: "1", CURRENCY: "USD", TIMESTAMP: "20261112102000", NONCE: q.get("NONCE")! });
await t.q("update card_payments set created_at = now() - interval '3 minutes' where order_no = $1", [FC2.ORDER]);
const callsBefore = bank.calls;
await cardStatusFn();
check("9.4 Планирана проверка: RC -40 в рамките на 16 мин. → остава отворен", bank.calls === callsBefore + 1 && (await attempts(C.id)).find((x: any) => x.orderNo === FC2.ORDER)!.status === "redirected");
let lastReq: URLSearchParams | null = null;
bank.reply = (q) => { lastReq = q; return sign({ ACTION: "0", RC: "00", APPROVAL: "S77777", TERMINAL: "V6200750", TRTYPE: "90", TRAN_TRTYPE: "1", AMOUNT: FC2.AMOUNT, CURRENCY: "EUR", ORDER: q.get("ORDER")!, RRN: "699999999999", INT_REF: "AAAABBBBCCCCDDDD", TIMESTAMP: "20261112103000", TRAN_DATE: "20261112123000", NONCE: q.get("NONCE")! }); };
await t.q("update card_payments set last_check_at = now() - interval '10 minutes' where order_no = $1", [FC2.ORDER]);
await cardStatusFn();
const sreq = lastReq as URLSearchParams | null;
check("9.5 Заявката за статус: TRTYPE 90, TRAN_TRTYPE 1, подписана с тестовия ключ",
  !!sreq && sreq.get("TRTYPE") === "90" && sreq.get("TRAN_TRTYPE") === "1" && sreq.get("TERMINAL") === "V6200750" && verifyMac(macString(MAC_REQUEST["90"], Object.fromEntries(sreq)), sreq.get("P_SIGN")!, merchantPub));
check("9.6 Липсващ BACKREF: плащането е потвърдено от проверката за статус (подписан отговор); писма веднъж", !!(await row(C.id)).cardPaidAt && (await pays(C.id)).length === 1 && mailsTo(C.email, /Потвърждение за плащане/) === 1);
br = await backref(respFor(FC2, { APPROVAL: "S77777", RRN: "699999999999" }));
check("9.7 Късен BACKREF след проверката: без второ плащане и без второ писмо", (await pays(C.id)).length === 1 && mailsTo(C.email, /Потвърждение за плащане/) === 1);

// Прекъснато плащане: след 16 мин. RC -40 е окончателен неуспех
const D = await booking();
ar = await adminCall("POST", { bookingId: D.id, action: "send_link" });
const dtk = tokenFrom(ar.json.url)!;
const FD = fieldsIn((await page(D.id, dtk[1], HOLDER)).html);
bank.reply = (q) => sign({ ACTION: "3", RC: "-40", TERMINAL: "V6200750", TRTYPE: "90", ORDER: q.get("ORDER")!, TRAN_TRTYPE: "1", CURRENCY: "USD", TIMESTAMP: "20261112102000", NONCE: q.get("NONCE")! });
await t.q("update card_payments set created_at = now() - interval '17 minutes' where order_no = $1", [FD.ORDER]);
ar = await adminCall("POST", { bookingId: D.id, action: "check" });
check("9.8 Проверка за статус след 16 мин. с RC -40 → неуспешно (окончателно), без плащане", ar.status === 200 && ar.json.results[0] === "failed" && !(await row(D.id)).cardPaidAt);
p = await page(D.id, dtk[1]);
check("9.9 След неуспех клиентът може да опита отново", p.status === 200 && /<form method="post"/.test(p.html));
// ===== 9b. Само RC -40 след GUARDTIME е доказан неуспех (стр. 18); други кодове след 16 мин. → неизвестен, без нов опит =====
const strict = async (reply: (q: URLSearchParams) => Record<string, string>, ageMin: number) => {
  const X = await booking();
  const xr = await adminCall("POST", { bookingId: X.id, action: "send_link" });
  const xt = tokenFrom(xr.json.url)!;
  const FX = fieldsIn((await page(X.id, xt[1], HOLDER)).html);
  bank.reply = (q) => sign({ TERMINAL: "V6200750", TRTYPE: "90", ORDER: q.get("ORDER")!, TRAN_TRTYPE: "1", CURRENCY: "USD", TIMESTAMP: "20261112102000", NONCE: q.get("NONCE")!, ...reply(q) });
  await t.q("update card_payments set created_at = now() - make_interval(mins => $2) where order_no = $1", [FX.ORDER, ageMin]);
  const res = await adminCall("POST", { bookingId: X.id, action: "check" });
  return { X, xt, FX, result: res.json.results[0], page: await page(X.id, xt[1]), row: await row(X.id) };
};
let s1 = await strict(() => ({ ACTION: "3", RC: "-40" }), 10);
check("9b.1 RC -40 в рамките на GUARDTIME → остава отворен, без нов опит", s1.result === "pending" && s1.page.status === 409 && /Има започнато плащане/.test(s1.page.html) && !/възможен след \d/.test(s1.page.html));
for (const [rc, act] of [["-31", "3"], ["-33", "3"], ["-24", "3"], ["00", "1"], ["65", "21"], ["05", "3"], ["-20", "3"], ["-19", "2"], ["-24", "2"]]) {
  const before = mail.sent.filter((m) => /Неизвестен резултат/.test(m.subject)).length;
  s1 = await strict(() => ({ ACTION: act, RC: rc }), 17);
  check(`9b.2 ACTION ${act} / RC ${rc} след 16 мин. → „неизвестен“: не е платено, нов опит НЕ е разрешен, собственикът е известен`,
    s1.result === "unknown" && !s1.row.cardPaidAt && s1.page.status === 409 && /Не плащайте отново/.test(s1.page.html) && mail.sent.filter((m) => /Неизвестен резултат/.test(m.subject)).length === before + 1
    && (await page(s1.X.id, s1.xt[1], HOLDER)).status === 409 && (await attempts(s1.X.id)).length === 1, s1.result);
}
s1 = await strict(() => ({ ACTION: "2", RC: "05" }), 17);
check("9b.3 ACTION 2 / RC 05 (отказ от издателя) → окончателен отказ, нов опит разрешен", s1.result === "declined" && s1.page.status === 200 && /<form method="post"/.test(s1.page.html));
// Ръчно освобождаване на неизвестен опит
s1 = await strict(() => ({ ACTION: "3", RC: "-24" }), 17);
const ua = (await attempts(s1.X.id))[0];
check("9b.4 Освобождаване без изрично потвърждение → отказ", (await adminCall("POST", { bookingId: s1.X.id, action: "release", attemptId: ua.id, note: "x" })).status === 400);
check("9b.5 Освобождаване от потребител без роля admin → 403", (await adminCall("POST", { bookingId: s1.X.id, action: "release", attemptId: ua.id, confirm: "merchant-portal-not-successful", note: "провер." }, "", O, adminJar("u2@example.com", []))).status === 403);
const rel = await adminCall("POST", { bookingId: s1.X.id, action: "release", attemptId: ua.id, confirm: "merchant-portal-not-successful", note: "Няма трансакция в Merchant Portal" });
check("9b.6 Администратор освобождава след проверка → неуспешен (ръчно), нов опит е разрешен, без плащане",
  rel.status === 200 && (await attempts(s1.X.id))[0].status === "failed" && (await attempts(s1.X.id))[0].resultSource === "manual" && (await page(s1.X.id, s1.xt[1])).status === 200 && !(await row(s1.X.id)).cardPaidAt);
check("9b.7 Повторно освобождаване на вече освободен опит → 409", (await adminCall("POST", { bookingId: s1.X.id, action: "release", attemptId: ua.id, confirm: "merchant-portal-not-successful", note: "още веднъж" })).status === 409);

// ===== 9c. „Назад“ на страницата на БОРИКА: ACTION 3 / RC -25 „Transaction Cancelled by Cardholder“ =====
{
  const X = await booking();
  const xt = tokenFrom((await adminCall("POST", { bookingId: X.id, action: "send_link" })).json.url)!;
  const FX = fieldsIn((await page(X.id, xt[1], HOLDER)).html);
  const cancel = { ACTION: "3", RC: "-25", APPROVAL: "", RRN: "", INT_REF: "", PARES_STATUS: "", ECI: "", STATUSMSG: "Transaction Cancelled by Cardholder" };
  // Банката отговаря на проверката за статус със същия код (както при теста на тестовия сайт)
  bank.reply = (q) => sign({ ACTION: "3", RC: "-25", STATUSMSG: "Transaction form state was cancelled by user", TERMINAL: "V6200750", TRTYPE: "90", ORDER: q.get("ORDER")!, TRAN_TRTYPE: "1", CURRENCY: "EUR", AMOUNT: FX.AMOUNT, TIMESTAMP: "20261113214500", NONCE: q.get("NONCE")! });
  let br2 = await backref(respFor(FX, cancel));
  let at2 = (await attempts(X.id))[0];
  check("9c.1 BACKREF с RC -25 (подписан): „Плащането е прекъснато. Окончателният резултат още се проверява.“, опитът остава отворен в рамките на GUARDTIME",
    br2.status === 200 && /Плащането е прекъснато\. Окончателният резултат още се проверява\./.test(br2.html) && !/нищо не е платено/.test(br2.html) && /след \d/.test(br2.html) && at2.status === "redirected" && at2.rc === "-25" && !(await row(X.id)).cardPaidAt);
  let px = await page(X.id, xt[1]);
  check("9c.1b Страницата на връзката (bg) – същият текст, без „нищо не е платено“", /Окончателният резултат още се проверява/.test(px.html) && !/нищо не е платено/.test(px.html));
  for (const [lang, re] of [["en", /The payment was interrupted\. The final result is still being checked\./], ["de", /Die Zahlung wurde abgebrochen\. Das endgültige Ergebnis wird noch geprüft\./]] as const) {
    await t.q("update bookings set lang = $2 where id = $1", [X.id, lang]);
    const lp = await page(X.id, xt[1]);
    const lb = await backref(respFor(FX, cancel));
    check(`9c.1c Текстът през първите 16 мин. на ${lang}: прекъснато, резултатът още се проверява; нов опит е блокиран`, lp.status === 409 && re.test(lp.html) && re.test(lb.html) && !/<form method="post"/.test(lp.html) && !/nothing has been paid|nichts bezahlt/.test(lp.html + lb.html));
  }
  await t.q("update bookings set lang = 'bg' where id = $1", [X.id]);
  check("9c.2 Връзката преди 16 мин.: „прекъснато“, нов опит НЕ е разрешен (документът: след „Назад“ може да стане успешна)", px.status === 409 && /Плащането е прекъснато/.test(px.html) && !/<form method="post"/.test(px.html));
  px = await page(X.id, xt[1], HOLDER);
  check("9c.3 POST преди 16 мин. не създава втори опит", px.status === 409 && (await attempts(X.id)).length === 1);
  // Проверка за статус в рамките на 16 мин. със същия код – остава отворен
  bank.reply = (q) => sign({ ACTION: "3", RC: "-25", STATUSMSG: "Transaction form state was cancelled by user", TERMINAL: "V6200750", TRTYPE: "90", ORDER: q.get("ORDER")!, TRAN_TRTYPE: "1", CURRENCY: "EUR", AMOUNT: FX.AMOUNT, TIMESTAMP: "20261113214500", NONCE: q.get("NONCE")! });
  await t.q("update card_payments set created_at = now() - interval '5 minutes' where order_no = $1", [FX.ORDER]);
  let ck = await adminCall("POST", { bookingId: X.id, action: "check" });
  check("9c.4 Проверка за статус с RC -25 след 5 мин. → още отворен", ck.json.results[0] === "pending" && (await attempts(X.id))[0].status === "redirected");
  // След GUARDTIME + 1 мин. – окончателно прекратен
  await t.q("update card_payments set created_at = now() - interval '17 minutes', last_check_at = null where order_no = $1", [FX.ORDER]);
  px = await page(X.id, xt[1]);
  at2 = (await attempts(X.id))[0];
  check("9c.5 Проверка за статус с RC -25 след 16 мин. → „прекратено“ (окончателно), без плащане, без писмо за неизвестен резултат",
    at2.status === "cancelled" && at2.resultSource === "status" && !(await row(X.id)).cardPaidAt && (await pays(X.id)).length === 0 && !mail.sent.some((m) => /Неизвестен резултат/.test(m.subject) && m.html.includes(at2.orderNo)));
  check("9c.6 Клиентът вижда отново формуляра за плащане (нов опит е разрешен)", px.status === 200 && /<form method="post"/.test(px.html));
  const FX2 = fieldsIn((await page(X.id, xt[1], HOLDER)).html);
  check("9c.7 Нов опит: нов ORDER и NONCE, същата сума от сървъра", !!FX2.ORDER && FX2.ORDER !== FX.ORDER && FX2.NONCE !== FX.NONCE && FX2.AMOUNT === FX.AMOUNT && (await attempts(X.id)).length === 2);
  br2 = await backref(respFor(FX2));
  check("9c.8 Новият опит може да бъде платен; прекратеният остава прекратен", !!(await row(X.id)).cardPaidAt && (await pays(X.id)).length === 1 && (await attempts(X.id)).find((x: any) => x.orderNo === FX.ORDER)!.status === "cancelled");
  // Късен успешен отговор за прекратения опит (банката не би трябвало да го изпрати – т. 9.5.1) се записва като второ плащане, не се губи
  // Защита: RC -25 с чужд подпис или друг NONCE не прекратява опита
  const Y = await booking();
  const yt = tokenFrom((await adminCall("POST", { bookingId: Y.id, action: "send_link" })).json.url)!;
  const FY = fieldsIn((await page(Y.id, yt[1], HOLDER)).html);
  await t.q("update card_payments set created_at = now() - interval '17 minutes' where order_no = $1", [FY.ORDER]);
  bank.reply = (q) => sign({ ACTION: "3", RC: "-25", TERMINAL: "V6200750", TRTYPE: "90", ORDER: q.get("ORDER")!, TRAN_TRTYPE: "1", CURRENCY: "EUR", TIMESTAMP: "20261113214500", NONCE: q.get("NONCE")! }, attacker.privateKey);
  ck = await adminCall("POST", { bookingId: Y.id, action: "check" });
  check("9c.9 RC -25 с чужд подпис → невалиден, опитът остава отворен", ck.json.results[0] === "invalid" && (await attempts(Y.id))[0].status === "redirected");
  bank.reply = (q) => sign({ ACTION: "3", RC: "-25", TERMINAL: "V6200750", TRTYPE: "90", ORDER: q.get("ORDER")!, TRAN_TRTYPE: "1", CURRENCY: "EUR", TIMESTAMP: "20261113214500", NONCE: "0".repeat(32) });
  ck = await adminCall("POST", { bookingId: Y.id, action: "check" });
  check("9c.10 RC -25 с друг NONCE → невалиден, опитът остава отворен", ck.json.results[0] === "invalid" && (await attempts(Y.id))[0].status === "redirected");
  br2 = await backref(respFor(FY, { ...cancel }));
  check("9c.11 BACKREF с RC -25 (дори след 16 мин.) сам не прекратява опита – само проверката за статус", (await attempts(Y.id))[0].status === "redirected");
  // Опит, записан като „неизвестен“ от по-стара версия: администраторът го проверява отново в рамките на 24 ч.
  await t.q("update card_payments set status = 'unknown' where order_no = $1", [FY.ORDER]);
  bank.reply = (q) => sign({ ACTION: "3", RC: "-25", TERMINAL: "V6200750", TRTYPE: "90", ORDER: q.get("ORDER")!, TRAN_TRTYPE: "1", CURRENCY: "EUR", TIMESTAMP: "20261113214500", NONCE: q.get("NONCE")! });
  ck = await adminCall("POST", { bookingId: Y.id, action: "check" });
  check("9c.12 „Неизвестен“ опит до 24 ч.: повторна проверка в банката с RC -25 → прекратен, нов опит е разрешен", ck.json.results[0] === "cancelled" && (await attempts(Y.id))[0].status === "cancelled" && (await page(Y.id, yt[1])).status === 200);
  await t.q("update card_payments set status = 'unknown', created_at = now() - interval '25 hours' where order_no = $1", [FY.ORDER]);
  const callsB = bank.calls;
  ck = await adminCall("POST", { bookingId: Y.id, action: "check" });
  check("9c.13 „Неизвестен“ опит след 24 ч. не се проверява отново и остава неизвестен (без нов опит)", ck.json.results[0] === "skip" && bank.calls === callsB && (await page(Y.id, yt[1])).status === 409);
}

// ===== 9d. ACTION 2 / RC -20 „Expired transaction“ от проверка за статус (потвърждение на Пощенска банка, 16.11.2026) =====
{
  const mk = async () => {
    const X = await booking();
    const xt = tokenFrom((await adminCall("POST", { bookingId: X.id, action: "send_link" })).json.url)!;
    const FX = fieldsIn((await page(X.id, xt[1], HOLDER)).html);
    return { X, xt, FX };
  };
  const expired = (o: Record<string, string> = {}, key?: string) => (q: URLSearchParams) =>
    sign({ ACTION: "2", RC: "-20", STATUSMSG: "Expired transaction", TERMINAL: "V6200750", TRTYPE: "90", TRAN_TRTYPE: "1", ORDER: q.get("ORDER")!, CURRENCY: "EUR", TIMESTAMP: "20261114004900", NONCE: q.get("NONCE")!, ...o }, key);
  const age = (order: string, sec: number) => t.q("update card_payments set created_at = now() - make_interval(secs => $2), last_check_at = null where order_no = $1", [order, sec]);
  const check1 = async (id: string) => (await adminCall("POST", { bookingId: id, action: "check" })).json.results[0];
  const ev = async (id: string, action: string) => (await t.q("select count(*)::int as n from booking_events where booking_id = $1 and action = $2", [id, action])).rows[0].n;
  const unknownMails = () => mail.sent.filter((m) => /Неизвестен резултат/.test(m.subject)).length;

  // Времева граница
  let { X, xt, FX } = await mk();
  bank.reply = (q) => sign({ ACTION: "3", RC: "-40", TERMINAL: "V6200750", TRTYPE: "90", TRAN_TRTYPE: "1", ORDER: q.get("ORDER")!, CURRENCY: "USD", TIMESTAMP: "20261113233500", NONCE: q.get("NONCE")! });
  await age(FX.ORDER, 5 * 60);
  check("9d.1 Преди 16 мин.: ACTION 3 / RC -40 → опитът остава отворен", (await check1(X.id)) === "pending" && (await attempts(X.id))[0].status === "redirected");
  bank.reply = expired();
  await age(FX.ORDER, 10 * 60);
  check("9d.2 ACTION 2 / RC -20 след 10 мин. → остава отворен, нов опит НЕ е разрешен", (await check1(X.id)) === "pending" && (await page(X.id, xt[1])).status === 409);
  await age(FX.ORDER, 16 * 60 - 5);
  check("9d.3 Граница: 15 мин. 55 сек. → още отворен", (await check1(X.id)) === "pending" && (await attempts(X.id))[0].status === "redirected");
  const um0 = unknownMails();
  await age(FX.ORDER, 16 * 60 + 5);
  const r3 = await check1(X.id);
  const ax = (await attempts(X.id))[0];
  check("9d.4 Граница: 16 мин. 5 сек., подписан отговор ACTION 2 / RC -20 → неуспешен (окончателно), източник – проверка за статус",
    r3 === "failed" && ax.status === "failed" && ax.resultSource === "status" && ax.action === "2" && ax.rc === "-20" && ax.statusMsg === "Expired transaction", r3);
  check("9d.5 Без запис на плащане, без „платено“, без писмо за неизвестен резултат", (await pays(X.id)).length === 0 && !(await row(X.id)).cardPaidAt && unknownMails() === um0 && (await ev(X.id, "card.failed")) === 1);
  // Повторна обработка
  const callsR = bank.calls;
  check("9d.6 Повторна проверка на неуспешния опит → не се праща нова заявка към банката", (await check1(X.id)) === undefined && bank.calls === callsR);
  await Promise.all(Array.from({ length: 3 }, () => adminCall("POST", { bookingId: X.id, action: "check" })));
  check("9d.7 Едновременни повторни проверки → едно събитие card.failed, статусът не се променя", (await ev(X.id, "card.failed")) === 1 && (await attempts(X.id))[0].status === "failed");
  // Нов опит
  let px = await page(X.id, xt[1]);
  check("9d.8 Клиентът вижда формуляра – нов опит е разрешен", px.status === 200 && /<form method="post"/.test(px.html));
  const FX2 = fieldsIn((await page(X.id, xt[1], HOLDER)).html);
  check("9d.9 Новият опит е с нов ORDER и NONCE и същата сума от сървъра", !!FX2.ORDER && FX2.ORDER !== FX.ORDER && FX2.NONCE !== FX.NONCE && FX2.AMOUNT === FX.AMOUNT && (await attempts(X.id)).length === 2);
  await backref(respFor(FX2));
  check("9d.10 Новият опит може да бъде платен; изтеклият остава неуспешен; един платежен запис", !!(await row(X.id)).cardPaidAt && (await pays(X.id)).length === 1 && (await attempts(X.id)).find((x: any) => x.orderNo === FX.ORDER)!.status === "failed");

  // Невалиден подпис и несъответстващи данни (опитът е по-стар от 16 мин.)
  const bad: [string, (q: URLSearchParams) => Record<string, string>][] = [
    ["чужд подпис", expired({}, attacker.privateKey)],
    ["друг NONCE", expired({ NONCE: "0".repeat(32) })],
    ["друг терминал", expired({ TERMINAL: "V0000001" })],
    ["друга поръчка", expired({ ORDER: "000000" })],
    ["TRTYPE 1 вместо 90", expired({ TRTYPE: "1" })],
    ["TRAN_TRTYPE 12", expired({ TRAN_TRTYPE: "12" })],
  ];
  for (const [name, reply] of bad) {
    ({ X, xt, FX } = await mk());
    bank.reply = reply;
    await age(FX.ORDER, 17 * 60);
    const r = await check1(X.id);
    check(`9d.11 ${name} → невалиден отговор, опитът остава отворен, без нов опит`, r === "invalid" && (await attempts(X.id))[0].status === "redirected" && (await page(X.id, xt[1])).status === 409 && !(await row(X.id)).cardPaidAt, r);
  }
  // Подписът покрива ACTION и RC: подменен код след подписа
  ({ X, xt, FX } = await mk());
  bank.reply = (q) => ({ ...sign({ ACTION: "3", RC: "-40", TERMINAL: "V6200750", TRTYPE: "90", TRAN_TRTYPE: "1", ORDER: q.get("ORDER")!, CURRENCY: "USD", TIMESTAMP: "20261114004900", NONCE: q.get("NONCE")! }), ACTION: "2", RC: "-20" });
  await age(FX.ORDER, 17 * 60);
  check("9d.12 ACTION / RC, подменени след подписа → невалиден, опитът остава отворен", (await check1(X.id)) === "invalid" && (await attempts(X.id))[0].status === "redirected");
  // Без TRAN_TRTYPE: не е доказано, че е статус на плащане → неизвестен (не неуспешен)
  ({ X, xt, FX } = await mk());
  bank.reply = (q) => { const f = expired()(q); delete (f as any).TRAN_TRTYPE; return sign(Object.fromEntries(Object.entries(f).filter(([k]) => k !== "P_SIGN")) as any); };
  await age(FX.ORDER, 17 * 60);
  check("9d.13 ACTION 2 / RC -20 без TRAN_TRTYPE → „неизвестен“, без нов опит", (await check1(X.id)) === "unknown" && (await page(X.id, xt[1])).status === 409);
  // BACKREF с ACTION 2 / RC -20 след 16 мин. – правилото не важи
  ({ X, xt, FX } = await mk());
  await age(FX.ORDER, 17 * 60);
  await backref(respFor(FX, { ACTION: "2", RC: "-20", APPROVAL: "", RRN: "", INT_REF: "", STATUSMSG: "Expired transaction" }));
  check("9d.14 BACKREF с ACTION 2 / RC -20 (дори след 16 мин.) не приключва опита", (await attempts(X.id))[0].status === "redirected" && (await page(X.id, xt[1])).status === 409);
  // Опит, записан „неизвестен“ от по-стара версия, до 24 ч.: повторна проверка в банката → неуспешен
  ({ X, xt, FX } = await mk());
  await t.q("update card_payments set status = 'unknown', created_at = now() - interval '2 hours' where order_no = $1", [FX.ORDER]);
  bank.reply = expired();
  check("9d.15 „Неизвестен“ опит до 24 ч. + ACTION 2 / RC -20 при повторна проверка → неуспешен, нов опит е разрешен", (await check1(X.id)) === "failed" && (await page(X.id, xt[1])).status === 200);
  // Над 24 ч. – не се проверява отново (както ORDER 097133)
  ({ X, xt, FX } = await mk());
  await t.q("update card_payments set status = 'unknown', created_at = now() - interval '48 hours' where order_no = $1", [FX.ORDER]);
  const callsU = bank.calls;
  check("9d.16 „Неизвестен“ опит над 24 ч. → без заявка към банката, остава неизвестен, без нов опит", (await check1(X.id)) === "skip" && bank.calls === callsU && (await attempts(X.id))[0].status === "unknown" && (await page(X.id, xt[1])).status === 409);
}

// ===== 9e. ACTION 3 / RC -19 „Authentication failed“ от проверка за статус (тест на Пощенска банка: „Изход“ при динамичната парола) =====
{
  const mk = async () => {
    const X = await booking();
    const xt = tokenFrom((await adminCall("POST", { bookingId: X.id, action: "send_link" })).json.url)!;
    const FX = fieldsIn((await page(X.id, xt[1], HOLDER)).html);
    return { X, xt, FX };
  };
  const authfail = (o: Record<string, string> = {}, key?: string) => (q: URLSearchParams) =>
    sign({ ACTION: "3", RC: "-19", STATUSMSG: "Authentication failed. Authentication declined", TERMINAL: "V6200750", TRTYPE: "90", TRAN_TRTYPE: "1", ORDER: q.get("ORDER")!, CURRENCY: "EUR", AMOUNT: "", TIMESTAMP: "20261116150400", NONCE: q.get("NONCE")!, ...o }, key);
  const age = (order: string, sec: number) => t.q("update card_payments set created_at = now() - make_interval(secs => $2), last_check_at = null where order_no = $1", [order, sec]);
  const check1 = async (id: string) => (await adminCall("POST", { bookingId: id, action: "check" })).json.results[0];
  const ev = async (id: string, action: string) => (await t.q("select count(*)::int as n from booking_events where booking_id = $1 and action = $2", [id, action])).rows[0].n;
  const unknownMails = () => mail.sent.filter((m) => /Неизвестен резултат/.test(m.subject)).length;
  const blocked = async (X: any, xt: string[]) => (await page(X.id, xt[1])).status === 409 && (await page(X.id, xt[1], HOLDER)).status === 409 && (await attempts(X.id)).length === 1;

  // BACKREF след „Изход“ – опитът остава отворен
  let { X, xt, FX } = await mk();
  const backrefRes = await backref(respFor(FX, { ACTION: "3", RC: "-19", APPROVAL: "", RRN: "", INT_REF: "", STATUSMSG: "Authentication failed. Authentication declined" }));
  check("9e.1 BACKREF с ACTION 3 / RC -19 (подписан) → опитът остава отворен, нов опит НЕ е разрешен", backrefRes.status === 200 && (await attempts(X.id))[0].status === "redirected" && await blocked(X, xt));
  // Времева граница (проверка за статус през функцията)
  bank.reply = authfail();
  await age(FX.ORDER, 5 * 60);
  check("9e.2 Проверка за статус с RC -19 след 5 мин. → отворен", (await check1(X.id)) === "pending" && await blocked(X, xt));
  await age(FX.ORDER, 16 * 60 - 5);
  check("9e.3 15 мин. 55 сек. → отворен", (await check1(X.id)) === "pending" && (await attempts(X.id))[0].status === "redirected");
  // Точно на границата: applyResult с момент = начало + 16 мин. (без допълнителни милисекунди)
  const a0 = (await attempts(X.id))[0];
  const fx = authfail()(new URLSearchParams({ ORDER: FX.ORDER, NONCE: FX.NONCE }));
  const atEdge = await applyResult(a0.id, fx, "status", new Date(a0.createdAt.getTime() + 16 * 60_000));
  check("9e.4 Точно 16 мин. 00,000 сек. → не е окончателно (опитът остава отворен)", atEdge.state === "pending" && (await attempts(X.id))[0].status === "redirected" && await blocked(X, xt));
  const um0 = unknownMails();
  const afterEdge = await applyResult(a0.id, fx, "status", new Date(a0.createdAt.getTime() + 16 * 60_000 + 1));
  check("9e.5 16 мин. + 1 мс → неуспешен", afterEdge.state === "failed" && (await attempts(X.id))[0].status === "failed");
  check("9e.6 Без запис на плащане, без „платено“, без писмо за неизвестен резултат, едно събитие card.failed", (await pays(X.id)).length === 0 && !(await row(X.id)).cardPaidAt && unknownMails() === um0 && (await ev(X.id, "card.failed")) === 1);
  // Повторна и едновременна обработка
  const again = await applyResult(a0.id, fx, "status", new Date(a0.createdAt.getTime() + 20 * 60_000));
  const calls0 = bank.calls;
  await Promise.all(Array.from({ length: 4 }, () => adminCall("POST", { bookingId: X.id, action: "check" })));
  await Promise.all(Array.from({ length: 3 }, () => applyResult(a0.id, fx, "status", new Date(a0.createdAt.getTime() + 21 * 60_000))));
  check("9e.7 Повторна и едновременна обработка: остава неуспешен, едно събитие, без нова заявка към банката", again.state === "failed" && (await attempts(X.id))[0].status === "failed" && (await ev(X.id, "card.failed")) === 1 && bank.calls === calls0);
  // Нов опит и плащане
  const px = await page(X.id, xt[1]);
  check("9e.8 Клиентът вижда формуляра – нов опит е разрешен", px.status === 200 && /<form method="post"/.test(px.html));
  const FX2 = fieldsIn((await page(X.id, xt[1], HOLDER)).html);
  check("9e.9 Новият опит: нов ORDER и NONCE, същата сума от сървъра", !!FX2.ORDER && FX2.ORDER !== FX.ORDER && FX2.NONCE !== FX.NONCE && FX2.AMOUNT === FX.AMOUNT && (await attempts(X.id)).length === 2);
  await backref(respFor(FX2));
  await backref(respFor(FX2));
  check("9e.10 Новият опит е платен; един платежен запис; неуспешният остава неуспешен", !!(await row(X.id)).cardPaidAt && (await pays(X.id)).length === 1 && (await attempts(X.id)).find((x: any) => x.orderNo === FX.ORDER)!.status === "failed");
  // Пълен път през функцията след 16 мин.
  ({ X, xt, FX } = await mk());
  bank.reply = authfail();
  await age(FX.ORDER, 16 * 60 + 5);
  check("9e.11 Проверка за статус през функцията след 16 мин. 5 сек. → неуспешен, нов опит разрешен", (await check1(X.id)) === "failed" && (await page(X.id, xt[1])).status === 200);

  // Невалиден подпис и несъответстващи данни
  const bad: [string, (q: URLSearchParams) => Record<string, string>][] = [
    ["чужд подпис", authfail({}, attacker.privateKey)],
    ["друг NONCE", authfail({ NONCE: "0".repeat(32) })],
    ["друг терминал", authfail({ TERMINAL: "V0000001" })],
    ["друга поръчка", authfail({ ORDER: "000000" })],
    ["TRTYPE 1 вместо 90", authfail({ TRTYPE: "1" })],
    ["различен TRAN_TRTYPE (12)", authfail({ TRAN_TRTYPE: "12" })],
    ["различен TRAN_TRTYPE (24)", authfail({ TRAN_TRTYPE: "24" })],
  ];
  for (const [name, reply] of bad) {
    ({ X, xt, FX } = await mk());
    bank.reply = reply;
    await age(FX.ORDER, 17 * 60);
    const r = await check1(X.id);
    check(`9e.12 ${name} → невалиден отговор, опитът остава отворен, без нов опит`, r === "invalid" && (await attempts(X.id))[0].status === "redirected" && await blocked(X, xt), r);
  }
  ({ X, xt, FX } = await mk());
  bank.reply = (q) => ({ ...sign({ ACTION: "3", RC: "-40", TERMINAL: "V6200750", TRTYPE: "90", TRAN_TRTYPE: "1", ORDER: q.get("ORDER")!, CURRENCY: "USD", TIMESTAMP: "20261116150400", NONCE: q.get("NONCE")! }), RC: "-19" });
  await age(FX.ORDER, 17 * 60);
  check("9e.13 RC, подменен след подписа (-40 → -19) → невалиден, опитът остава отворен", (await check1(X.id)) === "invalid" && (await attempts(X.id))[0].status === "redirected");
  ({ X, xt, FX } = await mk());
  bank.reply = (q) => { const f: any = authfail()(q); delete f.TRAN_TRTYPE; delete f.P_SIGN; return sign(f); };
  await age(FX.ORDER, 17 * 60);
  check("9e.14 Липсващ TRAN_TRTYPE → „неизвестен“, без нов опит", (await check1(X.id)) === "unknown" && await blocked(X, xt));
  for (const [act, rc] of [["2", "-19"], ["3", "-20"], ["3", "-24"]]) {
    ({ X, xt, FX } = await mk());
    bank.reply = authfail({ ACTION: act, RC: rc });
    await age(FX.ORDER, 17 * 60);
    check(`9e.15 ACTION ${act} / RC ${rc} след 16 мин. → „неизвестен“ (правилото не се разширява)`, (await check1(X.id)) === "unknown" && await blocked(X, xt));
  }
  // BACKREF след 16 мин. – правилото не важи
  ({ X, xt, FX } = await mk());
  await age(FX.ORDER, 17 * 60);
  await backref(respFor(FX, { ACTION: "3", RC: "-19", APPROVAL: "", RRN: "", INT_REF: "" }));
  check("9e.16 BACKREF с ACTION 3 / RC -19 след 16 мин. не приключва опита", (await attempts(X.id))[0].status === "redirected" && await blocked(X, xt));
  // unknown → неуспешен (като ORDER 782294, ако е в 24-часовия прозорец)
  ({ X, xt, FX } = await mk());
  bank.reply = authfail();
  await t.q("update card_payments set status = 'unknown', action = '3', rc = '-19', created_at = now() - interval '17 minutes' where order_no = $1", [FX.ORDER]);
  check("9e.17 „Неизвестен“ опит (стара версия) + валидна проверка до 24 ч. → неуспешен, нов опит разрешен", (await check1(X.id)) === "failed" && (await page(X.id, xt[1])).status === 200 && (await ev(X.id, "card.failed")) === 1);
  const FX3 = fieldsIn((await page(X.id, xt[1], HOLDER)).html);
  await backref(respFor(FX3));
  check("9e.18 След това новият опит е платен с един платежен запис", !!(await row(X.id)).cardPaidAt && (await pays(X.id)).length === 1);
  ({ X, xt, FX } = await mk());
  bank.reply = authfail({}, attacker.privateKey);
  await t.q("update card_payments set status = 'unknown', created_at = now() - interval '2 hours' where order_no = $1", [FX.ORDER]);
  check("9e.19 „Неизвестен“ + невалиден подпис при повторната проверка → остава „неизвестен“", (await check1(X.id)) === "invalid" && (await attempts(X.id))[0].status === "unknown" && await blocked(X, xt));
  ({ X, xt, FX } = await mk());
  await t.q("update card_payments set status = 'unknown', created_at = now() - interval '25 hours' where order_no = $1", [FX.ORDER]);
  const callsU = bank.calls;
  check("9e.20 „Неизвестен“ над 24 ч. → без заявка към банката, остава неизвестен", (await check1(X.id)) === "skip" && bank.calls === callsU && await blocked(X, xt));
}

// Подправен отговор на проверката за статус
const FD2 = fieldsIn((await page(D.id, dtk[1], HOLDER)).html);
bank.reply = (q) => sign({ ACTION: "0", RC: "00", TERMINAL: "V6200750", TRTYPE: "90", TRAN_TRTYPE: "1", AMOUNT: FD2.AMOUNT, CURRENCY: "EUR", ORDER: q.get("ORDER")!, TIMESTAMP: "20261112103000", NONCE: q.get("NONCE")! }, attacker.privateKey);
ar = await adminCall("POST", { bookingId: D.id, action: "check" });
check("9.10 Отговор на проверката за статус с чужд подпис → невалиден, без плащане", ar.json.results[0] === "invalid" && !(await row(D.id)).cardPaidAt);
bank.reply = () => "down";
ar = await adminCall("POST", { bookingId: D.id, action: "check" });
check("9.11 БОРИКА не отговаря → опитът остава отворен, без плащане", ar.json.results[0] === "network" && !(await row(D.id)).cardPaidAt);
// Над 24 ч. без резултат → „неизвестен“; известие до собственика; клиентът не може да плати повторно автоматично
await t.q("update card_payments set created_at = now() - interval '25 hours' where order_no = $1", [FD2.ORDER]);
ar = await adminCall("POST", { bookingId: D.id, action: "check" });
p = await page(D.id, dtk[1]);
check("9.12 Над 24 ч. без отговор → „неизвестен“, известие до собственика, без нов опит", ar.json.results[0] === "unknown" && !!lastMail(/Неизвестен резултат от плащане/) && p.status === 409 && /Не плащайте отново/.test(p.html) && !(await row(D.id)).cardPaidAt);

// ===== 10. Достъп до административните действия =====
setContext("deploy-preview");
const anon = await adminCardFn(new Request(`${O}/api/admin/card-payments?booking=${B.id}`), {} as any);
check("10.1 Без вход → 401", anon.status === 401);
ar = await adminCall("GET", undefined, `?booking=${B.id}`, O, adminJar("user@example.com", []));
check("10.2 Потребител без роля admin → 403", ar.status === 403);
ar = await adminCall("POST", { bookingId: B.id, action: "send_link" }, "", null);
check("10.3 POST от друг сайт (без Origin) → 403", ar.status === 403);
// Диагностика на ключовете при reason = "key" – само за администратор, без стойности, без нищо в логовете
{
  const encPair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "diag-only-pass" } });
  env({ ...TEST_ENV, BORICA_TEST_PRIVATE_KEY: encPair.privateKey.trim().replace(/\n/g, " "), BORICA_TEST_PRIVATE_KEY_PASSPHRASE: "wrong-diag-pass" });
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  let dj: any;
  try { dj = (await adminCall("GET", undefined, `?booking=${B.id}`)).json; } finally { Object.assign(console, orig); }
  const dg = dj.config.diagnostics;
  check("10.3a Грешна парола: reason key; диагностика – прочетен формат, „wrong“, публичният ключ на БОРИКА е наред",
    dj.config.available === false && dj.config.reason === "key" && dg.privateKey.encrypted && dg.privateKey.passphrase === "wrong" && dg.privateKey.fixes.includes("spaces") && dg.boricaPublicKey.readable && dg.boricaPublicKey.bitsOk && dg.terminal === "ok", JSON.stringify(dg.privateKey));
  const blob = JSON.stringify(dj) + logs.join("\n");
  const secretBits = [encPair.privateKey.split("\n")[1].slice(0, 16), "wrong-diag-pass", boricaTest.publicKey.split("\n")[1].slice(0, 16), "V6200750", "9200203803"];
  check("10.3b Отговорът и логовете не съдържат ключове, пароли или стойности на променливите", secretBits.every((x) => !blob.includes(x)) && !/BEGIN|PRIVATE KEY-----/.test(blob), logs.length + " реда в лога");
  env({ ...TEST_ENV, BORICA_TEST_PRIVATE_KEY: encPair.privateKey.trim().replace(/\n/g, "\\n"), BORICA_TEST_PRIVATE_KEY_PASSPHRASE: "diag-only-pass\n" });
  check("10.3c Ключ с „\\n“ като текст и парола с нов ред в края → наличен", cardAvailable());
  env({ ...TEST_ENV, BORICA_TEST_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 1024, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).privateKey });
  const sm = (await adminCall("GET", undefined, `?booking=${B.id}`)).json.config;
  check("10.3d RSA 1024: недостъпно; диагностиката показва размера отделно", sm.reason === "key" && sm.diagnostics.privateKey.readable && sm.diagnostics.privateKey.bits === 1024 && sm.diagnostics.privateKey.bitsOk === false);
  const noAdmin = await adminCall("GET", undefined, `?booking=${B.id}`, O, adminJar("viewer@example.com", []));
  check("10.3e Без роля admin диагностиката не се показва (403)", noAdmin.status === 403 && !noAdmin.json.config);
  env({ ...TEST_ENV });
  const okc = (await adminCall("GET", undefined, `?booking=${B.id}`)).json.config;
  check("10.3f При работеща конфигурация не се връща диагностика", okc.available && !("diagnostics" in okc));
}
ar = await adminCall("GET", undefined, `?booking=${B.id}`);
check("10.4 Администратор: среда, имена на променливите (без стойности), сума", ar.status === 200 && ar.json.config.available && ar.json.config.mode === "test" && ar.json.config.variables.includes("BORICA_TEST_PRIVATE_KEY") && !JSON.stringify(ar.json).includes("PRIVATE KEY-----") && ar.json.breakdown.payCents === 8150);
const pend = await booking({ status: "pending", stage: "review" });
ar = await adminCall("POST", { bookingId: pend.id, action: "send_link" });
check("10.5 Връзка за неподвърдена резервация → отказ", ar.status === 409 && ar.json.block === "state");
const cash = await booking({ payment: "cash" });
ar = await adminCall("POST", { bookingId: cash.id, action: "send_link" });
check("10.6 Резервация „в брой“ → без връзка за карта", ar.status === 409 && ar.json.block === "method");
// Нова връзка отменя старата
ar = await adminCall("POST", { bookingId: B.id, action: "send_link" });
const b1 = tokenFrom(ar.json.url)!;
ar = await adminCall("POST", { bookingId: B.id, action: "send_link" });
const b2 = tokenFrom(ar.json.url)!;
check("10.7 Нова връзка отменя предишната", (await page(B.id, b1[1])).status === 410 && (await page(B.id, b2[1])).status === 200);
// Отменена след изпращането резервация – връзката не позволява плащане
await t.q("update bookings set status = 'cancelled' where id = $1", [B.id]);
p = await page(B.id, b2[1]);
check("10.8 Отменена резервация → плащането не е възможно", p.status === 409 && /не е възможно/.test(p.html));
const ho = await booking({ handedOverAt: new Date() });
check("10.9 Предаден автомобил / минал час за получаване → без връзка", (await adminCall("POST", { bookingId: ho.id, action: "send_link" })).json.block === "handed_over"
  && (await adminCall("POST", { bookingId: (await booking({ startDate: "2020-01-01", pickup: "2020-01-01 10:00" })).id, action: "send_link" })).json.block === "pickup");

// ===== 11. Писма: повторен опит при неуспех, език, без дублиране =====
const E = await booking({ lang: "en" });
mail.fail = (m) => (m.to === E.email ? "Brevo 503" : null);
ar = await adminCall("POST", { bookingId: E.id, action: "send_link" });
check("11.1 Неуспешно писмо с връзката → записано за повторен опит", ar.json.email === "failed" && mailsTo(E.email, /payment link/i) === 0);
mail.fail = null;
await t.q("update email_log set next_attempt_at = now() - interval '1 minute' where kind = 'customer-card-link'");
await retryFn();
const enLink = lastMail(/Card payment link/);
check("11.2 Повторният опит изпраща писмото (на английски) с работеща връзка", !!enLink && enLink.to === E.email && !!tokenFrom(enLink.html) && (await page(E.id, tokenFrom(enLink.html)![1])).status === 200);
await retryFn();
check("11.3 Без второ копие на същото писмо", mailsTo(E.email, /Card payment link/) === 1);
const FE = fieldsIn((await page(E.id, tokenFrom(enLink!.html)![1], HOLDER)).html);
check("11.4 LANG=EN за английски клиент", FE.LANG === "EN");
mail.fail = (m) => (m.to === E.email ? "Brevo 503" : null);
await backref(respFor(FE));
check("11.5 Плащането е записано и при неуспешно писмо", !!(await row(E.id)).cardPaidAt && mailsTo(E.email, /Card payment confirmation/) === 0);
mail.fail = null;
await t.q("update email_log set next_attempt_at = now() - interval '1 minute' where kind like '%card-paid'");
await retryFn();
await retryFn();
const enPaid = lastMail(/Card payment confirmation/);
check("11.6 Потвърждението за плащане се изпраща при повторния опит – веднъж, на английски", mailsTo(E.email, /Card payment confirmation/) === 1 && !!enPaid && /not an invoice, fiscal receipt or bank document/.test(enPaid.html) && /security deposit of 100 € is not included/.test(enPaid.html));

// ===== 12. Двойно плащане (два успешни опита) – записва се, собственикът е предупреден =====
const G = await booking();
ar = await adminCall("POST", { bookingId: G.id, action: "send_link" });
const gtk = tokenFrom(ar.json.url)!;
const FG1 = fieldsIn((await page(G.id, gtk[1], HOLDER)).html);
await t.q("update card_payments set status = 'failed' where order_no = $1", [FG1.ORDER]); // напр. прието за неуспешно, а банката е одобрила
const FG2 = fieldsIn((await page(G.id, gtk[1], HOLDER)).html);
await backref(respFor(FG2));
await backref(respFor(FG1));
const gp = await pays(G.id), ga = await attempts(G.id);
check("12.1 Второ одобрено плащане: записано (парите са получени), отбелязано като второ, клиентът получава едно потвърждение",
  gp.length === 2 && ga.filter((x: any) => x.duplicate).length === 1 && mailsTo(G.email, /Потвърждение за плащане/) === 1 && !!lastMail(/ДВОЙНО ПЛАЩАНЕ/));
check("12.2 Договорената сума е намалена само веднъж", (await row(G.id)).totalCents === 8150);

// ===== 13. Вече получени плащания по наема =====
{
  let pk = 0;
  const pay = async (bookingId: string, kind: string, amount: string, o: Record<string, unknown> = {}) => {
    setContext("deploy-preview", { cookies: jar, ip: "203.0.113.9" });
    const r = await adminPaymentsFn(new Request(`${O}/api/admin/payments${o.id ? "/" + o.id : ""}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: O },
      body: JSON.stringify(o.id ? o.body : { bookingId, kind, method: "bank", amount, status: "received", idempotencyKey: `card-pre-${++pk}-key`, ...o }) }), { params: o.id ? { id: o.id } : {} } as any);
    setContext("deploy-preview");
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const withLink = async () => {
    const X = await booking();
    const r = await adminCall("POST", { bookingId: X.id, action: "send_link" });
    return { X, xt: tokenFrom(r.json.url)! };
  };
  const ev = async (id: string, action: string) => (await t.q("select count(*)::int as n from booking_events where booking_id = $1 and action = $2", [id, action])).rows[0].n;
  const cantStart = async (X: any, xt: string[]) => {
    const g = await page(X.id, xt[1]), p2 = await page(X.id, xt[1], HOLDER);
    return g.status === 409 && !/<form method="post"/.test(g.html) && p2.status === 409 && (await attempts(X.id)).length === 0;
  };

  // Аванс
  let { X, xt } = await withLink();
  check("13.1 Получен аванс (50 €) се записва", (await pay(X.id, "deposit", "50")).status === 201);
  let ar2 = await adminCall("POST", { bookingId: X.id, action: "send_link" });
  check("13.2 Аванс: администраторът не може да изпрати връзка (prepaid)", ar2.status === 409 && ar2.json.block === "prepaid");
  check("13.3 Аванс: старата връзка не позволява картово плащане (GET и POST), без опит", await cantStart(X, xt));
  check("13.4 Аванс: GET в админ показва блокирането и получената сума", (await adminCall("GET", undefined, `?booking=${X.id}`)).json.block === "prepaid" && (await adminCall("GET", undefined, `?booking=${X.id}`)).json.money.receivedCents === 5000);
  // Частично възстановен аванс – още блокира; изцяло възстановен – не
  const depId = (await pays(X.id))[0].id;
  check("13.5 Частично възстановен аванс (20 от 50 €) → пак блокирано", (await pay(X.id, "refund", "20", { refundOf: depId })).status === 201 && await cantStart(X, xt));
  check("13.6 Изцяло възстановен аванс (нетно 0) → картовото плащане е позволено", (await pay(X.id, "refund", "30", { refundOf: depId })).status === 201 && (await page(X.id, xt[1])).status === 200);
  // Пълно плащане
  ({ X, xt } = await withLink());
  await pay(X.id, "final", "89");
  check("13.7 Пълно плащане по банков път → без картово плащане", await cantStart(X, xt) && (await adminCall("POST", { bookingId: X.id, action: "send_link" })).json.block === "prepaid");
  // Гаранционен депозит – не блокира
  ({ X, xt } = await withLink());
  await pay(X.id, "security", "100");
  let px = await page(X.id, xt[1]);
  const FS = fieldsIn((await page(X.id, xt[1], HOLDER)).html);
  check("13.8 Само гаранционен депозит → картовото плащане е позволено", px.status === 200 && !!FS.ORDER);
  await backref(respFor(FS));
  check("13.9 Плащането с карта се записва; депозитът остава отделно; без предупреждение за надплащане",
    !!(await row(X.id)).cardPaidAt && (await pays(X.id)).length === 2 && (await ev(X.id, "card.overpaid")) === 0 && !/НАДПЛАЩАНЕ/.test(lastMail(/Платено с карта/)!.subject));
  // Очаквано (неполучено) плащане не блокира
  ({ X, xt } = await withLink());
  await pay(X.id, "deposit", "50", { status: "expected" });
  check("13.10 Очаквано, неполучено плащане → не блокира", (await page(X.id, xt[1])).status === 200);
  // Получено след започването на банковия опит → плащането се записва, надплащането се показва, собственикът е предупреден
  ({ X, xt } = await withLink());
  const FO = fieldsIn((await page(X.id, xt[1], HOLDER)).html);
  check("13.11 Опитът е започнат", !!FO.ORDER);
  await pay(X.id, "deposit", "50");
  const brO = await backref(respFor(FO));
  const po = await pays(X.id);
  check("13.12 Валидно банково плащане след въведен аванс → записано (2 получени записа), резервацията е платена", /Плащането е успешно/.test(brO.html) && !!(await row(X.id)).cardPaidAt && po.filter((p: any) => p.status === "received").length === 2 && po.some((p: any) => p.method === "card" && p.amountCents === 8150 && /НАДПЛАЩАНЕ/.test(p.note)));
  const om2 = lastMail(/Платено с карта/)!;
  check("13.13 Собственикът е предупреден: [НАДПЛАЩАНЕ] и получената преди това сума 50 €", /\[НАДПЛАЩАНЕ\]/.test(om2.subject) && /възможно надплащане/.test(om2.html) && /50,00 €/.test(om2.html) && (await ev(X.id, "card.overpaid")) === 1);
  const gO = (await adminCall("GET", undefined, `?booking=${X.id}`)).json;
  check("13.14 Админ панелът показва надплащането (50 €) – нищо не е скрито", gO.money.overpaidCents === 5000 && gO.money.receivedCents === 13150);
  check("13.15 Клиентът получава обичайното потвърждение за плащането", mailsTo((await row(X.id)).email, /Потвърждение за плащане/) === 1);
  // Получаването на очаквано плащане (admin: expected → received) също се вижда при започването
  ({ X, xt } = await withLink());
  const exp = await pay(X.id, "deposit", "40", { status: "expected" });
  const expId = exp.json.payments[0].id;
  check("13.16 Очаквано плащане, отбелязано като получено → блокирано", (await pay(X.id, "", "", { id: expId, body: { status: "received", paidAt: new Date().toISOString() } })).status === 200 && await cantStart(X, xt));

  // Едновременни операции: започване на картово плащане и записване на получен аванс
  let both = 0, cardFirst = 0, depFirst = 0;
  for (let i = 0; i < 6; i++) {
    ({ X, xt } = await withLink());
    const [pp, dp] = await Promise.all([page(X.id, xt[1], HOLDER), pay(X.id, "deposit", "30")]);
    const at3 = await attempts(X.id);
    if (pp.status !== 200 && pp.status !== 409 || dp.status !== 201) both = -100;
    if (at3.length === 1) {
      cardFirst++;
      await backref(respFor(fieldsIn(pp.html)));
      if (!(await row(X.id)).cardPaidAt || (await ev(X.id, "card.overpaid")) !== 1) both = -100;
    } else if (at3.length === 0) {
      depFirst++;
      if (!(await cantStart(X, xt))) both = -100;
    } else both = -100;
  }
  // Детерминиран случай „между проверката на страницата и транзакцията“: блокирането идва от транзакцията в startPayment
  ({ X, xt } = await withLink());
  {
    const { startPayment, checkLink } = await import("../../server/card-pay.ts");
    const lk: any = await checkLink(X.id, xt[1]);
    await pay(X.id, "deposit", "30");
    const sr = await startPayment(lk.booking, lk.link.id, { name: "IVAN IVANOV", addr: "Plovdiv 1" });
    check("13.16b Аванс, записан след проверката на страницата → транзакцията отказва (prepaid), без опит", !sr.ok && (sr as any).error === "prepaid" && (await attempts(X.id)).length === 0);
  }
  check("13.17 Едновременно: всяка двойка завършва последователно – или опит + предупреждение за надплащане, или блокирано; без грешки и без загубен запис",
    both === 0 && cardFirst + depFirst === 6, `първо карта: ${cardFirst}, първо аванс: ${depFirst}`);
  ({ X, xt } = await withLink());
  const exp2 = (await pay(X.id, "deposit", "40", { status: "expected" })).json.payments[0].id;
  const [pp2, rp2] = await Promise.all([page(X.id, xt[1], HOLDER), pay(X.id, "", "", { id: exp2, body: { status: "received", paidAt: new Date().toISOString() } })]);
  const at4 = await attempts(X.id);
  check("13.18 Едновременно: картов опит и „очаквано → получено“ – без грешка, резултатът е последователен", rp2.status === 200 && (pp2.status === 200 ? at4.length === 1 : pp2.status === 409 && at4.length === 0));
}

// ===== 14. Известие „неизвестен резултат“ до собственика: опашка, повторен опит, разрешен опит =====
{
  const um = () => mail.sent.filter((m) => m.to === "rentaptb_stroi@abv.bg" && /Неизвестен резултат/.test(m.subject));
  const logOf = async (attemptId: string) => (await t.q("select status, attempts, kind from email_log where dedupe_key = $1", ["owner-card-unknown:" + attemptId])).rows[0];
  const mk = async () => {
    const X = await booking();
    const xt = tokenFrom((await adminCall("POST", { bookingId: X.id, action: "send_link" })).json.url)!;
    const F = fieldsIn((await page(X.id, xt[1], HOLDER)).html);
    const a = (await attempts(X.id))[0];
    return { X, xt, F, a };
  };
  const due = (id: string) => t.q("update email_log set next_attempt_at = now() - interval '1 minute', at = at - interval '5 minutes' where dedupe_key = $1", ["owner-card-unknown:" + id]);
  // а) неуспешно изпращане → повторен опит → изпратено веднъж, с причината „24 часа“
  let { X, xt, a } = await mk();
  mail.fail = (m) => (m.to === "rentaptb_stroi@abv.bg" ? "Brevo 503" : null);
  await t.q("update card_payments set created_at = now() - interval '25 hours' where id = $1", [a.id]);
  const n0 = um().length;
  check("14.1 Над 24 ч. без резултат → „неизвестен“; писмото до собственика не минава (503) и е записано като неуспешно", (await adminCall("POST", { bookingId: X.id, action: "check" })).json.results[0] === "unknown" && um().length === n0 && (await logOf(a.id)).status === "failed");
  mail.fail = null;
  await due(a.id);
  await retryFn();
  check("14.2 Повторният опит изпраща известието с причината (без отговор 24 ч.)", um().length === n0 + 1 && /в рамките на 24 часа/.test(um().at(-1)!.html) && (await logOf(a.id)).status === "sent");
  await due(a.id); await retryFn(); await retryFn();
  check("14.3 Без дублиране при следващи повторни опити", um().length === n0 + 1);
  // б) прекъсване между записването и изпращането: „неизвестен“ + опашка в базата, без опит за изпращане
  ({ X, xt, a } = await mk());
  await t.q("update card_payments set status = 'unknown', action = '3', rc = '-24', result_source = 'status', resolved_at = now() where id = $1", [a.id]);
  await t.q("insert into email_log (kind, dedupe_key, booking_id, recipient, status) values ('owner-card-unknown', $1, $2, 're***@abv.bg', 'queued')", ["owner-card-unknown:" + a.id, X.id]);
  await due(a.id);
  const n1 = um().length;
  await retryFn();
  check("14.4 Прекъснато изпращане (само запис в опашката) → email-retry изпраща известието с причината „окончателен код“", um().length === n1 + 1 && /проверката за статус след 16 минути върна ACTION 3, RC -24/.test(um().at(-1)!.html));
  // Записът в опашката е в същата транзакция като „неизвестен“ (applyResult)
  ({ X, xt, a } = await mk());
  mail.network = (m) => (m.to === "rentaptb_stroi@abv.bg" && /Неизвестен/.test(m.subject) ? "timeout" : null);
  bank.reply = (q) => sign({ ACTION: "3", RC: "-31", TERMINAL: "V6200750", TRTYPE: "90", TRAN_TRTYPE: "1", ORDER: q.get("ORDER")!, CURRENCY: "USD", TIMESTAMP: "20261116150400", NONCE: q.get("NONCE")! });
  await t.q("update card_payments set created_at = now() - interval '17 minutes' where id = $1", [a.id]);
  const n2 = um().length;
  check("14.5 „Неизвестен“ от проверката + изтекло време при пощата → записът остава за повторен опит (unknown)", (await adminCall("POST", { bookingId: X.id, action: "check" })).json.results[0] === "unknown" && (await logOf(a.id)).status === "unknown" && um().length === n2);
  mail.network = null;
  await t.q("update email_log set next_attempt_at = now() - interval '1 minute' where dedupe_key = $1", ["owner-card-unknown:" + a.id]);
  await retryFn();
  check("14.6 Известието до собственика се повтаря и след несигурен резултат (като другите известия до фирмата)", um().length === n2 + 1 && (await logOf(a.id)).status === "sent");
  // в) вече разрешен опит → без остаряло предупреждение
  ({ X, xt, a } = await mk());
  await t.q("update card_payments set status = 'unknown', action = '3', rc = '-24', result_source = 'status', resolved_at = now() where id = $1", [a.id]);
  await t.q("insert into email_log (kind, dedupe_key, booking_id, recipient, status) values ('owner-card-unknown', $1, $2, 're***@abv.bg', 'queued')", ["owner-card-unknown:" + a.id, X.id]);
  await adminCall("POST", { bookingId: X.id, action: "release", attemptId: a.id, confirm: "merchant-portal-not-successful", note: "Проверено в Merchant Portal" });
  await due(a.id);
  const n3 = um().length;
  await retryFn();
  check("14.7 Освободен (неуспешен) опит → известието не се изпраща, записът е „пропуснат“", um().length === n3 && (await logOf(a.id)).status === "skipped");
  await retryFn();
  check("14.8 Пропуснатото известие не се опитва отново", um().length === n3 && (await logOf(a.id)).status === "skipped");
  ({ X, xt, a } = await mk());
  const F2 = fieldsIn((await page(X.id, xt[1])).html);
  await t.q("update card_payments set status = 'unknown', created_at = now() - interval '2 hours' where id = $1", [a.id]);
  await t.q("insert into email_log (kind, dedupe_key, booking_id, recipient, status, attempts) values ('owner-card-unknown', $1, $2, 're***@abv.bg', 'failed', 1)", ["owner-card-unknown:" + a.id, X.id]);
  bank.reply = (q) => sign({ ACTION: "0", RC: "00", APPROVAL: "S12345", TERMINAL: "V6200750", TRTYPE: "90", TRAN_TRTYPE: "1", AMOUNT: "81.50", CURRENCY: "EUR", ORDER: q.get("ORDER")!, RRN: "612345678999", INT_REF: "97E2F39EFCA1CAF9", TIMESTAMP: "20261116150400", NONCE: q.get("NONCE")! });
  check("14.9 „Неизвестен“ опит, потвърден като платен при повторната проверка", (await adminCall("POST", { bookingId: X.id, action: "check" })).json.results[0] === "paid" && !!(await row(X.id)).cardPaidAt && !F2.ORDER);
  await due(a.id);
  const n4 = um().length;
  await retryFn();
  check("14.10 Платен опит → чакащото известие „неизвестен резултат“ не се изпраща (пропуснато)", um().length === n4 && (await logOf(a.id)).status === "skipped");
}

http.handler = prevHandler;
env({});
await finish();
