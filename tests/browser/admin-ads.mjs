// Браузърна проверка на админ панела: банер за средата, „Рекламен източник“ (екраниране), плащания и отчет за рекламите.
//   npm install --no-save playwright-core@1 && npx playwright-core install chromium
//   node tests/browser/admin-ads.mjs <адрес на Deploy Preview или локален сървър>
// /api/admin/* се подменя със синтетични данни – не се влиза в реален акаунт и не се пипат реални резервации.
import { chromium } from "playwright-core";

const B = (process.argv[2] || "").replace(/\/$/, "");
if (!/^(https:\/\/[\w-]+--rentacarptb\.netlify\.app|http:\/\/(localhost|127\.0\.0\.1):\d+)$/.test(B)) { console.error("Задайте адреса на Deploy Preview или локален сървър (не production)."); process.exit(1); }
const results = [];
const check = (n, ok, info = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${n}${info ? " | " + info : ""}`); };
const browser = await chromium.launch();
const XSS = '<img src=x onerror="window.__xss=1">';
const ID = "a".repeat(32), OLD = "b".repeat(32);
const booking = (id, utm) => ({ booking: { id, status: "confirmed", car: "Ford Ka", pickup: "01.06.2027 10:00", dropoff: "03.06.2027 10:00", name: "ТЕСТ", phone: "+359000", email: "t@example.com", total: "50 €", createdAt: new Date().toISOString(), utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null, utmAt: null, ...utm }, can: {}, events: [], emails: [] });
const PAY = { payments: [
  { id: "p1", kind: "deposit", amountCents: 5000, currency: "EUR", method: "cash", status: "received", paidAt: new Date().toISOString(), note: XSS, txnId: "", createdBy: "admin@example.com", refundable: 5000 },
  { id: "p2", kind: "security", amountCents: 10000, currency: "EUR", method: "cash", status: "received", paidAt: new Date().toISOString(), note: "", txnId: "", createdBy: "admin@example.com", refundable: 0 },
  { id: "p3", kind: "refund", refundOf: "p2", amountCents: 10000, currency: "EUR", method: "cash", status: "received", paidAt: new Date().toISOString(), note: "", txnId: "", createdBy: "admin@example.com", refundable: 0 },
], summary: { rentalNet: 5000, securityHeld: 0, expected: 0 } };
const REPORT = { from: "2027-06-01", to: "2027-06-14", paidUntil: new Date().toISOString(), partialSpend: [], warnings: {}, rows: [
  { campaign: "ptb_plovdiv_video_test", content: "video_a_woman", label: "Видео А — жена", sources: ["meta / paid_social"], leads: 2, confirmed: 1, paid: 1, revenueCents: 14050, spendCents: 1735, cplCents: 868, costPerPaidCents: 1735, roas: 8.098 },
  { campaign: "ptb_plovdiv_video_test", content: "video_b_man", label: "Видео Б — мъж", sources: [], leads: 1, confirmed: 0, paid: 0, revenueCents: 0, spendCents: null, cplCents: null, costPerPaidCents: null, roas: null },
  { campaign: null, content: null, label: "Няма записан източник", sources: [], leads: 3, confirmed: 1, paid: 0, revenueCents: 0, spendCents: null, cplCents: null, costPerPaidCents: null, roas: null },
] };

async function open(path, me, loginFirst = false) {
  const ctx = await browser.newContext({ locale: "bg-BG" });
  const posts = [];
  await ctx.route((u) => !u.href.startsWith(B), (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route(B + "/api/**", (r) => {
    const u = new URL(r.request().url()), m = r.request().method();
    if (m === "POST") posts.push({ path: u.pathname, body: JSON.parse(r.request().postData() || "{}") });
    if (u.pathname === "/api/admin/me") return loginFirst ? r.fulfill({ status: 401, json: { error: "unauthorized" } }) : r.fulfill({ json: me });
    if (u.pathname === "/api/admin/login") return r.fulfill({ json: me });
    if (u.pathname === "/api/admin/backups") return r.fulfill({ json: { status: {} } });
    if (u.pathname === "/api/admin/emails") return r.fulfill({ json: { counts: {}, rows: [] } });
    if (u.pathname === `/api/admin/bookings/${ID}`) return r.fulfill({ json: booking(ID, { utmSource: "meta", utmMedium: "paid_social", utmCampaign: "ptb_plovdiv_video_test", utmContent: "video_a_woman", utmTerm: XSS, utmAt: new Date().toISOString() }) });
    if (u.pathname === `/api/admin/bookings/${OLD}`) return r.fulfill({ json: booking(OLD, {}) });
    if (u.pathname === "/api/admin/payments" && m === "POST") return r.fulfill({ status: 201, json: { ok: true, ...PAY } });
    if (u.pathname === "/api/admin/payments") return r.fulfill({ json: u.searchParams.get("booking") ? PAY : { rows: [] } });
    if (u.pathname === "/api/admin/ads/report") return r.fulfill({ json: REPORT });
    if (u.pathname === "/api/admin/ads/spend") return r.fulfill(m === "POST" ? { status: 201, json: { ok: true } } : { json: { rows: [] } });
    return r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(B + path, { waitUntil: "load" });
  if (loginFirst) { await page.fill("#e", "admin@example.com"); await page.fill("#p", "synthetic-pass"); await page.click("#f button.btn"); }
  await page.waitForTimeout(1200);
  return { ctx, page, errors, posts };
}
const alerts = (p) => p.$eval("#alerts", (e) => e.innerText);

// 1. Банер за средата
for (const [label, me, login, expect] of [
  ["production (/me)", { email: "admin@example.com", env: "production", envKind: "production", production: true }, false, (t) => !/Тестова среда|Неизвестна среда/.test(t)],
  ["production след вход (преди: „Тестова среда ()“)", { email: "admin@example.com", env: "production", envKind: "production", production: true }, true, (t) => !/Тестова среда|Неизвестна среда/.test(t)],
  ["deploy-preview", { email: "admin@example.com", env: "deploy-preview", envKind: "preview", production: false }, false, (t) => /Тестова среда \(deploy-preview\)/.test(t)],
  ["unknown", { email: "admin@example.com", env: "unknown", envKind: "unknown", production: false }, false, (t) => /Неизвестна среда/.test(t) && !/Тестова среда/.test(t) && !/промените тук не засягат/.test(t)],
  ["стар отговор без envKind", { email: "admin@example.com" }, false, (t) => /Неизвестна среда/.test(t) && !/Тестова среда \(\)/.test(t)],
]) {
  const s = await open("/admin/dashboard", me, login);
  const t = await alerts(s.page);
  check(`1. Банер: ${label}`, expect(t) && s.errors.length === 0, t.slice(0, 90).replace(/\n/g, " ") || "(няма банер)");
  await s.ctx.close();
}
const PROD = { email: "admin@example.com", env: "production", envKind: "production", production: true };
// 2. Рекламен източник и плащания в подробностите
{
  const s = await open(`/admin/bookings/${ID}`, PROD);
  const txt = await s.page.$eval("#view", (e) => e.innerText);
  check("2. „Рекламен източник“: вариант, UTM параметри и момент", /Рекламен източник/.test(txt) && /Видео А — жена/.test(txt) && /ptb_plovdiv_video_test/.test(txt) && /Посещение от рекламата/.test(txt), "");
  check("3. Опасна UTM стойност и бележка се показват като текст (екранирани)", txt.includes(XSS) && (await s.page.evaluate(() => window.__xss)) === undefined && (await s.page.$$("#view img[src=x]")).length === 0, "");
  check("4. Плащания: приход без гаранционния депозит, възстановяването е отделен ред", /50,00 €/.test(txt) && /Гаранционен депозит \(не е приход\)/.test(txt) && /−100,00 €/.test(txt), "");
  await s.page.fill("#pf-amount", "70,50");
  await s.page.selectOption("#pf-kind", "partial");
  await s.page.click("#payf button.btn:not([type])");
  await s.page.waitForTimeout(600);
  const p = s.posts.find((x) => x.path === "/api/admin/payments");
  check("5. Ново плащане: изпраща вид, сума, ключ против повторение", p && p.body.kind === "partial" && p.body.amount === "70,50" && p.body.bookingId === ID && /^[\w-]{8,}$/.test(p.body.idempotencyKey), JSON.stringify(p?.body || {}).slice(0, 120));
  await s.page.click("[data-refund=p1]");
  await s.page.waitForTimeout(400);
  const rf = await s.page.$eval("#payf", (e) => e.innerText);
  check("6. Възстановяване: към конкретното плащане, с оставащата сума", /Възстановяване на Аванс по наема/.test(rf) && (await s.page.$eval("#pf-amount", (e) => e.value)) === "50,00", "");
  check("6a. Без грешки в страницата", s.errors.length === 0, s.errors.join("; "));
  await s.ctx.close();
}
{
  const s = await open(`/admin/bookings/${OLD}`, PROD);
  const txt = await s.page.$eval("#view", (e) => e.innerText);
  check("7. Стара заявка: „Няма записан източник“, без „органично“", /Няма записан източник/.test(txt) && !/Органич/.test(txt), "");
  await s.ctx.close();
}
// 3. Отчет
{
  const s = await open("/admin/reports?from=2027-06-01&to=2027-06-14", PROD);
  const txt = await s.page.$eval("#view", (e) => e.innerText);
  check("8. Отчет: период на кохортата и докога са плащанията", /Заявки, създадени 01\.06\.2027 – 14\.06\.2027/.test(txt) && /плащания, отчетени до/.test(txt), "");
  check("9. Отчет: CPL, цена за резервация с плащане и ROAS", /8,68 €/.test(txt) && /17,35 €/.test(txt) && /8,10 \(810 %\)/.test(txt), "");
  check("10. Липсващ разход → „Няма данни“", (txt.match(/Няма данни/g) || []).length >= 8, "");
  check("11. ROAS е обяснен като възвръщаемост, не печалба; разлика с Meta", /възвръщаемост на рекламния разход, не печалба/.test(txt) && /Meta Ads Manager/.test(txt), "");
  await s.page.fill("#s-v", "video_b_man"); await s.page.fill("#s-f", "2027-06-01"); await s.page.fill("#s-t", "2027-06-14"); await s.page.fill("#s-a", "17,35");
  await s.page.click("#sf button");
  await s.page.waitForTimeout(500);
  const sp = s.posts.find((x) => x.path === "/api/admin/ads/spend");
  check("12. Въвеждане на действителен разход по вариант и период", sp && sp.body.campaign === "ptb_plovdiv_video_test" && sp.body.content === "video_b_man" && sp.body.amount === "17,35" && sp.body.periodStart === "2027-06-01", "");
  check("12a. Без грешки в страницата", s.errors.length === 0, s.errors.join("; "));
  await s.ctx.close();
}
{
  const s = await open("/admin/payments", PROD);
  check("13. Раздел „Плащания“ работи (не е „в процес на изграждане“)", !(await s.page.$eval("#view", (e) => e.innerText)).includes("в процес на изграждане") && s.errors.length === 0, "");
  await s.ctx.close();
}
await browser.close();
console.log(`ОБЩО: ${results.filter(Boolean).length} PASS, ${results.filter((x) => !x).length} FAIL`);
process.exit(results.every(Boolean) ? 0 : 1);
