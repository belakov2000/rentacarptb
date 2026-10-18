// Двуетапна заявка (server/stage.ts): кратка форма → първо одобрение (имейл / панел) → покана за документи →
// документи на страницата на заявката → „Получени документи — очакват проверка“ → окончателно потвърждение.
// Вериги и втори водач, заявител и водачи поотделно, Word договор, напомняне след 15 мин, персонален RENTY10.
// Синтетични данни; пощата, маршрутите, Identity и хранилищата са симулирани (harness.ts). Без реални писма и заявки.
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { adminJar, bookingBody, check, contractData, finish, freshDb, mail, O, quoteFor, schema, setContext, syntheticJpeg } from "./harness.ts";
import { stores } from "./stubs/blobs.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import adminBookingsFn from "../../netlify/functions/admin-bookings.mts";
import documentsFn from "../../netlify/functions/documents.mts";
import customerEmailsFn from "../../netlify/functions/customer-emails.mts";
import { docsReminders, DOCS_TIMING } from "../../server/stage.ts";

setContext("deploy-preview");
const t = await freshDb("two_stage");
t.use();
const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
const sentTo = (re: RegExp) => mail.sent.filter((m) => re.test(m.subject));
let k = 0;
const DEL = "ул. Тестова 3, Пловдив";
const RET = "ул. Връщане 7, Пловдив";
async function create(o: { d1: string; d2: string; extras?: any; requesterDrives?: boolean; mkt?: boolean }) {
  k++;
  const body: any = bookingBody(`TS${k}`, o.d1, "10:00", o.d2, "10:00", {
    carId: "golf", car: "golf", requestKey: `two-stage-${k}-key`, flow: 2, drivers: { requesterDrives: o.requesterDrives ?? true }, marketingConsent: !!o.mkt,
    ...(o.extras ? { extras: o.extras } : {}),
    contract: { ...contractData(o.d1, "10:00", o.d2, "10:00"), del: { addr: DEL, km: 1, rate: 1 }, ret: { addr: RET, km: 1, rate: 1 } },
  });
  body.emailConfirmation = body.email; body.termsAccepted = true;
  body.requester = { first: "ТЕСТ", middle: "Заявител", last: "Иванов", birthDate: "1990-01-01", phoneCountry: "BG", citizen: "България" };
  body.phone = "+359877000777";
  body.drivers.main = { first: "ТЕСТ", middle: "Основен", last: "Водач" };
  body.drivers.second = { first: "ТЕСТ", middle: "Втори", last: "Водач" };
  if (body.payment === "bank") body.invoiceData = { name: "ТЕСТ", registration: "123456789", notVatRegistered: true, country: "България", address: "ТЕСТ 1" };
  const q = await quoteFor(body);
  const r = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, quote: q.json.quote, quoteTotalCents: q.json.totalCents }) }), { params: {} } as any);
  return { q, status: r.status, json: (await r.json()) as any };
}
const view = async (id: string, tok: string) => (await (await bookingsFn(new Request(`${O}/api/bookings/${id}?t=${tok}`), { params: { id } } as any)).json()) as any;
const manage = async (id: string, key: string, action?: string) => {
  const r = await bookingsFn(new Request(`${O}/api/bookings/${id}/manage?key=${key}`, action ? { method: "POST", body: new URLSearchParams({ action }) } : {}), { params: { id } } as any);
  return { status: r.status, html: await r.text() };
};
const jar = adminJar();
const admin = async (id: string, body: object) => {
  setContext("deploy-preview", { cookies: jar, ip: "203.0.113.9" });
  const r = await adminBookingsFn(new Request(`${O}/api/admin/bookings/${id}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: O }, body: JSON.stringify(body) }), { ip: "203.0.113.9", params: { id } } as any);
  setContext("deploy-preview");
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const upload = async () => {
  const r = await documentsFn(new Request(`${O}/api/documents`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: syntheticJpeg() }), { params: {}, ip: `203.0.113.${40 + (k++ % 50)}` } as any);
  return String(((await r.json()) as any).url).split("/").pop()!;
};
const driver = async (name: string, egn: string) => ({
  name, citizen: "България", idt: "id", idn: "TEST" + egn.slice(-4), egn, idd: "2020-01-01", idp: "МВР ТЕСТ",
  region: "Пловдив", municipality: "Пловдив", placeType: "city", city: "Пловдив", addr: "ул. Документна 1", dln: "DL" + egn.slice(-4), dld: "2021-02-02", dlp: "МВР ТЕСТ",
  photos: { idf: await upload(), idb: await upload(), dlf: await upload(), dlb: await upload() },
});
const submit = async (id: string, tok: string, body: object) => {
  const r = await bookingsFn(new Request(`${O}/api/bookings/${id}/documents?t=${tok}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, documentsConsent: true }) }), { params: { id } } as any);
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

// ===== 1. Кратка заявка с вериги и втори водач; заявителят не шофира =====
const A = await create({ d1: "2028-09-04", d2: "2028-09-07", extras: { chains: true, secondDriver: true }, requesterDrives: false, mkt: true });
const a0 = await row(A.json.id);
const ln = (A.q.json.lines || []) as any[];
check("1.1 оферта: наем 3 дни + вериги 3 × 3,50 € + втори водач 3 × 3 € + доставка; депозитът е отделно",
  A.q.status === 200 && ln.find((l) => l.code === "chains")?.cents === 1050 && ln.find((l) => l.code === "second_driver")?.cents === 900 && A.q.json.depositCents === 10000, JSON.stringify(ln));
check("1.2 кратка заявка без документи и снимки: 201, етап request, без снимки и без договор; водачите и съгласието са записани отделно",
  A.status === 201 && a0.stage === "request" && a0.documents === null && a0.chains && a0.secondDriver && a0.marketingConsent && (a0.drivers as any).requesterDrives === false && (a0.drivers as any).count === 2 && !stores.get("deploypreview-contracts")?.has(a0.id),
  `${A.status} ${a0?.stage}`);
const own = sentTo(/Нова заявка \(първо одобрение\)/).at(-1);
check("1.3 служебен имейл: „Одобри и покани за документи“ и линк за управление; без автоматично одобрение", !!own && /Одобри и покани за документи/.test(own.html) && /не одобрява нищо/.test(own.html) && !/Потвърди резервацията/.test(own.html));
check("1.3b трите служебни бутона и клиентско писмо за получената заявка", !!own && /Одобри и покани/.test(own.html) && /Откажи/.test(own.html) && /Управление на резервацията/.test(own.html) && mail.sent.some(m=>m.to===a0.email));
setContext("deploy-preview", { cookies: jar, ip: "203.0.113.9" });
const customerPage = await adminBookingsFn(new Request(`${O}/api/admin/bookings/${a0.id}?view=customer`), { params: { id: a0.id } } as any);
check("1.3c вписан администратор отваря клиентската страница за текущата среда",customerPage.status===303&&customerPage.headers.get("Location")===`${O}/?b=${a0.id}&t=${a0.viewToken}#blagodarim`);
setContext("deploy-preview");
const noCustomerPage=await adminBookingsFn(new Request(`${O}/api/admin/bookings/${a0.id}?view=customer`),{params:{id:a0.id}} as any);
check("1.3d без вход няма достъп до клиентския линк",noCustomerPage.status===401);
const v1 = await view(a0.id, a0.viewToken);
check("1.4 страница на заявката: етап request, сума, водачи; без данни от документи", v1.stage === "request" && v1.status === "pending" && v1.total === a0.total && v1.drivers.count === 2 && !("egn" in v1), JSON.stringify(v1).slice(0, 160));
const svc = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chains: true }) }), { params: {} } as any);
check("1.5 старото поле chains извън extras остава отказано", svc.status === 400);

// ===== 2. Първо одобрение от служебния имейл: GET не променя нищо, POST одобрява и изпраща поканата =====
const g = await manage(a0.id, a0.adminToken);
check("2.1 отваряне на линка (GET) не одобрява", g.status === 200 && (await row(a0.id)).stage === "request" && /Одобри и покани за документи/.test(g.html));
const m0 = mail.sent.length;
const ap = await manage(a0.id, a0.adminToken, "confirm");
const a1 = await row(a0.id);
const inv = mail.sent.slice(m0).find((m) => /изпратете документите/.test(m.subject));
check("2.2 първо одобрение (бутон в страницата от имейла): етап docs, статус pending, поканата е изпратена и отбелязана; линк към страницата на заявката",
  a1.stage === "docs" && a1.status === "pending" && !!a1.docsInvitedAt && !!inv && inv.html.includes(`?b=${a1.id}&amp;t=${a1.viewToken}#blagodarim`) && /покана|документите/.test(ap.html), a1.stage + " " + !!inv);
const early = await manage(a0.id, a0.adminToken, "confirm");
check("2.3 окончателно потвърждение без документи не е възможно", (await row(a0.id)).status === "pending" && /Документите на клиента още не са получени|вече е обработена/.test(early.html));

// ===== 3. Одобрение от панела без имейл: поканата не е изпратена → сроковете не започват; ръчна покана =====
const B = await create({ d1: "2028-10-02", d2: "2028-10-04", mkt: true });
const b0 = await row(B.json.id);
const mb = mail.sent.length;
const pa = await admin(b0.id, { action: "confirm", notify: false });
const b1 = await row(b0.id);
check("3.1 първо одобрение от панела без отметка за имейл: етап docs, поканата НЕ е изпратена, docs_invited_at е празно; панелът го показва",
  pa.status === 200 && b1.stage === "docs" && !b1.docsInvitedAt && !mail.sent.slice(mb).some((m) => m.to === b1.email) && pa.json.can.invite === true && pa.json.booking.docsInvitedAt === null, `${pa.status} ${b1.stage}`);
// Заявка A (поканата е изпратена току-що) не е засегната: проверката е на B; за B без покана моментът няма значение
await t.q("update bookings set first_approved_at = now() - interval '5 hours', created_at = now() - interval '5 hours' where id = $1", [b0.id]);
await docsReminders(new Date(Date.now() + 60_000));
const b2 = await row(b0.id);
check("3.2 без изпратена покана няма напомняне и RENTY10", !b2.docsReminderAt && !b2.couponSentAt);
const iv = await admin(b0.id, { action: "invite" });
check("3.3 „Изпрати поканата за документите“ от панела → изпратена, сроковете започват от сега", iv.status === 200 && iv.json.email === "sent" && !!(await row(b0.id)).docsInvitedAt);

// ===== 4. Напомняне след 15 мин и RENTY10 след 2 ч (само при маркетингово съгласие и незавършени документи) =====
const C = await create({ d1: "2028-11-06", d2: "2028-11-08", mkt: false });
await manage(C.json.id, (await row(C.json.id)).adminToken, "confirm");
const inv0 = (await row(a0.id)).docsInvitedAt!.getTime();
await docsReminders(new Date(inv0 + DOCS_TIMING.reminderMs - 60_000));
check("4.1 преди 15 мин няма напомняне", !(await row(a0.id)).docsReminderAt);
const mr = mail.sent.length;
await docsReminders(new Date(inv0 + DOCS_TIMING.reminderMs + 60_000));
check("4.2 след 15 мин: едно напомняне за документите", !!(await row(a0.id)).docsReminderAt && mail.sent.slice(mr).filter((m) => /Напомняне: изпратете документите/.test(m.subject) && m.to === a0.email).length === 1);
await docsReminders(new Date(inv0 + DOCS_TIMING.reminderMs + 120_000));
check("4.3 напомнянето не се повтаря", mail.sent.slice(mr).filter((m) => /Напомняне: изпратете документите/.test(m.subject) && m.to === a0.email).length === 1);
const mc = mail.sent.length;
const cAt = new Date(inv0 + DOCS_TIMING.couponMs + 60_000);
await docsReminders(cAt);
const cp = mail.sent.slice(mc).filter((m) => /RENTY10|10%/.test(m.subject + m.html));
check("4.4 след 2 ч: RENTY10 само на заявката със съгласие (A), не и на C без съгласие", !!(await row(a0.id)).couponSentAt && cp.some((m) => m.to === a0.email) && !(await row(C.json.id)).couponSentAt, `${cp.length}`);
await t.q("update bookings set coupon_sent_at = now() - interval '1 minute' where id = $1", [a0.id]);
const v2 = await view(a0.id, a0.viewToken);
check("4.5 страницата показва кода като наличен с реален срок 24 ч от изпращането", v2.coupon.available === true && Math.abs(Date.parse(v2.coupon.until) - (Date.now() - 60_000 + 24 * 3600_000)) < 120_000, JSON.stringify(v2.coupon));
const cust = await customerEmailsFn();
check("4.6 функцията за напомнянията работи и с двуетапните заявки (без грешка)", cust === undefined);

// ===== 5. Подаване на документите =====
const d1 = await driver("ТЕСТ Основен Водач", "8001010001"), d2 = await driver("ТЕСТ Втори Водач", "8102020002");
const one = await submit(a0.id, a0.viewToken, { drivers: [d1] });
check("5.1 броят водачи трябва да съвпада с услугата „втори водач“", one.status === 400 && one.json.error === "drivers");
const badPh = await submit(a0.id, a0.viewToken, { drivers: [d1, { ...d2, photos: { ...d2.photos, idf: "f".repeat(64) } }] });
check("5.2 снимка, която не е качена на сайта → отказ", badPh.status === 400 && badPh.json.error === "photos");
const badCp = await submit(a0.id, a0.viewToken, { drivers: [d1, d2], coupon: "RENTY20" });
check("5.3 непознат код → отказ", badCp.status === 400 && badCp.json.error === "coupon");
await t.q("update bookings set coupon_sent_at = now() - interval '25 hours' where id = $1", [a0.id]);
const exp = await submit(a0.id, a0.viewToken, { drivers: [d1, d2], coupon: "renty10" });
check("5.4 RENTY10 след 24 ч от изпращането → отказ (проверка на сървъра)", exp.status === 400 && exp.json.error === "coupon");
const cpC = await submit(C.json.id, (await row(C.json.id)).viewToken, { drivers: [await driver("ТЕСТ Ц", "8203030003")], coupon: "RENTY10" });
check("5.5 RENTY10 за резервация, за която не е изпратен → отказ (персонален код)", cpC.status === 400 && cpC.json.error === "coupon");
await t.q("update bookings set coupon_sent_at = now() - interval '1 hour' where id = $1", [a0.id]);
const before = await row(a0.id);
const rentCents = (before.priceCheck as any).server.lines.find((l: any) => l.code === "rent").cents;
const mo = mail.sent.length;
const ok = await submit(a0.id, a0.viewToken, { drivers: [d1, d2], coupon: "RENTY10" });
const a2 = await row(a0.id);
check("5.6 документи на двамата водачи + RENTY10: етап review, „Получени документи — очакват проверка“; отстъпка = 10% само от наема",
  ok.status === 200 && ok.json.stage === "review" && a2.stage === "review" && !!a2.couponUsedAt && a2.totalCents === before.totalCents! - Math.round(rentCents / 10) && (a2.documents as any[]).length === 8 && (a2.drivers as any).names.join() === "ТЕСТ Основен Водач,ТЕСТ Втори Водач",
  `${ok.status} ${a2.totalCents} ${before.totalCents} ${rentCents}`);
const again = await submit(a0.id, a0.viewToken, { drivers: [d1, d2], coupon: "RENTY10" });
check("5.7 повторно подаване / повторно ползване на кода → отказ (етапът вече е review)", again.status === 409 && again.json.error === "stage");
const ownDocs = mail.sent.slice(mo).find((m) => /Получени документи — очакват проверка/.test(m.subject));
const custDocs = mail.sent.slice(mo).find((m) => /Получихме документите/.test(m.subject));
check("5.8 служебен имейл „Получени документи — очакват проверка“ с бутон за окончателно потвърждение и прикачен Word договор; без ЕГН; писмо до клиента",
  !!ownDocs && ownDocs.attachments === 1 && /Окончателно потвърди/.test(ownDocs.html) && !ownDocs.html.includes("8001010001") && !!custDocs);

// ===== 6. Word договорът =====
const docx = stores.get("deploypreview-contracts")!.get(a0.id)!;
const xml = strFromU8(unzipSync(new Uint8Array(docx.data))["word/document.xml"]).replace(/<[^>]+>/g, "");
const has = (s: string) => xml.includes(s);
check("6.1 договорът (редактируем .docx): наемател е основният водач (не заявителят), ЕГН и документите му, адрес по документа",
  has("ТЕСТ Основен Водач") && has("8001010001") && has("TEST0001") && has("DL0001") && has("ул. Документна 1"), "");
check("6.2 договорът: адрес и км за доставка от сървърната оферта, наем, период", has(DEL) && has("5,00") && has("04.09.2028"), xml.slice(0, 0));
check("6.3 приложение: вериги, втори водач с документите му, заявителят (не е водач), отстъпка RENTY10 и общата сума",
  has("Вериги за сняг: 3 дни") && has("Втори (допълнителен) водач: ТЕСТ Втори Водач") && has("8102020002") && has("Заявител (не е водач): ТЕСТ Заявител Иванов") && has("Отстъпка RENTY10") && has(`Обща сума за услугите:`), "");

check("6.4 основният договор използва наема след отстъпката, не само приложението", has((rentCents * 0.9 / 100).toFixed(2).replace(".", ",")));

check("6.5 договорът съдържа връщане от адрес, дати, часове, книжки и цялата ценова разбивка",has(RET)&&has("07.09.2028")&&has("10:00")&&has("TEST0002")&&has("DL0002")&&has("Гаранционен депозит")&&has("Доставка до адрес:")&&has("Връщане от адрес:"));
// ===== 7. Окончателно потвърждение от панела =====
const md = mail.sent.length;
const fin = await admin(a0.id, { action: "confirm", notify: true });
const a3 = await row(a0.id);
check("7.1 второ одобрение от панела: статус confirmed, етап done; писмо с окончателното потвърждение", fin.status === 200 && a3.status === "confirmed" && a3.stage === "done" && mail.sent.slice(md).some((m) => m.to === a3.email));
check("7.2 страницата на заявката: потвърдена", (await view(a0.id, a0.viewToken)).status === "confirmed");

// ===== 8. Заетост и съвместимост =====
const D = await create({ d1: "2028-09-05", d2: "2028-09-06" });
check("8.1 нова заявка за дни, заети от потвърдената двуетапна резервация → 409 busy", D.status === 409);
const E = await create({ d1: "2028-12-01", d2: "2028-12-03", requesterDrives: true });
const e0 = await row(E.json.id);
await manage(e0.id, e0.adminToken, "confirm");
const F = await create({ d1: "2028-12-02", d2: "2028-12-04" });
check("8.2 одобрена заявка, очакваща документи, заема автомобила за периода", F.status === 409);
const rj = await manage(e0.id, e0.adminToken, "reject");
check("8.3 отказ в етап docs → rejected; автомобилът е освободен", (await row(e0.id)).status === "rejected" && /отказана/.test(rj.html) && (await create({ d1: "2028-12-02", d2: "2028-12-04" })).status === 201);
const old = await bookingsFn(new Request(`${O}/api/bookings/${b0.id}?t=${b0.viewToken}`), { params: { id: b0.id } } as any);
check("8.4 статусът на двуетапна заявка не съдържа токени и данни от документите", !/adminToken|viewToken|egn/.test(await old.text()));

const prefUrl = `${O}/api/bookings/${b0.id}/marketing?t=${b0.viewToken}`;
await bookingsFn(new Request(prefUrl), { params: { id: b0.id } } as any);
check("9.1 opening marketing preference link does not change consent", (await row(b0.id)).marketingConsent);
await bookingsFn(new Request(prefUrl, { method: "POST" }), { params: { id: b0.id } } as any);
check("9.2 promotional email opt-out preserves reservation", !(await row(b0.id)).marketingConsent && (await row(b0.id)).stage === "docs");
// Поправка на часове след окончателно потвърждение: стойността остава,
// адресите се пазят, а Word договорът се обновява с нова версия.
const beforeTime=await row(a0.id);
const ct=await admin(a0.id,{action:"change_times",startTime:"11:00",endTime:"11:00",expectedUpdatedAt:beforeTime.updatedAt?.toISOString()||""});
const afterTime=await row(a0.id);
const changedXml=strFromU8(unzipSync(new Uint8Array(stores.get("deploypreview-contracts")!.get(a0.id)!.data))["word/document.xml"]).replace(/<[^>]+>/g,"");
check("10.1 часовете се поправят; цената, адресите, водачите и услугите се запазват в новия договор",ct.status===200&&ct.json.contract==="saved"&&afterTime.startTime==="11:00"&&afterTime.endTime==="11:00"&&changedXml.includes(DEL)&&changedXml.includes(RET)&&afterTime.totalCents===beforeTime.totalCents&&changedXml.includes("11:00")&&!changedXml.includes("10:00")&&changedXml.includes("TEST0002")&&changedXml.includes("Вериги за сняг"), JSON.stringify({status:ct.status,contract:ct.json.contract,start:afterTime.startTime,end:afterTime.endTime,old:changedXml.includes("10:00"),del:changedXml.includes(DEL),ret:changedXml.includes(RET)}));
const staleTime=await admin(a0.id,{action:"change_times",startTime:"12:00",endTime:"12:00",expectedUpdatedAt:beforeTime.updatedAt?.toISOString()||""});
check("10.2 остарял формуляр не презаписва часовете",staleTime.status===409&&staleTime.json.error==="changed");
const reprice=await admin(a0.id,{action:"change_times",startTime:"10:00",endTime:"12:00",expectedUpdatedAt:afterTime.updatedAt?.toISOString()||""});
check("10.3 допълнителен платен ден изисква нова цена",reprice.status===409&&reprice.json.error==="reprice"&&(await row(a0.id)).startTime==="11:00");
await t.q("insert into car_blocks(car_id,start_date,end_date,start_time,end_time,reason,created_by) values ('golf','2028-09-07','2028-09-07','13:00','15:00','test','test')");
const busyTime=await admin(a0.id,{action:"change_times",startTime:"12:30",endTime:"12:30",expectedUpdatedAt:afterTime.updatedAt?.toISOString()||""});
check("10.4 конфликт с буфера отказва промяната",busyTime.status===409&&busyTime.json.error==="busy");
await t.q("update bookings set handed_over_at=now() where id=$1",[a0.id]);
const handedTime=await admin(a0.id,{action:"change_times",startTime:"12:00",endTime:"12:00",expectedUpdatedAt:afterTime.updatedAt?.toISOString()||""});
check("10.5 часове не се променят след предаване",handedTime.status===409&&handedTime.json.error==="state");
await finish();
