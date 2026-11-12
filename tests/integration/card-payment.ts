// Плащане с карта онлайн (БОРИКА): конфигурация по среди, сума и отстъпка, защитени връзки, подпис и проверки на отговора,
// дублирани и едновременни отговори, отказ, прекъснато плащане, проверка за статус, достъп до админ действията и писмата.
// „БОРИКА“ тук е симулирана: отговорите се подписват с ключ, генериран само за теста. Не се свързва с реалния платежен сървър.
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { adminJar, check, finish, freshDb, http, mail, O, schema, setContext } from "./harness.ts";
import { loadPrivateKey, loadPublicKey, MAC_REQUEST, MAC_RESPONSE, macString, signMac, verifyMac } from "../../server/borica.ts";
import { breakdown, cardAvailable, terminalConfig } from "../../server/card-pay.ts";
import { breakdownRows } from "../../mail/card.ts";
import { decide } from "../../server/booking-actions.ts";
import { statusView } from "../../server/stage.ts";
import payFn from "../../netlify/functions/pay.mts";
import backrefFn from "../../netlify/functions/borica-backref.mts";
import cardStatusFn from "../../netlify/functions/card-status.mts";
import adminCardFn from "../../netlify/functions/admin-card-payments.mts";
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
for (const [rc, act] of [["-19", "3"], ["-31", "3"], ["-33", "3"], ["-24", "3"], ["00", "1"], ["65", "21"], ["05", "3"]]) {
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

http.handler = prevHandler;
env({});
await finish();
