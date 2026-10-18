import type { Config, Context } from "@netlify/functions";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings, contractVersions } from "../../db/schema.js";
import { audit, json, requireAdmin } from "../../server/auth.js";
import { contracts, contractDataKey, saveContract } from "../../server/contracts.js";
import type { ContractData } from "../../contract/index.js";
import { store } from "../../server/stores.js";
import { LIST, searchWhere } from "../../server/admin-lists.js";

// Договори и документи в админ панела. Файловете се връщат само на вписан администратор (проверка при всяка заявка),
// с Cache-Control: no-store – без публичен каталог и без постоянни линкове. Липсващ файл → 404 { error: "missing" }.
// Подписване (contract_versions.sign_status): системата не съхранява доказателство за подпис. Версиите отпреди колоната са
// „Няма записани данни за подписване“ (това не значи, че не са подписани); новите – „Генерирана – очаква подписване“.
// GET /api/admin/contracts?q=&page=                       – резервации с договори (търсене по номер, клиент, автомобил)
// GET /api/admin/contracts/:booking                       – версии (коя е актуална), наличност на файловете, приложени документи
// GET /api/admin/contracts/:booking/file?v=<N>|current    – изтегляне на версия (.docx)
// GET /api/admin/contracts/:booking/document/:doc         – снимка на документ, приложена към тази резервация (.jpg)
const ID_RE = /^[a-f0-9]{32}$/;
const DOC_RE = /^[a-f0-9]{64}$/;
const PAGE = 50;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const FILE_HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const safeName = (n: string) => n.replace(/[^\w.-]/g, "_");
type Doc = { label: string; id: string };

async function detail(id: string) {
  const [b] = await db.select({ ...LIST, documents: bookings.documents }).from(bookings).where(eq(bookings.id, id));
  if (!b) return null;
  const versions = await db.select().from(contractVersions).where(eq(contractVersions.bookingId, id)).orderBy(asc(contractVersions.version));
  const cur = await contracts().getMetadata(id).catch(() => null);
  const curVersion = cur ? Number(cur.metadata?.version) || null : null;
  const out = [];
  for (const v of versions) {
    const m = await contracts().getMetadata(v.blobKey).catch(() => null);
    out.push({ version: v.version, fileName: v.fileName, reason: v.reason, createdBy: v.createdBy, createdAt: v.createdAt, signStatus: v.signStatus, available: !!m, current: curVersion === v.version });
  }
  const docs: (Doc & { available: boolean })[] = [];
  for (const d of (Array.isArray(b.documents) ? b.documents : []) as Doc[]) docs.push({ label: d.label, id: d.id, available: !!(await store("documents").getMetadata(d.id).catch(() => null)) });
  const { documents: _d, ...booking } = b;
  return {
    booking, versions: out,
    // Текущ файл без версия: договор отпреди историята на версиите
    current: cur ? { version: curVersion, name: String(cur.metadata?.name || "Dogovor-naem.docx"), legacy: !versions.length } : null,
    documents: Array.isArray(b.documents) ? docs : null,
  };
}

export default async (req: Request, context: Context) => {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean); // api admin contracts :booking file|document :doc
  const id = parts[3] || "";
  if (req.method === "POST") {
    if (!ID_RE.test(id) || parts.length !== 4) return json({ error: "not_found" }, 404);
    const body = await req.json().catch(() => null);
    if (body?.action !== "regenerate") return json({ error: "invalid" }, 400);
    const [booking] = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.id, id));
    if (!booking) return json({ error: "not_found" }, 404);
    const data = await contracts().get(contractDataKey(id), { type: "json" }).catch(() => null) as ContractData | null;
    if (!data || typeof data.name !== "string" || !data.carId) return json({ error: "missing_data" }, 409);
    const result = await saveContract(id, data, admin.email, "Обновяване по актуалния шаблон");
    return json({ ok: true, version: result.version });
  }
  if (!id) {
    const q = (url.searchParams.get("q") || "").slice(0, 100);
    const page = Math.max(1, Math.min(1000, Number(url.searchParams.get("page")) || 1));
    const s = searchWhere(q);
    const versions = sql<number>`(select count(*)::int from contract_versions v where v.booking_id = "bookings"."id")`;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(s);
    const rows = await db.select({ ...LIST, versions, latest: sql<number | null>`(select max(v.version) from contract_versions v where v.booking_id = "bookings"."id")`, documentsCount: sql<number | null>`jsonb_array_length(${bookings.documents})` })
      .from(bookings).where(s).orderBy(desc(bookings.createdAt)).limit(PAGE).offset((page - 1) * PAGE);
    return json({ rows, total: n, page, pageSize: PAGE });
  }
  if (!ID_RE.test(id)) return json({ error: "not_found" }, 404);
  if (parts[4] === "file") {
    const v = url.searchParams.get("v") || "current";
    let key = id, name = "";
    if (v !== "current") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) return json({ error: "not_found" }, 404);
      const [row] = await db.select().from(contractVersions).where(sql`${contractVersions.bookingId} = ${id} and ${contractVersions.version} = ${n}`);
      if (!row) return json({ error: "not_found" }, 404);
      key = row.blobKey;
      name = row.fileName.replace(/\.docx$/, "") + `-v${n}.docx`;
    }
    const f = await contracts().getWithMetadata(key, { type: "arrayBuffer" }).catch(() => null);
    if (!f) return json({ error: "missing" }, 404);
    return new Response(f.data, { headers: { ...FILE_HEADERS, "Content-Type": DOCX, "Content-Disposition": `attachment; filename="${safeName(name || String(f.metadata?.name || "Dogovor-naem.docx"))}"` } });
  }
  if (parts[4] === "document") {
    const doc = parts[5] || "";
    if (!DOC_RE.test(doc)) return json({ error: "not_found" }, 404);
    const [b] = await db.select({ documents: bookings.documents }).from(bookings).where(eq(bookings.id, id));
    // Само снимка, записана към тази резервация – ключ от друга резервация не се отваря оттук
    const d = ((Array.isArray(b?.documents) ? b!.documents : []) as Doc[]).find((x) => x.id === doc);
    if (!d) return json({ error: "not_found" }, 404);
    const data = await store("documents").get(doc, { type: "arrayBuffer" }).catch(() => null);
    if (!data) return json({ error: "missing" }, 404);
    await audit(admin.email, "document.view", { label: d.label }, id).catch(() => null);
    return new Response(data, { headers: { ...FILE_HEADERS, "Content-Type": "image/jpeg", "Content-Disposition": `inline; filename="dokument.jpg"` } });
  }
  const d = await detail(id);
  return d ? json(d) : json({ error: "not_found" }, 404);
};

export const config: Config = {
  path: ["/api/admin/contracts", "/api/admin/contracts/:booking", "/api/admin/contracts/:booking/file", "/api/admin/contracts/:booking/document/:doc"],
  method: ["GET", "POST"],
};
