// Плащане с карта – истински браузър (Chromium), настолен компютър и телефон, срещу локалния e2e сървър с изолирана тестова
// конфигурация: E2E_BORICA_SIM=1 node tests/e2e/run.mjs tests/browser/card-visual.mjs
// Ключовете са генерирани в паметта при старта на сървъра; страницата на „банката“ е симулирана локално (/__e2e/borica-sim) –
// заявките към 3dsgate-dev / 3dsgate се прихващат и НЕ излизат от машината. Писмата се прихващат (harness.ts). Снимки: tests/e2e/.out/screens/.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const B = (process.argv[2] || "").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(B)) { console.error("Само локален e2e сървър."); process.exit(1); }
const SHOTS = "tests/e2e/.out/screens";
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (n, ok, info = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${n}${info ? " | " + info : ""}`); };
const sql = async (q) => (await fetch(B + "/__e2e/sql?q=" + encodeURIComponent(q))).json();
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Sofia" });
const browser = await chromium.launch();
const bankHits = [], external = [];

async function context(mobile, locale = "bg-BG") {
  const ctx = await browser.newContext(mobile ? { locale, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { locale, viewport: { width: 1366, height: 900 } });
  await ctx.route((u) => !u.href.startsWith(B), async (r) => {
    const u = r.request().url();
    if (/^https:\/\/3dsgate(-dev)?\.borica\.bg\//.test(u)) {
      bankHits.push(u);
      // Подписаният формуляр отива към локалната симулация, не към БОРИКА
      const res = await r.fetch({ url: B + "/__e2e/borica-sim", method: "POST", postData: r.request().postData() || "", headers: { "content-type": "application/x-www-form-urlencoded" } });
      return r.fulfill({ response: res });
    }
    external.push(new URL(u).host);
    return r.fulfill({ status: 204, body: "" });
  });
  return ctx;
}
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("dialog", (d) => (d.type() === "prompt" ? d.accept("test") : d.accept()));
  return page;
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function login(page) {
  await page.goto(B + "/admin/", { waitUntil: "load" });
  await page.fill("#e", "admin@example.com");
  await page.fill("#p", "admin-pass-123");
  await page.click("#f button.btn");
  await page.waitForSelector("nav a[data-k=dashboard]");
}
let n = 0;
async function booking(lang = "bg") {
  n++;
  const id = crypto.randomUUID().replace(/-/g, ""), tok = () => crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const d1 = day(20 + n * 5), d2 = day(23 + n * 5);
  const lines = [{ code: "rent", cents: 7500, qty: 3, unitCents: 2500 }, { code: "seats", cents: 900, qty: 3, unitCents: 300 }, { code: "delivery", cents: 500, km: 5, rate: 1 }];
  const pc = JSON.stringify({ server: { days: 3, lines, totalCents: 8900, depositCents: 10000 } }).replace(/'/g, "''");
  await sql(`insert into bookings (id, view_token, admin_token, status, stage, name, email, phone, lang, car, car_id, start_date, end_date, start_time, end_time, pickup, dropoff, payment, total, total_cents, total_review, price_check_status, price_check)
    values ('${id}', '${tok()}', '${tok()}', 'confirmed', 'done', 'ТЕСТ Визуален ${n}', 'visual${n}@example.com', '+359000000000', '${lang}', 'Volkswagen Golf', 'golf', '${d1}', '${d2}', '10:00', '10:00', '${d1} 10:00 – офис', '${d2} 10:00 – офис', 'card', '89 €', 8900, '', 'server', '${pc}'::jsonb)`);
  return id;
}

for (const mobile of [false, true]) {
  const tag = mobile ? "телефон" : "компютър", sfx = mobile ? "mobile" : "desktop";
  const ctx = await context(mobile);
  // 1. Формата: опцията за карта е видима при тестова конфигурация, „В брой“ остава
  const home = await newPage(ctx);
  await home.addInitScript(({ d1, d2 }) => {
    localStorage.setItem("cookie-consent", JSON.stringify({ v: 2, necessary: true, marketing: false, date: new Date().toISOString() }));
    sessionStorage.setItem("req", JSON.stringify({ car: "golf", d1, t1: "10:00", d2, t2: "10:00", m1: "office", m2: "office", open: true }));
  }, { d1: day(40), d2: day(42) });
  await home.goto(B + "/#avtomobili", { waitUntil: "load" });
  await home.waitForSelector("#card-choice:not([hidden])", { timeout: 15000 }).catch(() => null);
  const cardVisible = await home.locator("#card-choice").isVisible();
  if (cardVisible) await home.locator(".fb-pay").scrollIntoViewIfNeeded();
  await home.locator(".fb-pay").screenshot({ path: `${SHOTS}/1-form-payment-${sfx}.png` }).catch(() => home.screenshot({ path: `${SHOTS}/1-form-payment-${sfx}.png` }));
  check(`${tag}: формата показва „Плащане с карта онлайн“ и „В брой на място“`, cardVisible && (await home.locator("input[name=pay2][value=cash]").isVisible()));
  check(`${tag}: формата без хоризонтално превъртане и без JS грешки`, (await noOverflow(home)) && home.errors.length === 0, home.errors.join("; "));

  // 2. Админ панел: изпращане на връзката
  const id = await booking();
  const admin = await newPage(ctx);
  await login(admin);
  await admin.goto(B + "/admin/bookings/" + id, { waitUntil: "load" });
  await admin.waitForSelector("#cardpay [data-card-link]");
  await admin.click("#cardpay [data-card-link]");
  await admin.waitForSelector("#card-url input");
  const link = await admin.inputValue("#card-url input");
  await admin.locator("#cardpay").scrollIntoViewIfNeeded();
  await admin.locator("#cardpay").screenshot({ path: `${SHOTS}/2-admin-card-panel-${sfx}.png` });
  check(`${tag}: админ панел – тестов терминал, сума 81,50 €, връзка към /pay/`, /\/pay\/[a-f0-9]{32}\?k=[a-f0-9]{64}$/.test(link) && /ТЕСТОВ терминал/.test(await admin.locator("#cardpay").innerText()) && /81,50 €/.test(await admin.locator("#cardpay").innerText()));
  check(`${tag}: админ панел без хоризонтално превъртане`, await noOverflow(admin));

  // 3. Страницата за плащане
  const pay = await newPage(ctx);
  await pay.goto(link.replace(/^https?:\/\/[^/]+/, B), { waitUntil: "load" });
  await pay.screenshot({ path: `${SHOTS}/3-pay-page-${sfx}.png`, fullPage: true });
  const pt = await pay.locator("main").innerText();
  check(`${tag}: страницата показва наем, −7,50 €, услуги „без отстъпка“, 81,50 € и депозита отделно`, /75,00 €/.test(pt) && /−7,50 €/.test(pt) && /без отстъпка/.test(pt) && /81,50 €/.test(pt) && /не е включен в онлайн плащането/.test(pt) && /ТЕСТОВА СРЕДА/.test(pt));
  check(`${tag}: страницата за плащане без хоризонтално превъртане`, await noOverflow(pay));
  const btnBox = await pay.locator("form button").boundingBox();
  check(`${tag}: бутонът е поне 44 px висок`, !!btnBox && btnBox.height >= 44, btnBox && `${Math.round(btnBox.height)} px`);

  // 4. Отказ (само на компютър), после успех
  if (!mobile) {
    await pay.fill("#cn", "Ivan Ivanov"); await pay.fill("#ad", "Plovdiv, bul. Dunav 10");
    await Promise.all([pay.waitForURL(/3dsgate-dev\.borica\.bg/), pay.click("form button")]);
    await pay.click("#sim-no");
    await pay.waitForSelector("h1");
    await pay.screenshot({ path: `${SHOTS}/4-declined-${sfx}.png`, fullPage: true });
    check(`${tag}: отказ от банката → „Плащането е отказано“, без плащане`, /Плащането е отказано/.test(await pay.locator("main").innerText()) && !(await sql(`select card_paid_at from bookings where id='${id}'`))[0].card_paid_at);
    await pay.goto(link.replace(/^https?:\/\/[^/]+/, B), { waitUntil: "load" });
  }
  await pay.fill("#cn", "Ivan Ivanov"); await pay.fill("#ad", "Plovdiv, bul. Dunav 10");
  await Promise.all([pay.waitForURL(/3dsgate-dev\.borica\.bg/), pay.click("form button")]);
  check(`${tag}: формулярът отива към ТЕСТОВИЯ адрес на БОРИКА (прихванат)`, pay.url().startsWith("https://3dsgate-dev.borica.bg/cgi-bin/cgi_link"));
  await pay.screenshot({ path: `${SHOTS}/5-simulated-bank-${sfx}.png` });
  await pay.click("#sim-ok");
  await pay.waitForSelector("h1");
  await pay.screenshot({ path: `${SHOTS}/6-success-${sfx}.png`, fullPage: true });
  const st = await pay.locator("main").innerText();
  const row = (await sql(`select card_paid_at, total_cents from bookings where id='${id}'`))[0];
  check(`${tag}: успех → „Плащането е успешно“, резервацията е платена (81,50 €)`, /Плащането е успешно/.test(st) && !!row.card_paid_at && row.total_cents === 8150);
  check(`${tag}: страницата след плащането без хоризонтално превъртане`, await noOverflow(pay));
  await pay.goto(link.replace(/^https?:\/\/[^/]+/, B), { waitUntil: "load" });
  await pay.screenshot({ path: `${SHOTS}/7-link-after-paid-${sfx}.png`, fullPage: true });
  check(`${tag}: връзката след плащане – потвърждение, без нов формуляр`, /вече е получено/.test(await pay.locator("main").innerText()) && (await pay.locator("form").count()) === 0);
  check(`${tag}: без JS грешки`, [admin, pay].every((p) => p.errors.length === 0), [admin, pay].flatMap((p) => p.errors).join("; "));
  await ctx.close();
}

// 5. Английски клиент на телефон (страницата за плащане)
{
  const ctx = await context(true, "en-GB");
  const id = await booking("en");
  const r = await (await fetch(B + `/__e2e/sql?q=` + encodeURIComponent(`select id from bookings where id='${id}'`))).json();
  const admin = await newPage(ctx); await login(admin);
  await admin.goto(B + "/admin/bookings/" + id); await admin.click("#cardpay [data-card-link]"); await admin.waitForSelector("#card-url input");
  const link = await admin.inputValue("#card-url input");
  const pay = await newPage(ctx);
  await pay.goto(link.replace(/^https?:\/\/[^/]+/, B), { waitUntil: "load" });
  await pay.screenshot({ path: `${SHOTS}/8-pay-page-en-mobile.png`, fullPage: true });
  const pt = await pay.locator("main").innerText();
  check("телефон, английски: страницата е на английски", r.length === 1 && /Online card payment/.test(pt) && /Card payment discount/.test(pt) && /security deposit/.test(pt) && (await noOverflow(pay)));
  await ctx.close();
}

const mails = await (await fetch(B + "/__e2e/mail")).json();
check("писмата са само прихванати локално (тестови адреси @example.com)", mails.every((m) => /@example\.com$/.test(m.to) || /rentaptb/.test(m.to)), mails.map((m) => m.to).join(","));
check("потвърждение за плащане до клиента (прихванато)", mails.some((m) => /Потвърждение за плащане с карта/.test(m.subject)));
check("нито една заявка не е стигнала до реалната БОРИКА или друг външен сайт", bankHits.every((u) => u.startsWith("https://3dsgate-dev.borica.bg/")), `${bankHits.length} прихванати към тестовия адрес; блокирани външни: ${[...new Set(external)].join(", ") || "няма"}`);
await browser.close();
const f = results.filter((x) => !x).length;
console.log(`\nОБЩО: ${results.length - f} PASS, ${f} FAIL`);
process.exit(f ? 1 : 0);
