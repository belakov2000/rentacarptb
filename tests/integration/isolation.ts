// Изолация на Netlify Blobs: функциите в Deploy Preview не четат и не променят продукционните хранилища.
import { randomBytes } from "node:crypto";
import { adminJar, bookingBody, check, contractData, finish, freshDb, O, setContext, schema, syntheticJpeg } from "./harness.ts";
import { fingerprint, getStore, stores } from "./stubs/blobs.ts";
import { storeName } from "../../server/stores.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import documentsFn from "../../netlify/functions/documents.mts";
import { backupDatabase, backupBlobs, runBackup, verifyBackup } from "../../server/backup.ts";

// 1. Избор на хранилище по среда (от сървъра)
check("Хранилище: production → продукционното", storeName("contracts", "production") === "contracts", "");
check("Хранилище: deploy-preview → отделно", storeName("contracts", "deploy-preview") === "deploypreview-contracts", storeName("contracts", "deploy-preview"));
check("Хранилище: branch-deploy и dev → отделни", storeName("documents", "branch-deploy") === "branchdeploy-documents" && storeName("backups", "dev") === "dev-backups", "");
setContext(undefined);
check("Хранилище: неизвестна среда → изолирано (не продукционното)", storeName("contracts") === "unknown-contracts", storeName("contracts"));

// 2. Продукционни файлове (синтетични), които не бива да се променят
const PROD = ["contracts", "documents", "backups", "mail-outbox"];
for (let i = 0; i < 5; i++) await getStore("contracts").set("prod" + i, randomBytes(2000), { metadata: { name: `real-${i}.docx` } });
for (let i = 0; i < 5; i++) await getStore("documents").set("d".repeat(63) + i, randomBytes(3000));
await getStore("backups").set("db/production/2020-01-01.json", "{}", { metadata: { sha256: "x" } }); // старо копие – в продукция би се изтрило, ако се пипне
await getStore("backups").set("db/deploy-preview/2020-01-01.json", "{}", { metadata: { sha256: "x" } }); // същият ключ, но в продукционното хранилище
await getStore("mail-outbox").set("owner-new/keep", "{}");
const before = PROD.map(fingerprint).join("\n---\n");

// 3. Всички операции, които пишат или трият файлове, изпълнени в Deploy Preview
const t = await freshDb("isolation");
t.use();
setContext("deploy-preview");
await getStore("deploypreview-backups").set("db/deploy-preview/2020-01-01.json", "{}", { metadata: { sha256: "x" } });
const call = (url: string, init: RequestInit = {}, params: Record<string, string> = {}) => bookingsFn(new Request(url, init), { params } as any);
// Заявката идва „към продукционния домейн“ с подправени заглавки – изборът не зависи от тях
const forged = { "Content-Type": "application/json", Host: "rentacar-ptb.com", "X-Nf-Deploy-Context": "production", "X-Forwarded-Host": "rentacar-ptb.com" };
const r = await call("https://rentacar-ptb.com/api/bookings", { method: "POST", headers: forged, body: JSON.stringify(bookingBody("ISO", "2027-04-01", "10:00", "2027-04-03", "10:00", { requestKey: "iso-test-0001", contract: contractData("2027-04-01", "10:00", "2027-04-03", "10:00") })) });
const { id } = await r.json();
const [b] = await t.db.select().from(schema.bookings);
await call(`${O}/api/bookings/${id}/manage?key=${b.adminToken}`, { method: "POST", body: new URLSearchParams({ action: "km", kmDel: "9", kmDelRate: "1" }) }, { id }); // промяна
const up = await documentsFn(new Request(`${O}/api/documents`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: syntheticJpeg() }), { params: {}, ip: "203.0.113.9" } as any);
const docUrl = (await up.json()).url as string;
// Снимките се показват само на вписан администратор (етап 1) – четенето се проверява с администраторска сесия
setContext("deploy-preview", { cookies: adminJar() });
const docGet = await documentsFn(new Request(docUrl), { params: { id: docUrl.split("/").pop()! } } as any);
const prodDocGet = await documentsFn(new Request(`${O}/api/documents/${"d".repeat(63)}0`), { params: { id: "d".repeat(63) + "0" } } as any);
setContext("deploy-preview");
await runBackup(true); // копие + изтриване на старите копия (ретенция) – трие
await backupBlobs(60_000);
const v = await verifyBackup(100);
const after = PROD.map(fingerprint).join("\n---\n");

check("Нова заявка в Preview (с подправени заглавки за продукция)", r.status === 201, `HTTP ${r.status}`);
check("Договорът е в отделното хранилище", stores.get("deploypreview-contracts")?.has(id) === true && !stores.get("contracts")!.has(id), "deploypreview-contracts");
check("Снимка на документ: запис и четене в отделното хранилище", up.status === 201 && docGet.status === 200, `POST ${up.status}, GET ${docGet.status}`);
check("Preview не може да прочете продукционен документ", prodDocGet.status === 404, `HTTP ${prodDocGet.status}`);
check("Изтриване (ретенция на копията) само в отделното хранилище", !stores.get("deploypreview-backups")!.has("db/deploy-preview/2020-01-01.json") && stores.get("backups")!.has("db/deploy-preview/2020-01-01.json"), "старото копие в Preview е изтрито, продукционното е непокътнато");
check("Резервното копие в Preview копира само файловете на Preview", v.ok && v.files!.contracts.source === stores.get("deploypreview-contracts")!.size && [...stores.get("deploypreview-backups")!.keys()].every((k) => !k.includes("prod")), `contracts ${v.files!.contracts.source}, documents ${v.files!.documents.source}`);
check("Нито един продукционен файл не е променен", before === after, `${PROD.map((n) => `${n}: ${stores.get(n)?.size ?? 0}`).join(", ")} – ключ, etag, SHA-256 и metadata са еднакви`);
check("В продукционните хранилища няма нов ключ", [...stores.get("contracts")!.keys()].every((k) => k.startsWith("prod")), "");

// 4. Същите операции в продукция пишат в продукционните хранилища (контролна проверка, че тестът различава средите)
setContext("production");
const r2 = await call(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bookingBody("PROD", "2027-05-01", "10:00", "2027-05-03", "10:00", { requestKey: "iso-test-0002", contract: contractData("2027-05-01", "10:00", "2027-05-03", "10:00") })) });
const id2 = (await r2.json()).id;
check("Контрола: в продукция договорът отива в продукционното хранилище", stores.get("contracts")!.has(id2) && !stores.get("deploypreview-contracts")!.has(id2), "");
await finish();
