// Браузърна проверка на рекламния източник (UTM) през формата за резервация.
//   npm install --no-save playwright-core@1 && npx playwright-core install chromium
//   node tests/browser/utm-attribution.mjs <адрес на Deploy Preview или локален сървър>
// /api/* се подменя (не се създават реални резервации и не се пращат имейли), заявките към Meta се спират. Само синтетични данни.
import { chromium } from "playwright-core";

const B = (process.argv[2] || "").replace(/\/$/, "");
if (!/^(https:\/\/[\w-]+--rentacarptb\.netlify\.app|http:\/\/(localhost|127\.0\.0\.1):\d+)$/.test(B)) { console.error("Задайте адреса на Deploy Preview или локален сървър (не production)."); process.exit(1); }
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP8z8DAQAxgYhhVSF+FAMWKAh8Yq0QdAAAAAElFTkSuQmCC", "base64");
const A = "utm_source=meta&utm_medium=paid_social&utm_campaign=ptb_plovdiv_video_test&utm_content=video_a_woman";
const Bv = "utm_source=meta&utm_medium=paid_social&utm_campaign=ptb_plovdiv_video_test&utm_content=video_b_man";
const results = [];
const check = (n, ok, info = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${n}${info ? " | " + info : ""}`); };
const browser = await chromium.launch();
const V2 = (m) => ({ v: 2, necessary: true, marketing: m, date: "2026-10-01T00:00:00.000Z" });
const stored = (content, daysAgo, extra = {}) => ({ v: 1, source: "meta", medium: "paid_social", campaign: "ptb_plovdiv_video_test", content, term: "", at: new Date(Date.now() - daysAgo * 864e5).toISOString(), ...extra });

async function session({ consent, attr, path = "/" } = {}) {
  const ctx = await browser.newContext({ locale: "bg-BG" });
  const posts = [];
  await ctx.route((u) => !u.href.startsWith(B), (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route(B + "/.netlify/scripts/cdp*", (r) => r.fulfill({ contentType: "application/javascript", body: "" }));
  await ctx.route(B + "/api/**", (r) => {
    const u = new URL(r.request().url()), m = r.request().method();
    if (u.pathname === "/api/availability") return r.fulfill({ json: { cars: {}, buffer: 0 } });
    if (u.pathname === "/api/documents" && m === "POST") return r.fulfill({ json: { url: B + "/api/documents/syn" + Math.random().toString(36).slice(2, 8) } });
    if (u.pathname === "/api/route") return r.fulfill({ json: { km: 10, rate: 0.5 } });
    if (u.pathname === "/api/bookings" && m === "POST") { posts.push(JSON.parse(r.request().postData() || "{}")); return r.fulfill({ status: 201, json: { id: "SYN" + posts.length, token: "tok", status: "pending" } }); }
    if (u.pathname.startsWith("/api/bookings/")) return r.fulfill({ json: { status: "pending" } });
    return r.fulfill({ status: 401, json: { error: "mock" } });
  });
  await ctx.addInitScript(([c, a]) => { if (window === top && !localStorage.getItem("__seeded")) { localStorage.setItem("__seeded", "1"); if (c) localStorage.setItem("cookie-consent", JSON.stringify(c)); if (a) localStorage.setItem("ad-attribution", JSON.stringify(a)); } }, [consent, attr]);
  const seed = { car: "ka", d1: "2029-04-01", t1: "10:00", d2: "2029-04-03", t2: "10:00", m1: "office", m2: "office" };
  await ctx.addInitScript((x) => { try { if (!sessionStorage.getItem("req")) sessionStorage.setItem("req", JSON.stringify(x)); } catch (e) {} }, seed);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(B + path, { waitUntil: "load" });
  await page.waitForTimeout(800);
  return { ctx, page, posts, errors };
}
async function book(page) {
  await page.evaluate(() => { location.hash = "avtomobili"; });
  await page.waitForSelector("#bk", { state: "visible" });
  const f = { "#b-name": "ТЕСТ UTM", "#b-cit": "BG", "#b-phone": "+359000000000", "#b-mail": "utm-test@example.com", "#b-idn": "TESTID1", "#b-egn": "8001019999", "#b-idd": "2020-01-01", "#b-idp": "МВР-ТЕСТ", "#b-city": "Тестоград", "#b-addr": "ул. Тестова 1", "#b-dln": "TESTDL1", "#b-dlname": "ТЕСТ", "#b-dld": "2020-01-01", "#b-dlp": "МВР-ТЕСТ" };
  for (const [sel, v] of Object.entries(f)) if (await page.$(sel)) await page.fill(sel, v).catch(() => {});
  for (const id of ["p-idf", "p-idb", "p-dlf", "p-dlb"]) await page.setInputFiles("#" + id, { name: "test.png", mimeType: "image/png", buffer: PNG });
  await page.check("#b-ok").catch(() => {});
  const pay = await page.$('input[name="pay"][value="cash"]'); if (pay) await pay.check();
  await page.waitForTimeout(400);
  await page.click("#bk button[type=submit]");
  await page.waitForFunction(() => location.hash === "#blagodarim" || !document.querySelector("#b-err").hidden, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  return page.evaluate(() => location.hash);
}
const ls = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("ad-attribution") || "null"));
const near = (iso, ms = 120_000) => Math.abs(Date.parse(iso) - Date.now()) < ms;

// 1–2. Двата варианта при дадено съгласие, през стъпките на резервацията (и на /en/)
{
  const s = await session({ consent: V2(true), path: "/?" + A });
  const h = await book(s.page);
  const at = s.posts[0]?.attribution;
  check("1. Видео А: източникът стига до заявката през стъпките", h === "#blagodarim" && at?.content === "video_a_woman" && at.source === "meta" && at.medium === "paid_social" && at.campaign === "ptb_plovdiv_video_test" && near(at.at), JSON.stringify(at));
  check("1a. Изпраща се само проверените полета (без адрес на страницата)", Object.keys(at || {}).sort().join() === "at,campaign,content,medium,source,term" && !JSON.stringify(s.posts[0]).includes("utm_source="), "");
  check("1b. Без грешки в страницата", s.errors.length === 0, s.errors.join("; "));
  await s.ctx.close();
}
{
  const s = await session({ consent: V2(true), path: "/en/?" + Bv });
  await s.page.goto(B + "/en/", { waitUntil: "load" }); // преминаване към страница без UTM (напр. друг раздел)
  const h = await book(s.page);
  check("2. Видео Б (на /en/): запазено след преминаване към страница без UTM", h === "#blagodarim" && s.posts[0]?.attribution?.content === "video_b_man", JSON.stringify(s.posts[0]?.attribution));
  await s.ctx.close();
}
// 3. Директно посещение не презаписва; ново посещение с UTM заменя целия източник (без смесване)
{
  const s = await session({ consent: V2(true), attr: stored("video_a_woman", 2, { term: "old-term" }), path: "/" });
  await book(s.page);
  const at = s.posts[0]?.attribution;
  check("3. Директно посещение: остава записаният източник с неговия момент", at?.content === "video_a_woman" && at.term === "old-term" && near(at.at, 2 * 864e5 + 120_000) && !near(at.at), JSON.stringify(at));
  await s.ctx.close();
}
{
  const s = await session({ consent: V2(true), attr: stored("video_a_woman", 2, { term: "old-term" }), path: "/?" + Bv });
  await book(s.page);
  const at = s.posts[0]?.attribution;
  check("4. Ново посещение с UTM: заменя целия източник (term от старото не остава)", at?.content === "video_b_man" && at.term === "" && near(at.at), JSON.stringify(at));
  await s.ctx.close();
}
// 5. Изтекла атрибуция
{
  const s = await session({ consent: V2(true), attr: stored("video_a_woman", 31), path: "/" });
  await book(s.page);
  check("5. Изтекла (31 дни): заявката е без източник и записът е изтрит", s.posts[0] && s.posts[0].attribution === null && (await ls(s.page)) === null, JSON.stringify(s.posts[0]?.attribution));
  await s.ctx.close();
}
// 6. Преди решение: само в паметта; след „Приемам“ – запазва се с момента на посещението
{
  const s = await session({ path: "/?" + A });
  const before = await ls(s.page);
  await s.page.waitForTimeout(1200);
  await s.page.click("#ck-main [data-ck=yes]");
  const after = await ls(s.page);
  await book(s.page);
  check("6. Без решение: нищо не се записва в браузъра", before === null, "");
  check("6a. След съгласие: източникът се запазва с момента на посещението", after?.content === "video_a_woman" && Date.parse(after.at) < Date.now() - 1000 && s.posts[0]?.attribution?.content === "video_a_woman", after?.at);
  await s.ctx.close();
}
// 7. Отказ: нищо не се пази и не се изпраща
{
  const s = await session({ path: "/?" + A });
  await s.page.click("#ck-main [data-ck=no]");
  await book(s.page);
  check("7. Отказ: източникът не се пази и заявката е без него", (await ls(s.page)) === null && s.posts[0] && s.posts[0].attribution === null, JSON.stringify(s.posts[0]?.attribution));
  await s.ctx.close();
}
{
  const s = await session({ consent: V2(false), attr: stored("video_a_woman", 1), path: "/?" + Bv });
  await book(s.page);
  check("7a. Запазен отказ: стар запис се изтрива, нов не се създава, заявката е без източник", (await ls(s.page)) === null && s.posts[0]?.attribution === null, "");
  await s.ctx.close();
}
// 8. Оттегляне на съгласието
{
  const s = await session({ consent: V2(true), path: "/?" + A });
  const had = await ls(s.page);
  await s.page.click("footer [data-ck-open]");
  await s.page.uncheck("#ck-mk");
  await s.page.click("#ck-more [data-ck=save]");
  await book(s.page);
  check("8. Оттегляне: записаният източник се изтрива; следващата заявка е без него", had?.content === "video_a_woman" && (await ls(s.page)) === null && s.posts[0]?.attribution === null, "");
  await s.ctx.close();
}
// 9. Невалидни / опасни стойности в адреса
{
  const s = await session({ consent: V2(true), path: "/?utm_source=meta&utm_medium=paid_social&utm_campaign=%3Cscript%3Ealert(1)%3C%2Fscript%3E&utm_content=video_a_woman" });
  check("9. Невалидна кампания (HTML): посещението не се записва", (await ls(s.page)) === null, "");
  await s.ctx.close();
}
{
  const s = await session({ consent: V2(true), path: "/?utm_source=meta&utm_medium=paid_social&utm_campaign=ptb_plovdiv_video_test&utm_content=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&utm_term=ivan%40example.com&email=ivan%40example.com" });
  const a = await ls(s.page);
  check("10. Невалидни незадължителни полета и чужди параметри не се пазят", a?.campaign === "ptb_plovdiv_video_test" && a.content === "" && a.term === "" && !JSON.stringify(a).includes("ivan"), JSON.stringify(a));
  check("10a. Без изпълнен скрипт и без грешки", s.errors.length === 0, s.errors.join("; "));
  await s.ctx.close();
}
// 11. Презареждане на страницата „Благодарим“ и повторно изпращане не създават нов източник
{
  const s = await session({ consent: V2(true), path: "/?" + A });
  await book(s.page);
  await s.page.reload({ waitUntil: "load" });
  await s.page.waitForTimeout(800);
  check("11. Презареждане след заявката: без нова заявка към сървъра", s.posts.length === 1, `${s.posts.length}`);
  await s.ctx.close();
}
await browser.close();
console.log(`ОБЩО: ${results.filter(Boolean).length} PASS, ${results.filter((x) => !x).length} FAIL`);
process.exit(results.every(Boolean) ? 0 : 1);
