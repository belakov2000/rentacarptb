// Договори: генериране, последователни версии, запазване на старите версии и проверка на съдържанието.
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { adminJar, bookingBody, check, contractData, finish, freshDb, O, setContext, schema, sha, withQuote } from "./harness.ts";
import { getStore, stores } from "./stubs/blobs.ts";
import { listContractVersions, saveContract } from "../../server/contracts.ts";
import { buildContract, parseContract } from "../../contract/index.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import adminContractsFn from "../../netlify/functions/admin-contracts.mts";

setContext("deploy-preview");
const t = await freshDb("contracts");
t.use();
const S = () => stores.get("deploypreview-contracts")!;
const xml = (d: Uint8Array) => strFromU8(unzipSync(d)["word/document.xml"]);
const call = (url: string, init: RequestInit = {}, id = "") => bookingsFn(new Request(url, init), { params: id ? { id } : {} } as any);

// 1. Генериране при нова заявка
const r = await call(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await withQuote(bookingBody("Contract", "2028-09-01", "10:00", "2028-09-03", "10:00", { requestKey: "contract-0001", contract: contractData("2028-09-01", "10:00", "2028-09-03", "10:00") }))) });
const { id } = await r.json();
const [b] = await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id));
let v = await listContractVersions(id);
const cur1 = S().get(id)!.data;
check("Генериране: версия 1 и текущ файл", v.length === 1 && v[0].version === 1 && v[0].createdBy === "customer" && sha(S().get(v[0].blobKey)!.data) === sha(cur1), v.map((x) => x.blobKey.split("/").pop()).join(","));
check("Съдържание: име, рег. № на Passat, период и 5 км за доставка", xml(cur1).includes("ТЕСТ Contract") && xml(cur1).includes("РВ8991XE") && xml(cur1).includes("01.09.2028") && xml(cur1).includes("5 км"), "");
const dl = await call(`${O}/api/bookings/${id}/contract?key=${b.adminToken}`, {}, id);
check("Изтегляне по стария линк дава текущата версия", dl.status === 200 && sha(new Uint8Array(await dl.arrayBuffer())) === sha(cur1), `HTTP ${dl.status}`);

// 2. Последователни версии (поправка на км ×3)
for (const km of ["12", "27,5", "40"]) await call(`${O}/api/bookings/${id}/manage?key=${b.adminToken}`, { method: "POST", body: new URLSearchParams({ action: "km", kmDel: km, kmDelRate: "1" }) }, id);
v = await listContractVersions(id);
const files = v.map((x) => S().get(x.blobKey)!.data);
check("4 последователни версии с номера 1–4 и отделни файлове", v.map((x) => x.version).join() === "1,2,3,4" && new Set(v.map((x) => x.blobKey)).size === 4 && new Set(files.map(sha)).size === 4, "");
check("Всяка версия съдържа своите километри", xml(files[0]).includes("5 км") && xml(files[1]).includes("12 км") && xml(files[2]).includes("27,5 км") && xml(files[3]).includes("40 км"), "5 → 12 → 27,5 → 40 км");
check("Версия 1 е запазена байт по байт", sha(files[0]) === sha(cur1), "");
check("Текущият файл е последната версия", sha(S().get(id)!.data) === sha(files[3]) && S().get(id)!.metadata.version === 4, "");
const ev = (await t.q("select count(*)::int n from booking_events where booking_id=$1 and action='contract.version'", [id])).rows[0].n;
check("Всяка версия е записана в историята", ev === 4 && v.slice(1).every((x) => x.createdBy === "owner-link" && x.reason === "Поправка на километрите"), `събития: ${ev}`);

// 3. Възстановяване на предишна версия (като нова версия – историята не се губи)
const old = parseContract({ ...contractData("2028-09-01", "10:00", "2028-09-03", "10:00"), del: { addr: "ул. Тестова 1", km: 12, rate: 1 } }, "ТЕСТ Contract", "passat")!;
const restored = await saveContract(id, old, "test-admin", "Възстановяване на версия 2");
v = await listContractVersions(id);
check("Възстановяване на версия 2 създава версия 5 със същото съдържание", restored.version === 5 && xml(S().get(id)!.data) === xml(files[1]) && v.length === 5, "word/document.xml на v5 = v2");

// 4. Договор отпреди версиите (само текущ файл) – запазва се като версия 1
const r2 = await call(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await withQuote(bookingBody("Legacy", "2028-10-01", "10:00", "2028-10-03", "10:00", { requestKey: "contract-legacy" }))) });
const id2 = (await r2.json()).id;
const legacy = new Uint8Array(cur1);
await getStore("deploypreview-contracts").set(id2, legacy, { metadata: { name: "Dogovor-old.docx" } });
await getStore("deploypreview-contracts").setJSON(`${id2}.json`, { ...contractData("2028-10-01", "10:00", "2028-10-03", "10:00"), name: "ТЕСТ Legacy", carId: "passat", city: "", addr: "", idp: "", idd: "", dln: "", dld: "", dlp: "" });
const [b2] = await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id2));
await call(`${O}/api/bookings/${id2}/manage?key=${b2.adminToken}`, { method: "POST", body: new URLSearchParams({ action: "km", kmDel: "8", kmDelRate: "1" }) }, id2);
const v2 = await listContractVersions(id2);
check("Стар договор: оригиналът е запазен като версия 1, промяната е версия 2", v2.length === 2 && sha(S().get(v2[0].blobKey)!.data) === sha(legacy) && v2[0].createdBy === "system" && xml(S().get(v2[1].blobKey)!.data).includes("8 км"), "");

// 5. Едновременни промени – без загубени или дублирани версии
await Promise.all([1, 2, 3, 4, 5].map((k) => saveContract(id2, { ...old, name: "ТЕСТ Legacy", del: { addr: "тест", km: k, rate: 1 } }, "test", "едновременно")));
const v3 = await listContractVersions(id2);
check("5 едновременни промени → версии 3–7 без пропуски и дубликати", v3.map((x) => x.version).join() === "1,2,3,4,5,6,7" && new Set(v3.map((x) => x.blobKey)).size === 7, v3.map((x) => x.version).join());
check("Нито един файл на версия не е презаписан", v3.every((x) => S().has(x.blobKey)) && sha(S().get(v2[0].blobKey)!.data) === sha(legacy), "");
// Variable-length appendices must never claim a fixed total page count.
const clause="3. Документите, включително приложенията към тях, са с общ обем от ";
check("Заключителната разпоредба няма фиксирани 14 страници",xml(cur1).includes(clause)&&!xml(cur1).includes("14 (четиринадесет)"));
const appendix=["Приложение – допълнителни условия по заявката","Вериги за сняг: 3 дни","Обща сума: 100 €"];
const one=xml(buildContract({...old,appendix,appendixSecondDriver:false}));
const two=xml(buildContract({...old,appendix,appendixSecondDriver:true,appendixSecondDriverName:"ТЕСТ Втори Водач"}));
const signPart=(s:string)=>s.slice(s.indexOf("Подписи по приложението"));
check("Приложение с един водач: подписи за наемодател и наемател, без втори водач",signPart(one).includes("Наемодател – име:")&&signPart(one).includes("Наемател – име:")&&!signPart(one).includes("Втори водач – име:"));
check("Приложение с двама водачи: трите подписа са в края и остават заедно",signPart(two).includes("Наемодател – име:")&&signPart(two).includes("Наемател – име:")&&signPart(two).includes("Втори водач – име:")&&signPart(two).includes("<w:keepNext/>")&&two.includes("<w:pageBreakBefore/>"));
const legacyAppendix=xml(buildContract({...old,appendix:[...appendix,"Втори (допълнителен) водач: ТЕСТ Втори Водач"]}));
check("Запазено старо приложение с втори водач получава третия подпис при ново генериране",signPart(legacyAppendix).includes("Втори водач – име:"));
check("Без приложение не се добавя празна страница с подписи",!xml(buildContract(old)).includes("Подписи по приложението"));
// Regeneration uses saved data and preserves the original versions and booking state.
const regen = (origin = O) => adminContractsFn(new Request(`${O}/api/admin/contracts/${id}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ action: "regenerate" }) }), {} as any);
setContext("deploy-preview");
check("Нова версия без администратор е забранена", (await regen()).status === 401);
setContext("deploy-preview", { cookies: adminJar() });
check("Нова версия от чужд сайт е забранена", (await regen("https://other.example")).status === 403);
await saveContract(id, { ...old, appendix, appendixSecondDriver: true }, "test", "Двама водачи");
const before = await listContractVersions(id);
const beforeHashes = before.map(x => sha(S().get(x.blobKey)!.data));
const regenResponse = await regen();
const after = await listContractVersions(id);
const [unchanged] = await t.db.select().from(schema.bookings).where(eq(schema.bookings.id,id));
check("Администраторът създава нова версия със запазени данни и трите подписа", regenResponse.status === 200 && after.length === before.length + 1 && xml(S().get(id)!.data).includes(clause) && signPart(xml(S().get(id)!.data)).includes("Втори водач – име:") && after.at(-1)!.signStatus === "awaiting");
check("Обновяването запазва старите файлове и статуса на резервацията", before.every((x,i) => sha(S().get(x.blobKey)!.data) === beforeHashes[i]) && unchanged.status === b.status);
await getStore("deploypreview-contracts").delete(`${id}.json`);
check("Без записани данни не се създава празен договор", (await regen()).status === 409 && (await listContractVersions(id)).length === after.length);
check("Подписите включват имената на наемодателя, наемателя и втория водач", signPart(two).includes("Теодор Петков Белаков") && signPart(two).includes(old.name) && signPart(two).includes("ТЕСТ Втори Водач") && (signPart(two).match(/Подпис:/g)||[]).length === 3);
check("Старо приложение възстановява името на втория водач над подписа", signPart(legacyAppendix).includes("Втори водач – име: ТЕСТ Втори Водач"));
check("Общият брой страници е автоматично NUMPAGES поле с обновяване при отваряне", xml(cur1).includes('w:instr=" NUMPAGES "') && strFromU8(unzipSync(cur1)["word/settings.xml"]).includes('<w:updateFields w:val="true"/>'));
check("Чл. 16 има изрични точки 1, 2 и 3 за еднаква номерация във всички четци", xml(cur1).includes("1. Договорът се съставя") && xml(cur1).includes("2. Договорът, Приемо-предавателният протокол") && xml(cur1).includes(clause));
await finish();
