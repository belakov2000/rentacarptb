// Възстановяване от резервно копие в ИЗРИЧНО посочена база и хранилища.
//
//   node --experimental-strip-types scripts/restore.ts --target-prefix restore-test            (само проверка, без запис)
//   node --experimental-strip-types scripts/restore.ts --target-prefix restore-test --apply --confirm "RESTORE db/production/2026-10-12.json"
//
// Променливи на средата (не се записват никъде и не се отпечатват):
//   TARGET_DATABASE_URL  – целевата база (напр. временна база или отделен клон); миграциите трябва да са приложени
//   NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN – достъп до Netlify Blobs (личен токен от User settings → Applications)
// Опции:
//   --from <production|deploypreview|…>  – от копията на коя среда (по подразбиране production)
//   --snapshot <ключ>                     – конкретно копие (по подразбиране последното)
//   --target-prefix <име>                 – файловете се възстановяват в <име>-contracts и <име>-documents
//   --overwrite-seeded                    – замества началните редове в cars и settings със стойностите от копието
//   --allow-production-target             – позволява продукционните хранилища като цел (само при реална авария)
import { getStore } from "@netlify/blobs";
import pg from "pg";
import { applyRestore, planRestore, restoreFiles } from "../server/restore.ts";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n: string) => args.includes(n);
const fail = (m: string) => { console.error("СПРЯНО: " + m); process.exit(1); };

const from = opt("--from") || "production";
const prefix = opt("--target-prefix") || "";
const apply = flag("--apply");
const overwriteSeeded = flag("--overwrite-seeded");
const { TARGET_DATABASE_URL: dbUrl, NETLIFY_SITE_ID: siteID, NETLIFY_AUTH_TOKEN: token } = process.env;
if (!dbUrl) fail("липсва TARGET_DATABASE_URL.");
if (!siteID || !token) fail("липсват NETLIFY_SITE_ID / NETLIFY_AUTH_TOKEN.");
if (!/^[a-z0-9-]{3,40}$/.test(prefix)) fail("задайте --target-prefix (малки букви, цифри и тире), напр. restore-test.");
if (["production", "", "deploypreview", "branchdeploy", "dev"].includes(prefix) && !flag("--allow-production-target")) fail(`--target-prefix ${prefix} е име на работна среда – изберете отделно име.`);

const storeOf = (name: string) => getStore({ name, siteID: siteID!, token: token! });
const backups = storeOf(from === "production" ? "backups" : `${from}-backups`);
const target = (name: string) => storeOf(prefix === "production" ? name : `${prefix}-${name}`);

const keys = (await backups.list({ prefix: `db/${from}/` })).blobs.map((b) => b.key).sort().reverse();
const snapshotKey = opt("--snapshot") || keys[0];
if (!snapshotKey) fail(`няма копия за среда ${from}.`);
const item = await backups.getWithMetadata(snapshotKey, { type: "text" });
if (!item) fail(`копието ${snapshotKey} не е намерено.`);

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const q = (text: string, params?: unknown[]) => client.query(text, params as any[]);
try {
  const plan = await planRestore(item!.data, item!.metadata.sha256 as string, q, { overwriteSeeded });
  console.log(`Копие: ${snapshotKey} (създадено ${plan.snapshot?.createdAt ?? "?"})`);
  console.table(plan.tables);
  if (Object.keys(plan.differentKeys).length) console.log("Редове, които съществуват в целта с ДРУГИ стойности (няма да бъдат променени):", plan.differentKeys);
  for (const name of ["contracts", "documents"]) console.log(name, await restoreFiles(backups as any, target(name) as any, name, false));
  if (!plan.ok) fail(plan.problems.join(" "));
  if (!apply) { console.log("\nПроверката е успешна. Нищо не е записано. За запис добавете --apply --confirm \"RESTORE " + snapshotKey + "\"."); process.exit(0); }
  if (opt("--confirm") !== `RESTORE ${snapshotKey}`) fail(`нужно е --confirm "RESTORE ${snapshotKey}".`);
  const res = await applyRestore(plan, q, { overwriteSeeded });
  console.log("\nДобавени редове:", res.inserted, "Заменени начални редове:", res.overwritten);
  console.table(res.verify.tables);
  for (const name of ["contracts", "documents"]) console.log(name, await restoreFiles(backups as any, target(name) as any, name, true));
  console.log(res.verify.ok ? "\nВЪЗСТАНОВЯВАНЕТО Е ПРОВЕРЕНО: всички редове съвпадат с копието." : "\nВНИМАНИЕ: има разлики – вижте таблицата.");
  process.exit(res.verify.ok ? 0 : 2);
} finally {
  await client.end();
}
