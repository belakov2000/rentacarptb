// Браузърна проверка на формата за резервация и резервното известие (Web3Forms) срещу Deploy Preview.
//   npm install --no-save playwright-core@1 && npx playwright-core install chromium
//   node tests/browser/form-fallback.mjs https://<deploy-preview>.netlify.app [--local-index]
// --local-index: браузърът получава локалния index.html на адреса на Preview (за проверка преди нов deploy);
// всички заявки към /api/* отиват към реалните функции на Preview.
// Само синтетични данни (@example.com, тестови номера). Заявките към Web3Forms се прихващат и НЕ се изпращат.
// Писма: заявките стигат до реалните функции на Preview. Извън продукция сървърът не изпраща писма (mail/index.ts,
// mailAllowed) – затова отговорът е notify: "failed". Ако Preview върне друго (напр. по-стара версия без тази защита),
// тестът спира веднага след първата заявка, за да не създава следващи писма.
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const B = process.argv[2];
if (!/^https:\/\/[\w-]+--rentacarptb\.netlify\.app$/.test(B || "")) { console.error("Задайте адреса на Deploy Preview (не production)."); process.exit(1); }
const LOCAL = process.argv.includes("--local-index") ? readFileSync("index.html", "utf8") : null;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP8z8DAQAxgYhhVSF+FAMWKAh8Yq0QdAAAAAElFTkSuQmCC", "base64");
const RUN = Date.now().toString(36);
const SECRET = { egn: "8001019999", idn: "TESTID123456", addr: "ул. Тестова 99", city: "Тестоград", reg: "Тестообласт", mun: "Тестообщина", dln: "TESTDL987654", idp: "МВР-ТЕСТ", a1: "бул. Доставка 5" };
const results = [];
const check = (n, ok, info = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${n} | ${info}`); };
const leaks = (p) => { const s = JSON.stringify(p || {}); return Object.entries(SECRET).filter(([, v]) => s.includes(v)).map(([k]) => k).concat(/\/api\/documents|https?:\/\//.test(s) ? ["link"] : []); };
const browser = await chromium.launch();

async function session(tag, dates, { abort = false, delivery = false } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const w3 = [], api = [], state = { abort };
  if (LOCAL) await page.route((u) => u.origin === B && (u.pathname === "/" || u.pathname === "/index.html"), (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: LOCAL }));
  await page.route("https://api.web3forms.com/**", async (r) => { w3.push(r.request().postDataJSON()); await r.fulfill({ json: { success: true } }); });
  await page.route("**/api/bookings", async (r) => {
    if (state.abort) { api.push("aborted"); return r.abort("connectionreset"); }
    const res = await r.fetch(); const j = await res.json().catch(() => ({}));
    api.push({ status: res.status(), id: j.id, notify: j.notify, duplicate: j.duplicate });
    await r.fulfill({ response: res, json: j });
  });
  const s = { name: "ТЕСТ Браузър " + tag, phone: "+359000000000", mail: `browser-${tag}@example.com`, car: "ka", d1: dates[0], t1: "10:00", d2: dates[1], t2: "10:00", m1: delivery ? "addr" : "office", m2: "office", ...(delivery ? { a1: SECRET.a1 } : {}) };
  await page.addInitScript((x) => { if (!sessionStorage.getItem("req")) sessionStorage.setItem("req", JSON.stringify(x)); }, s);
  await page.goto(B + "/#avtomobili", { waitUntil: "load" });
  await page.waitForSelector("#bk", { state: "visible" });
  return { ctx, page, w3, api, state };
}
async function reopen(page) { await page.evaluate(() => { location.hash = "avtomobili"; }); await page.waitForSelector("#bk", { state: "visible" }); await page.waitForTimeout(800); }
async function fill(page, tag, { skip = [] } = {}) {
  const f = { "#b-name": "ТЕСТ Браузър " + tag, "#b-cit": "BG", "#b-phone": "+359000000000", "#b-mail": `browser-${tag}@example.com`, "#b-idn": SECRET.idn, "#b-egn": SECRET.egn,
    "#b-idd": "2020-01-01", "#b-idp": SECRET.idp, "#b-reg": SECRET.reg, "#b-mun": SECRET.mun, "#b-city": SECRET.city, "#b-addr": SECRET.addr, "#b-dln": SECRET.dln, "#b-dlname": "ТЕСТ", "#b-dld": "2020-01-01", "#b-dlp": SECRET.idp };
  for (const [sel, v] of Object.entries(f)) if (!skip.includes(sel) && (await page.$(sel))) await page.fill(sel, v).catch(() => {});
  for (const id of ["p-idf", "p-idb", "p-dlf", "p-dlb"]) await page.setInputFiles("#" + id, { name: "test.png", mimeType: "image/png", buffer: PNG });
  await page.check('input[name="ptype"][value="village"]').catch(() => {});
  await page.check("#b-ok").catch(() => {});
  const pay = await page.$('input[name="pay"][value="cash"]'); if (pay) await pay.check();
  await page.waitForTimeout(800);
  return page.evaluate(() => formErr());
}
async function submit(page) {
  await page.click("#bk button[type=submit]");
  await page.waitForFunction(() => location.hash === "#blagodarim" || !document.querySelector("#b-err").hidden, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  return page.evaluate(() => ({ hash: location.hash, sub: document.querySelector("#th-sub")?.textContent || "" }));
}

// 0. Откъде е заредена страницата: от самия Preview (без --local-index) или подменена локално
{
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  if (LOCAL) await page.route((u) => u.origin === B && u.pathname === "/", (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: LOCAL }));
  const res = await page.goto(B + "/", { waitUntil: "load" });
  const h = await res.allHeaders();
  const info = await page.evaluate(() => ({ fn: typeof fallbackNotice === "function", old: typeof mailFields !== "undefined", src: [...document.scripts].some((x) => x.text.includes("fallback-notice:start")) }));
  const fromNet = !LOCAL && !!h["x-nf-request-id"] && /netlify/i.test(h.server || "");
  check(LOCAL ? "Страницата е ПОДМЕНЕНА с локален index.html" : "Страницата е заредена от самия Preview (заглавки на Netlify, без подмяна)", (LOCAL || fromNet) && info.fn && info.src && !info.old, `server=${h.server}, x-nf-request-id ${h["x-nf-request-id"] ? "има" : "няма"}, fallbackNotice=${info.fn}, mailFields=${info.old}`);
  await ctx.close();
}
// 1. Успешно записване + кратко резервно известие (в Preview писмата не се изпращат – виж по-горе)
const s1 = await session("ok" + RUN, ["2029-04-01", "2029-04-03"], { delivery: true });
const e1 = await fill(s1.page, "ok" + RUN);
const r1 = await submit(s1.page);
check("Успешно записване (реална функция на Preview)", !e1 && r1.hash === "#blagodarim" && s1.api[0]?.status === 201, `HTTP ${s1.api[0]?.status}, notify=${s1.api[0]?.notify}`);
check("Preview не изпраща писма (сървърът връща notify: failed)", s1.api[0]?.notify === "failed", `notify=${s1.api[0]?.notify}`);
if (s1.api[0]?.notify !== "failed") { console.log("СПРЯНО: Preview може да изпраща реални писма – останалите сценарии не се изпълняват."); await browser.close(); process.exit(1); }
check("Клиентът вижда „получена и се обработва“", /получена успешно и в момента се обработва/.test(r1.sub), "");
check("Резервно известие: точно 1, само разрешени полета", s1.w3.length === 1 && Object.keys(s1.w3[0]).sort().join() === "access_key,from_name,message,subject", Object.keys(s1.w3[0] || {}).join(","));
check("Резервно известие при запис: без ЕГН, документи, адреси, снимки и връзки", leaks(s1.w3[0]).length === 0, leaks(s1.w3[0]).join(",") || "чисто");
console.log("\nПРИМЕР (записана заявка, синтетични данни):\n" + JSON.stringify({ ...s1.w3[0], access_key: "<публичен ключ на формата>" }, null, 2) + "\n");
// 2. Повторно изпращане
await reopen(s1.page); await fill(s1.page, "ok" + RUN); await submit(s1.page);
check("Повторно изпращане → същата резервация, без ново известие", s1.api[1]?.duplicate === true && s1.api[1]?.id === s1.api[0]?.id && s1.w3.length === 1, `HTTP ${s1.api[1]?.status}`);
await s1.ctx.close();
// 3. Мрежова грешка преди запис
const s3 = await session("net" + RUN, ["2029-05-01", "2029-05-03"], { abort: true, delivery: true });
await fill(s3.page, "net" + RUN);
const r3 = await submit(s3.page);
check("Мрежова грешка: клиентът вижда „Благодарим“, 1 резервно известие", r3.hash === "#blagodarim" && s3.api[0] === "aborted" && s3.w3.length === 1, "");
check("Резервно известие при мрежова грешка: без ЕГН, документи, адреси, снимки и връзки", leaks(s3.w3[0]).length === 0, leaks(s3.w3[0]).join(",") || "чисто");
check("…съдържа имейл и телефон за връзка", /browser-net/.test(s3.w3[0]?.message) && /\+359000000000/.test(s3.w3[0]?.message), "");
console.log("\nПРИМЕР (мрежова грешка, синтетични данни):\n" + JSON.stringify({ ...s3.w3[0], access_key: "<публичен ключ на формата>" }, null, 2) + "\n");
// 4. Повторно изпращане след мрежовата грешка
s3.state.abort = false;
await reopen(s3.page); await fill(s3.page, "net" + RUN); await submit(s3.page);
await reopen(s3.page); await fill(s3.page, "net" + RUN); await submit(s3.page);
const created = s3.api.filter((a) => a.status === 201).length, dups = s3.api.filter((a) => a.duplicate).length;
check("След мрежовата грешка повторните опити създават точно 1 резервация", created === 1 && dups === 1, `201: ${created}, duplicate: ${dups}`);
check("Всички резервни известия в този сценарий са без чувствителни данни", s3.w3.every((p) => leaks(p).length === 0), `${s3.w3.length} известия`);
await s3.ctx.close();
// 5. Липсващи полета: формата не се изпраща
const s5 = await session("miss" + RUN, ["2029-06-01", "2029-06-03"]);
const e5 = await fill(s5.page, "miss" + RUN, { skip: ["#b-egn", "#b-phone"] });
const disabled = await s5.page.$eval("#bk button[type=submit]", (b) => b.disabled);
await s5.page.click("#bk button[type=submit]", { force: true }).catch(() => {});
await s5.page.waitForTimeout(1500);
check("Липсващи полета: бутонът е неактивен, нищо не се изпраща", !!e5 && disabled && s5.api.length === 0 && s5.w3.length === 0, e5 || "");
await s5.ctx.close();
await browser.close();
console.log(`ОБЩО: ${results.filter(Boolean).length} PASS, ${results.filter((x) => !x).length} FAIL`);
process.exit(results.every(Boolean) ? 0 : 1);
