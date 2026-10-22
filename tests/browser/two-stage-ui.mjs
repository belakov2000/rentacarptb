// Браузърна проверка на новия двуетапен процес срещу локалния e2e сървър (истинските функции, временна база, симулирана поща):
// кратка форма с вериги и втори водач (без документи) → първо одобрение (бутонът в страницата от служебния имейл) →
// линкът от имейла в нов браузър (телефон) → документите на двамата водачи → „Получени документи — очакват проверка“
// → окончателно потвърждение → потвърдена. Английската и немската версия на кратката форма. Само синтетични данни.
//   node tests/e2e/run.mjs tests/browser/two-stage-ui.mjs
import { chromium } from "playwright-core";
import jpeg from "jpeg-js";

const B = (process.argv[2] || "").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(B)) { console.error("Само локален e2e сървър (tests/e2e/run.mjs)."); process.exit(1); }
const JPG = (() => { const w = 640, h = 400, d = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) d.set([i % 251, (i * 3) % 253, 90, 255], i * 4); return Buffer.from(jpeg.encode({ data: d, width: w, height: h }, 80).data); })();
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Sofia" });
let n0 = 30, D1 = day(n0); while ([0, 6].includes(new Date(D1 + "T12:00:00Z").getUTCDay())) D1 = day(++n0);
const D2 = new Date(Date.parse(D1 + "T12:00:00Z") + 2 * 864e5).toISOString().slice(0, 10);
const res = []; const check = (n, ok, i = "") => { res.push(ok); console.log(`${ok ? "PASS" : "FAIL"} | ${n} | ${i}`); };
const sql = async (q) => (await (await fetch(B + "/__e2e/sql?q=" + encodeURIComponent(q))).json());
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
async function open(seed, o = {}) {
  const ctx = await browser.newContext({ locale: "bg-BG", viewport: { width: 1280, height: 900 }, ...o });
  await ctx.route((u) => !u.href.startsWith(B), (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.addInitScript((s) => { localStorage.setItem("cookie-consent", JSON.stringify({ v: 2, necessary: true, marketing: false, date: "2026-10-01T00:00:00.000Z" })); if (s && !sessionStorage.getItem("req")) sessionStorage.setItem("req", JSON.stringify(s)); }, seed);
  const page = await ctx.newPage(); page.errs = []; page.on("pageerror", (e) => { page.errs.push(e.message); console.error("PAGE ERROR", e.message); });
  page.on("response", async r => { if (r.url().startsWith(B + "/api/") && r.status() >= 400) console.error("API ERROR", new URL(r.url()).pathname, r.status(), (await r.text()).slice(0, 300)); });
  return { ctx, page };
}
const pickText = (page) => page.locator("#pick").innerText();
const seed = { car: "golf", d1: D1, t1: "10:00", d2: D2, t2: "10:00", m1: "addr", a1: "ул. Тестова 1", m2: "office", open: true };


async function checkSocialFooter(page,label){const result=await page.evaluate(()=>{const f=document.querySelector("footer").getBoundingClientRect(),group=document.querySelector("footer .footer-social"),r=group.getBoundingClientRect();return{inside:r.top>=f.top&&r.bottom<=f.bottom,static:getComputedStyle(group).position==="static",count:group.querySelectorAll("a.social-link").length}});check(label,result.inside&&result.static&&result.count===2,JSON.stringify(result))}
{
 const {ctx,page}=await open(null);await page.goto(B+"/#home",{waitUntil:"load"});
 for(const width of [320,390,430,1280]){await page.setViewportSize({width,height:900});await checkSocialFooter(page,"Social icons stay inside footer at "+width+"px")}
 await ctx.close();
}
// 1. Кратка форма: вериги и втори водач в офертата, без полета и снимки на документите
{
  const { ctx, page } = await open(seed);
  await page.goto(B + "/#avtomobili", { waitUntil: "load" });
  await page.waitForFunction(() => /Общо за услугите/.test(document.querySelector("#pick").innerText), null, { timeout: 15000 });
  check("0. външните карти не получават адреса с кода на резервацията", await page.$$eval("iframe[src*=\"maps\"]", fs => fs.every(f => f.referrerPolicy === "no-referrer")));
  await page.check("#b-chains"); await page.check("#b-sd");
  await page.waitForFunction(() => /Вериги за сняг[\s\S]*Втори допълнителен водач/.test(document.querySelector("#pick").innerText), null, { timeout: 15000 });
  const t = await pickText(page);
  check("1.1 оферта от сървъра: вериги 2 × 3,50 € = 7 € и втори водач 2 × 3 € = 6 €, доставка 5 €, обща сума 68 €", /Вериги за сняг[\s\S]*7 €/.test(t) && /Втори допълнителен водач[\s\S]*6 €/.test(t) && /Общо за услугите\s*68 €/.test(t), t.replace(/\n/g, " / ").slice(0, 300));
  const docsVisible = await page.$$eval("#bk [data-flow1]", (fs) => fs.filter((f) => !f.hidden).length);
  check("1.2 кратката форма няма полета и снимки за документите; има „Кой ще шофира“ и маркетингово съгласие", docsVisible === 0 && (await page.isVisible("input[name=rdrv][value='0']")) && (await page.isVisible("#b-mkt")));
  for (const [s, v] of Object.entries({ "#b-first": "ТЕСТ", "#b-middle": "Заявител", "#b-last": "Иванов", "#b-phone-local": "877000777", "#b-mail": "two-stage-ui@example.com", "#b-mail-confirm": "two-stage-ui@example.com" })) await page.fill(s, v);
  await page.selectOption("#b-bday", "1"); await page.selectOption("#b-bmonth", "1"); await page.selectOption("#b-byear", "1990");
  await page.check("input[name=rdrv][value='0']");
  for (const [prefix, values] of [["d", ["ТЕСТ", "Основен", "Водач"]], ["s", ["ТЕСТ", "Втори", "Водач"]]]) for (const [i, part] of ["first", "middle", "last"].entries()) await page.fill("#b-" + prefix + part, values[i]);
  await page.check('input[name="pay2"][value="cash"]'); await page.check("#b-ok"); await page.check("#b-mkt");
  await page.waitForFunction(() => !document.querySelector("#bk button[type=submit]").disabled, null, { timeout: 10000 });
  await page.click("#bk button[type=submit]");
  await page.waitForFunction(() => location.hash === "#blagodarim" && /Заявката е получена/.test(document.querySelector("#th-h").textContent), null, { timeout: 20000 }).catch(async e => { console.error("SUBMIT STATE", await page.evaluate(() => ({ hash: location.hash, heading: document.querySelector("#th-h")?.textContent, error: document.querySelector("#b-err")?.textContent, progress: document.querySelector("#b-msg")?.textContent, hidden: document.hidden }))); throw e; });
  check("1.2a статусът е видим", await page.isVisible("#th-h"));
  await checkSocialFooter(page,"Social icons remain in footer on request confirmation page");
  const [b] = await sql("select id, stage, chains, second_driver, marketing_consent, drivers, documents, total_cents from bookings order by created_at desc limit 1");
  check("1.3 изпратена заявка → страница „Заявката е получена“; в базата: етап request, вериги, втори водач, съгласие, заявителят не шофира, без снимки, 68 €",
    b && b.stage === "request" && b.chains && b.second_driver && b.marketing_consent && b.drivers.requesterDrives === false && b.documents === null && b.total_cents === 6800 && page.errs.length === 0 && !(await page.isVisible("#th-docs")), JSON.stringify(b).slice(0, 200));
  await ctx.close();
}
const [bk] = await sql("select id, admin_token, view_token from bookings order by created_at desc limit 1");
// 2. Първо одобрение от страницата в служебния имейл (GET не променя, POST одобрява)
{
  const g = await fetch(`${B}/api/bookings/${bk.id}/manage?key=${bk.admin_token}`);
  const [s0] = await sql(`select stage from bookings where id='${bk.id}'`);
  const p = await fetch(`${B}/api/bookings/${bk.id}/manage?key=${bk.admin_token}`, { method: "POST", body: new URLSearchParams({ action: "confirm" }) });
  const [s1] = await sql(`select stage, docs_invited_at from bookings where id='${bk.id}'`);
  check("2. линкът от имейла: GET не одобрява; бутонът одобрява → етап docs, поканата е изпратена (симулирана поща)", g.status === 200 && s0.stage === "request" && p.status === 200 && s1.stage === "docs" && !!s1.docs_invited_at, JSON.stringify(s1));
}
// 3. Линкът от поканата в нов браузър на телефон: документи на двамата водачи
{
  const { ctx, page } = await open(null, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await page.goto(`${B}/?b=${bk.id}&t=${bk.view_token}#blagodarim`, { waitUntil: "load" });
  await page.waitForSelector("#docs-f", { timeout: 15000 });
  const h = await page.locator("#th-h").textContent(), legends = await page.$$eval("#docs-f legend", (l) => l.map((x) => x.textContent));
  check("3.1 линкът от имейла (нов браузър, телефон): „Заявката е одобрена – подайте документите“; два водача; без плащане, столчета и коментар",
    /подайте документите/.test(h) && legends.length === 2 && /наемател/.test(legends[0]) && !(await page.$("#docs-f [name=pay]")) && !(await page.$("#docs-f #b-note")), legends.join(" | "));
  // Check actual paint colors and geometry, not just whether inputs exist.
  for (const width of [1280, 320, 375, 390, 430]) {
    await page.setViewportSize({width,height:900});
    const visual=await page.evaluate(()=>{
      const luminance=c=>{const rgb=c.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};
      const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
      const card=document.querySelector('#th-docs'),r=card.getBoundingClientRect(),grid=card.parentElement.getBoundingClientRect();
      const inputs=[...document.querySelectorAll('#docs-f input:not([hidden])')].filter(e=>e.getBoundingClientRect().width>2);
      return {outsideSidebar:!card.closest('.th-side'),width:r.width,centered:Math.abs((r.left+r.right)-(grid.left+grid.right))<4,
        fits:inputs.every(e=>{const b=e.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right+1}),
        text:inputs.filter(e=>!['radio','checkbox','file'].includes(e.type)).every(e=>{const c=getComputedStyle(e);return contrast(c.color,c.backgroundColor)>=4.5&&contrast(c.webkitTextFillColor,c.backgroundColor)>=4.5}),
        labels:[...document.querySelectorAll('#docs-f label')].every(e=>contrast(getComputedStyle(e).color,getComputedStyle(card).backgroundColor)>=4.5)};
    });
    check(`3.1a ${width}px: centered document form, readable text and labels, controls fit`,visual.outsideSidebar&&visual.centered&&visual.fits&&visual.text&&visual.labels&&(width<960||visual.width>=800),JSON.stringify(visual));
  }
  await page.setViewportSize({width:390,height:844});
  check("3.1b mobile shows one compact section at a time", await page.locator("#docs-f [data-collapsed=false]").count() === 1 && (await page.locator("#docs-f [data-collapsed=true]").first().boundingBox()).height < 75 && await page.isVisible("#d0-name") && !(await page.isVisible("#d0-addr")));
  await page.fill("#d0-name","ТЕСТ Запазено Име");
  await page.locator("#ds-0-0 .doc-next").click();
  check("3.1c continue opens address and preserves entered identity",await page.isVisible("#d0-addr") && !(await page.isVisible("#d0-name"))) ;
  await page.locator("[aria-controls=ds-0-0]").click();
  check("3.1d returning to a section keeps values",await page.inputValue("#d0-name") === "ТЕСТ Запазено Име");
  await page.click("#docs-f button[type=submit]");
  check("3.2 непопълнени данни → ясна грешка, нищо не се изпраща", /Моля, попълнете всички данни на водач 1/.test(await page.locator("#d-err").innerText()));
  const reveal = async selector => {const section=await page.locator(selector).evaluate(e=>e.closest('[data-doc-section]')?.querySelector('.doc-section-head').getAttribute('aria-controls'));if(section && !(await page.isVisible(selector)))await page.locator(`[aria-controls="${section}"]`).click()};
  for (const i of [0, 1]) {
    const v = { name: i ? "ТЕСТ Втори Водач" : "ТЕСТ Основен Водач", idn: "TID" + i, egn: "800101000" + i, idd: "2020-01-01", idp: "МВР ТЕСТ", region: "Пловдив", municipality: "Пловдив", city: "Пловдив", addr: "ул. Документна " + (i + 1), dln: "TDL" + i, dld: "2021-02-02", dlp: "МВР ТЕСТ" };
    for (const [k, x] of Object.entries(v)) {await reveal(`#d${i}-${k}`);await page.fill(`#d${i}-${k}`, x)}
    await reveal(`input[name="d${i}-pt"][value="city"]`);await page.check(`input[name="d${i}-pt"][value="city"]`);
    await page.locator(`[aria-controls="ds-${i}-3"]`).click();
    if(i===0){
      await page.evaluate(()=>{window.__realMedia=navigator.mediaDevices.getUserMedia;navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Test denial','NotAllowedError')}});
      await page.click('[data-doc-camera="0-idf"]');await page.waitForSelector('#cam-file',{state:'visible'});
      check('3.2a denied camera shows guidance and gallery fallback, not a black live frame',await page.isVisible('#cam-msg')&&!(await page.isVisible('#cam-live')));
      check('3.2a1 camera refusal offers a neutral phone-camera recovery',await page.isVisible('#cam-native')&&!(await page.locator('#cam-msg').getAttribute('class')).includes('err'));
      const chooserPromise=page.waitForEvent('filechooser');await page.click('#cam-native');const chooser=await chooserPromise;
      await chooser.setFiles({name:'native-camera.jpg',mimeType:'image/jpeg',buffer:JPG});
      await page.waitForFunction(()=>document.querySelector('#d0-pidf-v').naturalWidth>0&&!document.querySelector('#d0-pidf-view').hidden);
      check('3.2a2 system camera capture reaches the same document preview',await page.locator('#cam-native-input').getAttribute('capture')==='environment'&&!(await page.locator('#cam').isVisible()));
      await page.evaluate(()=>{CAM.nativePreferred=false});
      await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{const c=document.createElement('canvas');c.width=640;c.height=400;const g=c.getContext('2d');for(let x=0;x<640;x+=8){g.fillStyle=`rgb(${x%255},${(x*3)%255},120)`;g.fillRect(x,0,8,400)}window.__cameraCanvas=c;window.__docCameraStream=c.captureStream(10);return window.__docCameraStream}});
      await page.click('[data-doc-camera="0-idf"]');await page.waitForSelector('#cam-shot',{state:'visible'});
      check('3.2b live camera has decoded video before showing capture',await page.evaluate(()=>document.querySelector('#cam-v').videoWidth===640&&document.querySelector('#cam-v').readyState>=2));
      await page.click('#cam-shot');await page.waitForSelector('#cam-use',{state:'visible'});await page.click('#cam-use');
      await page.waitForFunction(()=>document.querySelector('#d0-pidf-v').naturalWidth>0&&!document.querySelector('#d0-pidf-view').hidden);
      check('3.2c accepted camera shot appears in the form and stops all tracks',await page.evaluate(()=>window.__docCameraStream.getTracks().every(t=>t.readyState==='ended')));
      await page.click('[data-doc-preview="d0-pidf"]');check('3.2d photo opens full size for inspection',await page.locator('#photo-review').isVisible());await page.click('[data-photo-close]');
    }
    for (const k of ["idf", "idb", "dlf", "dlb"]) await page.setInputFiles(`#d${i}-p${k}`, { name: "t.jpg", mimeType: "image/jpeg", buffer: JPG });
  }
  await page.waitForFunction(() => document.querySelectorAll("[id$='-m']").length && [...document.querySelectorAll("#docs-f small[id$='-m']")].every((m) => /готова/.test(m.textContent)), null, { timeout: 15000 });
  await page.waitForFunction(()=>[...document.querySelectorAll('#docs-f .doc-preview-button img')].length===8&&[...document.querySelectorAll('#docs-f .doc-preview-button img')].every(i=>i.naturalWidth>0));
  check('3.2e all eight gallery images have visible preview controls and whole-document guidance',await page.locator('#docs-f .doc-preview-button:not([hidden])').count()===8 && /четири края/.test(await page.locator('.doc-photo-tip').first().textContent()));
  await page.check("#d-consent"); await page.tap("#docs-f button[type=submit]");
  await page.waitForFunction(() => /Получени документи — очакват проверка/.test(document.querySelector("#th-h").textContent), null, { timeout: 20000 });
  const [s] = await sql(`select stage, jsonb_array_length(documents) docs, drivers from bookings where id='${bk.id}'`);
  check("3.3 подадени документи → „Получени документи — очакват проверка“; 8 снимки, имената на двамата водачи; без грешки",
    s.stage === "review" && s.docs === 8 && s.drivers.names.join() === "ТЕСТ Основен Водач,ТЕСТ Втори Водач" && page.errs.length === 0, JSON.stringify(s).slice(0, 160));
  // 4. Окончателно потвърждение от имейла → страницата показва потвърдена резервация
  await fetch(`${B}/api/bookings/${bk.id}/manage?key=${bk.admin_token}`, { method: "POST", body: new URLSearchParams({ action: "confirm" }) });
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => /Резервацията е потвърдена/.test(document.querySelector("#th-h").textContent), null, { timeout: 15000 });
  const [f] = await sql(`select status, stage from bookings where id='${bk.id}'`);
  check("4. окончателно потвърждение → потвърдена (status confirmed, stage done) и страницата го показва", f.status === "confirmed" && f.stage === "done");
  await ctx.close();
}
// 5. Английска и немска версия на кратката форма
for (const [lang, re] of [["en/", /Snow chains[\s\S]*Second additional driver[\s\S]*I will drive[\s\S]*Someone else will drive/], ["de/", /Schneeketten[\s\S]*Zweiter Zusatzfahrer[\s\S]*Ich fahre selbst[\s\S]*Eine andere Person fährt/]]) {
  const { ctx, page } = await open(seed);
  await page.goto(B + "/" + lang + "#avtomobili", { waitUntil: "load" });
  await page.waitForSelector("#details:not([hidden])", { timeout: 15000 }).catch(() => {});
  const t = await page.locator("#plan").innerText() + "\n" + await page.locator("#bk").innerText();
  check(`5.${lang} кратката форма е преведена (вериги, втори водач, кой шофира, съгласие)`, re.test(t) && /(offers and discounts|Angebote und Rabatte)/.test(t) && page.errs.length === 0, t.replace(/\n/g, " / ").slice(0, 200));
  await ctx.close();
}
await browser.close();
console.log(`ОБЩО: ${res.filter(Boolean).length} PASS, ${res.filter((x) => !x).length} FAIL`);
process.exit(res.every(Boolean) ? 0 : 1);
