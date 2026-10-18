// Етап 1: сървърна проверка на цената (само наблюдение), защитени снимки на документите и известие до фирмата без
// лични идентификатори. Синтетични данни; маршрутите, Brevo и Identity са прихванати (harness.ts).
import { eq } from "drizzle-orm";
import { adminJar, bookingBody, check, cookieJar, finish, freshDb, http, mail, O, schema, setContext, syntheticJpeg } from "./harness.ts";
import { stores } from "./stubs/blobs.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import documentsFn, { UPLOAD_LIMITS } from "../../netlify/functions/documents.mts";
import routeFn from "../../netlify/functions/route.mts";

setContext("deploy-preview");
const t = await freshDb("stage1");
t.use();
const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
const events = async (id: string, action: string) => (await t.q("select details from booking_events where booking_id=$1 and action=$2", [id, action])).rows;

// Прихванати маршрути (OpenStreetMap): адрес „…Мрежа…“ → няма отговор; иначе 12,4 км в зоната на Пловдив
let routeCalls = 0;
const prev = http.handler;
http.handler = async (url, init) => {
  if (url.includes("nominatim.openstreetmap.org")) {
    routeCalls++;
    if (decodeURIComponent(url).includes("Мрежа")) throw new TypeError("fetch failed");
    return Response.json([{ lat: "42.15", lon: "24.75", display_name: "ул. Синтетична, Пловдив" }]);
  }
  if (url.includes("router.project-osrm.org")) return Response.json({ code: "Ok", routes: [{ distance: 12400 }] });
  return prev ? prev(url, init) : null;
};

// Стара резервация отпреди проверката – не се преизчислява
await t.q(`insert into bookings (id, view_token, admin_token, name, email, phone, car, car_id, start_date, end_date, start_time, end_time, pickup, dropoff, total, total_cents)
  values ('${"0".repeat(32)}', 'v', 'a', 'ТЕСТ Стара', 'old@example.com', '+359', 'Golf', 'golf', '2027-01-01', '2027-01-03', '10:00', '10:00', 'x', 'y', '1 €', 100)`);

const contract = (o: Record<string, unknown> = {}) => ({
  citizen: "България", idt: "id", idn: "640000001", egn: "8001010000", idd: "2020-01-01", idp: "МВР Тест", region: "Тест", municipality: "Тест", placeType: "city",
  city: "Тест", addr: "ул. Документ 9", dln: "290000001", dld: "2021-02-02", dlp: "МВР Тест", d1: "2027-05-03", t1: "10:00", d2: "2027-05-05", t2: "10:00",
  days: 2, rent: 50, seat: 0, seatN: 0, seatDay: 0, del: null, ret: null, abroad: [], ...o,
});
const docs = [`${O}/api/documents/${"a".repeat(64)}`, `${O}/api/documents/${"b".repeat(64)}`];
const message = [
  "Заявка за наем: Volkswagen Passat", "Общо за услугите: 50 €", "", "ПЛАЩАНЕ: В брой на място с касов бон", "", "КЛИЕНТ", "Имена: ТЕСТ Етап1", "Телефон: +359000000000",
  "", "ДОКУМЕНТ ЗА САМОЛИЧНОСТ", "Номер: 640000001", "ЕГН: 8001010000", "Адрес по документа: обл. Тест, ул. Документ 9",
  "", "ШОФЬОРСКА КНИЖКА", "Номер: 290000001", "", "Език на сайта: BG", "", "", "СНИМКИ НА ДОКУМЕНТИТЕ", `Лична карта – лице: ${docs[0]}`, `Книжка – лице: ${docs[1]}`,
].join("\n");
let k = 0;
async function create(o: { total?: string; contract?: unknown; d1?: string; d2?: string } = {}) {
  k++;
  const d1 = o.d1 || `2027-05-${String(2 * k + 1).padStart(2, "0")}`, d2 = o.d2 || `2027-05-${String(2 * k + 2).padStart(2, "0")}`;
  const body = bookingBody(`S${k}`, d1, "10:00", d2, "10:00", { requestKey: `stage1-${k}-key`, total: o.total ?? "25 €", message, ...(o.contract !== undefined ? { contract: o.contract } : {}) });
  const r = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: {} } as any);
  const j = await r.json();
  return { status: r.status, id: j.id as string, name: body.name };
}

// ===== 1. Наблюдение на цената =====
const m1 = await create({ contract: contract({ days: 1, rent: 25 }) });
const r1 = await row(m1.id);
check("1.1 сумата съвпада → price_check_status = match; историята на действията остава без нов запис", m1.status === 201 && r1.priceCheckStatus === "match" && (r1.priceCheck as any).server.totalCents === 2500 && r1.priceCheckedAt != null && (await events(m1.id, "price.observe")).length === 0, `${r1.priceCheckStatus}`);
const m2 = await create({ total: "1 €", contract: contract({ days: 1, rent: 1 }) });
const r2 = await row(m2.id);
const cd2 = JSON.parse(Buffer.from(stores.get("deploypreview-contracts")!.get(m2.id + ".json")!.data).toString());
check("1.2 подадена неправилна сума → mismatch, но observe НЕ я променя (total, total_cents и договорът са от браузъра)",
  r2.priceCheckStatus === "mismatch" && r2.total === "1 €" && r2.totalCents === 100 && cd2.rent === 1 && (r2.priceCheck as any).reasons.includes("total"), JSON.stringify((r2.priceCheck as any).reasons));
const pc2 = r2.priceCheck as any;
check("1.3 записът на проверката е без лични данни: статус, причини и разлика в центове", pc2.diffCents === 100 - 2500 && !/ТЕСТ|example|Документ|8001010000/.test(JSON.stringify(pc2)), JSON.stringify(pc2.reasons));
const m3 = await create({ total: "37,40 €", contract: contract({ days: 1, rent: 25, del: { addr: "ул. Синтетична 1", km: 12.4, rate: 1 } }) });
const r3 = await row(m3.id);
check("1.4 доставка: маршрутът се изчислява отново на сървъра → match; адресът не се записва", r3.priceCheckStatus === "match" && !JSON.stringify(r3.priceCheck).includes("Синтетична") && (r3.priceCheck as any).route.del.km === 12.4, JSON.stringify((r3.priceCheck as any).reasons));
const m4 = await create({ total: "26 €", contract: contract({ days: 1, rent: 25, del: { addr: "ул. Синтетична 2", km: 1, rate: 1 } }) });
check("1.5 доставка с други км от браузъра → mismatch (km_del, total)", (await row(m4.id)).priceCheckStatus === "mismatch", JSON.stringify(((await row(m4.id)).priceCheck as any).reasons));
const m5 = await create({ total: "37,40 €", contract: contract({ days: 1, rent: 25, del: { addr: "ул. Мрежа 3", km: 12.4, rate: 1 } }) });
const r5 = await row(m5.id);
check("1.6 маршрутът не може да се изчисли → incomplete; без сървърна цена (не се приема нито нула, нито км от браузъра)", r5.priceCheckStatus === "incomplete" && (r5.priceCheck as any).server === null && r5.status === "pending" && r5.total === "37,40 €", JSON.stringify((r5.priceCheck as any).reasons));
const m6 = await create({ contract: null });
check("1.7 стара страница без данни за договора → incomplete (no_contract), заявката е приета", m6.status === 201 && (await row(m6.id)).priceCheckStatus === "incomplete", "");
const old = await row("0".repeat(32));
check("1.8 стара резервация не се преизчислява", old.priceCheck === null && old.priceCheckStatus === null && old.total === "1 €", "");
const route = await routeFn(new Request(`${O}/api/route?destination=${encodeURIComponent("ул. Синтетична 9")}`));
const rj = await route.json();
check("1.9 /api/route (браузърът) – същият отговор след изнасянето на логиката в server/route.ts", route.status === 200 && rj.km === 12.4 && rj.rate === 1 && rj.local === true && rj.source === "osm" && "place" in rj, JSON.stringify(Object.keys(rj)));

// ===== 2. Известие до фирмата =====
const owner = mail.sent.find((m) => /Нова заявка за наем/.test(m.subject) && m.subject.includes(m1.name))!;
check("2.1 писмото до фирмата е без ЕГН, номера на документи, адрес по документа и линкове към снимките",
  !!owner && !["8001010000", "640000001", "290000001", "ул. Документ 9", "/api/documents/", "ЕГН"].some((x) => owner.html.includes(x)), "");
check("2.2 прикаченият редактируем договор остава", owner.attachments === 1 && owner.html.includes("Изтегли договора за наем"), "");
check("2.3 бутоните „Потвърди“, „Откажи“ и „Управление“ остават (линкът за управление)", /Потвърди резервацията/.test(owner.html) && /Откажи/.test(owner.html) && owner.html.includes(`/api/bookings/${m1.id}/manage?key=`), "");
check("2.4 снимките: брой и защитен линк към панела", owner.html.includes("Снимки на документите: 2") && owner.html.includes(`${O}/admin/bookings/${m1.id}`), "");
const docXml = Buffer.from(stores.get("deploypreview-contracts")!.get(m1.id)!.data);
check("2.5 договорът (прикаченият файл) съдържа пълните данни – не е променян", docXml.length > 1000 && (r1.documents as any[]).length === 2, "");
const cust = mail.sent.find((m) => m.to === "test-s1@example.com")!;
check("2.6 писмото до клиента е непроменено („Получихме вашата заявка“)", !!cust && /Получихме вашата заявка/.test(cust.subject), cust?.subject);

// ===== 3. Снимки на документите =====
const up = (body: Uint8Array, ip = "198.51.100.1", type = "image/jpeg") =>
  documentsFn(new Request(`${O}/api/documents`, { method: "POST", headers: { "Content-Type": type }, body }), { params: {}, ip } as any);
const good = await up(syntheticJpeg(800, 500));
const gj = await good.json();
const docId = String(gj.url).split("/").pop()!;
const meta = stores.get("deploypreview-documents")!.get(docId)!.metadata as any;
check("3.1 валидна JPEG снимка → 201 и записани размери", good.status === 201 && meta.width === 800 && meta.height === 500, `HTTP ${good.status}`);
const fake = await up(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]));
check("3.2 само начало и край на JPEG (без изображение) → 415", fake.status === 415, `HTTP ${fake.status}`);
const jpg = syntheticJpeg(800, 500);
check("3.3 отрязан (повреден) JPEG → 415", (await up(jpg.slice(0, Math.floor(jpg.length / 2)))).status === 415, "");
check("3.4 твърде малко изображение (100×80) → 415", (await up(syntheticJpeg(100, 80))).status === 415, "");
check("3.5 твърде голямо по размери (4100×300) → 415", (await up(syntheticJpeg(4100, 300, 30))).status === 415, "");
check("3.6 друг тип (PNG) → 415", (await up(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "198.51.100.1", "image/png")).status === 415, "");
const big = await documentsFn(new Request(`${O}/api/documents`, { method: "POST", headers: { "Content-Type": "image/jpeg", "Content-Length": String(5 * 1024 * 1024) }, body: new Uint8Array(10) }), { params: {}, ip: "198.51.100.1" } as any);
check("3.7 над 4 MB → 413", big.status === 413, `HTTP ${big.status}`);
// Ограничение по IP: записите за качванията се добавят директно (бързо), след това следващото качване се отказва
const { ipHash } = await import("../../server/auth.ts");
const iph = await ipHash("198.51.100.77");
for (let i = 0; i < UPLOAD_LIMITS.perIp; i++) await t.q(`insert into booking_events (actor, action, details) values ('customer', 'document.upload', $1)`, [JSON.stringify({ ip: iph })]);
check("3.8 твърде много качвания от един IP → 429", (await up(syntheticJpeg(), "198.51.100.77")).status === 429, "");
check("3.9 друг IP адрес не е блокиран", (await up(syntheticJpeg(), "198.51.100.78")).status === 201, "");
const upEv = (await t.q("select details from booking_events where action='document.upload' and details ? 'width' limit 1")).rows[0]?.details;
check("3.10 записът за качването е без IP адрес (само хеш) и без лични данни", !!upEv && /^[a-f0-9]{24}$/.test(upEv.ip) && !JSON.stringify(upEv).includes("198.51"), JSON.stringify(upEv));

// Отваряне на снимка: само за вписан администратор
const get = (id: string, accept: string, jar?: ReturnType<typeof cookieJar>) => {
  setContext("deploy-preview", jar ? { cookies: jar } : { cookies: cookieJar() });
  return documentsFn(new Request(`${O}/api/documents/${id}`, { headers: { Accept: accept } }), { params: { id } } as any);
};
const anonHtml = await get(docId, "text/html,application/xhtml+xml");
check("3.11 без вход, линк от браузъра → 303 към входа в панела с връщане към снимката", anonHtml.status === 303 && anonHtml.headers.get("location") === `/admin/?doc=${docId}`, `${anonHtml.status} ${anonHtml.headers.get("location")}`);
const anonImg = await get(docId, "image/*");
check("3.12 без вход, заявка за изображение → 401 без данни", anonImg.status === 401 && !(anonImg.headers.get("content-type") || "").includes("image"), `HTTP ${anonImg.status}`);
const userImg = await get(docId, "text/html", adminJar("user@example.com", []));
check("3.13 вписан потребител без роля admin → 403", userImg.status === 403, `HTTP ${userImg.status}`);
// Снимка, записана към резервация – отваряне от администратор и одит с номера на резервацията
await t.q("update bookings set documents=$1 where id=$2", [JSON.stringify([{ label: "Тест", id: docId }]), m1.id]);
const adminImg = await get(docId, "text/html", adminJar());
const bytes = new Uint8Array(await adminImg.arrayBuffer());
const audits = (await t.q("select actor, booking_id, details from booking_events where action='document.view'")).rows;
check("3.14 администратор → 200 image/jpeg, no-store, no-referrer", adminImg.status === 200 && adminImg.headers.get("content-type") === "image/jpeg" && adminImg.headers.get("cache-control")!.includes("no-store") && adminImg.headers.get("referrer-policy") === "no-referrer" && bytes[0] === 0xff, `HTTP ${adminImg.status}`);
check("3.15 отварянето се записва в историята (кой, коя резервация)", audits.length === 1 && audits[0].actor === "admin@example.com" && audits[0].booking_id === m1.id, JSON.stringify(audits));
const fakeAdmin = cookieJar(); fakeAdmin.set({ name: "nf_jwt", value: "подправен.токен.x" });
check("3.16 подправена сесия → 401", (await get(docId, "image/*", fakeAdmin)).status === 401, "");
check("3.17 непознат ключ при вписан администратор → 404", (await get("e".repeat(64), "image/*", adminJar())).status === 404, "");
check("3.18 маршрутите са прихванати (без реални заявки)", routeCalls > 0, `${routeCalls}`);

await finish();
