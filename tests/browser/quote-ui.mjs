// Браузърна проверка на сървърната ценова оферта във формата (етап 2): грешка при маршрута с повторен опит и контакт,
// разбивка от сървъра, променена цена с изрично потвърждение, изтекла оферта (автоматично ново изчисление при същата сума),
// стара страница без оферта, ограничение на заявките (429), английската и немската версия.
//   npm install --no-save embedded-postgres@17.5.0-beta.15 playwright-core@1 && npx playwright-core install chromium
//   node tests/e2e/run.mjs tests/browser/quote-ui.mjs
// Само срещу локалния e2e сървър (истинските функции, временна база, симулирани маршрути и поща). Само синтетични данни.
import { chromium } from "playwright-core";
import jpeg from "jpeg-js";

const B = (process.argv[2] || "").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(B)) { console.error("Само локален e2e сървър (tests/e2e/run.mjs)."); process.exit(1); }
const PNG = (() => { const w = 640, h = 400, d = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) d.set([i % 251, (i * 3) % 253, 90, 255], i * 4); return Buffer.from(jpeg.encode({ data: d, width: w, height: h }, 80).data); })();
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Sofia" });
let n0 = 20, D1 = day(n0); while ([0,6].includes(new Date(D1+"T12:00:00Z").getUTCDay())) D1 = day(++n0);
const D2 = new Date(Date.parse(D1+"T12:00:00Z")+2*864e5).toISOString().slice(0,10);
const res = []; const check = (n, ok, i = "") => { res.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${n} | ${i}`); };
const browser = await chromium.launch();
async function open(seed, opts = {}) {
  const ctx = await browser.newContext({ locale: "bg-BG", viewport: { width: 1280, height: 900 }, ...opts });
  await ctx.route((u) => !u.href.startsWith(B), (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.addInitScript((s) => { localStorage.setItem("cookie-consent", JSON.stringify({ v: 2, necessary: true, marketing: false, date: "2026-10-01T00:00:00.000Z" })); if (!sessionStorage.getItem("req")) sessionStorage.setItem("req", JSON.stringify(s)); }, { car: "golf", d1: D1, t1: "10:00", d2: D2, t2: "10:00", m1: "office", m2: "office", open: true, ...seed });
  const page = await ctx.newPage(); page.errs = []; page.on("pageerror", (e) => page.errs.push(e.message));
  return { ctx, page };
}
async function fill(page) {
  const f = { "#b-name": "ТЕСТ UI", "#b-cit": "BG", "#b-phone": "+359000000123", "#b-mail": "ui-test@example.com", "#b-idn": "TESTID1", "#b-egn": "8001019999", "#b-idd": "2020-01-01", "#b-idp": "МВР-ТЕСТ", "#b-reg": "Т", "#b-mun": "Т", "#b-city": "Тестоград", "#b-addr": "ул. Тестова 1", "#b-dln": "TESTDL1", "#b-dlname": "ТЕСТ", "#b-dld": "2020-01-01", "#b-dlp": "МВР-ТЕСТ" };
  for (const [s, v] of Object.entries(f)) await page.fill(s, v).catch(() => {});
  for (const id of ["p-idf", "p-idb", "p-dlf", "p-dlb"]) await page.setInputFiles("#" + id, { name: "t.jpg", mimeType: "image/jpeg", buffer: PNG });
  await page.check('input[name="ptype"][value="city"]'); await page.check("#b-ok"); await page.check('input[name="pay"][value="cash"]');
  await page.waitForTimeout(500);
}
// 1. Маршрутът не може да бъде изчислен → ясна грешка, повторен опит, контакт, бутонът е неактивен; поправка → цена
{
  const { ctx, page } = await open({ m1: "addr", a1: "ул. Няма 1" });
  await page.goto(B + "/#avtomobili", { waitUntil: "load" });
  await page.waitForSelector("#pick [data-requote]", { timeout: 15000 });
  await fill(page);
  const t = await page.locator("#pick").innerText();
  const dis = await page.$eval("#bk button[type=submit]", (b) => b.disabled);
  const need = await page.locator("#b-need").innerText();
  check("1.1 грешка за адреса: текст, „Изчисли цената отново“, „Обадете се“; без сума", /Не успяхме да изчислим разстоянието до адреса за доставка/.test(t) && /Обадете се/.test(t) && !/Общо за услугите/.test(t), t.replace(/\n/g, " / ").slice(0, 220));
  check("1.2 изпращането е неактивно, причината и бутон за повторен опит са до бутона", dis && /Не успяхме/.test(need) && (await page.$("#b-need [data-requote]")) !== null, need);
  await page.fill("#b-a1", "ул. Тестова 1");
  await page.waitForFunction(() => /Общо за услугите/.test(document.querySelector("#pick").innerText), null, { timeout: 15000 });
  const t2 = await page.locator("#pick").innerText();
  check("1.3 след поправка: сървърна разбивка с доставка 5 км и обща сума; данните във формата са запазени", /Доставка[\s\S]*5 км × 1,00 €[\s\S]*Общо за услугите\s*55 €/.test(t2) && (await page.inputValue("#b-egn")) === "8001019999" && !(await page.$eval("#bk button[type=submit]", (b) => b.disabled)), t2.replace(/\n/g, " / ").slice(0, 260));
  check("1.4 без грешки в страницата", page.errs.length === 0, page.errs.join(";"));
  await ctx.close();
}
// 2. Цената е променена при подаването → нова сума, изисква се потвърждение; потвърждение → изпраща новата сума
{
  const { ctx, page } = await open({});
  let bump = false, posts = [];
  await page.route("**/api/quote", async (r) => { const resp = await r.fetch(); const j = await resp.json(); if (bump) { j.totalCents += 1000; j.total = (j.totalCents / 100) + " €"; } return r.fulfill({ status: resp.status(), json: j }); });
  await page.route("**/api/bookings", async (r) => { posts.push(r.request().postDataJSON()); if (posts.length === 1) { bump = true; return r.fulfill({ status: 409, json: { error: "price_changed", detail: "x", currentCents: 6000 } }); } return r.fulfill({ status: 201, json: { id: "c".repeat(32), token: "d".repeat(64), status: "pending" } }); });
  await page.goto(B + "/#avtomobili", { waitUntil: "load" });
  await page.waitForFunction(() => /Общо за услугите/.test(document.querySelector("#pick").innerText), null, { timeout: 15000 });
  await fill(page);
  await page.click("#bk button[type=submit]");
  await page.waitForSelector("#b-err:not([hidden])", { timeout: 20000 });
  const err = await page.locator("#b-err").innerText(), lbl = await page.locator("#bk button[type=submit]").innerText(), pk = await page.locator("#pick").innerText();
  check("2.1 променена цена: съобщение със старата и новата сума, без автоматично записване", posts.length === 1 && /беше 50 €, сега е 60 €/.test(err), err);
  check("2.2 бутонът иска изрично потвърждение; обобщението показва новата сума", /Потвърждавам новата цена/.test(lbl) && /Цената е променена: беше 50 €, сега е 60 €/.test(pk), lbl);
  await page.click("#bk button[type=submit]");
  await page.waitForFunction(() => location.hash === "#blagodarim", null, { timeout: 20000 });
  check("2.3 след потвърждение се изпраща новата оферта и сума", posts.length === 2 && posts[1].quoteTotalCents === 6000 && posts[1].quote !== posts[0].quote && !("total" in posts[1]), `${posts[1]?.quoteTotalCents}`);
  await ctx.close();
}
// 3. Изтекла оферта: нова оферта със същата сума → автоматично повторно изпращане, без второ качване на снимките
{
  const { ctx, page } = await open({});
  let posts = [], docs = 0;
  await page.route("**/api/documents", async (r) => { docs++; return r.fallback(); });
  await page.route("**/api/bookings", async (r) => { posts.push(r.request().postDataJSON()); if (posts.length === 1) return r.fulfill({ status: 409, json: { error: "quote_expired" } }); return r.fallback(); });
  await page.goto(B + "/#avtomobili", { waitUntil: "load" });
  await page.waitForFunction(() => /Общо за услугите/.test(document.querySelector("#pick").innerText), null, { timeout: 15000 });
  await fill(page);
  await page.click("#bk button[type=submit]");
  await page.waitForFunction(() => location.hash === "#blagodarim" || !document.querySelector("#b-err").hidden, null, { timeout: 30000 });
  check("3.1 изтекла оферта → нова оферта (същата сума) и автоматично изпращане към реалния сървър; снимките се качват веднъж", (await page.evaluate(() => location.hash)) === "#blagodarim" && posts.length === 2 && posts[0].quote !== posts[1].quote && docs === 4, `posts ${posts.length}, docs ${docs}`);
  await ctx.close();
}
// 4. Стара версия на страницата (без оферта) → сървърът отказва (409), нищо не се записва
{
  const r = await fetch(B + "/api/bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "ТЕСТ", email: "old@example.com", phone: "+359", car: "Golf", carId: "golf", startDate: D1, endDate: D2, startTime: "10:00", endTime: "10:00", pickup: "x", dropoff: "y", total: "1 €", message: "ТЕСТ", payment: "cash" }) });
  const j = await r.json();
  check("4.1 заявка без оферта (стара страница) → 409 quote_required", r.status === 409 && j.error === "quote_required", JSON.stringify(j));
}
// 5. Английска версия: същите състояния, преведени → ясна грешка, повторен опит, контакт, бутонът е неактивен; поправка → цена
{
  const { ctx, page } = await open({ m1: "addr", a1: "ул. Няма 1" });
  await page.goto(B + "/en/#avtomobili", { waitUntil: "load" });
  await page.waitForSelector("#pick [data-requote]", { timeout: 15000 });
  await fill(page);
  const t = await page.locator("#pick").innerText();
  const dis = await page.$eval("#bk button[type=submit]", (b) => b.disabled);
  const need = await page.locator("#b-need").innerText();
  check("5.1 грешка за адреса: текст, „Изчисли цената отново“, „Обадете се“; без сума", /We could not calculate the distance to the delivery address\. Please check the address/.test(t) && /Call us/.test(t) && /Please try again or call \+359877748693/.test(t) && !/[А-я]/.test(t.replace(/Volkswagen Golf 5/,"")), t.replace(/\n/g, " / ").slice(0, 220));
  check("5.2 изпращането е неактивно, причината и бутон за повторен опит са до бутона", dis && /We could not/.test(need) && (await page.$("#b-need [data-requote]")) !== null, need);
  await page.fill("#b-a1", "ул. Тестова 1");
  await page.waitForFunction(() => /Total for services/.test(document.querySelector("#pick").innerText), null, { timeout: 15000 });
  const t2 = await page.locator("#pick").innerText();
  check("5.3 след поправка: сървърна разбивка с доставка 5 км и обща сума; данните във формата са запазени", /Delivery[\s\S]*5 km × 1,00 €[\s\S]*Total for services\s*55 €/.test(t2) && /calculated by our server/.test(t2) && (await page.inputValue("#b-egn")) === "8001019999" && !(await page.$eval("#bk button[type=submit]", (b) => b.disabled)), t2.replace(/\n/g, " / ").slice(0, 260));
  check("5.4 без грешки в страницата", page.errs.length === 0, page.errs.join(";"));
  await ctx.close();
}
// 6. Немска версия: грешка за адреса, разбивка, бутоните – без останал български текст
{
  const { ctx, page } = await open({ m1: "addr", a1: "ул. Няма 1" });
  await page.goto(B + "/de/#avtomobili", { waitUntil: "load" });
  await page.waitForSelector("#pick [data-requote]", { timeout: 15000 });
  await fill(page);
  const t = await page.locator("#pick").innerText(), need = await page.locator("#b-need").innerText();
  const cyr = (x) => x.replace(/Volkswagen Golf 5/g, "").match(/[А-я][А-я ,.()]*/g) || [];
  check("6.1 DE: грешка за адреса, „Preis neu berechnen“, „Rufen Sie uns an“, без кирилица", /Wir konnten die Entfernung zur Lieferadresse nicht berechnen\. Bitte prüfen Sie die Adresse/.test(t) && /Preis neu berechnen/.test(t) && /Rufen Sie uns an/.test(t) && /Ihre Angaben bleiben erhalten/.test(t) && !cyr(t).length && !cyr(need).length, (cyr(t).concat(cyr(need)).join(" | ") || t.replace(/\n/g, " / ")).slice(0, 220));
  await page.fill("#b-a1", "ул. Тестова 1");
  await page.waitForFunction(() => /Gesamt für Leistungen/.test(document.querySelector("#pick").innerText), null, { timeout: 15000 });
  const t2 = await page.locator("#pick").innerText(), btn = await page.locator("#bk button[type=submit]").innerText();
  check("6.2 DE: сървърна разбивка (Lieferung 5 km × 1,00 €, Gesamt 55 €), бележка за сървърната цена, Kaution, бутон на немски", /Lieferung[\s\S]*5 km × 1,00 €[\s\S]*Gesamt für Leistungen\s*55 €/.test(t2) && /von unserem Server/.test(t2) && /Kaution/.test(t2) && !cyr(t2).length && /Buchung senden/.test(btn), (cyr(t2).join(" | ") || btn));
  check("6.3 DE: без грешки в страницата", page.errs.length === 0, page.errs.join(";"));
  await ctx.close();
}
// 7. Твърде много заявки (429) на трите езика: ясно съобщение, повторен опит; изпращането е неактивно; ключ на раздела в заглавката
for (const [lang, re] of [["", /Направени са твърде много изчисления на цената за кратко време\. Изчакайте около минута/], ["en/", /Too many price calculations in a short time\. Please wait about a minute/], ["de/", /Zu viele Preisberechnungen in kurzer Zeit\. Bitte warten Sie etwa eine Minute/]]) {
  const { ctx, page } = await open({});
  let limited = true, cid = [];
  await page.route("**/api/quote", (r) => { cid.push(r.request().headers()["x-client-id"] || ""); return limited ? r.fulfill({ status: 429, headers: { "Retry-After": "60" }, json: { error: "rate_limited", scope: "quote:client", retryAfter: 60 } }) : r.fallback(); });
  await page.goto(B + "/" + lang + "#avtomobili", { waitUntil: "load" });
  await page.waitForSelector("#pick [data-requote]", { timeout: 15000 });
  await fill(page);
  const t = await page.locator("#pick").innerText(), dis = await page.$eval("#bk button[type=submit]", (b) => b.disabled);
  limited = false;
  await page.click("#pick [data-requote]");
  await page.waitForFunction(() => /(Общо за услугите|Total for services|Gesamt für Leistungen)/.test(document.querySelector("#pick").innerText), null, { timeout: 15000 });
  const ok = !(await page.$eval("#bk button[type=submit]", (b) => b.disabled));
  check(`7.${lang || "bg/"} 429: съобщение на езика на страницата, бутонът е неактивен; „Изчисли отново“ след изчакване → цена`, re.test(t) && dis && ok && cid.length > 0 && cid.every((c) => /^[a-f0-9]{32}$/.test(c)) && new Set(cid).size === 1, t.replace(/\n/g, " / ").slice(0, 200));
  await ctx.close();
}
// 8. Нееднозначен адрес (регресия Бяла река) и адрес с непотвърден номер (на картата е само улицата) на трите езика:
// „гр. Пловдив, пл. Централен 1“ → искане за уточнение; „ул. Улична 4“ → искане за уточнение на номера и контакт.
// И в двата случая няма сума, изпращането е неактивно; с потвърден номер → цена.
for (const [lang, amb, imp, total] of [
  ["", /Адресът за доставка не беше намерен в посоченото населено място и улица\. Уточнете адреса/, /Не намерихме точния номер на адреса за доставка на картата – цената не може да бъде изчислена до произволна точка от улицата\. Уточнете улицата и номера или се обадете/, /Общо за услугите\s*55 €/],
  ["en/", /The delivery address was not found in the given town and street\. Please specify the address/, /We could not find the exact house number of the delivery address on the map – the price cannot be calculated to an arbitrary point on the street\. Please specify the street and number or call us/, /Total for services\s*55 €/],
  ["de/", /Die Lieferadresse wurde im angegebenen Ort und in der angegebenen Straße nicht gefunden\. Bitte präzisieren Sie die Adresse/, /Wir konnten die genaue Hausnummer der Lieferadresse auf der Karte nicht finden – der Preis kann nicht bis zu einem beliebigen Punkt der Straße berechnet werden/, /Gesamt für Leistungen\s*55 €/],
]) {
  const { ctx, page } = await open({ m1: "addr", a1: "гр. Пловдив, пл. Централен 1" });
  await page.goto(B + "/" + lang + "#avtomobili", { waitUntil: "load" });
  await page.waitForSelector("#pick [data-requote]", { timeout: 15000 });
  await fill(page);
  const t = await page.locator("#pick").innerText(), dis = await page.$eval("#bk button[type=submit]", (b) => b.disabled);
  const noSum = (x) => !/49,8|Общо за услугите|Total for services|Gesamt für/.test(x);
  check(`8.${lang || "bg/"} нееднозначен адрес: искане за уточнение, без сума и без 49,8 км; изпращането е неактивно`, amb.test(t) && noSum(t) && dis, t.replace(/\n/g, " / ").slice(0, 240));
  await page.fill("#b-a1", "ул. Улична 4");
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector("#pick").innerText), imp.source, { timeout: 15000 });
  const t2 = await page.locator("#pick").innerText(), dis2 = await page.$eval("#bk button[type=submit]", (b) => b.disabled);
  const tel = await page.$("#pick a[href^='tel:']"), rq = await page.$("#pick [data-requote]");
  check(`8.${lang || "bg/"} непотвърден номер: искане за уточнение и бутон за обаждане, без км и сума; изпращането е неактивно`, imp.test(t2) && noSum(t2) && !/4,1 (км|km)/.test(t2) && !!tel && !!rq && dis2, t2.replace(/\n/g, " / ").slice(0, 300));
  await page.fill("#b-a1", "ул. Тестова 1");
  await page.waitForFunction(() => /5 (км|km) × 1,00 €/.test(document.querySelector("#pick").innerText), null, { timeout: 15000 });
  const t3 = await page.locator("#pick").innerText();
  check(`8.${lang || "bg/"} потвърден номер: цена 5 км × 1,00 €, обща сума 55 €; без грешки в страницата`, total.test(t3) && page.errs.length === 0, page.errs.join(";"));
  await ctx.close();
}
// 9. Летище София без терминал (доставка и връщане) на трите езика: съобщение за избор, бутони „Терминал 1“ / „Терминал 2“,
// неактивни „Продължи с данните“ и изпращане; избор → адресът е точният терминал, цена от сървъра и активен бутон
for (const [lang, msgDel, msgRet, t2txt, t1txt, line2, line1] of [
  ["", /Изберете терминал на Летище София за доставката/, /Изберете терминал на Летище София за връщането/, "Летище София, Терминал 2", "Летище София, Терминал 1", /до Летище София, Терминал 2 · 139,3 км × 0,70 €/, /до Летище София, Терминал 1 · 138,5 км × 0,70 €/],
  ["en/", /Please choose the Sofia Airport terminal for the delivery/, /Please choose the Sofia Airport terminal for the collection/, "Sofia Airport, Terminal 2", "Sofia Airport, Terminal 1", /to Sofia Airport, Terminal 2 · 139,3 km × 0,70 €/, /to Sofia Airport, Terminal 1 · 138,5 km × 0,70 €/],
  ["de/", /Bitte wählen Sie das Terminal am Flughafen Sofia für die Lieferung/, /Bitte wählen Sie das Terminal am Flughafen Sofia für die Abholung/, "Flughafen Sofia, Terminal 2", "Flughafen Sofia, Terminal 1", /zum Flughafen Sofia, Terminal 2 · 139,3 km × 0,70 €/, /zum Flughafen Sofia, Terminal 1 · 138,5 km × 0,70 €/],
]) {
  const L = lang || "bg/";
  const { ctx, page } = await open({ m1: "addr", a1: "Летище София" });
  await page.goto(B + "/" + lang + "#avtomobili", { waitUntil: "load" });
  await page.waitForSelector("#pick [data-term]", { timeout: 15000 });
  const t = await page.locator("#pick").innerText();
  const cont = await page.$eval("#pick [data-details]", (b) => b.disabled);
  const btns = await page.$$eval("#pick [data-term]", (bs) => bs.map((b) => b.innerText.trim()));
  check(`9.${L} неясен терминал: съобщение, бутони Терминал 1 / 2, без сума; „Продължи с данните“ е неактивен`, msgDel.test(t) && btns.join("|") === "Terminal 1|Terminal 2".replace(/Terminal/g, lang ? "Terminal" : "Терминал") && cont && !/Общо за услугите|Total for services|Gesamt für/.test(t), `${btns} ${cont} ${t.replace(/\n/g, " / ").slice(0, 200)}`);
  await page.click("#pick [data-term$=':2']");
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector("#pick").innerText), line2.source, { timeout: 15000 });
  const v = await page.inputValue("#b-a1"), cont2 = await page.$eval("#pick [data-details]", (b) => b.disabled);
  check(`9.${L} избран Терминал 2: адресът е „${t2txt}“, сървърна цена 139,3 км × 0,70 €; „Продължи“ е активен`, v === t2txt && !cont2 && page.errs.length === 0, `${v} ${cont2} ${page.errs}`);
  // Връщане от летището без терминал → избор за връщането
  await page.check('input[name="m2"][value="addr"]');
  await page.fill("#b-a2", "Sofia Airport");
  await page.waitForSelector("#pick [data-term^='2:']", { timeout: 15000 });
  const t3 = await page.locator("#pick").innerText(), cont3 = await page.$eval("#pick [data-details]", (b) => b.disabled);
  check(`9.${L} връщане без терминал: искане за избор за връщането; „Продължи“ отново е неактивен`, msgRet.test(t3) && cont3, t3.replace(/\n/g, " / ").slice(0, 200));
  await page.click("#pick [data-term='2:1']");
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector("#pick").innerText), line1.source, { timeout: 15000 });
  const t4 = await page.locator("#pick").innerText();
  check(`9.${L} връщане от Терминал 1 (138,5 км) и доставка до Терминал 2 (139,3 км): два отделни реда, сума 50 + 97,51 + 96,95 = 244,46 €`, (await page.inputValue("#b-a2")) === t1txt && line2.test(t4) && line1.test(t4) && /244,46 €/.test(t4), t4.replace(/\n/g, " / ").slice(0, 400));
  // Бутонът „Продължи“ при грешка не премества към данните
  await page.fill("#b-a1", "гр. Пловдив, пл. Централен 1");
  await page.waitForSelector("#pick [data-requote]", { timeout: 15000 });
  const y0 = await page.evaluate(() => scrollY);
  await page.$eval("#pick [data-details]", (b) => { b.disabled = false; b.click(); }); // дори ако бутонът бъде активиран
  await page.waitForTimeout(400);
  const msg = await page.locator("#pick-msg").innerText();
  check(`9.${L} грешка за адреса: „Продължи“ е неактивен, а принудителното натискане показва причината и не продължава`, msg.length > 0 && Math.abs((await page.evaluate(() => scrollY)) - y0) < 5, msg);
  await ctx.close();
}
// 10. Предложения от Google за адреса (симулиран Google на локалния сървър) на трите езика: показване, без автоматичен
// избор, клавиатура, мишка, промяна след избор, „Продължи“ само с валидна оферта
const pick = (page) => page.locator("#pick").innerText();
const waitPick = (page, re) => page.waitForFunction((s) => new RegExp(s).test(document.querySelector("#pick").innerText), re.source, { timeout: 15000 });
const contDisabled = (page) => page.$eval("#pick [data-details]", (b) => b.disabled);
for (const [lang, hint] of [["", /Започнете да пишете и изберете адреса от предложенията/], ["en/", /Start typing and choose the address from the suggestions/], ["de/", /Beginnen Sie zu tippen und wählen Sie die Adresse aus den Vorschlägen/]]) {
  const L = lang || "bg/";
  const { ctx, page } = await open({ m1: "addr", a1: "" });
  const posts = [], plq = [];
  page.on("request", (r) => { if (r.url().includes("/api/quote")) posts.push(JSON.parse(r.postData() || "{}")); if (r.url().includes("/api/places")) plq.push(new URL(r.url())); });
  await page.goto(B + "/" + lang + "#avtomobili", { waitUntil: "load" });
  await page.click("#b-a1");
  await page.keyboard.type("Гладст", { delay: 40 });
  await page.waitForSelector("#b-a1-list:not([hidden]) [role=option]", { timeout: 15000 });
  const opts = await page.$$eval("#b-a1-list [role=option]", (os) => os.map((o) => o.innerText.replace(/\n/g, " | ")));
  const attr = await page.locator("#b-a1-list .ac-attr").innerText();
  const aria = await page.$eval("#b-a1", (i) => [i.getAttribute("role"), i.getAttribute("aria-expanded"), i.getAttribute("aria-controls")].join());
  await waitPick(page, /Не успяхме|We could not|Wir konnten|номер|number|Hausnummer|Изберете|choose|wählen/);
  const sel0 = await page.$$eval("#b-a1-list [aria-selected=true]", (x) => x.length);
  const t0 = await pick(page);
  const q = plq.at(-1);
  check(`10.${L} предложения под полето: улица и номер + населено място, атрибуция „Google Maps“, достъпен списък; език ${lang || "bg"}, сесия`,
    opts[0] === "ул. „Гладстон“ 10 | Пловдив, България" && attr === "Google Maps" && aria === "combobox,true,b-a1-list" && q.searchParams.get("lang") === (lang ? lang.slice(0, 2) : "bg") && /^[a-f0-9]{32}$/.test(q.searchParams.get("session")) && hint.test(await page.locator("#plan").innerText()), `${opts} ${attr} ${aria}`);
  check(`10.${L} без автоматичен избор: нищо не е маркирано, текстът е въведеният, офертата е без избрано място; „Продължи“ е неактивен`,
    sel0 === 0 && (await page.inputValue("#b-a1")) === "Гладст" && posts.at(-1)?.deliveryPlace === null && (await contDisabled(page)) && !/3,3 (км|km)/.test(t0), t0.replace(/\n/g, " / ").slice(0, 160));
  // Клавиатура: ↓ и Enter
  await page.keyboard.press("ArrowDown");
  const act = await page.$eval("#b-a1", (i) => i.getAttribute("aria-activedescendant"));
  await page.keyboard.press("Enter");
  await waitPick(page, /3,3 (км|km) × 1,00 €/);
  const v = await page.inputValue("#b-a1"), sent = posts.at(-1);
  check(`10.${L} клавиатура (↓, Enter): избран адрес, оферта с Place ID и сесията на търсенето, 3,3 км × 1,00 €; „Продължи“ е активен`,
    act === "b-a1-list-0" && v === "ул. „Гладстон“ 10, Пловдив, България" && sent.deliveryPlace?.id === "gp_pdv_gladston_10" && sent.deliveryPlace.session === q.searchParams.get("session") && !(await contDisabled(page)) && (await page.$("#b-a1-list[hidden]")) !== null, `${act} ${v}`);
  // Промяна на текста след избора → изборът и офертата са обезсилени
  await page.focus("#b-a1");
  for (let k = 0; k < 9; k++) await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");
  await waitPick(page, /5 (км|km) × 1,00 €/);
  check(`10.${L} промяна след избора: Place ID не се изпраща, нова оферта по текста (не 3,3 км)`, posts.at(-1).deliveryPlace === null && !/3,3 (км|km)/.test(await pick(page)), JSON.stringify(posts.at(-1)).slice(0, 160));
  // Мишка: връщане от Летище София → „Терминал 2“
  await page.check('input[name="m2"][value="addr"]');
  await page.click("#b-a2");
  await page.keyboard.type("Летище Соф", { delay: 40 });
  await page.waitForSelector("#b-a2-list:not([hidden]) [role=option]", { timeout: 15000 });
  await page.click("#b-a2-list [role=option]:has-text('Терминал 2')");
  await waitPick(page, /(Терминал|Terminal) 2 · 139,3 (км|km) × 0,70 €/);
  const t3 = await pick(page);
  check(`10.${L} мишка: връщане от „Терминал 2“ (Google) → точката пред Т2, 139,3 км × 0,70 €; два отделни реда`, /(Терминал|Terminal) 2 · 139,3 (км|km)/.test(t3) && posts.at(-1).returnPlace?.id === "gp_sofia_t2" && page.errs.length === 0, t3.replace(/\n/g, " / ").slice(0, 300));
  // Google „Летище София“ (цялото летище) → избор на терминал; Esc затваря списъка
  await page.fill("#b-a2", "");
  await page.keyboard.type("Летище Соф", { delay: 40 });
  await page.waitForSelector("#b-a2-list:not([hidden]) [role=option]", { timeout: 15000 });
  await page.click("#b-a2-list [role=option]:first-child");
  await page.waitForSelector("#pick [data-term^='2:']", { timeout: 15000 });
  check(`10.${L} „Летище София“ от Google → искане за терминал; „Продължи“ е неактивен`, await contDisabled(page));
  await page.click("#b-a2"); await page.keyboard.type(" x", { delay: 40 }); await page.keyboard.press("Escape");
  check(`10.${L} Esc затваря списъка`, (await page.$("#b-a2-list[hidden]")) !== null);
  await ctx.close();
}
// 10м. Телефон (докосване): София, бул. Витоша 1 → 146,2 км × 0,70 €; само улица → уточнение
{
  const { ctx, page } = await open({ m1: "addr", a1: "" }, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await page.goto(B + "/#avtomobili", { waitUntil: "load" });
  await page.tap("#b-a1");
  await page.keyboard.type("Витош", { delay: 40 });
  await page.waitForSelector("#b-a1-list:not([hidden]) [role=option]", { timeout: 15000 });
  await page.tap("#b-a1-list [role=option]:nth-child(2)");
  await waitPick(page, /Изберете адреса от предложенията|номер/);
  const t1 = await pick(page);
  await page.fill("#b-a1", ""); await page.tap("#b-a1"); await page.keyboard.type("Витош", { delay: 40 });
  await page.waitForSelector("#b-a1-list:not([hidden]) [role=option]", { timeout: 15000 });
  await page.tap("#b-a1-list [role=option]:first-child");
  await waitPick(page, /146,2 км × 0,70 €/);
  check("10м. телефон (докосване): само „бул. Витоша“ → уточнение; „бул. Витоша 1“ → 146,2 км × 0,70 € = 102,34 €", /Изберете адреса от предложенията/.test(t1) && /102,34 €/.test(await pick(page)) && page.errs.length === 0, t1.replace(/\n/g, " / ").slice(0, 200));
  await ctx.close();
}
// 10н. Без ключ за Google (503) и грешка на Google (502): без предложения, без грешки; въведеният текст работи както досега
for (const [st, name] of [[503, "без ключ"], [502, "грешка на Google"]]) {
  const { ctx, page } = await open({ m1: "addr", a1: "" });
  let n = 0;
  await page.route("**/api/places**", (r) => { n++; return r.fulfill({ status: st, json: { error: st === 503 ? "unavailable" : "provider" } }); });
  await page.goto(B + "/#avtomobili", { waitUntil: "load" });
  await page.click("#b-a1"); await page.keyboard.type("ул. Тестова 1", { delay: 30 });
  await waitPick(page, /5 км × 1,00 €/);
  await page.keyboard.type("0", { delay: 30 }); await page.waitForTimeout(600);
  const hint = await page.$$eval("[data-ac-hint]", (h) => h.filter((x) => !x.hidden).length);
  check(`10н. ${name}: няма списък и подсказка, без грешки в страницата; цена по въведения текст`, n >= 1 && (await page.$("#b-a1-list[hidden]")) !== null && hint === 0 && page.errs.length === 0 && (st === 502 || n === 1), `заявки ${n}, подсказки ${hint}`);
  await ctx.close();
}
await browser.close();
console.log(`ОБЩО: ${res.filter(Boolean).length} PASS, ${res.filter((x) => !x).length} FAIL`);
process.exit(res.every(Boolean) ? 0 : 1);
