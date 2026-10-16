// Браузърна проверка: „Адрес по документа“ в стъпка „2 Лична карта / паспорт“ – област, община, град / село и адрес.
//   npm install --no-save playwright-core@1 && npx playwright-core install chromium
//   python3 -m http.server 8890            (от папката на проекта, в отделен терминал)
//   node tests/browser/doc-address.mjs http://localhost:8890
// /api/*, Web3Forms и Meta се подменят: не се създават резервации и нищо не излиза навън. Само синтетични данни.
import { chromium } from "playwright-core";

const B = (process.argv[2] || "").replace(/\/$/, "");
if (!/^(https:\/\/[\w-]+--rentacarptb\.netlify\.app|http:\/\/(localhost|127\.0\.0\.1):\d+)$/.test(B)) { console.error("Задайте адреса на Deploy Preview или локален сървър (не production)."); process.exit(1); }
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP8z8DAQAxgYhhVSF+FAMWKAh8Yq0QdAAAAAElFTkSuQmCC", "base64");
const HINT = "Попълнете адреса по документа: област, община и град/село. Пример: обл. Пловдив, общ. Марица, с. Труд.";
const results = [];
const check = (n, ok, info = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${n}${info ? " | " + info : ""}`); };
const browser = await chromium.launch();

async function session({ viewport = { width: 1280, height: 900 }, mobile = false, lang = "bg", consent = true } = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: "bg-BG" });
  const meta = [], w3 = [], posted = [];
  await ctx.route(/facebook\.(net|com)/, (r) => { meta.push(r.request().url() + " " + (r.request().postData() || "")); return r.fulfill({ status: 204, body: "" }); });
  await ctx.route("https://api.web3forms.com/**", (r) => { w3.push(r.request().postData()); return r.fulfill({ json: { success: true } }); });
  await ctx.route((u) => !u.href.startsWith(B) && !/facebook|web3forms/.test(u.hostname), (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/api/availability", (r) => r.fulfill({ json: { cars: {}, buffer: 60 } }));
  await ctx.route("**/api/documents", (r) => r.fulfill({ json: { url: "/api/documents/syndoc" } }));
  await ctx.route("**/api/bookings", (r) => { posted.push(r.request().postDataJSON()); return r.fulfill({ status: 201, json: { id: "c".repeat(32), token: "d".repeat(64), status: "pending" } }); });
  await ctx.addInitScript(([lang, consent]) => { try { localStorage.setItem("lang", lang); if (consent) localStorage.setItem("ck", JSON.stringify({ v: 1, marketing: true, t: Date.now() })); } catch (e) {} }, [lang, consent]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(B + "/#avtomobili", { waitUntil: "load" });
  await page.waitForSelector("#car-grid .vcard");
  await page.evaluate(() => { Object.assign(S, { car: "ka", d1: "2029-04-02", t1: "10:00", d2: "2029-04-04", t2: "10:00", m1: "store", m2: "store", open: true }); writePlan(); $("#plan").hidden = false; renderCars(); renderPick(); });
  await page.waitForSelector("#bk", { state: "visible" });
  return { ctx, page, meta, w3, posted, errors };
}
async function fill(page, a) {
  const f = { "#b-name": "ТЕСТ Адрес", "#b-cit": a.cit, "#b-phone": "+359000000000", "#b-mail": "address-test@example.com", "#b-idn": "TESTID777", "#b-egn": "8001019999",
    "#b-idd": "2020-01-01", "#b-idp": "МВР-ТЕСТ", "#b-reg": a.reg, "#b-mun": a.mun, "#b-city": a.city, "#b-addr": a.addr, "#b-dln": "TESTDL777", "#b-dlname": "ТЕСТ", "#b-dld": "2020-01-01", "#b-dlp": "МВР-ТЕСТ" };
  if (a.idt) await page.check(`input[name="idt"][value="${a.idt}"]`);
  for (const [sel, v] of Object.entries(f)) { await page.fill(sel, v); await page.dispatchEvent(sel, "change"); }
  if (a.ptype) await page.check(`input[name="ptype"][value="${a.ptype}"]`);
  for (const id of ["p-idf", "p-idb", "p-dlf", "p-dlb"]) await page.setInputFiles("#" + id, { name: "test.png", mimeType: "image/png", buffer: PNG });
  await page.check('input[name="pay"][value="cash"]');
  await page.check("#b-ok");
  await page.waitForTimeout(500);
  return page.evaluate(() => formErr());
}
const submit = async (s) => { await s.page.click("#bk button[type=submit]"); await s.page.waitForFunction(() => location.hash === "#blagodarim", null, { timeout: 15000 }); return s.posted.find((p) => p && p.contract); };

// ===== 1. Оформление и текстове (компютър и телефон) =====
for (const [label, vp, mobile] of [["компютър", { width: 1280, height: 900 }, false], ["телефон", { width: 360, height: 740 }, true]]) {
  const s = await session({ viewport: vp, mobile });
  const r = await s.page.evaluate((HINT) => {
    const lab = (id) => document.querySelector(`label[for=${id}]`)?.innerText.trim();
    const h = document.getElementById("b-adoc-hint"), cs = getComputedStyle(h), seg = document.querySelector("input[name=ptype]").closest(".seg");
    const box = (e) => e.getBoundingClientRect(), fs = document.querySelector("#bk .adoc"), over = [...fs.querySelectorAll("input,label,p")].some((e) => box(e).right > document.documentElement.clientWidth + 0.5);
    return { labels: [lab("b-reg"), lab("b-mun"), lab("b-city"), lab("b-addr")], ptitle: document.getElementById("b-ptype-t").textContent, opts: [...seg.querySelectorAll("span")].map((x) => x.textContent),
      hint: h.textContent, hidden: h.hidden || cs.display === "none", color: cs.color, font: parseFloat(cs.fontSize), over, scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      noGrad: ![...document.querySelectorAll("#bk label[for]")].some((l) => l.textContent.trim() === "Град"), addrPh: document.getElementById("b-addr").placeholder, regReq: !!document.querySelector("[data-adm-opt]:not([hidden])"),
      tap: [...seg.querySelectorAll(".opt")].every((o) => box(o).height >= 40) };
  }, HINT);
  check(`1. ${label}: етикети „Област“, „Община“, „Населено място“ с избор „Град / Село“, „Име на населеното място“, отделно „Адрес“`, r.labels[0] === "Област" && r.labels[1] === "Община" && r.labels[2] === "Име на населеното място" && r.labels[3] === "Адрес" && r.ptitle === "Населено място" && r.opts.join("/") === "Град/Село" && r.noGrad && r.addrPh === "Улица, номер, вход, апартамент", JSON.stringify([r.labels, r.ptitle, r.opts, r.noGrad, r.addrPh]));
  check(`1. ${label}: сивият текст под групата е видим и четлив`, r.hint === HINT && !r.hidden && r.color === "rgb(91, 102, 120)" && r.font >= 14, `${r.color} ${r.font}px`);
  check(`1. ${label}: без хоризонтално превъртане, бутоните „Град / Село“ са удобни за докосване`, !r.over && !r.scroll && r.tap, "");
  check(`1. ${label}: при българска лична карта област и община са задължителни (без „по избор“)`, !r.regReq, "");
  check(`1. ${label}: без грешки в страницата`, s.errors.length === 0, s.errors.join("; "));
  await s.ctx.close();
}

// ===== 2. Село: данни към сървъра, договор и текст до фирмата; представките не се дублират =====
{
  const s = await session();
  const errNoType = await fill(s.page, { cit: "България", reg: "Пловдив", mun: "Марица", city: "Труд", addr: "ул. Тестова 7" });
  check("2. без избор „Град / Село“ формата не се изпраща", errNoType === "Моля, изберете дали населеното място е град или село.", errNoType);
  await s.page.check('input[name="ptype"][value="village"]');
  const noReg = await s.page.evaluate(() => { $("#b-reg").value = ""; return formErr(); });
  check("2. българска лична карта без област → ясна грешка", noReg === "Моля, попълнете областта и общината по документа.", noReg);
  // Клиентът пише и представките – те се махат от полетата и не се повтарят
  for (const [sel, v] of [["#b-reg", "обл. Пловдив"], ["#b-mun", "община Марица"], ["#b-city", "с. Труд"]]) { await s.page.fill(sel, v); await s.page.dispatchEvent(sel, "change"); }
  const vals = await s.page.evaluate(() => [$("#b-reg").value, $("#b-mun").value, $("#b-city").value]);
  check("2. „обл.“, „община“ и „с.“, написани от клиента, се махат от полетата", vals.join("|") === "Пловдив|Марица|Труд", vals.join("|"));
  const p = await submit(s);
  const c = p?.contract || {};
  check("2. към сървъра: region, municipality, placeType=village, city, addr", c.region === "Пловдив" && c.municipality === "Марица" && c.placeType === "village" && c.city === "Труд" && c.addr === "ул. Тестова 7", JSON.stringify({ r: c.region, m: c.municipality, t: c.placeType, c: c.city }));
  check("2. текстът до фирмата: област, община, „с. Труд“ и пълният адрес без двойни представки",
    /Област: Пловдив\n/.test(p.message) && /Община: Марица\n/.test(p.message) && /Населено място: с\. Труд\n/.test(p.message) && /Адрес: ул\. Тестова 7\n/.test(p.message) && p.message.includes("Адрес по документа: обл. Пловдив, общ. Марица, с. Труд, ул. Тестова 7") && !/с\. с\.|обл\. обл\.|общ\. общ\./.test(p.message), "");
  check("2. адресът и документът не стигат до Meta и Web3Forms", !s.meta.some((m) => /Тестова|Марица|Труд|TESTID777/.test(decodeURIComponent(m))) && !s.w3.some((m) => /Тестова|Марица|Труд/.test(m || "")), `${s.meta.length} заявки към Meta`);
  // Възстановяване на въведените данни при ново зареждане (sessionStorage)
  await s.page.reload({ waitUntil: "load" });
  await s.page.evaluate(() => { location.hash = "avtomobili"; });
  await s.page.waitForTimeout(800);
  const back = await s.page.evaluate(() => [$("#b-reg").value, $("#b-mun").value, $("#b-city").value, $("#b-addr").value, (document.querySelector("input[name=ptype]:checked") || {}).value]);
  check("2. въведените данни се възстановяват след презареждане (вкл. „Село“)", back.join("|") === "Пловдив|Марица|Труд|ул. Тестова 7|village", back.join("|"));
  await s.ctx.close();
}

// ===== 3. Град: „гр. Пловдив“ избира „Град“ автоматично =====
{
  const s = await session();
  await fill(s.page, { cit: "BG", reg: "Пловдив", mun: "Пловдив", city: "гр. Пловдив", addr: "бул. Тестов 1, вх. А, ап. 2" });
  const t = await s.page.evaluate(() => [(document.querySelector("input[name=ptype]:checked") || {}).value, $("#b-city").value, formErr()]);
  check("3. „гр. Пловдив“ → избран „Град“, полето е „Пловдив“, формата е готова", t[0] === "city" && t[1] === "Пловдив" && t[2] === "", t.join("|"));
  const p = await submit(s);
  check("3. текстът до фирмата: „гр. Пловдив“ веднъж", p.message.includes("Адрес по документа: обл. Пловдив, общ. Пловдив, гр. Пловдив, бул. Тестов 1, вх. А, ап. 2") && !p.message.includes("гр. гр."), "");
  await s.ctx.close();
}

// ===== 4. Чуждестранен адрес: паспорт, латиница, без област и община =====
{
  const s = await session();
  const err = await fill(s.page, { idt: "pass", cit: "Germany", reg: "", mun: "", city: "München", addr: "Leopoldstraße 12" });
  const r = await s.page.evaluate(() => ({ opt: [...document.querySelectorAll("[data-adm-opt]")].every((e) => !e.hidden), foreign: !$("#b-adoc-foreign").hidden }));
  check("4. паспорт / чуждо гражданство: област и община са „по избор“, показва се бележка за латиница", err === "Моля, изберете дали населеното място е град или село." && r.opt && r.foreign, err);
  await s.page.check('input[name="ptype"][value="city"]');
  check("4. без област и община формата е готова", (await s.page.evaluate(() => formErr())) === "", "");
  const p = await submit(s);
  check("4. латиница се приема: city=München, без област и община", p.contract.city === "München" && p.contract.region === "" && p.contract.municipality === "" && p.contract.placeType === "city" && p.message.includes("Адрес по документа: гр. München, Leopoldstraße 12"), p.contract.city);
  // Лична карта на чужденец (не българско гражданство) – също без задължителни област и община
  await s.ctx.close();
}

// ===== 5. Преводи на английски и немски =====
for (const [lang, want] of [["en", ["Region (oblast) / state", "Municipality", "Town / village", "Town / city", "Village", "Enter the address as shown in the document"]], ["de", ["Bezirk (Oblast) / Bundesland", "Gemeinde", "Ort", "Stadt", "Dorf", "Geben Sie die Adresse laut Dokument an"]]]) {
  const s = await session({ lang, viewport: { width: 375, height: 740 }, mobile: true });
  const t = await s.page.evaluate(() => [document.querySelector("label[for=b-reg]").textContent.trim(), document.querySelector("label[for=b-mun]").textContent.trim(), $("#b-ptype-t").textContent, ...[...document.querySelectorAll("input[name=ptype]")].map((i) => i.nextElementSibling.textContent), $("#b-adoc-hint").textContent]);
  const ok = t[0].startsWith(want[0]) && t[1].startsWith(want[1]) && t[2] === want[2] && t[3] === want[3] && t[4] === want[4] && t[5].startsWith(want[5]) && !t.some((x) => /[А-я]/.test(x));
  check(`5. ${lang.toUpperCase()}: адресната група е преведена`, ok, t.join(" | "));
  await s.ctx.close();
}

await browser.close();
const fails = results.filter((x) => !x).length;
console.log(`\nОБЩО: ${results.length - fails} PASS, ${fails} FAIL`);
process.exit(fails ? 1 : 0);
