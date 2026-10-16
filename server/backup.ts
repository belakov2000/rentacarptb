import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { deployContext, store } from "./stores.js";

// Резервни копия в отделно хранилище на Netlify Blobs („backups“; извън продукция – отделно хранилище, виж stores.ts).
// Личните данни остават в инфраструктурата на Netlify, не в публичното Git хранилище.
//   db/<среда>/<дата>.json          – пълно копие на всички таблици (по едно на ден, пазят се последните 35)
//   blobs/<хранилище>/<ключ>@<etag>  – копие на всеки договор и всяка снимка на документ; новите версии се добавят,
//                                      старите копия не се презаписват
//   status/<среда>.json             – последно успешно копие и последна грешка (показват се в административния панел)
// Таблиците се копират от Postgres като JSON (json_agg) – времената остават с точност до микросекунда,
// а имената на колоните са като в базата, така че server/restore.ts ги връща с json_populate_recordset без загуба.
export const TABLES = {
  bookings: schema.bookings,
  payments: schema.payments,
  booking_events: schema.bookingEvents,
  cars: schema.cars,
  car_blocks: schema.carBlocks,
  expenses: schema.expenses,
  email_log: schema.emailLog,
  contract_versions: schema.contractVersions,
  settings: schema.settings,
  ad_spend: schema.adSpend,
  customers: schema.customers,
  booking_extensions: schema.bookingExtensions,
} as const;
// Първичен ключ на всяка таблица (име на колоната в базата)
const PK: Record<keyof typeof TABLES, string> = {
  bookings: "id", payments: "id", booking_events: "id", cars: "id", car_blocks: "id",
  expenses: "id", email_log: "id", contract_versions: "id", settings: "key", ad_spend: "id", customers: "id", booking_extensions: "id",
};
export const SOURCE_STORES = ["contracts", "documents"] as const;
const KEEP_DAYS = 35;
const STALE_HOURS = 26;

const backups = () => store("backups", { strong: true });
const env = () => deployContext().replace(/[^\w-]/g, "_");

async function sha256(data: ArrayBuffer | Uint8Array | string) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest("SHA-256", buf as ArrayBuffer);
  return Buffer.from(h).toString("hex");
}
const safeEtag = (e: string) => e.replace(/[^\w-]/g, "");
const today = () => new Date().toISOString().slice(0, 10);
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);

export type Snapshot = { version: 2; env: string; createdAt: string; tables: Record<string, Record<string, unknown>[]> };

// ===== Копие на базата =====
export async function backupDatabase(force = false) {
  const key = `db/${env()}/${today()}.json`;
  if (!force && (await backups().getMetadata(key))) return { key, skipped: true };
  const tables: Snapshot["tables"] = {};
  const counts: Record<string, number> = {};
  for (const [name, table] of Object.entries(TABLES)) {
    const r = await db.execute(sql`select coalesce(json_agg(t), '[]'::json) as rows from ${sql.identifier(getTableName(table))} t`);
    const v = rowsOf(r)[0]?.rows;
    tables[name] = typeof v === "string" ? JSON.parse(v) : v ?? [];
    counts[name] = tables[name].length;
  }
  const body = JSON.stringify({ version: 2, env: env(), createdAt: new Date().toISOString(), tables } satisfies Snapshot);
  await backups().set(key, body, { metadata: { sha256: await sha256(body), counts, createdAt: new Date().toISOString() } });
  // Изтриват се само копия по-стари от KEEP_DAYS дни – живите данни не се пипат
  const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  const { blobs } = await backups().list({ prefix: `db/${env()}/` });
  for (const b of blobs) if (b.key.slice(-15, -5) < cutoff) await backups().delete(b.key);
  return { key, skipped: false, counts };
}

// ===== Копие на договорите и документите (на части – спира преди изтичане на времето и продължава при следващото изпълнение) =====
export async function backupBlobs(budgetMs = 20_000) {
  const until = Date.now() + budgetMs;
  const result: Record<string, { total: number; copied: number; pending: number }> = {};
  for (const name of SOURCE_STORES) {
    const src = store(name, { strong: true });
    const { blobs } = await src.list();
    const have = new Set((await backups().list({ prefix: `blobs/${name}/` })).blobs.map((b) => b.key));
    let copied = 0, pending = 0;
    for (const b of blobs) {
      const target = `blobs/${name}/${b.key}@${safeEtag(b.etag)}`;
      if (have.has(target)) continue;
      if (Date.now() > until) { pending++; continue; }
      const item = await src.getWithMetadata(b.key, { type: "arrayBuffer" });
      if (!item) continue;
      await backups().set(target, item.data, {
        metadata: { ...item.metadata, sourceKey: b.key, sha256: await sha256(item.data), copiedAt: new Date().toISOString() },
      });
      copied++;
    }
    result[name] = { total: blobs.length, copied, pending };
  }
  return result;
}

// ===== Състояние: последно успешно копие и последна грешка =====
// lastSuccessAt – последно успешно копие на БАЗАТА; filesComplete – дали при последното изпълнение всички договори и
// документи имат копие (pendingFiles – колко чакат). Двете се показват отделно: копие на базата ≠ завършено архивиране на файловете.
type Status = {
  lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string; consecutiveFailures: number; pendingFiles: number;
  filesCheckedAt?: string | null; filesComplete?: boolean | null; filesTotal?: number; filesBackedUp?: number;
};
const STATUS_KEYS = ["lastSuccessAt", "lastErrorAt", "lastError", "consecutiveFailures", "pendingFiles", "filesCheckedAt", "filesComplete", "filesTotal", "filesBackedUp"] as const;
// Записва се само състоянието – без изчислените полета (stale, warning), които иначе остават записани в хранилището
const pickStatus = (s: Record<string, unknown>) => Object.fromEntries(STATUS_KEYS.filter((k) => k in s).map((k) => [k, s[k]])) as Status;
const statusKey = () => `status/${env()}.json`;
export async function backupStatus() {
  const s = ((await backups().get(statusKey(), { type: "json" }).catch(() => null)) as Status | null) ?? {
    lastSuccessAt: null, lastErrorAt: null, lastError: "", consecutiveFailures: 0, pendingFiles: 0,
  };
  const stale = !s.lastSuccessAt || Date.now() - Date.parse(s.lastSuccessAt) > STALE_HOURS * 3600_000;
  const filesComplete = s.filesComplete ?? (s.lastSuccessAt ? s.pendingFiles === 0 : null);
  const warning = s.consecutiveFailures
    ? `Последното резервно копие е неуспешно (${s.consecutiveFailures} поредни грешки): ${s.lastError}`
    : stale ? (s.lastSuccessAt ? `Няма успешно резервно копие от повече от ${STALE_HOURS} часа.` : "Все още няма успешно резервно копие.")
    : filesComplete === false ? `Копието на базата е успешно, но архивирането на файловете не е завършено: ${s.pendingFiles} файла без копие.` : "";
  return { ...pickStatus(s as any), filesComplete, stale, warning };
}

export async function runBackup(force = false) {
  const prev = await backupStatus();
  try {
    const database = await backupDatabase(force);
    const files = await backupBlobs();
    const report = { at: new Date().toISOString(), env: env(), database, files };
    await backups().setJSON(`manifest/${env()}.json`, report);
    const pendingFiles = Object.values(files).reduce((n, f) => n + f.pending, 0);
    const filesTotal = Object.values(files).reduce((n, f) => n + f.total, 0);
    await backups().setJSON(statusKey(), pickStatus({
      ...prev, lastSuccessAt: report.at, lastError: "", consecutiveFailures: 0, pendingFiles,
      filesCheckedAt: report.at, filesComplete: pendingFiles === 0, filesTotal, filesBackedUp: filesTotal - pendingFiles,
    }));
    return report;
  } catch (e) {
    // Грешката се записва (без лични данни – само съобщението) и се показва като предупреждение в панела
    const lastError = String((e as Error)?.message || e).replace(/\b[a-f0-9]{32,}\b/gi, "***").replace(/https?:\/\/\S+/g, "[url]").slice(0, 300);
    const s: Status = pickStatus({ ...prev, lastErrorAt: new Date().toISOString(), lastError, consecutiveFailures: prev.consecutiveFailures + 1 });
    await backups().setJSON(statusKey(), s).catch(() => null);
    await db.insert(schema.bookingEvents).values({ actor: "system", action: "backup.failed", details: { error: lastError } }).catch(() => null);
    throw e;
  }
}

// ===== Проверка, че копието може да бъде възстановено =====
export async function listSnapshots() {
  const { blobs } = await backups().list({ prefix: `db/${env()}/` });
  return blobs.map((b) => b.key).sort().reverse();
}

export async function verifyBackup(sample = 5) {
  const problems: string[] = [];
  const [key] = await listSnapshots();
  if (!key) return { ok: false, problems: ["Няма копие на базата."] };
  const item = await backups().getWithMetadata(key, { type: "text" });
  if (!item) return { ok: false, problems: [`Копието ${key} не може да бъде прочетено.`] };

  // 1. Целост: контролната сума съвпада и JSON-ът се чете
  if ((await sha256(item.data)) !== item.metadata.sha256) problems.push("Контролната сума на копието на базата не съвпада.");
  let snap: Snapshot | null = null;
  try { snap = JSON.parse(item.data); } catch { problems.push("Копието на базата не е валиден JSON."); }

  // 2. Съвместимост със схемата и сухо възстановяване: кои редове от копието липсват в живата база
  const tables: Record<string, { inBackup: number; live: number; missingInLive: number; unknownColumns: string[] }> = {};
  if (snap) {
    for (const [name, table] of Object.entries(TABLES) as [keyof typeof TABLES, (typeof TABLES)[keyof typeof TABLES]][]) {
      const rows = snap.tables[name];
      if (!Array.isArray(rows)) { problems.push(`Таблица ${name} липсва в копието.`); continue; }
      const cols = getTableColumns(table) as Record<string, any>;
      const columns = new Set(Object.values(cols).map((c) => c.name as string));
      const unknownColumns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !columns.has(c));
      if (unknownColumns.length) problems.push(`Таблица ${name}: непознати колони ${unknownColumns.join(", ")}.`);
      const pk = PK[name];
      const live = rowsOf(await db.execute(sql`select ${sql.identifier(pk)}::text as k from ${sql.identifier(getTableName(table))}`));
      const liveKeys = new Set(live.map((r: { k: string }) => r.k));
      const missingInLive = rows.filter((r) => !liveKeys.has(String(r[pk]))).length;
      tables[name] = { inBackup: rows.length, live: liveKeys.size, missingInLive, unknownColumns };
    }
  }

  // 3. Файлове: всеки договор и документ има копие; случайна извадка се проверява байт по байт
  const files: Record<string, { source: number; backedUp: number; missing: number; checked: number; mismatched: number }> = {};
  for (const name of SOURCE_STORES) {
    const src = (await store(name, { strong: true }).list()).blobs;
    const copies = new Set((await backups().list({ prefix: `blobs/${name}/` })).blobs.map((b) => b.key));
    const withCopy = src.filter((b) => copies.has(`blobs/${name}/${b.key}@${safeEtag(b.etag)}`));
    let checked = 0, mismatched = 0;
    for (const b of withCopy.sort(() => Math.random() - 0.5).slice(0, sample)) {
      const [orig, copy] = await Promise.all([
        store(name, { strong: true }).get(b.key, { type: "arrayBuffer" }),
        backups().getWithMetadata(`blobs/${name}/${b.key}@${safeEtag(b.etag)}`, { type: "arrayBuffer" }),
      ]);
      checked++;
      if (!orig || !copy || (await sha256(orig)) !== (await sha256(copy.data)) || copy.metadata.sha256 !== (await sha256(copy.data))) mismatched++;
    }
    if (mismatched) problems.push(`${name}: ${mismatched} от проверените копия не съвпадат с оригинала.`);
    if (src.length > withCopy.length) problems.push(`${name}: ${src.length - withCopy.length} от ${src.length} файла нямат копие – архивирането на файловете не е завършено.`);
    files[name] = { source: src.length, backedUp: withCopy.length, missing: src.length - withCopy.length, checked, mismatched };
  }
  // Отделно: копието на базата (цяло и съвместимо) и файловете (всички с копие, извадката съвпада)
  const dbOk = !problems.some((p) => !/^(contracts|documents):/.test(p));
  const filesOk = Object.values(files).every((f) => f.missing === 0 && f.mismatched === 0);
  return { ok: dbOk && filesOk, dbOk, filesOk, snapshot: key, createdAt: item.metadata.createdAt, tables, files, problems };
}
