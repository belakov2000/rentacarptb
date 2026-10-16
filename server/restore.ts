// Възстановяване от резервно копие (server/backup.ts) – само в изрично посочена база и хранилища.
// Без зависимости от останалия код, за да може да се ползва от scripts/restore.ts и от тестовете.
//
// Правила за безопасност:
//  • първо planRestore(): проверка на контролната сума, схемата, връзките и конфликтите – без запис;
//  • applyRestore() добавя САМО липсващите редове (по първичен ключ) в една транзакция; съществуващ ред не се променя
//    (по изключение overwriteSeeded заменя началните редове в cars и settings, създадени от миграцията);
//  • файловете се записват само ако ключът липсва в целевото хранилище; съществуващ файл не се презаписва;
//  • след запис всеки ред и всеки файл се сравнява с копието (подробен отчет).
export const RESTORE_ORDER = ["cars", "settings", "customers", "bookings", "payments", "booking_events", "car_blocks", "expenses", "email_log", "contract_versions", "ad_spend", "booking_extensions"] as const;
type Table = (typeof RESTORE_ORDER)[number];
const PK: Record<Table, string> = {
  cars: "id", settings: "key", bookings: "id", payments: "id", booking_events: "id",
  car_blocks: "id", expenses: "id", email_log: "id", contract_versions: "id", ad_spend: "id", customers: "id", booking_extensions: "id",
};
const SEEDED = new Set<Table>(["cars", "settings"]);
// Таблици, добавени по-късно: в по-старите копия липсват и се приемат за празни
const ADDED_LATER = new Set<Table>(["ad_spend", "customers", "booking_extensions"]);
const SERIAL = ["booking_events", "car_blocks", "expenses", "email_log", "contract_versions", "ad_spend", "customers", "booking_extensions"];
// Външни ключове: таблица.колона → таблица
const FK: [Table, string, Table][] = [
  ["payments", "booking_id", "bookings"], ["contract_versions", "booking_id", "bookings"],
  ["car_blocks", "car_id", "cars"], ["expenses", "car_id", "cars"],
  ["bookings", "customer_id", "customers"], ["booking_extensions", "booking_id", "bookings"],
];

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
export type Snapshot = { version: number; env: string; createdAt: string; tables: Record<string, Record<string, unknown>[]> };

async function sha256(data: ArrayBuffer | Uint8Array | string) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return Buffer.from(await crypto.subtle.digest("SHA-256", buf as ArrayBuffer)).toString("hex");
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export type TablePlan = { inSnapshot: number; toInsert: number; identical: number; different: number; overwrite: number };
export type Plan = { ok: boolean; problems: string[]; snapshot: Snapshot | null; tables: Partial<Record<Table, TablePlan>>; differentKeys: Partial<Record<Table, string[]>> };

export async function planRestore(text: string, expectedSha: string | undefined, q: Query, opts: { overwriteSeeded?: boolean } = {}): Promise<Plan> {
  const problems: string[] = [];
  const tables: Plan["tables"] = {};
  const differentKeys: Plan["differentKeys"] = {};
  if (!expectedSha || (await sha256(text)) !== expectedSha) problems.push("Контролната сума на копието не съвпада – възстановяването е спряно.");
  let snap: Snapshot | null = null;
  try { snap = JSON.parse(text); } catch { problems.push("Копието не е валиден JSON."); }
  if (snap && snap.version !== 2) problems.push(`Неподдържана версия на копието: ${snap.version} (нужна е 2).`);
  if (!snap || problems.length) return { ok: false, problems, snapshot: snap, tables, differentKeys };

  for (const t of RESTORE_ORDER) {
    const rows = snap.tables[t] ?? (ADDED_LATER.has(t) ? [] : undefined);
    if (!Array.isArray(rows)) { problems.push(`Таблица ${t} липсва в копието.`); continue; }
    const cols = (await q(`select column_name from information_schema.columns where table_schema='public' and table_name=$1`, [t])).rows.map((r) => r.column_name);
    if (!cols.length) { problems.push(`Таблица ${t} липсва в целевата база (приложете първо миграциите).`); continue; }
    const extra = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !cols.includes(c));
    if (extra.length) problems.push(`Таблица ${t}: колоните ${extra.join(", ")} липсват в целевата база.`);
    const pk = PK[t];
    const keys = rows.map((r) => String(r[pk]));
    const existing = new Map<string, unknown>(
      (await q(`select ${pk}::text as k, to_json(t) as j from ${t} t where ${pk}::text = any($1)`, [keys])).rows.map((r) => [r.k, typeof r.j === "string" ? JSON.parse(r.j) : r.j]),
    );
    let identical = 0, different = 0;
    const diff: string[] = [];
    for (const r of rows) {
      const e = existing.get(String(r[pk]));
      if (e === undefined) continue;
      // Сравняват се само колоните от копието (целевата база може да има по-нови колони)
      if (Object.keys(r).every((c) => same((e as any)[c], r[c]))) identical++;
      else { different++; diff.push(String(r[pk])); }
    }
    const overwrite = SEEDED.has(t) && opts.overwriteSeeded ? different : 0;
    tables[t] = { inSnapshot: rows.length, toInsert: rows.length - existing.size, identical, different, overwrite };
    if (diff.length) differentKeys[t] = diff.slice(0, 50);
  }
  // Връзки: всяко плащане / версия на договор / недостъпност сочи към съществуващ ред (в копието или в целевата база)
  for (const [t, col, ref] of FK) {
    const refs = [...new Set((snap.tables[t] || []).map((r) => r[col]).filter((v) => v != null).map(String))];
    if (!refs.length) continue;
    const inSnap = new Set((snap.tables[ref] || []).map((r) => String(r[PK[ref]])));
    const inTarget = new Set((await q(`select ${PK[ref]}::text as k from ${ref} where ${PK[ref]}::text = any($1)`, [refs])).rows.map((r) => r.k));
    const broken = refs.filter((v) => !inSnap.has(v) && !inTarget.has(v));
    if (broken.length) problems.push(`${t}.${col}: ${broken.length} препратки към липсващи редове в ${ref}.`);
  }
  return { ok: problems.length === 0, problems, snapshot: snap, tables, differentKeys };
}

export async function applyRestore(plan: Plan, q: Query, opts: { overwriteSeeded?: boolean } = {}) {
  if (!plan.ok || !plan.snapshot) throw new Error("Предварителната проверка не е успешна – възстановяването не е изпълнено.");
  const snap = plan.snapshot;
  const inserted: Partial<Record<Table, number>> = {}, overwritten: Partial<Record<Table, number>> = {};
  await q("begin");
  try {
    for (const t of RESTORE_ORDER) {
      const rows = snap.tables[t] || [];
      if (!rows.length) continue;
      const pk = PK[t];
      const cols = Object.keys(rows[0]);
      const list = cols.map((c) => `"${c}"`).join(", ");
      const r = await q(
        `insert into ${t} (${list}) select ${list} from json_populate_recordset(null::${t}, $1::json) on conflict ("${pk}") do nothing returning 1`,
        [JSON.stringify(rows)],
      );
      inserted[t] = r.rows.length;
      if (SEEDED.has(t) && opts.overwriteSeeded) {
        const keys = plan.differentKeys[t] || [];
        const changed = rows.filter((x) => keys.includes(String(x[pk])));
        if (changed.length) {
          const set = cols.filter((c) => c !== pk).map((c) => `"${c}" = excluded."${c}"`).join(", ");
          const u = await q(`insert into ${t} (${list}) select ${list} from json_populate_recordset(null::${t}, $1::json) on conflict ("${pk}") do update set ${set} returning 1`, [JSON.stringify(changed)]);
          overwritten[t] = u.rows.length;
        }
      }
    }
    // Броячите на автоматичните номера продължават след най-големия възстановен номер
    for (const t of SERIAL) await q(`select setval(pg_get_serial_sequence('${t}','id'), greatest((select coalesce(max(id),0) from ${t}), 1))`);
    await q("commit");
  } catch (e) {
    await q("rollback");
    throw e;
  }
  return { inserted, overwritten, verify: await verifyRestore(snap, q) };
}

// След възстановяването: всеки ред от копието съществува в целевата база със същите стойности
export async function verifyRestore(snap: Snapshot, q: Query) {
  const result: Partial<Record<Table, { expected: number; found: number; mismatched: number }>> = {};
  let ok = true;
  for (const t of RESTORE_ORDER) {
    const rows = snap.tables[t] || [];
    const pk = PK[t];
    const got = new Map<string, any>(
      (await q(`select ${pk}::text as k, to_json(t) as j from ${t} t where ${pk}::text = any($1)`, [rows.map((r) => String(r[pk]))])).rows.map((r) => [r.k, typeof r.j === "string" ? JSON.parse(r.j) : r.j]),
    );
    const mismatched = rows.filter((r) => { const g = got.get(String(r[pk])); return !g || !Object.keys(r).every((c) => same(g[c], r[c])); }).length;
    result[t] = { expected: rows.length, found: got.size, mismatched };
    if (mismatched || got.size !== rows.length) ok = false;
  }
  return { ok, tables: result };
}

// ===== Файлове =====
type BlobStore = {
  list(o?: { prefix?: string }): Promise<{ blobs: { key: string; etag: string }[] }>;
  getWithMetadata(key: string, o: { type: "arrayBuffer" }): Promise<{ data: ArrayBuffer; metadata: Record<string, unknown> } | null>;
  getMetadata(key: string): Promise<{ metadata: Record<string, unknown> } | null>;
  set(key: string, data: ArrayBuffer | Blob, o?: { metadata?: Record<string, unknown> }): Promise<unknown>;
};

// Най-новото копие на всеки файл: blobs/<хранилище>/<ключ>@<etag> → по copiedAt
async function latestCopies(backups: BlobStore, name: string) {
  const latest = new Map<string, { key: string; at: string }>();
  for (const b of (await backups.list({ prefix: `blobs/${name}/` })).blobs) {
    const m = await backups.getMetadata(b.key);
    const src = String(m?.metadata?.sourceKey || b.key.slice(`blobs/${name}/`.length).replace(/@[^@]*$/, ""));
    const at = String(m?.metadata?.copiedAt || "");
    const cur = latest.get(src);
    if (!cur || at > cur.at) latest.set(src, { key: b.key, at });
  }
  return latest;
}

export async function restoreFiles(backups: BlobStore, target: BlobStore, name: string, apply: boolean) {
  const latest = await latestCopies(backups, name);
  const existing = new Set((await target.list()).blobs.map((b) => b.key));
  let restored = 0, skippedExisting = 0, verified = 0, failed = 0;
  for (const [src, { key }] of latest) {
    if (existing.has(src)) { skippedExisting++; continue; }
    if (!apply) continue;
    const c = await backups.getWithMetadata(key, { type: "arrayBuffer" });
    if (!c || (await sha256(c.data)) !== c.metadata.sha256) { failed++; continue; }
    const { sourceKey, sha256: hash, copiedAt, ...metadata } = c.metadata;
    await target.set(src, c.data, { metadata });
    const back = await target.getWithMetadata(src, { type: "arrayBuffer" });
    if (back && (await sha256(back.data)) === hash) verified++;
    else failed++;
    restored++;
  }
  return { inBackup: latest.size, toRestore: latest.size - skippedExisting, restored, verified, skippedExisting, failed };
}
