// Браузърна проверка на съгласието за бисквитки и Meta Pixel.
//   npm install --no-save playwright-core@1 && npx playwright-core install chromium
//   curl -so /tmp/fbevents.js https://connect.facebook.net/en_US/fbevents.js
//   node tests/browser/meta-pixel.mjs <адрес на Deploy Preview или локален сървър> /tmp/fbevents.js
// Всички заявки към Meta (connect.facebook.net, facebook.com) се прихващат: SDK-то се зарежда от локалното копие,
// а събитията се записват и НЕ стигат до Meta. /api/* и Web3Forms също се подменят – не се създават реални резервации.
// Само синтетични данни.
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { fulfillQuote } from "./quote-stub.mjs";

const B = (process.argv[2] || "").replace(/\/$/, "");
if (!/^(https:\/\/[\w-]+--rentacarptb\.netlify\.app|http:\/\/(localhost|127\.0\.0\.1):\d+)$/.test(B)) { console.error("Задайте адреса на Deploy Preview или локален сървър (не production)."); process.exit(1); }
const SDK = readFileSync(process.argv[3] || "/tmp/fbevents.js", "utf8");
const PIXEL = "1089565650382038";
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP8z8DAQAxgYhhVSF+FAMWKAh8Yq0QdAAAAAElFTkSuQmCC", "base64");
const BID = "SYNBOOKING7", TOK = "syntoken0123456789", DOC = "/api/documents/syndoc-abcdef";
const SECRET = { name: "ТЕСТ Пиксел", mail: "pixel-test@example.com", phone: "359000000000", egn: "8001019999", idn: "TESTID123456", addr: "ул. Тестова 99", city: "Тестоград", reg: "Тестообласт", mun: "Тестообщина", dln: "TESTDL987654", bid: BID, tok: TOK, doc: "syndoc", hash: "blagodarim", cars: "avtomobili" };
const results = [];
const check = (n, ok, info = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${n}${info ? " | " + info : ""}`); };
const leaks = (s) => Object.entries(SECRET).filter(([, v]) => s.includes(v) || s.includes(encodeURIComponent(v))).map(([k]) => k);
const browser = await chromium.launch();

async function session({ consent, storageFails = false, path = "/", booking = "ok" } = {}) {
  const ctx = await browser.newContext({ locale: "bg-BG" });
  const meta = [], other = [], api = [], w3 = [], st = { booking };
  await ctx.route("https://connect.facebook.net/**", (r) => { const u = r.request().url(); meta.push({ url: u, kind: "script" }); return /\/fbevents\.js$/.test(new URL(u).pathname) ? r.fulfill({ contentType: "application/javascript", body: SDK }) : r.fulfill({ status: 204, body: "" }); });
  await ctx.route(/^https:\/\/([\w-]+\.)*facebook\.com\//, (r) => { const q = r.request(); meta.push({ url: q.url(), body: q.postData() || "", referer: q.headers().referer || "", kind: "event" }); return r.fulfill({ contentType: "image/gif", body: GIF }); });
  await ctx.route((u) => !u.href.startsWith(B) && !/facebook\.(net|com)/.test(u.hostname), (r) => { const u = r.request().url(); if (/web3forms/.test(u)) { w3.push(u); return r.fulfill({ json: { success: true } }); } other.push(u); return r.fulfill({ status: 204, body: "" }); });
  // Панелът на Netlify в Deploy Preview (Netlify Drawer) закрива футъра и не е част от сайта.
  await ctx.route(B + "/.netlify/scripts/cdp*", (r) => r.fulfill({ contentType: "application/javascript", body: "" }));
  await ctx.route(B + "/api/**", async (r) => {
    const u = new URL(r.request().url()), m = r.request().method();
    if (u.pathname === "/api/availability") return r.fulfill({ json: { cars: {}, buffer: 0 } });
    if (u.pathname === "/api/documents" && m === "POST") return r.fulfill({ json: { url: B + DOC + Math.random().toString(36).slice(2, 6) } });
    if (u.pathname === "/api/route") return r.fulfill({ json: { km: 10, rate: 0.5 } });
    if (u.pathname === "/api/quote" && m === "POST") return fulfillQuote(r);
    if (u.pathname === "/api/bookings" && m === "POST") {
      api.push(st.booking);
      if (st.booking === "busy") return r.fulfill({ status: 409, json: { error: "busy" } });
      if (st.booking === "err") return r.fulfill({ status: 500, json: { error: "synthetic failure" } });
      return r.fulfill({ status: st.booking === "dup" ? 200 : 201, json: { id: BID, token: TOK, status: "pending", notify: "sent", ...(st.booking === "dup" ? { duplicate: true } : {}) } });
    }
    if (u.pathname.startsWith("/api/bookings/")) return r.fulfill({ json: { status: "pending" } });
    return r.fulfill({ status: 401, json: { error: "mock" } });
  });
  if (storageFails) await ctx.addInitScript(() => { if (window === top) for (const k of ["getItem", "setItem", "removeItem"]) Storage.prototype[k] = () => { throw new DOMException("blocked", "SecurityError"); }; });
  if (consent !== undefined) await ctx.addInitScript((c) => { if (window === top && !localStorage.getItem("__seeded")) { localStorage.setItem("__seeded", "1"); localStorage.setItem("cookie-consent", JSON.stringify(c)); } }, consent);
  const seed = { car: "ka", d1: "2029-04-01", t1: "10:00", d2: "2029-04-03", t2: "10:00", m1: "office", m2: "office" };
  await ctx.addInitScript((x) => { try { if (!sessionStorage.getItem("req")) sessionStorage.setItem("req", JSON.stringify(x)); } catch (e) {} }, seed);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(B + path, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  return { ctx, page, meta, other, api, w3, st, errors };
}
const events = (s, ev) => s.meta.filter((m) => m.kind === "event" && new URL(m.url).searchParams.get("ev") === ev || (m.body && new URLSearchParams(m.body).get("ev") === ev));
const banner = (p) => p.$eval("#ck", (e) => !e.hidden);
const frames = (p) => p.$$eval("iframe[src^='/meta-pixel']", (f) => f.length);
async function fill(page) {
  await page.evaluate(() => { location.hash = "avtomobili"; });
  // Без sessionStorage началното състояние не се зарежда – избира се автомобил и период в самата страница.
  if (!(await page.evaluate(() => !!S.car))) await page.evaluate(() => { Object.assign(S, { car: "ka", d1: "2029-04-01", t1: "10:00", d2: "2029-04-03", t2: "10:00", m1: "office", m2: "office", open: true }); writePlan(); $("#plan").hidden = false; renderCars(); renderPick(); });
  await page.waitForSelector("#bk", { state: "visible" });
  const f = { "#b-name": SECRET.name, "#b-cit": "BG", "#b-phone": "+" + SECRET.phone, "#b-mail": SECRET.mail, "#b-idn": SECRET.idn, "#b-egn": SECRET.egn, "#b-idd": "2020-01-01", "#b-idp": "МВР-ТЕСТ", "#b-reg": SECRET.reg, "#b-mun": SECRET.mun, "#b-city": SECRET.city, "#b-addr": SECRET.addr, "#b-dln": SECRET.dln, "#b-dlname": "ТЕСТ", "#b-dld": "2020-01-01", "#b-dlp": "МВР-ТЕСТ" };
  for (const [sel, v] of Object.entries(f)) if (await page.$(sel)) await page.fill(sel, v).catch(() => {});
  for (const id of ["p-idf", "p-idb", "p-dlf", "p-dlb"]) await page.setInputFiles("#" + id, { name: "test.png", mimeType: "image/png", buffer: PNG });
  await page.check('input[name="ptype"][value="village"]').catch(() => {});
  await page.check("#b-ok").catch(() => {});
  const pay = await page.$('input[name="pay"][value="cash"]'); if (pay) await pay.check();
  await page.waitForTimeout(600);
  return page.evaluate(() => formErr());
}
async function submit(page) {
  await page.evaluate(() => { document.querySelector("#b-err").hidden = true; });
  await page.click("#bk button[type=submit]");
  await page.waitForFunction(() => location.hash === "#blagodarim" || !document.querySelector("#b-err").hidden, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  return page.evaluate(() => location.hash);
}
const V2 = (m) => ({ v: 2, necessary: true, marketing: m, date: "2026-10-01T00:00:00.000Z" });

// 1. Първо посещение
{
  const s = await session();
  check("Първо посещение: банерът е видим, маркетинг е изключен", (await banner(s.page)) && !(await s.page.$eval("#ck-mk", (e) => e.checked)));
  check("Първо посещение: няма iframe и нито една заявка към Meta", (await frames(s.page)) === 0 && s.meta.length === 0, `${s.meta.length} заявки`);
  const btns = await s.page.$$eval("#ck-main [data-ck]", (b) => b.map((x) => x.dataset.ck).join(","));
  check("Банерът има Приемам / Отказвам / Настройки", btns === "yes,no,set", btns);
  await s.page.click("#ck-main [data-ck=set]");
  check("Настройки: маркетинг по подразбиране изключен", !(await s.page.$eval("#ck-mk", (e) => e.checked)));
  await s.page.click("#ck-more [data-ck=save]"); await s.page.waitForTimeout(1500);
  check("Запази без промяна → няма заявки към Meta", s.meta.length === 0 && (await frames(s.page)) === 0);
  await s.ctx.close();
}
// 2. Стар запис само с necessary:true
{
  const s = await session({ consent: { necessary: true, date: "2026-09-01T00:00:00.000Z" } });
  check("Стар запис {necessary:true}: банерът се показва отново, без Meta", (await banner(s.page)) && s.meta.length === 0 && (await frames(s.page)) === 0, `${s.meta.length} заявки`);
  await s.ctx.close();
}
// 3. Отказ, презареждане, резервация след отказ
{
  const s = await session();
  await s.page.click("#ck-main [data-ck=no]"); await s.page.waitForTimeout(1000);
  const saved = await s.page.evaluate(() => localStorage.getItem("cookie-consent"));
  check("Отказ: записва marketing:false, банерът се скрива", /"marketing":false/.test(saved) && !(await banner(s.page)), saved);
  await s.page.reload({ waitUntil: "load" }); await s.page.waitForTimeout(1500);
  check("След отказ и презареждане: без банер, без Meta", !(await banner(s.page)) && s.meta.length === 0);
  const e = await fill(s.page); const h = await submit(s.page);
  check("Резервацията работи след отказ", !e && h === "#blagodarim" && s.api.length === 1, e || h);
  check("След отказ и резервация: 0 заявки към Meta", s.meta.length === 0, `${s.meta.length}`);
  await s.ctx.close();
}
// 4. Съгласие: PageView, изолация, съдържание на заявките, Lead и повторно изпращане
{
  const s = await session();
  check("Преди съгласие: 0 заявки към Meta", s.meta.length === 0);
  await s.page.click("#ck-main [data-ck=yes]"); await s.page.waitForTimeout(3000);
  const pv = events(s, "PageView");
  check("Приемам → iframe и точно 1 PageView", (await frames(s.page)) === 1 && pv.length === 1, `PageView: ${pv.length}, всички: ${s.meta.length}`);
  const fr = s.page.frames().find((f) => f.url().includes("/meta-pixel/"));
  const iso = fr ? await fr.evaluate(() => { const r = {}; try { r.parent = !!parent.document.body; } catch (e) { r.parent = false; } try { r.top = top.location.href; } catch (e) { r.top = ""; } r.origin = self.origin; r.ref = document.referrer; r.cfg = fbq.disableConfigLoading === true; return r; }) : null;
  check("iframe е изолиран: без достъп до страницата, opaque origin, без referrer", iso && iso.parent === false && iso.top === "" && iso.origin === "null" && iso.ref === "", JSON.stringify(iso));
  check("Отдалечената конфигурация на пиксела не се зарежда (няма автоматични събития/съпоставяне)", iso?.cfg && !s.meta.some((m) => /signals\/config/.test(m.url)), s.meta.filter((m) => m.kind === "script").map((m) => new URL(m.url).pathname).join(","));
  if (pv[0]) { const u = new URL(pv[0].url), p = Object.fromEntries(u.searchParams); console.log("  PageView параметри:", JSON.stringify(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.length > 80 ? v.slice(0, 80) + "…" : v])))); check("PageView: id на пиксела, dl = страницата на iframe, без rl, без Referer", p.id === PIXEL && /\/meta-pixel\/$/.test(p.dl || "") && !p.rl && !pv[0].referer, `dl=${p.dl} rl=${p.rl || ""} referer=${pv[0].referer}`); }
  const e = await fill(s.page);
  check("Попълване на формата с лични данни: 0 нови заявки към Meta", s.meta.filter((m) => m.kind === "event").length === 1 && !e, e);
  await s.page.click("#bk button[type=submit]");
  await s.page.waitForFunction(() => location.hash === "#blagodarim", null, { timeout: 30000 }); await s.page.waitForTimeout(2500);
  check("Успешна резервация (201 + id) → точно 1 Lead", events(s, "Lead").length === 1, `Lead: ${events(s, "Lead").length}`);
  check("Няма Purchase/Schedule/CompleteRegistration", ["Purchase", "Schedule", "CompleteRegistration", "SubscribedButtonClick", "Microdata"].every((x) => events(s, x).length === 0));
  s.st.booking = "dup"; const e2 = await fill(s.page); await submit(s.page);
  check("Повторно изпращане (duplicate:true, същият id) → без нов Lead", !e2 && s.api.length === 2 && events(s, "Lead").length === 1, `Lead: ${events(s, "Lead").length}`);
  s.st.booking = "ok"; await fill(s.page); await submit(s.page);
  check("Повторен отговор със същия id (без duplicate) → без нов Lead", s.api.length === 3 && events(s, "Lead").length === 1, `Lead: ${events(s, "Lead").length}`);
  const all = s.meta.map((m) => m.url + " " + (m.body || "") + " " + (m.referer || "")).join("\n");
  check("Заявките към Meta не съдържат лични данни, номер/код на резервация, документи, адрес на страницата", leaks(all).length === 0 && !all.includes(encodeURIComponent(B + "/#")) && !all.includes("/api/"), leaks(all).join(",") || `чисто (${s.meta.length} заявки)`);
  check("Без грешки в страницата", s.errors.length === 0, s.errors.join("; "));
  // 5. Оттегляне от футъра
  await s.page.evaluate(() => { location.hash = "home"; }); await s.page.click("footer [data-ck-open]");
  check("Футър → Настройки: маркетинг е отбелязан", (await banner(s.page)) && (await s.page.$eval("#ck-mk", (e) => e.checked)));
  await s.page.uncheck("#ck-mk"); await s.page.click("#ck-more [data-ck=save]"); await s.page.waitForTimeout(800);
  const n = s.meta.length;
  check("Оттегляне: iframe се премахва", (await frames(s.page)) === 0 && /"marketing":false/.test(await s.page.evaluate(() => localStorage.getItem("cookie-consent"))));
  s.st.booking = "ok"; await s.page.evaluate(() => sessionStorage.removeItem("meta-leads")); await fill(s.page); await submit(s.page);
  await s.page.reload({ waitUntil: "load" }); await s.page.waitForTimeout(2000);
  check("След оттегляне: нова резервация и презареждане → 0 нови заявки към Meta", s.meta.length === n, `${s.meta.length - n} нови`);
  await s.ctx.close();
}
// 6. Грешки при изпращане: 409, 500 + Web3Forms, непопълнена форма
{
  const s = await session({ consent: V2(true), booking: "busy" });
  check("Запазено съгласие → PageView при зареждане", events(s, "PageView").length === 1);
  await s.page.evaluate(() => { location.hash = "avtomobili"; }); await s.page.waitForSelector("#bk", { state: "visible" });
  await s.page.fill("#b-name", SECRET.name); await s.page.click("#bk button[type=submit]", { force: true }).catch(() => {}); await s.page.waitForTimeout(1000);
  check("Непълна форма / клик на бутона → без Lead", events(s, "Lead").length === 0 && s.api.length === 0);
  await fill(s.page); await submit(s.page);
  check("HTTP 409 → без Lead", s.api[0] === "busy" && events(s, "Lead").length === 0);
  s.st.booking = "err"; const h = await submit(s.page);
  check("HTTP 500 → Web3Forms резервно известие, без Lead", h === "#blagodarim" && s.w3.length >= 1 && events(s, "Lead").length === 0, `w3=${s.w3.length}`);
  check("Без грешки в страницата", s.errors.length === 0, s.errors.join("; "));
  await s.ctx.close();
}
// 7. Браузърното хранилище не работи
{
  const s = await session({ storageFails: true });
  check("Без хранилище: банерът се показва, без Meta", (await banner(s.page)) && s.meta.length === 0);
  await s.page.click("#ck-main [data-ck=no]");
  const e = await fill(s.page); const h = await submit(s.page);
  check("Без хранилище + отказ: резервацията работи, 0 заявки към Meta", !e && h === "#blagodarim" && s.meta.length === 0, e || h);
  await s.page.click("footer [data-ck-open]"); await s.page.check("#ck-mk"); await s.page.click("#ck-more [data-ck=save]"); await s.page.waitForTimeout(2500);
  check("Без хранилище + съгласие: PageView в рамките на страницата", events(s, "PageView").length === 1);
  check("Без грешки в страницата", s.errors.length === 0, s.errors.join("; "));
  await s.ctx.close();
}
// 8. Административен панел, покана/вход, EN/DE
for (const [path, label] of [["/admin/", "Административен панел"], ["/#invite_token=synthetic", "Покана за вход"], ["/#recovery_token=synthetic", "Нова парола"]]) {
  const s = await session({ consent: V2(true), path });
  await s.page.waitForTimeout(1000);
  check(`${label} при дадено съгласие: 0 заявки към Meta`, s.meta.length === 0, `${s.meta.length} заявки, адрес ${new URL(s.page.url()).pathname}`);
  await s.ctx.close();
}
for (const [path, word] of [["/en/", "Reject"], ["/de/", "Ablehnen"]]) {
  const s = await session({ path });
  const t = await s.page.$eval("#ck", (e) => e.innerText);
  check(`Банер на ${path}: преведен`, t.includes(word) && !/[А-я]/.test(t), t.slice(0, 80).replace(/\n/g, " "));
  await s.page.click("footer [data-ck-open]");
  const t2 = await s.page.$eval("#ck-more", (e) => e.innerText);
  check(`Настройки на ${path}: преведени`, !/[А-я]/.test(t2), t2.slice(0, 60).replace(/\n/g, " "));
  await s.ctx.close();
}
await browser.close();
console.log(`ОБЩО: ${results.filter(Boolean).length} PASS, ${results.filter((x) => !x).length} FAIL`);
process.exit(results.every(Boolean) ? 0 : 1);
