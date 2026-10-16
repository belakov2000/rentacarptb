// Браузърна проверка на админ панела: „Резервации → Чакащи → Управление“ – „Потвърди заявката“ и „Откажи заявката“.
//   npm install --no-save playwright-core@1 && npx playwright-core install chromium
//   node tests/browser/admin-decide.mjs <адрес на Deploy Preview или локален сървър>
// /api/admin/* се подменя със синтетични данни – не се влиза в реален акаунт и не се пипат реални резервации.
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const B = (process.argv[2] || "").replace(/\/$/, "");
if (!/^(https:\/\/[\w-]+--rentacarptb\.netlify\.app|http:\/\/(localhost|127\.0\.0\.1):\d+)$/.test(B)) { console.error("Задайте адреса на Deploy Preview или локален сървър (не production)."); process.exit(1); }
const ADMIN = readFileSync(new URL("../../admin/index.html", import.meta.url), "utf8");
const results = [];
const check = (n, ok, info = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${n}${info ? " | " + info : ""}`); };
const browser = await chromium.launch();
const ME = { email: "admin@example.com", env: "deploy-preview", envKind: "preview" };
const P = "c".repeat(32), OLD = "d".repeat(32);
const base = { car: "Ford Ka", pickup: "01.06.2027 10:00, офис", dropoff: "03.06.2027 10:00, офис", name: "ТЕСТ Чакаща", phone: "+359000", email: "t@example.com", total: "50 €", createdAt: new Date().toISOString(), pickupAt: "2027-06-01 10:00", note: "", decisionNote: "", decidedBy: "", closeNote: "" };
const pending = (id, can) => ({ booking: { id, status: "pending", ...base }, can: { cancel: false, no_show: false, handover: false, reject: true, ...can }, events: [{ at: new Date().toISOString(), actor: "customer", action: "booking.created", details: {} }], emails: [] });

async function open(id, { detail, onPost, viewport = { width: 1280, height: 900 }, mobile = false }) {
  const ctx = await browser.newContext({ locale: "bg-BG", viewport, isMobile: mobile, hasTouch: mobile });
  const posts = [];
  await ctx.route((u) => !u.href.startsWith(B), (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route(B + "/admin/**", (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: ADMIN }));
  await ctx.route(B + "/api/**", (r) => {
    const u = new URL(r.request().url()), m = r.request().method();
    if (u.pathname === "/api/admin/me") return r.fulfill({ json: ME });
    if (u.pathname === "/api/admin/backups") return r.fulfill({ json: { status: {} } });
    if (u.pathname === "/api/admin/emails") return r.fulfill({ json: { counts: {}, rows: [] } });
    if (u.pathname === "/api/admin/payments") return r.fulfill({ json: { payments: [], summary: { rentalNet: 0, securityHeld: 0, expected: 0 } } });
    if (u.pathname === `/api/admin/bookings/${id}` && m === "POST") { const body = JSON.parse(r.request().postData() || "{}"); posts.push(body); return onPost(r, body); }
    if (u.pathname === `/api/admin/bookings/${id}`) return r.fulfill({ json: detail() });
    return r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${B}/admin/bookings/${id}`, { waitUntil: "load" });
  await page.waitForSelector(".act h3");
  return { ctx, page, posts, errors };
}

// ===== 1–5. Потвърждаване с вътрешна бележка и имейл =====
{
  let state = "pending";
  const s = await open(P, {
    detail: () => (state === "pending" ? pending(P, { confirm: true, block: "", conflict: null }) : { ...pending(P, {}), booking: { id: P, status: "confirmed", ...base, decidedAt: new Date().toISOString(), decidedBy: "admin@example.com", decisionNote: "ВЪТРЕШНО-1" }, can: { cancel: true, handover: true, no_show: false, confirm: false, reject: false } }),
    onPost: (r) => { state = "confirmed"; return r.fulfill({ json: { ok: true, email: "sent", ...pending(P, {}) } }); },
  });
  const h = await s.page.$$eval(".act h3", (x) => x.map((e) => e.textContent));
  check("1. чакаща заявка: панели „Потвърди заявката“ и „Откажи заявката“", h.includes("Потвърди заявката") && h.includes("Откажи заявката"), h.join(" | "));
  await s.page.fill("#confirm-note", "ВЪТРЕШНО-1");
  await s.page.click('[data-ask="confirm"]');
  const ask = await s.page.evaluate(() => ({ shown: !document.getElementById("ask-confirm").hidden, q: document.querySelector("#ask-confirm p b").textContent, mail: document.getElementById("ask-confirm-mail").textContent, rejectAsk: document.getElementById("ask-reject").hidden }));
  check("2. отделно потвърждение: въпрос и ясно, че ще има имейл без вътрешната бележка; нищо не е изпратено", ask.shown && /Да потвърдим ли заявката\?/.test(ask.q) && /Ще бъде изпратен имейл до клиента с решението/.test(ask.mail) && /Вътрешната бележка не се изпраща/.test(ask.mail) && ask.rejectAsk && s.posts.length === 0, ask.mail);
  await s.page.click('[data-back="confirm"]');
  check("3. „Назад, без промяна“ скрива въпроса без заявка към сървъра", (await s.page.evaluate(() => document.getElementById("ask-confirm").hidden)) && s.posts.length === 0, "");
  await s.page.click('[data-ask="confirm"]');
  await s.page.click('[data-do="confirm"]');
  await s.page.waitForSelector('.msg.ok[role="status"]');
  const msg = await s.page.textContent('.msg[role="status"]');
  check("4. POST { action: confirm, note, notify: true } и съобщение за успех", s.posts.length === 1 && s.posts[0].action === "confirm" && s.posts[0].note === "ВЪТРЕШНО-1" && s.posts[0].notify === true && /Заявката е потвърдена/.test(msg) && /Клиентът получи имейл/.test(msg), JSON.stringify(s.posts[0]));
  const kv = await s.page.textContent(".kv");
  check("5. след решението: показани кой е решил и вътрешната бележка, без бутони за решение", kv.includes("admin@example.com") && kv.includes("ВЪТРЕШНО-1") && !(await s.page.$('[data-ask="confirm"]')) && s.errors.length === 0, s.errors.join("; "));
  await s.ctx.close();
}

// ===== 6–8. Отказ без имейл; повторно действие (409 state) =====
{
  const s = await open(P, { detail: () => pending(P, { confirm: true, block: "", conflict: null }), onPost: (r) => r.fulfill({ status: 409, json: { error: "state", ...pending(P, {}) } }) });
  await s.page.uncheck("#reject-notify");
  await s.page.click('[data-ask="reject"]');
  const mail = await s.page.textContent("#ask-reject-mail");
  check("6. отказ без имейл: потвърждението казва „Няма да бъде изпратен имейл“", /Няма да бъде изпратен имейл до клиента/.test(mail) && /Да откажем ли заявката\?/.test(await s.page.textContent("#ask-reject p b")), mail);
  await s.page.click('[data-do="reject"]');
  await s.page.waitForSelector('.msg.err[role="status"]');
  check("7. POST { action: reject, notify: false }", s.posts[0]?.action === "reject" && s.posts[0]?.notify === false, JSON.stringify(s.posts[0]));
  check("8. вече взето решение (409 state) → ясно съобщение, без презаписване", /вече е обработена/.test(await s.page.textContent('.msg[role="status"]')), "");
  await s.ctx.close();
}

// ===== 9–10. Стара заявка без дати; заета кола (телефон) =====
{
  const s = await open(OLD, { detail: () => pending(OLD, { confirm: false, block: "no_dates", conflict: null }), onPost: (r) => r.fulfill({ json: { ok: true, email: "none", ...pending(OLD, {}) } }), viewport: { width: 360, height: 740 }, mobile: true });
  const t = await s.page.evaluate(() => ({ warn: document.querySelector(".act .warn")?.textContent || "", confirm: !!document.querySelector('[data-ask="confirm"]'), reject: !!document.querySelector('[data-ask="reject"]'), scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }));
  check("9. стара заявка без дати: ясно съобщение, без „Потвърди“, „Откажи“ е достъпно", /няма записани дати/.test(t.warn) && !t.confirm && t.reject, t.warn);
  check("10. телефон: без хоризонтално превъртане", !t.scroll && s.errors.length === 0, s.errors.join("; "));
  await s.ctx.close();
}
{
  const conflict = { kind: "booking", id: "e".repeat(32), name: "x", pickup: "01.06.2027 10:00", dropoff: "03.06.2027 10:00" };
  const s = await open(P, { detail: () => pending(P, { confirm: true, block: "", conflict: null }), onPost: (r) => r.fulfill({ status: 409, json: { error: "busy", ...pending(P, { confirm: false, block: "busy", conflict }) } }) });
  await s.page.click('[data-ask="confirm"]');
  await s.page.click('[data-do="confirm"]');
  await s.page.waitForSelector('.msg.err[role="status"]');
  const m = await s.page.textContent('.msg[role="status"]');
  check("11. едновременно заета кола (409 busy) → съобщение със застъпващата се резервация", /не е потвърдена – автомобилът е зает/.test(m) && m.includes("EEEEEE"), m);
  await s.ctx.close();
}

await browser.close();
const fails = results.filter((x) => !x).length;
console.log(`\nОБЩО: ${results.length - fails} PASS, ${fails} FAIL`);
process.exit(fails ? 1 : 0);
