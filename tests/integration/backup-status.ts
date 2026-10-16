// Отчетът за резервните копия: веднага след „Направи копие сега“ проверката разпознава копираните файлове
// (strong consistency при eventual list() в Netlify Blobs), броячите съвпадат с хранилищата на текущата среда,
// а успешно копие на базата се разграничава от завършено архивиране на файловете. Само синтетични данни.
import { check, finish, freshDb, setContext } from "./harness.ts";
import { faults, getStore, stores } from "./stubs/blobs.ts";
import { backupBlobs, backupStatus, runBackup, verifyBackup } from "../../server/backup.ts";

setContext("deploy-preview");
const t = await freshDb("backupstatus");
t.use();
const jpg = (i: number) => new Uint8Array([0xff, 0xd8, i & 255, (i >> 8) & 255, 1, 2, 3]);
const docs = getStore("deploypreview-documents"), cons = getStore("deploypreview-contracts");
for (let i = 0; i < 12; i++) await docs.set(i.toString(16).padStart(64, "a"), jpg(i));
for (let i = 0; i < 6; i++) await cons.set(i.toString(16).padStart(32, "c"), jpg(100 + i));
// Продукционните хранилища не се пипат
const prod = getStore("documents"); await prod.set("f".repeat(64), jpg(999));
const prodBefore = JSON.stringify([...stores.get("documents")!.keys()]);

faults.eventualMs = 60_000; // както в Netlify: list() без strong не вижда току-що записаното
const r = await runBackup(true);
const v = await verifyBackup(3);
check("1. веднага след копието проверката разпознава всички копия (strong consistency)", v.files.documents.backedUp === 12 && v.files.contracts.backedUp === 6 && v.files.documents.missing === 0, JSON.stringify(v.files));
check("2. броячите са от хранилищата на текущата среда (deploypreview-*), не от production", v.files.documents.source === 12 && v.files.contracts.source === 6 && JSON.stringify([...stores.get("documents")!.keys()]) === prodBefore && !stores.has("backups"), "");
check("3. всичко копирано → база успешна, файлове завършени, общо ok", v.ok && v.dbOk && v.filesOk && (await backupStatus()).filesComplete === true && (await backupStatus()).warning === "", JSON.stringify({ ok: v.ok, dbOk: v.dbOk, filesOk: v.filesOk }));
const raw = await getStore({ name: "deploypreview-backups", consistency: "strong" }).get("status/deploy-preview.json", { type: "json" });
check("4. записаното състояние е без изчислените полета (stale, warning)", !("stale" in raw) && !("warning" in raw) && raw.filesComplete === true, Object.keys(raw).join(","));
// Нов файл след копието: базата има копие, файловете – не
await docs.set("e".repeat(64), jpg(500));
const v2 = await verifyBackup(0);
check("5. нов файл без копие → проверката НЕ е зелена: база ok, файлове не", v2.ok === false && v2.dbOk === true && v2.filesOk === false && v2.files.documents.missing === 1 && v2.problems.some((p) => /не е завършено/.test(p)), v2.problems.join("; "));
// Изтичане на времето при копирането: копието на базата е успешно, архивирането на файловете не е завършено
for (let i = 0; i < 5; i++) await docs.set((i + 100).toString(16).padStart(64, "b"), jpg(600 + i));
const realNow = Date.now; let calls = 0;
Date.now = () => realNow() + (++calls > 4 ? 60_000 : 0); // бюджетът свършва след първите файлове
await runBackup(true);
Date.now = realNow;
const st = await backupStatus();
check("6. частично копиране: lastSuccessAt за базата, filesComplete = false, предупреждение за файловете", !!st.lastSuccessAt && st.filesComplete === false && st.pendingFiles > 0 && /базата е успешно, но архивирането на файловете не е завършено/.test(st.warning), `${st.pendingFiles} чакат – ${st.warning}`);
await runBackup(true);
const st2 = await backupStatus(), v3 = await verifyBackup(0);
check("7. следващото изпълнение довършва; броячите и статусът съвпадат", st2.filesComplete === true && st2.pendingFiles === 0 && v3.filesOk && v3.files.documents.backedUp === 18 && st2.filesTotal === 24 && st2.filesBackedUp === 24, `${v3.files.documents.backedUp}/${v3.files.documents.source}`);
// Старо записано състояние (с изчислени полета и без filesComplete) се чете правилно
await getStore({ name: "deploypreview-backups", consistency: "strong" }).setJSON("status/deploy-preview.json", { lastSuccessAt: new Date().toISOString(), lastErrorAt: null, lastError: "", consecutiveFailures: 0, pendingFiles: 1, stale: true, warning: "Все още няма успешно резервно копие." });
const old = await backupStatus();
check("8. старо състояние (pendingFiles 1, записани stale/warning) → не е „зелено“ и не показва остарялото предупреждение", old.stale === false && old.filesComplete === false && /не е завършено: 1 файла/.test(old.warning), old.warning);
faults.eventualMs = 0;
await finish();
