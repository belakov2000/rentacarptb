// Резервни копия и възстановяване: миграции и суми, нов формат (json_agg), точност до микросекунда, контролни суми,
// липсващи/повредени файлове, запис на неуспешно копие и scripts/restore.ts в отделна временна база и хранилища.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { check, finish, freshDb, migrations, rejects, setContext, schema, sha } from "./harness.ts";
import { faults, getStore, loadStores, saveStores, stores } from "./stubs/blobs.ts";
import { state } from "./stubs/db.ts";
import { backupBlobs, backupDatabase, backupStatus, runBackup, verifyBackup } from "../../server/backup.ts";

setContext("production"); // копието се прави „в продукция“ – но върху временна база и хранилища в паметта
const migs = migrations();

// ===== 1. Миграции върху данни като старите (29 суми + 4 нееднозначни, времена с микросекунди) =====
const src = await freshDb("backup_src", 3);
const totals = ["50 €","120 €","140 €","140 €","140 €","140 €","175 €","196 €","196 €","242,10 €","261 €","261 €","261 €","261 €","261 €","261 €","261 €","261 €","265,76 €","266,46 €","266,46 €","266,46 €","266,46 €","287,04 €","287,46 €","287,46 €","296 €","540 €","829,47 €"];
const odd = ["250 € (без доставка)", "", "1.200 €", "12,5 €"];
let i = 0;
for (const tt of [...totals, ...odd]) {
  await src.q(`insert into bookings (id, view_token, admin_token, status, name, email, phone, car, car_id, start_date, end_date, start_time, end_time, pickup, dropoff, total, payment, created_at)
    values ($1,$2,$3,$4,$5,$6,'+359000000000','Test','punto','2027-01-10','2027-01-12','10:00','10:00','p','d',$7,'cash', $8::timestamp)`,
    [createHash("md5").update("b" + i).digest("hex"), sha("v" + i), sha("a" + i), i % 7 ? "rejected" : "confirmed", `Тест ${i}`, `t${i}@example.com`, tt, `2026-10-04 16:26:${String(10 + i).padStart(2, "0")}.5192${String(i).padStart(2, "0")}`]);
  i++;
}
for (const m of migs.slice(3)) await src.applyMigration(m);
const conv = (await src.q("select total, total_cents, total_review from bookings")).rows;
const expect = (t: string) => { const m = /^(\d{1,6})(?:,(\d{2}))? €$/.exec(t); return m ? Number(m[1]) * 100 + Number(m[2] || 0) : null; };
check("Миграции: 29 суми → total_cents точно", conv.filter((r) => totals.includes(r.total)).length === 29 && conv.filter((r) => totals.includes(r.total)).every((r) => r.total_cents === expect(r.total) && r.total_review === ""), `сума ${conv.reduce((a, r) => a + (r.total_cents || 0), 0)} евроцента`);
check("Миграции: нееднозначните не се отгатват", conv.filter((r) => odd.includes(r.total)).every((r) => r.total_cents === null && r.total_review), "");
const snapRows = async () => JSON.stringify((await src.q("select id, total_cents, total_review from bookings order by id")).rows) + JSON.stringify((await src.q("select * from cars order by id")).rows);
const b1 = await snapRows(); await src.applyMigration(migs[4]); 
check("Миграции: попълващата миграция е повторяема", b1 === (await snapRows()), "");
// Последните миграции са приложени: колоните на приключване/удължаване, клиентите и състоянието на подписване съществуват
const cols = (await src.q("select table_name || '.' || column_name c from information_schema.columns where table_schema = 'public'")).rows.map((r: any) => r.c);
check(`Миграции: всички ${migs.length} са приложени (до ${migs.at(-1)})`, migs.length === 18 && ["bookings.stage", "route_cache.precision", "route_cache.claim_token", "api_limits.expires_at", "price_quotes.booking_id", "bookings.price_check_status", "bookings.handover_recorded_at", "bookings.returned_at", "bookings.customer_id", "booking_extensions.added_cents", "customers.name", "contract_versions.sign_status"].every((c) => cols.includes(c)), migs.join(", "));
src.use();
const db = state.db;
// Синтетични редове във всички нови таблици
const [b0] = (await src.q("select id from bookings limit 1")).rows;
await db.insert(schema.payments).values([
  { id: "p1", bookingId: b0.id, amountCents: 10000, method: "cash", kind: "deposit", status: "received", paidAt: new Date(), idempotencyKey: "k1", createdBy: "t" },
  { id: "p2", bookingId: b0.id, amountCents: 5000, method: "cash", kind: "refund", status: "received", refundOf: "p1", paidAt: new Date(), idempotencyKey: "k2", createdBy: "t" },
]);
check("Ограничение: плащане към несъществуваща резервация се отказва", await rejects(db.insert(schema.payments).values({ id: "p3", bookingId: "nope", amountCents: 1, method: "cash", kind: "deposit", idempotencyKey: "k3", createdBy: "t" })), "");
check("Ограничение: двойно плащане със същия ключ се отказва", await rejects(db.insert(schema.payments).values({ id: "p4", bookingId: b0.id, amountCents: 1, method: "cash", kind: "deposit", idempotencyKey: "k1", createdBy: "t" })), "");
await db.insert(schema.bookingEvents).values({ bookingId: b0.id, actor: "t", action: "x", details: { текст: "кирилица", n: 1.5 } });
await db.insert(schema.carBlocks).values({ carId: "golf", startDate: "2027-02-01", endDate: "2027-02-03", reason: "сервиз", createdBy: "t" });
await db.insert(schema.expenses).values({ carId: "ka", date: "2027-01-05", category: "repair", amountCents: 12345, createdBy: "t" });
await db.insert(schema.emailLog).values({ kind: "x", recipient: "t***@example.com", status: "sent", dedupeKey: "d1" });
await db.insert(schema.contractVersions).values({ bookingId: b0.id, version: 1, blobKey: "k", fileName: "f.docx", createdBy: "t" });
await db.insert(schema.adSpend).values({ campaign: "ptb_test", content: "video_a_woman", periodStart: "2027-01-01", periodEnd: "2027-01-14", amountCents: 1735, createdBy: "t" });

// ===== 2. Файлове: голям обем, на части, прекъсване, нова версия =====
for (let k = 0; k < 40; k++) await getStore("contracts").set("c" + k, randomBytes(20_000), { metadata: { name: `Dogovor-${k}.docx` } });
for (let k = 0; k < 200; k++) await getStore("documents").set(sha("d" + k), randomBytes(200_000));
faults.delayMs = 10;
let runs = 0, copied = 0, last: any;
do { last = await backupBlobs(300); runs++; copied += last.contracts.copied + last.documents.copied; } while (last.contracts.pending + last.documents.pending > 0 && runs < 100);
faults.delayMs = 0;
check("240 файла се копират на части и продължават при следващо изпълнение", copied === 240 && runs > 1, `${runs} изпълнения, копирани ${copied}`);
for (let k = 200; k < 230; k++) await getStore("documents").set(sha("d" + k), randomBytes(50_000));
faults.gets = 0; faults.failGetAfter = 10;
const interrupted = await rejects(backupBlobs(60_000));
faults.failGetAfter = Infinity;
const resumed = await backupBlobs(60_000);
check("Прекъсване по средата → следващото изпълнение копира останалите без дубликати", interrupted && resumed.documents.copied === 20 && (await getStore("backups").list({ prefix: "blobs/documents/" })).blobs.length === 230, `довършени ${resumed.documents.copied}`);
await getStore("contracts").set("c0", randomBytes(21_000), { metadata: { name: "Dogovor-0.docx" } });
await backupBlobs(60_000);
check("Нова версия на договор не презаписва старото копие", (await getStore("backups").list({ prefix: "blobs/contracts/c0@" })).blobs.length === 2, "");

// ===== 3. Нов формат и точност на времената =====
const snap = await backupDatabase(true);
const bstore = stores.get("backups")!;
const text = new TextDecoder().decode(bstore.get(snap.key)!.data);
const json = JSON.parse(text);
const srcTimes = (await src.q("select id, created_at::text t from bookings order by id")).rows;
const snapTimes = new Map(json.tables.bookings.map((r: any) => [r.id, r.created_at]));
const exact = srcTimes.every((r: any) => String(snapTimes.get(r.id)).replace("T", " ") === r.t);
check("Нов формат (версия 2, имена на колоните както в базата)", json.version === 2 && "created_at" in json.tables.bookings[0] && "total_cents" in json.tables.bookings[0], "");
check("Времената са с точност до микросекунда", exact && json.tables.bookings.some((r: any) => /\.\d{6}$/.test(String(r.created_at))), `напр. ${srcTimes[0].t} → ${snapTimes.get(srcTimes[0].id)}`);
let v = await verifyBackup(1000);
check("Проверка: цяло копие, файловете съвпадат байт по байт", v.ok && v.files!.documents.checked === 230 && v.files!.contracts.checked === 40, v.problems.join(" ") || "ok");

// ===== 4. Повреди =====
const oneDoc = [...bstore.keys()].find((k) => k.startsWith("blobs/documents/"))!;
const keep = bstore.get(oneDoc)!;
bstore.delete(oneDoc);
v = await verifyBackup(0);
check("Липсващ файл в копието се открива", v.files!.documents.missing === 1, `missing ${v.files!.documents.missing}`);
bstore.set(oneDoc, { ...keep, data: randomBytes(10) });
v = await verifyBackup(1000);
check("Подменено съдържание на файл се открива", !v.ok && v.files!.documents.mismatched >= 1, v.problems.join(" "));
bstore.set(oneDoc, keep);
const orig = bstore.get(snap.key)!;
bstore.set(snap.key, { ...orig, data: new TextEncoder().encode(text.replace("Тест 1", "Тест X")) });
v = await verifyBackup(0);
check("Подменено копие на базата (контролна сума) се открива", !v.ok && v.problems.some((p) => p.includes("Контролната сума")), "");
bstore.set(snap.key, orig);

// ===== 5. Неуспешно копие се записва и е видимо =====
state.db = new Proxy({}, { get: () => () => { throw new Error("simulated db outage for " + "a".repeat(40)); } });
const failed = await rejects(runBackup(true));
state.db = db;
let st = await backupStatus();
check("Неуспешно копие: грешката е записана и има предупреждение", failed && st.consecutiveFailures === 1 && st.warning.includes("неуспешно") && !st.lastError.includes("a".repeat(40)), st.warning);
await runBackup(true);
st = await backupStatus();
check("Следващото успешно копие изчиства предупреждението", st.consecutiveFailures === 0 && !st.warning && !!st.lastSuccessAt, "");

// ===== 6. scripts/restore.ts като отделен процес: отделна временна база и отделни хранилища =====
const dst = await freshDb("restore_dst");
const dir = resolve("tests/integration/.out/restore-blobs");
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
process.env.BLOB_STUB_DIR = dir;
const finalSnap = (await getStore("backups").list({ prefix: "db/production/" })).blobs.map((b) => b.key).sort().reverse()[0];
saveStores();
const cli = (...a: string[]) => {
  try {
    const out = execFileSync(process.execPath, [resolve("tests/integration/.out/restore-cli.mjs"), ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BLOB_STUB_CHILD: "1", TARGET_DATABASE_URL: dst.url, NETLIFY_SITE_ID: "test-site", NETLIFY_AUTH_TOKEN: "test-only" } });
    return { code: 0, out };
  } catch (e: any) { return { code: e.status ?? 1, out: String(e.stdout) + String(e.stderr) }; }
};
const dstCount = async () => (await dst.q("select count(*)::int n from bookings")).rows[0].n;
const tgtFiles = () => { loadStores(); return (stores.get("restore-test-contracts")?.size ?? 0) + (stores.get("restore-test-documents")?.size ?? 0); };
let c = cli("--target-prefix", "restore-test");
check("restore.ts без --apply: само проверка, нищо не е записано", c.code === 0 && c.out.includes("Нищо не е записано") && (await dstCount()) === 0 && tgtFiles() === 0, `код ${c.code}`);
c = cli("--target-prefix", "restore-test", "--apply");
check("restore.ts --apply без потвърждение → отказ, нищо не е записано", c.code === 1 && c.out.includes("--confirm") && (await dstCount()) === 0 && tgtFiles() === 0, `код ${c.code}`);
c = cli("--target-prefix", "restore-test", "--apply", "--confirm", "RESTORE wrong");
check("restore.ts с грешна фраза → отказ", c.code === 1 && (await dstCount()) === 0, `код ${c.code}`);
c = cli("--target-prefix", "production", "--apply", "--confirm", `RESTORE ${finalSnap}`);
check("restore.ts отказва продукционните хранилища като цел", c.code === 1 && c.out.includes("работна среда"), `код ${c.code}`);
c = cli("--apply", "--confirm", `RESTORE ${finalSnap}`);
check("restore.ts без --target-prefix → отказ", c.code === 1, `код ${c.code}`);
c = cli("--target-prefix", "restore-test", "--overwrite-seeded", "--apply", "--confirm", `RESTORE ${finalSnap}`);
check("restore.ts с изрично потвърждение: възстановяване и проверка", c.code === 0 && c.out.includes("ВЪЗСТАНОВЯВАНЕТО Е ПРОВЕРЕНО"), `код ${c.code}`);
// Независима проверка: всеки ред във всяка таблица, включително микросекундите
let same = true; const counts: string[] = [];
for (const tb of ["cars", "settings", "bookings", "payments", "booking_events", "car_blocks", "expenses", "email_log", "contract_versions"]) {
  const pk = tb === "settings" ? "key" : "id";
  const a = (await src.q(`select to_json(t)::text j from ${tb} t order by ${pk}`)).rows.map((r: any) => r.j);
  const b = (await dst.q(`select to_json(t)::text j from ${tb} t order by ${pk}`)).rows.map((r: any) => r.j);
  const ok = JSON.stringify(a) === JSON.stringify(b); same &&= ok; counts.push(`${tb} ${b.length}/${a.length}${ok ? "" : " РАЗЛИКА"}`);
}
check("Възстановената база съвпада ред по ред (вкл. микросекунди)", same, counts.join(", "));
const fk = (await dst.q("select count(*)::int n from payments p left join bookings b on b.id=p.booking_id where b.id is null")).rows[0].n;
const refund = (await dst.q("select count(*)::int n from payments r join payments o on o.id=r.refund_of")).rows[0].n;
check("Връзките между таблиците са запазени", fk === 0 && refund === 1, "");
loadStores();
const fileOk = ["contracts", "documents"].every((n) => [...stores.get(n)!].every(([k, it]) => stores.get("restore-test-" + n)?.get(k) && sha(stores.get("restore-test-" + n)!.get(k)!.data) === sha(it.data)));
check("Файловете са възстановени в отделни хранилища и съвпадат (SHA-256)", fileOk && stores.get("restore-test-documents")!.size === 230 && stores.get("restore-test-contracts")!.size === 40, `${stores.get("restore-test-contracts")!.size} + ${stores.get("restore-test-documents")!.size}`);
check("Изходните хранилища не са променени от възстановяването", stores.get("documents")!.size === 230 && stores.get("contracts")!.size === 40, "");
const nextId = (await dst.q("insert into booking_events (actor, action) values ('t','after') returning id")).rows[0].id;
check("Възстановената база работи (броячите продължават)", nextId > 1, `нов id ${nextId}`);
// Повторно изпълнение: нищо не се дублира и не се презаписва
await dst.q("update bookings set note='промяна след възстановяването' where id=$1", [b0.id]);
c = cli("--target-prefix", "restore-test", "--apply", "--confirm", `RESTORE ${finalSnap}`);
const note = (await dst.q("select note from bookings where id=$1", [b0.id])).rows[0].note;
check("Повторно възстановяване не дублира и не променя съществуващи редове", c.out.includes("bookings: 0") || (c.out.includes("Добавени редове") && note === "промяна след възстановяването"), `бележката остава: ${note === "промяна след възстановяването"}`);
// Повредено копие → отказ
loadStores();
const sk = stores.get("backups")!.get(finalSnap)!;
stores.get("backups")!.set(finalSnap, { ...sk, data: new TextEncoder().encode(new TextDecoder().decode(sk.data).replace("Тест 2", "Тест Y")) });
saveStores();
c = cli("--target-prefix", "restore-test-2", "--apply", "--confirm", `RESTORE ${finalSnap}`);
check("Повредено копие → restore.ts отказва преди запис", c.code === 1 && c.out.includes("Контролната сума"), `код ${c.code}`);
delete process.env.BLOB_STUB_DIR;
await finish();
