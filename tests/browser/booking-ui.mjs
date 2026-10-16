// Браузърна проверка: badge „−20%“, работно време за получаване/връщане и камерата с насочваща рамка.
//   npm install --no-save playwright-core@1 && npx playwright-core install chromium
//   python3 -m http.server 8890            (от папката на проекта, в отделен терминал)
//   node tests/browser/booking-ui.mjs http://localhost:8890
// Камерата е фалшива (--use-fake-device-for-media-stream) – не се снимат реални документи. /api/*, Web3Forms и Meta се
// подменят: не се създават резервации и нищо не излиза навън. Само синтетични данни.
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const B = (process.argv[2] || "").replace(/\/$/, "");
if (!/^(https:\/\/[\w-]+--rentacarptb\.netlify\.app|http:\/\/(localhost|127\.0\.0\.1):\d+)$/.test(B)) { console.error("Задайте адреса на Deploy Preview или локален сървър (не production)."); process.exit(1); }
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP8z8DAQAxgYhhVSF+FAMWKAh8Yq0QdAAAAAElFTkSuQmCC", "base64");
const SECRET = { egn: "8001019999", idn: "TESTID123456", dln: "TESTDL987654", addr: "ул. Тестова 99", doc: "syndoc-camera" };
const results = [];
const check = (n, ok, info = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${n}${info ? " | " + info : ""}`); };
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });

// Заявките към камерата се записват, за да се провери, че всички потоци са спрени
const TRACK = () => {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const orig = md.getUserMedia.bind(md);
  window.__streams = [];
  window.__constraints = [];
  md.getUserMedia = async (c) => { window.__constraints.push(c); const s = await orig(c); window.__streams.push(s); return s; };
  window.__live = () => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length;
};

async function session({ viewport = { width: 1280, height: 900 }, init = TRACK, mobile = false, consent = false, booking = "ok", origin = B } = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: "bg-BG", permissions: ["camera"] });
  const meta = [], w3 = [], posted = [];
  await ctx.route(/facebook\.(net|com)/, (r) => { meta.push({ url: r.request().url(), body: r.request().postData() || "" }); return r.fulfill({ status: 204, body: "" }); });
  await ctx.route("https://api.web3forms.com/**", (r) => { w3.push(r.request().postData()); return r.fulfill({ json: { success: true } }); });
  await ctx.route((u) => !u.href.startsWith(origin) && !/facebook|web3forms/.test(u.hostname), (r) => r.fulfill({ status: 204, body: "" }));
  if (origin !== B) await ctx.route(origin + "/**", async (r) => { const u = new URL(r.request().url()); const res = await r.fetch({ url: B + u.pathname + u.search }); return r.fulfill({ response: res }); });
  await ctx.route("**/api/availability", (r) => r.fulfill({ json: { cars: {}, buffer: 60 } }));
  await ctx.route("**/api/documents", (r) => { posted.push("doc"); return r.fulfill({ json: { url: "/api/documents/" + SECRET.doc + posted.length } }); });
  await ctx.route("**/api/bookings", (r) => { posted.push(r.request().postDataJSON()); return booking === "hours" ? r.fulfill({ status: 400, json: { error: "hours" } }) : r.fulfill({ status: 201, json: { id: "c".repeat(32), token: "d".repeat(64), status: "pending" } }); });
  if (init) await ctx.addInitScript(init);
  if (consent) await ctx.addInitScript(() => { try { localStorage.setItem("ck", JSON.stringify({ v: 1, marketing: true, t: Date.now() })); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/#avtomobili", { waitUntil: "load" });
  await page.waitForSelector("#car-grid .vcard");
  return { ctx, page, meta, w3, posted, errors };
}
const plan = (page, d1, t1, d2, t2) => page.evaluate(([d1, t1, d2, t2]) => { Object.assign(S, { car: "ka", d1, t1, d2, t2, m1: "store", m2: "store" }); writePlan(); $("#plan").hidden = false; planChanged(); return { err: planErr(), t1min: $("#b-t1").min, t1max: $("#b-t1").max, t2min: $("#b-t2").min, t2max: $("#b-t2").max, alert: $("#pick .alert")?.textContent || "", details: !$("#details").hidden }; }, [d1, t1, d2, t2]);
async function fill(page) {
  const f = { "#b-name": "ТЕСТ Камера", "#b-cit": "BG", "#b-phone": "+359000000000", "#b-mail": "camera-test@example.com", "#b-idn": SECRET.idn, "#b-egn": SECRET.egn, "#b-idd": "2020-01-01", "#b-idp": "МВР-ТЕСТ", "#b-reg": "ТЕСТ-област", "#b-mun": "ТЕСТ-община", "#b-city": "Тестоград", "#b-addr": SECRET.addr, "#b-dln": SECRET.dln, "#b-dlname": "ТЕСТ", "#b-dld": "2020-01-01", "#b-dlp": "МВР-ТЕСТ" };
  for (const [sel, v] of Object.entries(f)) await page.fill(sel, v);
  await page.check('input[name="ptype"][value="village"]').catch(() => {});
  await page.check("#b-ok");
  await page.check('input[name="pay"][value="cash"]');
}
const upload = (page, ids) => Promise.all(ids.map((id) => page.setInputFiles("#" + id, { name: "test.png", mimeType: "image/png", buffer: PNG })));

// ===== 1. Badge „−20%“ (PROMO.on – публично) =====
for (const [label, vp, mobile] of [["компютър", { width: 1280, height: 900 }, false], ["телефон", { width: 375, height: 740 }, true]]) {
  const { ctx, page, errors } = await session({ viewport: vp, mobile, origin: "https://rentacar-ptb.com" });
  const r = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#car-grid .vcard")];
    const box = (e) => e.getBoundingClientRect();
    const b = cards.map((c) => { const p = c.querySelector(".promo"), v = c.querySelector(".vimg"); if (!p) return null; const pb = box(p), vb = box(v), cs = getComputedStyle(p);
      return { text: p.textContent, inside: pb.bottom <= vb.bottom + 0.5 && pb.right <= vb.right + 0.5 && vb.bottom - pb.bottom >= 6 && vb.bottom - pb.bottom < 20 && vb.right - pb.right >= 6 && vb.right - pb.right < 20,
        // не се застъпва с „Свободен“ / „Зает“ и не излиза извън снимката
        clear: [...c.querySelectorAll(".vimg .ok")].every((o) => { const ob = box(o); return ob.bottom <= pb.top || ob.right <= pb.left || ob.left >= pb.right || ob.top >= pb.bottom; }), small: pb.width < vb.width * 0.25 && pb.height < vb.height * 0.2, bg: cs.backgroundColor, color: cs.color, anim: cs.animationName, font: parseFloat(cs.fontSize) }; });
    const h1 = cards.map((c) => c.getBoundingClientRect().height);
    document.querySelectorAll(".promo").forEach((p) => (p.style.display = "none"));
    const h2 = cards.map((c) => c.getBoundingClientRect().height);
    document.querySelectorAll(".promo").forEach((p) => (p.style.display = ""));
    const note = document.querySelector("#promo-note");
    const prices = cards.map((c) => c.textContent);
    return { n: cards.length, b, same: h1.every((h, i) => Math.abs(h - h2[i]) < 0.5), note: !note.hidden && note.textContent, small: note.querySelectorAll("small").length, overflow: document.documentElement.scrollWidth > innerWidth + 1, on: PROMO.on, strike: document.querySelectorAll("#car-grid s, #car-grid del").length, tiers: CARS.map((c) => c.tiers.join("/")).join(" ") };
  });
  check(`1. ${label}: badge „−20%“ на всеки автомобил (публично)`, r.on === true && r.n === 5 && r.b.every((x) => x && x.text === "−20%"), `карти: ${r.n}, PROMO.on=${r.on}`);
  check(`1. ${label}: в долния десен ъгъл на снимката с отстояние, малък, без застъпване`, r.b.every((x) => x && x.inside && x.small && x.clear), "");
  check(`1. ${label}: червен фон, бял текст, без анимация, ≥ 12px`, r.b.every((x) => x && x.bg === "rgb(198, 40, 40)" && x.color === "rgb(255, 255, 255)" && x.anim === "none" && x.font >= 12), r.b[0] && `${r.b[0].bg} / ${r.b[0].color} / ${r.b[0].font}px`);
  check(`1. ${label}: размерът на картите не се променя`, r.same, "");
  check(`1. ${label}: надпис без демо-бележка, без зачертани цени, без хоризонтален скрол`, r.note === "Промоционални цени −20%" && r.small === 0 && r.strike === 0 && !r.overflow, r.note);
  check(`1. ${label}: цените не са променени`, r.tiers === "20/18/15 20/18/15 25/23/20 25/23/20 25/23/20", r.tiers);
  check(`1. ${label}: без JS грешки`, errors.length === 0, errors.join("; "));
  // След филтриране – badge на всяка видима карта, на същото място
  const f = [];
  for (const [sel, v] of [["#f-price", "20"], ["#f-fuel", "Дизел"], ["#f-type", "Комби"]]) {
    await page.selectOption(sel, v);
    f.push(await page.evaluate(() => { const cs = [...document.querySelectorAll(".vcard")]; return [cs.length, cs.filter((c) => { const p = c.querySelector(".promo"); if (!p) return false; const a = p.getBoundingClientRect(), v = c.querySelector(".vimg").getBoundingClientRect(); return v.bottom - a.bottom >= 6 && v.bottom - a.bottom < 20 && v.right - a.right >= 6 && v.right - a.right < 20; }).length]; }));
    if (sel === "#f-price") await page.screenshot({ path: `/tmp/booking-ui-cars-filter-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await page.selectOption(sel, "");
  }
  check(`1. ${label}: badge на всяка карта и след филтриране`, f.every(([n, k]) => n > 0 && n === k), f.map((x) => x.join("/")).join(", "));
  await page.screenshot({ path: `/tmp/booking-ui-cars-${mobile ? "mobile" : "desktop"}.png` });
  await ctx.close();
}
// Изключване: PROMO.on = false скрива badge-а и надписа навсякъде
{
  const { ctx, page } = await session();
  const r = await page.evaluate(() => { PROMO.on = false; renderCars(); return { badges: document.querySelectorAll(".promo").length, note: !$("#promo-note").hidden }; });
  check("1. PROMO.on = false: без badge и надпис", r.badges === 0 && !r.note, `badges=${r.badges}`);
  await ctx.close();
}
// Превод на надписа
{
  const { ctx, page } = await session();
  await page.evaluate(() => setLang("en"));
  const en = await page.evaluate(() => [$("#promo-note").textContent, $("#b-t1-h").textContent, $("[data-cam=p-idf]").textContent, $("#p-idf-u").textContent, document.querySelector("#bk .doc-tip").textContent]);
  await page.evaluate(() => setLang("de"));
  const de = await page.evaluate(() => [$("#promo-note").textContent, $("#b-t1-h").textContent, $("[data-cam=p-idf]").textContent, $("#p-idf-u").textContent, document.querySelector("#bk .doc-tip").textContent]);
  check("5. EN преводи", en.every((t) => !/[А-я]/.test(t)), en.join(" | ").slice(0, 200));
  check("5. DE преводи", de.every((t) => !/[А-я]/.test(t)), de.join(" | ").slice(0, 200));
  await ctx.close();
}

// ===== 2. Работно време =====
{
  const { ctx, page } = await session();
  // 2029-04-02 е понеделник, 2029-04-07 – събота, 2029-04-08 – неделя
  const cases = [
    ["пн 08:00 → пн 20:00", ["2029-04-02", "08:00", "2029-04-02", "20:00"], true],
    ["пн 07:59 получаване", ["2029-04-02", "07:59", "2029-04-03", "10:00"], false],
    ["пн 20:01 връщане", ["2029-04-02", "10:00", "2029-04-02", "20:01"], false],
    ["сб 09:00 → нд 19:00", ["2029-04-07", "09:00", "2029-04-08", "19:00"], true],
    ["сб 08:59 получаване", ["2029-04-07", "08:59", "2029-04-08", "12:00"], false],
    ["нд 19:01 връщане", ["2029-04-07", "12:00", "2029-04-08", "19:01"], false],
    ["пн 20:00 (делник) → сб 19:30", ["2029-04-02", "20:00", "2029-04-07", "19:30"], false],
  ];
  for (const [n, d, ok] of cases) {
    const r = await plan(page, ...d);
    check(`4. ${n}: ${ok ? "приема се" : "отхвърля се"}`, ok ? !r.err && r.details : /работното време/.test(r.err) && /работното време/.test(r.alert) && !r.details, r.err || `min/max ${r.t1min}-${r.t1max} / ${r.t2min}-${r.t2max}`);
  }
  const mm = await plan(page, "2029-04-02", "10:00", "2029-04-07", "10:00");
  check("4. min/max по деня (пн 08:00–20:00, сб 09:00–19:00)", mm.t1min === "08:00" && mm.t1max === "20:00" && mm.t2min === "09:00" && mm.t2max === "19:00", `${mm.t1min}-${mm.t1max} / ${mm.t2min}-${mm.t2max}`);
  const past = await page.evaluate(() => ({ min: $("#b-d1").min, today }));
  check("4. най-ранна дата = днес в Europe/Sofia", past.min === past.today && past.today === new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(new Date()), past.min);
  const hint = await page.evaluate(() => [$("#b-t1").getAttribute("aria-describedby"), $("#b-t1-h").textContent]);
  check("4. работното време е до полетата (aria-describedby)", hint[0] === "b-t1-h" && /пн–пт 08:00–20:00, сб–нд 09:00–19:00/.test(hint[1]), hint[1]);
  await ctx.close();
}
// Отказ от сървъра (ръчно променена заявка / различен график) – ясно съобщение, без резервно известие
{
  const { ctx, page, w3, posted } = await session({ booking: "hours" });
  await plan(page, "2029-04-02", "10:00", "2029-04-03", "10:00");
  await page.waitForSelector("#bk", { state: "visible" });
  await fill(page);
  await upload(page, ["p-idf", "p-idb", "p-dlf", "p-dlb"]);
  await page.waitForFunction(() => !formErr());
  await page.click("#bk button[type=submit]");
  await page.waitForFunction(() => !document.querySelector("#b-err").hidden);
  const msg = await page.textContent("#b-err");
  check("4. сървърът отхвърля часа → съобщение, без Web3Forms", /извън работното време/.test(msg) && w3.length === 0 && posted.some((p) => p && p.startTime === "10:00"), msg);
  await ctx.close();
}

// ===== 3. Камера =====
{
  const { ctx, page, errors } = await session({ viewport: { width: 390, height: 800 }, mobile: true });
  await plan(page, "2029-04-02", "10:00", "2029-04-03", "10:00");
  await page.waitForSelector("#bk", { state: "visible" });
  const before = await page.evaluate(() => window.__streams.length);
  check("3. камерата не се включва без действие", before === 0, `потоци: ${before}`);
  const tips = await page.$$eval("#bk .doc-tip", (e) => e.map((x) => x.textContent));
  check("2. указания при лична карта/паспорт и шофьорска книжка", tips.length === 2 && tips.every((t) => /^Поставете документа върху равна повърхност/.test(t) && /Проверете четливостта преди изпращане\.$/.test(t)), `${tips.length} блока`);
  await page.click("[data-cam=p-idf]");
  await page.waitForSelector("#cam-shot", { state: "visible" });
  const live = await page.evaluate(() => { const v = $("#cam-v"), st = $("#cam-stage").getBoundingClientRect(), f = $("#cam-f").getBoundingClientRect();
    return { open: $("#cam").open, vw: v.videoWidth, vh: v.videoHeight, sr: st.width / st.height, fr: f.width / f.height, fit: f.left >= st.left && f.right <= st.right && f.top >= st.top && f.bottom <= st.bottom, tip: document.querySelector(".cam-tip").textContent, title: $("#cam-h").textContent, c: window.__constraints[0], live: __live(), focus: document.activeElement.id }; });
  check("3. собствен изглед с рамка, задна камера предпочетена", live.open && live.live === 1 && live.c.video.facingMode.ideal === "environment" && live.tip === "Поставете целия документ в рамката", `${live.vw}×${live.vh}, ${live.title}`);
  check("3. сцената има пропорциите на кадъра (без изрязване)", Math.abs(live.sr - live.vw / live.vh) < 0.02, `сцена ${live.sr.toFixed(3)} / кадър ${(live.vw / live.vh).toFixed(3)}`);
  check("3. рамка за карта ID-1 (≈1,586) изцяло в кадъра", Math.abs(live.fr - 85.6 / 54) < 0.03 && live.fit, live.fr.toFixed(3));
  check("3. фокусът е на „Снимай“", live.focus === "cam-shot", live.focus);
  await page.click("#cam-shot");
  await page.waitForSelector("#cam-use", { state: "visible" });
  const shot = await page.evaluate(async () => { const i = $("#cam-img"); await i.decode(); return { w: i.naturalWidth, h: i.naturalHeight, vw: $("#cam-v").videoWidth || 0, live: __live(), btns: ["cam-shot", "cam-again", "cam-use", "cam-close"].map((id) => !$("#" + id).hidden) }; });
  check("3. преглед: цял кадър, камерата е спряна, бутоните „Снимай отново“ / „Използвай снимката“ / „Затвори“", shot.w === live.vw && shot.h === live.vh && shot.live === 0 && shot.btns.join() === "false,true,true,true", `${shot.w}×${shot.h}, активни: ${shot.live}`);
  await page.click("#cam-again");
  await page.waitForSelector("#cam-shot", { state: "visible" });
  check("3. „Снимай отново“ включва камерата наново", (await page.evaluate(() => __live())) === 1, "");
  await page.click("#cam-shot");
  await page.waitForSelector("#cam-use", { state: "visible" });
  await page.click("#cam-use");
  await page.waitForFunction(() => !!PH["p-idf"] && !$("#p-idf-v").hidden);
  const used = await page.evaluate(() => ({ open: $("#cam").open, live: __live(), size: PH["p-idf"].size, type: PH["p-idf"].type, max: new Promise((ok) => { const i = new Image(); i.onload = () => ok(Math.max(i.naturalWidth, i.naturalHeight)); i.src = $("#p-idf-v").src; }) }));
  const maxSide = await page.evaluate(() => new Promise((ok) => { const i = new Image(); i.onload = () => ok(Math.max(i.naturalWidth, i.naturalHeight)); i.src = $("#p-idf-v").src; }));
  check("3. „Използвай снимката“: затваря, спира камерата, снимката минава през същото смаляване (JPEG ≤ 1800px)", !used.open && used.live === 0 && used.type === "image/jpeg" && maxSide <= 1800, `${used.size} B, ${maxSide}px`);
  // Паспорт: рамка 125 × 88
  await page.check('input[name="idt"][value="pass"]');
  await page.click("[data-cam=p-idb]");
  await page.waitForSelector("#cam-shot", { state: "visible" });
  const pr = await page.evaluate(() => { const f = $("#cam-f").getBoundingClientRect(); return f.width / f.height; });
  check("3. рамка за паспорт (≈1,42)", Math.abs(pr - 125 / 88) < 0.03, pr.toFixed(3));
  await page.click("#cam-close");
  check("3. „Затвори“ спира камерата", (await page.evaluate(() => [$("#cam").open, __live()])).join() === "false,0", "");
  await page.click("[data-cam=p-dlf]");
  await page.waitForSelector("#cam-shot", { state: "visible" });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !$("#cam").open);
  check("3. Esc затваря и спира камерата", (await page.evaluate(() => __live())) === 0, "");
  await page.click("[data-cam=p-dlf]");
  await page.waitForSelector("#cam-shot", { state: "visible" });
  await page.evaluate(() => { location.hash = "terms"; });
  await page.waitForFunction(() => !$("#cam").open);
  check("3. напускане на изгледа (смяна на страницата) спира камерата", (await page.evaluate(() => __live())) === 0, "");
  await page.evaluate(() => { location.hash = "avtomobili"; });
  await page.waitForSelector("#bk", { state: "visible" });
  // Клавиатура: бутоните са достъпни с Tab и Enter
  await page.focus("[data-cam=p-dlb]");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#cam-shot", { state: "visible" });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#cam-use", { state: "visible" });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !!PH["p-dlb"]);
  check("5. камера и приемане само с клавиатура", (await page.evaluate(() => [$("#cam").open, __live()])).join() === "false,0", "");
  await page.screenshot({ path: "/tmp/booking-ui-docs-mobile.png" });
  check("3. без JS грешки", errors.length === 0, errors.join("; "));
  await ctx.close();
}
// Отказан достъп
{
  const denied = () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError")); };
  const { ctx, page } = await session({ init: denied });
  await plan(page, "2029-04-02", "10:00", "2029-04-03", "10:00");
  await page.waitForSelector("#bk", { state: "visible" });
  await page.click("[data-cam=p-idf]");
  await page.waitForSelector("#cam-file", { state: "visible" });
  const msg = await page.textContent("#cam-msg");
  check("3. отказан достъп: инструкции за разрешаване, „Опитай отново“, без черен кадър", /отказан за този сайт/.test(msg) && /Настройки на уебсайта/.test(msg) && (await page.isHidden("#cam-shot")) && (await page.isVisible("#cam-retry")) && (await page.isHidden("#cam-live")) && (await page.isHidden("#cam-tab")), msg.slice(0, 80));
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#cam-file")]);
  await chooser.setFiles({ name: "test.png", mimeType: "image/png", buffer: PNG });
  await page.waitForFunction(() => !!PH["p-idf"]);
  check("3. отказан достъп: качването на файл работи", !(await page.evaluate(() => $("#cam").open)), "");
  await ctx.close();
}
// Вграден в чужда рамка без allow="camera" (както прегледът в app.netlify.com): не е отказ на посетителя
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, permissions: ["camera"] });
  await ctx.route(/facebook/, (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/api/availability", (r) => r.fulfill({ json: { cars: {}, buffer: 60 } }));
  // Външна страница с друг произход вгражда сайта без allow="camera" (както app.netlify.com). Двата адреса са https и се
  // обслужват от теста; сайтът идва от B (локален сървър или Deploy Preview).
  const PARENT = "https://app.example.test/", SITE = /localhost|127\.0\.0\.1/.test(B) ? "https://site.example.test" : B;
  if (SITE !== B) await ctx.route(SITE + "/**", async (r) => { const u = new URL(r.request().url()); return r.fulfill({ response: await r.fetch({ url: B + u.pathname + u.search }) }); });
  await ctx.route(PARENT, (r) => r.fulfill({ contentType: "text/html", body: `<!doctype html><meta name=viewport content="width=device-width"><body style="margin:0"><iframe src="${SITE}/#avtomobili" style="border:0;width:100vw;height:100vh"></iframe>` }));
  const page = await ctx.newPage();
  await page.goto(PARENT, { waitUntil: "load" });
  const fr = page.frameLocator("iframe");
  const f = await (await page.waitForSelector("iframe")).contentFrame();
  await f.waitForSelector("#car-grid .vcard");
  await f.evaluate(() => { Object.assign(S, { car: "ka", d1: "2029-04-02", t1: "10:00", d2: "2029-04-03", t2: "10:00", m1: "store", m2: "store" }); writePlan(); $("#plan").hidden = false; planChanged(); });
  await fr.locator("[data-cam=p-idf]").click();
  await f.waitForSelector("#cam-tab", { state: "visible" });
  const r = await f.evaluate(() => ({ msg: $("#cam-msg").textContent, live: $("#cam-live").hidden, tip: $("#cam-tip").hidden, file: !$("#cam-file").hidden, close: !$("#cam-close").hidden, code: $("#cam-code-v").textContent, href: $("#cam-tab").href, target: $("#cam-tab").target }));
  check("3. вграден без разрешение: „блокирана от страницата“, а не „отказан“", /блокирана от страницата/.test(r.msg) && !/отказан за този сайт/.test(r.msg), `${r.code}`);
  check("3. вграден: скрити черен кадър и инструкция; има „Качи снимка/файл“, „Затвори“ и „Отвори в нов раздел“", r.live && r.tip && r.file && r.close && r.target === "_blank" && r.href.startsWith(SITE), r.href);
  const box = await f.evaluate(() => { const d = $("#cam").getBoundingClientRect(), c = $("#cam-close").getBoundingClientRect(), h = $("#cam-h").getBoundingClientRect(); return { d: [d.top, d.bottom], c: c.bottom, h: h.top, vh: innerHeight }; });
  check("3. мобилен диалог в рамката на екрана (заглавие и „Затвори“ видими)", box.d[0] >= 0 && box.d[1] <= box.vh && box.h >= 0 && box.c <= box.vh, JSON.stringify(box));
  await ctx.close();
}
// Мобилен диалог при работеща камера на малък екран (375×667): заглавие и бутони в екрана
{
  const { ctx, page } = await session({ viewport: { width: 375, height: 667 }, mobile: true });
  await plan(page, "2029-04-02", "10:00", "2029-04-03", "10:00");
  await page.waitForSelector("#bk", { state: "visible" });
  await page.click("[data-cam=p-idf]");
  await page.waitForSelector("#cam-shot", { state: "visible" });
  const b = await page.evaluate(() => { const d = $("#cam").getBoundingClientRect(), h = $("#cam-h").getBoundingClientRect(), s = $("#cam-shot").getBoundingClientRect(), c = $("#cam-close").getBoundingClientRect(); return { top: d.top, bottom: d.bottom, h: h.top, s: s.bottom, c: c.bottom, vh: innerHeight }; });
  check("3. мобилен диалог 375×667: заглавие, „Снимай“ и „Затвори“ в екрана", b.top >= 0 && b.bottom <= b.vh && b.h >= 0 && b.s <= b.vh && b.c <= b.vh, JSON.stringify(b));
  await page.screenshot({ path: "/tmp/booking-ui-cam-375.png" });
  await page.click("#cam-close");
  await ctx.close();
}
// Неподдържан браузър: съобщение до полето, резервацията не се блокира
{
  const unsup = () => { try { Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true }); } catch (e) {} };
  const { ctx, page, posted, meta } = await session({ init: unsup, consent: true });
  await plan(page, "2029-04-02", "10:00", "2029-04-03", "10:00");
  await page.waitForSelector("#bk", { state: "visible" });
  await page.click("[data-cam=p-idf]");
  const r = await page.evaluate(() => ({ open: $("#cam").open, msg: $("#p-idf-m").textContent }));
  check("3. неподдържан браузър: съобщение до полето, без изглед", !r.open && /не позволява снимане/.test(r.msg), r.msg);
  await fill(page);
  await upload(page, ["p-idf", "p-idb", "p-dlf", "p-dlb"]);
  await page.waitForFunction(() => !formErr());
  check("3. неподдържан браузър: съобщението изчезва след качване", (await page.textContent("#p-idf-m")) === "", "");
  await page.click("#bk button[type=submit]");
  await page.waitForFunction(() => location.hash === "#blagodarim");
  const body = posted.find((p) => p && p.name);
  check("3. резервацията се изпраща с качени файлове", posted.filter((p) => p === "doc").length === 4 && body && body.startTime === "10:00", `документи: ${posted.filter((p) => p === "doc").length}`);
  await page.waitForTimeout(1500);
  const leak = meta.filter((m) => Object.values(SECRET).some((v) => (m.url + m.body).includes(v)) || /api\/documents|blob:/.test(m.url + m.body));
  check("6. заявките към Meta не съдържат документи и лични данни", leak.length === 0, `заявки към Meta: ${meta.length}, с данни: ${leak.length}`);
  await ctx.close();
}

await browser.close();
const fails = results.filter((x) => !x).length;
console.log(`\nОБЩО: ${results.length - fails} PASS, ${fails} FAIL`);
process.exit(fails ? 1 : 0);
