// Целият път в браузъра (настолен компютър и телефон) срещу локалния e2e сървър (tests/e2e/run.mjs):
// публична заявка → вход в панела → табло → потвърждаване → предаване → удължаване → приключване → календар,
// автомобили, клиенти, договори (изтегляне), настройки; на телефон – карти, календар като списък, без хоризонтално превъртане.
import { chromium } from "playwright-core";

const B = (process.argv[2] || "").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(B)) { console.error("Само локален e2e сървър."); process.exit(1); }
const results = [];
const check = (n, ok, info = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${n}${info ? " | " + info : ""}`); };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP8z8DAQAxgYhhVSF+FAMWKAh8Yq0QdAAAAAElFTkSuQmCC", "base64");
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Sofia" });
const dmy = (d) => d.split("-").reverse().join(".");
const D1 = day(10), D2 = day(12), D3 = day(14);
const browser = await chromium.launch();
const external = [];

async function context(mobile) {
  const ctx = await browser.newContext(mobile ? { locale: "bg-BG", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { locale: "bg-BG", viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  // Външни заявки (шрифтове, Meta, карти) се прихващат – не излизат от машината
  await ctx.route((u) => !u.href.startsWith(B), (r) => { external.push(new URL(r.request().url()).host); return r.fulfill({ status: 204, body: "" }); });
  return ctx;
}
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  return page;
}
const text = (page, sel = "#view") => page.locator(sel).innerText();
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function login(page) {
  await page.goto(B + "/admin/", { waitUntil: "load" });
  await page.fill("#e", "admin@example.com");
  await page.fill("#p", "admin-pass-123");
  await page.click("#f button.btn");
  await page.waitForSelector("nav a[data-k=dashboard]");
  await page.waitForSelector(".kpi");
}
const navTo = async (page, path, sel) => { await page.goto(B + path, { waitUntil: "load" }); if (sel) await page.waitForSelector(sel, { timeout: 15000 }); };

// ===== Настолен компютър =====
const desk = await context(false);
// 1. Публична заявка през формата на сайта (без съгласие за маркетинг – Meta Pixel не се зарежда)
{
  await desk.addInitScript(([seed]) => {
    if (window !== top) return;
    if (!localStorage.getItem("cookie-consent")) localStorage.setItem("cookie-consent", JSON.stringify({ v: 2, necessary: true, marketing: false, date: "2026-10-01T00:00:00.000Z" }));
    try { if (!sessionStorage.getItem("req")) sessionStorage.setItem("req", JSON.stringify(seed)); } catch (e) {}
  }, [{ car: "passat", d1: D1, t1: "10:00", d2: D2, t2: "10:00", m1: "office", m2: "office" }]);
  const page = await newPage(desk);
  await page.goto(B + "/", { waitUntil: "load" });
  await page.waitForTimeout(800);
  await page.evaluate(() => { location.hash = "avtomobili"; });
  await page.waitForSelector("#bk", { state: "visible" });
  const f = { "#b-name": "ТЕСТ Е2Е Клиент", "#b-cit": "BG", "#b-phone": "+359000000123", "#b-mail": "e2e-client@example.com", "#b-idn": "TESTID1", "#b-egn": "8001019999", "#b-idd": "2020-01-01", "#b-idp": "МВР-ТЕСТ", "#b-reg": "ТЕСТ-област", "#b-mun": "ТЕСТ-община", "#b-city": "Тестоград", "#b-addr": "ул. Тестова 1", "#b-dln": "TESTDL1", "#b-dlname": "ТЕСТ", "#b-dld": "2020-01-01", "#b-dlp": "МВР-ТЕСТ" };
  for (const [sel, v] of Object.entries(f)) if (await page.$(sel)) await page.fill(sel, v).catch(() => {});
  for (const id of ["p-idf", "p-idb", "p-dlf", "p-dlb"]) await page.setInputFiles("#" + id, { name: "test.png", mimeType: "image/png", buffer: PNG });
  await page.check('input[name="ptype"][value="village"]').catch(() => {});
  await page.check("#b-ok").catch(() => {});
  const pay = await page.$('input[name="pay"][value="cash"]'); if (pay) await pay.check();
  await page.waitForTimeout(400);
  await page.click("#bk button[type=submit]");
  await page.waitForFunction(() => location.hash === "#blagodarim" || !document.querySelector("#b-err").hidden, null, { timeout: 30000 });
  check("1. Публична форма: заявката е приета от сървъра", (await page.evaluate(() => location.hash)) === "#blagodarim", await page.evaluate(() => location.hash));
  check("1a. Без грешки на публичната страница", page.errors.length === 0, page.errors.join("; "));
  await page.close();
}
const [bk] = await (await fetch(B + "/__e2e/sql?q=" + encodeURIComponent("select id, total, total_cents, jsonb_array_length(documents) docs from bookings"))).json();
const ID = bk.id, REF = ID.slice(0, 6).toUpperCase();
check("1b. Заявката е в базата със сумата и 4 снимки на документите", !!ID && bk.total_cents > 0 && bk.docs === 4, JSON.stringify(bk));

const page = await newPage(desk);
await login(page);
// 2. Табло → чакащи
{
  const kpi = page.locator('a.kpi[href="/admin/bookings?view=pending"] b');
  check("2. Табло: 1 чакаща заявка", (await kpi.innerText()) === "1", await kpi.innerText());
  await page.click('a.kpi[href="/admin/bookings?view=pending"]');
  await page.waitForSelector("table.cards");
  const t = await text(page);
  check("2a. Показателят отваря списъка с филтъра; има „Създадена на“ във формат дд.мм.гггг, чч:мм ч.", page.url().includes("view=pending") && t.includes(REF) && /Създадена на/.test(t) && /\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2} ч\./.test(t), "");
}
// 3. Потвърждаване
await navTo(page, `/admin/bookings/${ID}`, "[data-ask=confirm]");
check("3. Детайли: „Създадена на“ отделно от получаване/връщане", /Създадена на\s+\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2} ч\./.test(await text(page)) && (await text(page)).includes(dmy(D1)), "");
await page.click("[data-ask=confirm]"); await page.click("[data-do=confirm]");
await page.waitForSelector(".msg.ok");
check("3a. Потвърдена от панела", /потвърдена/i.test(await text(page, ".msg.ok")), await text(page, ".msg.ok"));
// 4. Предаване
await page.click("[data-ask=handover]"); await page.click("[data-do=handover]");
await page.waitForFunction(() => /предаден/.test(document.querySelector(".msg.ok")?.textContent || ""));
check("4. Отбелязано предаване; появяват се „Приключи наема“ и „Удължи наема“", /предаден/i.test(await text(page, ".msg.ok")) && (await page.$("[data-ask=return]")) !== null, "");
// 5. Удължаване с автоматична сума
{
  await page.fill("#ext-d", D3);
  await page.click("[data-ext-quote]");
  await page.waitForSelector("[data-ext-do]");
  const q = await text(page, "#ext-q");
  const daily = bk.total_cents / 2;
  const added = ((daily * 2) / 100).toFixed(2).replace(".", ",") + " €";
  check("5. Удължаване: показани дневна цена, допълнителна сума и нова обща сума преди запис", q.includes("Договорена дневна цена") && q.includes(added) && q.includes("Нова обща сума"), q.replace(/\n/g, " ").slice(0, 300));
  await page.click("[data-ext-do]");
  await page.waitForFunction(() => /удължен/.test(document.querySelector(".msg.ok")?.textContent || ""));
  const m = await text(page, ".msg.ok");
  check("5a. Удължено; нова версия на договора „очаква подписване“; без имейл", /удължен/.test(m) && /версия 2/.test(m) && /Не е изпратен имейл/.test(m), m);
  const pays = await (await fetch(B + "/__e2e/sql?q=" + encodeURIComponent(`select count(*)::int n from payments`))).json();
  check("5b. Удължаването не създава плащане", pays[0].n === 0, String(pays[0].n));
}
// 6. Плащане и приключване
{
  await page.fill("#pf-amount", "100"); await page.selectOption("#pf-kind", "security");
  await page.click("#payf button.btn:not([type=button])");
  await page.waitForSelector("#pay .msg.ok");
  const fin = await text(page, "#pay");
  check("6. Гаранционен депозит 100 € е видим отделно от наема", /Гаранционен депозит[\s\S]*100,00 €/.test(fin) && /Договорена сума/.test(fin) && /Остатък за плащане/.test(fin), "");
  await page.click("[data-ask=return]"); await page.click("[data-do=return]");
  await page.waitForFunction(() => /приключен/.test(document.querySelector(".msg.ok")?.textContent || ""));
  const t = await text(page);
  check("6a. Наемът е приключен; неприключеният депозит остава като задача", /Наемът е приключен/.test(t) && /Неприключен гаранционен депозит: 100,00 €/.test(t), "");
  const ret = await (await fetch(B + "/__e2e/sql?q=" + encodeURIComponent(`select returned_at is not null r, end_date::text e from bookings where id='${ID}'`))).json();
  check("6b. Реално връщане записано; договореният край (след удължаването) е запазен", ret[0].r === true && ret[0].e === D3, JSON.stringify(ret[0]));
}
// 7. Календар, автомобили, клиенти, договори, настройки
{
  await navTo(page, `/admin/calendar?from=${D1}&days=7`, "table.cal");
  const chip = page.locator(`a.chip.booking[href="/admin/bookings/${ID}"]`).first();
  check("7. Календар: приключеният наем е показан като отделно събитие, води към детайлите", (await chip.count()) > 0 && (await chip.getAttribute("class")).includes("done"), "");
  await navTo(page, "/admin/cars", "table.cards");
  check("7a. Автомобили: рег. номер, активност и заетост", /РВ8991XE/.test(await text(page)) && /активен/.test(await text(page)), "");
  await navTo(page, "/admin/cars/ka", "#blk");
  await page.fill("#b-sd", day(20)); await page.fill("#b-ed", day(21));
  await page.click("#blk button");
  await page.waitForSelector(".msg.ok");
  const av = await (await fetch(B + "/api/availability")).json();
  check("7b. Блокиран период от панела → публичната наличност", (av.cars.ka || []).some((p) => p[0] === day(20)), JSON.stringify(av.cars.ka));
  await navTo(page, `/admin/bookings/${ID}`, "#mkcust");
  await page.click("#mkcust");
  await page.waitForURL(/\/admin\/customers\/\d+/);
  await page.waitForSelector("#csave");
  check("7c. Клиентски профил от резервацията с реално полученото (депозитът не е приход)", /ТЕСТ Е2Е Клиент/.test(await text(page)) && /Реално получено за наеми[\s\S]*0,00 €/.test(await text(page)), "");
  await navTo(page, `/admin/contracts/${ID}`, "[data-dl]");
  const ct = await text(page);
  check("7d. Договори: v2 актуална, „Генерирана — очаква подписване“; 4 снимки", /v2\s*актуална/.test(ct) && /Генерирана — очаква подписване/.test(ct) && (await page.locator("[data-doc]").count()) === 4, "");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-dl="1"]')]);
  check("7e. Изтегляне на v1 (след вход)", /\.docx$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  await page.click("[data-doc]");
  await page.waitForSelector('img[alt="Снимка на документ"]');
  check("7f. Снимка на документ се отваря в панела", true);
  const anon = await fetch(`${B}/api/admin/contracts/${ID}/file?v=1`);
  check("7g. Същият файл без вход → 401", anon.status === 401, String(anon.status));
  await navTo(page, "/admin/settings", "#rf2");
  await page.fill("#h-pickup24", "36");
  await page.click("#rf2 button");
  await page.waitForSelector(".msg.ok");
  const st = await (await fetch(B + "/__e2e/sql?q=" + encodeURIComponent(`select value->'pickup24'->>'hours' h from settings where key='reminders'`))).json();
  check("7h. Настройки: „Запази“ записва напомнянията в общия източник", st[0]?.h === "36", JSON.stringify(st));
  check("7i. Без грешки в панела (настолен)", page.errors.length === 0, page.errors.join("; "));
}
await desk.close();

// ===== Телефон =====
{
  const ctx = await context(true);
  const p = await newPage(ctx);
  await login(p);
  check("8. Телефон: таблото без хоризонтално превъртане", await noOverflow(p), "");
  await navTo(p, "/admin/bookings?status=all", "table.cards");
  const card = p.locator("table.cards tr").nth(1);
  const created = card.locator('td[data-l="Създадена на"]');
  check("8a. Телефон: заявката е карта и „Създадена на“ се вижда в нея", (await created.isVisible()) && /\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2} ч\./.test(await created.innerText()) && (await card.evaluate((e) => getComputedStyle(e).display)) === "block", await created.innerText());
  check("8b. Телефон: списъкът без хоризонтално превъртане", await noOverflow(p), "");
  await navTo(p, `/admin/calendar?from=${D1}&days=7`, ".agenda");
  check("8c. Телефон: календарът е списък по дни (таблицата е скрита)", (await p.locator(".agenda").isVisible()) && !(await p.locator(".cal-wrap").isVisible()) && /ТЕСТ|№/.test(await p.locator(".agenda").innerText()), "");
  await navTo(p, `/admin/bookings/${ID}`, "#pay .stat");
  check("8d. Телефон: детайли и плащания без хоризонтално превъртане", await noOverflow(p), "");
  for (const s of ["cars", "customers", "contracts", "settings"]) {
    await navTo(p, "/admin/" + s, "#view .panel");
    await p.waitForTimeout(300);
    check(`8e. Телефон: „${s}“ се зарежда без хоризонтално превъртане`, (await noOverflow(p)) && !(await text(p)).includes("Неуспешно"), "");
  }
  await p.click(".menu-btn");
  check("8f. Телефон: менюто се отваря", await p.locator("nav.open").isVisible(), "");
  check("8g. Без грешки в панела (телефон)", p.errors.length === 0, p.errors.join("; "));
  await ctx.close();
}
const mails = await (await fetch(B + "/__e2e/mail")).json();
check("9. Прихванати имейли: до фирмата и до клиента (получена, решение); без писмо за удължаването", mails.some((m) => /Нова заявка/.test(m.subject)) && mails.some((m) => m.to === "e2e-client@example.com" && /потвърдена/i.test(m.subject)) && !mails.some((m) => /удължен/i.test(m.subject)), mails.map((m) => m.subject).join(" | "));
check("9a. Външните заявки от браузъра са прихванати (не излизат)", true, [...new Set(external)].join(", ") || "няма");
await browser.close();
const f = results.filter((x) => !x).length;
console.log(`\nОБЩО: ${results.length - f} PASS, ${f} FAIL`);
process.exit(f ? 1 : 0);
