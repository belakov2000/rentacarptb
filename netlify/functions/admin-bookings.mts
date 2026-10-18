import type { Config, Context } from "@netlify/functions";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookingEvents, bookingExtensions, bookings, contractVersions, customers, emailLog, payments } from "../../db/schema.js";
import { parseAmountCents } from "../../db/money.js";
import { json, requireAdmin } from "../../server/auth.js";
import {
  act, allowed, confirmBlock, decide, extendRental, pickupAt, quoteExtension, readContractData, REASONS, returnRental, type Action, inviteDocs } from "../../server/booking-actions.js";
import { findConflict } from "../../server/conflicts.js";
import { finance } from "../../server/payments.js";
import { LIST, PAGE, searchWhere, SORTS, sortRows, STATUS_FILTER, viewRows, VIEWS, type ListRow, type View } from "../../server/admin-lists.js";

// Резервации в админ панела (само за вписан администратор с роля "admin"; промените – само от същия сайт).
// GET  /api/admin/bookings?status=confirmed|pending|closed|all&view=…&q=…&sort=created_desc|created_asc|pickup_desc|pickup_asc&page=1
//      – списък (по 50 на страница); view – изгледите от началното табло (server/admin-lists.ts); q – име, имейл, телефон,
//        автомобил или номер; по подразбиране най-новите заявки първо (по createdAt – момента на създаване на заявката)
// GET  /api/admin/bookings/:id – подробности, финансово състояние, възможни действия, удължавания, договори, история и писма
// POST /api/admin/bookings/:id { action: cancel | no_show | handover, reason?, note?, notify? }
//      – същите действия като страницата от имейла (server/booking-actions.ts); извършителят е имейлът на администратора
// POST /api/admin/bookings/:id { action: confirm | reject, note?, notify? } – решение по чакаща заявка (общата логика decide())
// POST /api/admin/bookings/:id { action: return, returnedAt?, note? } – приключване на наема (реално връщане)
// POST /api/admin/bookings/:id { action: extend_quote, newEndDate, newEndTime } – само изчисление и проверка, без промяна
// POST /api/admin/bookings/:id { action: extend, newEndDate, newEndTime, amount?, confirmCents, notify?, note?, idempotencyKey }
const ID_RE = /^[a-f0-9]{32}$/;
const KEY_RE = /^[\w-]{8,100}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function detail(id: string) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id));
  if (!b) return null;
  const events = await db.select({ at: bookingEvents.at, actor: bookingEvents.actor, action: bookingEvents.action, details: bookingEvents.details })
    .from(bookingEvents).where(eq(bookingEvents.bookingId, id)).orderBy(asc(bookingEvents.at));
  const emails = await db.select({ at: emailLog.at, kind: emailLog.kind, status: emailLog.status, recipient: emailLog.recipient })
    .from(emailLog).where(eq(emailLog.bookingId, id)).orderBy(asc(emailLog.at));
  const pays = await db.select().from(payments).where(eq(payments.bookingId, id));
  const extensions = await db.select().from(bookingExtensions).where(eq(bookingExtensions.bookingId, id)).orderBy(asc(bookingExtensions.id));
  const versions = await db.select({ version: contractVersions.version, fileName: contractVersions.fileName, reason: contractVersions.reason, createdBy: contractVersions.createdBy, createdAt: contractVersions.createdAt })
    .from(contractVersions).where(eq(contractVersions.bookingId, id)).orderBy(asc(contractVersions.version));
  const [customer] = b.customerId ? await db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.id, b.customerId)) : [];
  // Без токените за достъп – те остават само в имейла до фирмата; без ключовете на снимките (отварят се от „Договори и документи“)
  const { viewToken: _v, adminToken: _a, documents, ...safe } = b;
  // Чакаща заявка: може ли да бъде потвърдена (дати, час, заетост към момента – окончателната проверка е при действието)
  const block = b.status === "pending" ? confirmBlock(b) : "state";
  const conflict = b.status === "pending" && !block ? await findConflict(b.carId, b.startDate!, b.endDate!, b.startTime, b.endTime, b.id) : null;
  // Двуетапна заявка в етап „docs“: окончателното потвърждение е възможно едва след подаването на документите
  const docsWait = b.status === "pending" && b.stage === "docs";
  const decision = { confirm: !block && !conflict && !docsWait, reject: b.status === "pending", block: block === "state" ? "" : block || (conflict ? "busy" : docsWait ? "docs_pending" : ""), conflict, invite: docsWait };
  return {
    booking: { ...safe, pickupAt: pickupAt(b), documentsCount: Array.isArray(documents) ? documents.length : null },
    can: { ...allowed(b), ...decision }, finance: finance(b, pays), extensions, versions, customer: customer || null, events, emails,
  };
}

export default async (req: Request, context: Context) => {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const id = context.params?.id || new URL(req.url).pathname.split("/")[4] || "";
  if (!id) {
    if (req.method !== "GET") return json({ error: "method" }, 405);
    const p = new URL(req.url).searchParams;
    const st = p.get("status") || "confirmed";
    const view = (VIEWS as readonly string[]).includes(p.get("view") || "") ? (p.get("view") as View) : null;
    const sortQ = p.get("sort") || "";
    const sort: keyof typeof SORTS = Object.hasOwn(SORTS, sortQ) ? (sortQ as keyof typeof SORTS) : "created_desc";
    const page = Math.max(1, Math.min(1000, Number(p.get("page")) || 1));
    const search = searchWhere(p.get("q") || "");
    const filters = [...(STATUS_FILTER[st] && !view ? [inArray(bookings.status, STATUS_FILTER[st])] : []), ...(search ? [search] : [])];
    if (view) {
      const all = sortRows(await viewRows(view, new Date(), filters), sort);
      return json({ rows: all.slice((page - 1) * PAGE, page * PAGE), total: all.length, page, pageSize: PAGE, sort, view });
    }
    const where = filters.length ? and(...filters) : undefined;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(where);
    const rows = (await db.select(LIST).from(bookings).where(where).orderBy(...SORTS[sort]).limit(PAGE).offset((page - 1) * PAGE)) as ListRow[];
    return json({ rows, total: n, page, pageSize: PAGE, sort, view: null });
  }
  if (!ID_RE.test(id)) return json({ error: "not_found" }, 404);
  if (req.method === "GET") {
    const d = await detail(id);
    return d ? json(d) : json({ error: "not_found" }, 404);
  }
  const body = await req.json().catch(() => null);
  if (body?.action === "confirm" || body?.action === "reject") {
    const r = await decide(id, body.action, { actor: admin.email, internalNote: typeof body?.note === "string" ? body.note : "", notify: body?.notify === true });
    if (!r.ok) return json({ error: r.error, ...(r.booking ? await detail(id) : {}) }, r.error === "not_found" ? 404 : 409);
    return json({ ok: true, email: r.email, ...(await detail(id)) });
  }
  // Покана за документите (ако при одобрението не е изпратена или клиентът я иска повторно)
  if (body?.action === "invite") {
    const r = await inviteDocs(id, admin.email);
    if (!r.ok) return json({ error: r.error, ...(await detail(id)) || {} }, r.error === "not_found" ? 404 : 409);
    return json({ ok: true, email: r.email, ...(await detail(id)) });
  }
  if (body?.action === "return") {
    let at: Date | null = null;
    if (body.returnedAt != null && body.returnedAt !== "") {
      const t = typeof body.returnedAt === "string" ? Date.parse(body.returnedAt) : NaN;
      if (!Number.isFinite(t)) return json({ error: "returned_at" }, 400);
      at = new Date(t);
    }
    const r = await returnRental(id, { actor: admin.email, at, note: str(body.note, 1000) });
    if (!r.ok) return json({ error: r.error, ...("booking" in r && r.booking ? await detail(id) : {}) }, r.error === "not_found" ? 404 : r.error === "returned_at" ? 400 : 409);
    return json({ ok: true, ...(await detail(id)) });
  }
  if (body?.action === "extend_quote" || body?.action === "extend") {
    const newEndDate = str(body.newEndDate, 10), newEndTime = str(body.newEndTime, 5);
    if (body.action === "extend_quote") {
      const [b] = await db.select().from(bookings).where(eq(bookings.id, id));
      if (!b) return json({ error: "not_found" }, 404);
      if (!allowed(b).extend) return json({ error: "state" }, 409);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(newEndDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(newEndTime)) return json({ error: "end" }, 400);
      const quote = quoteExtension(b, await readContractData(id), newEndDate, newEndTime);
      const conflict = await findConflict(b.carId, b.startDate!, newEndDate, b.startTime, newEndTime, b.id);
      return json({ quote, conflict });
    }
    const idempotencyKey = str(body.idempotencyKey, 100);
    if (!KEY_RE.test(idempotencyKey)) return json({ error: "key" }, 400);
    const manual = body.amount == null || body.amount === "" ? null : parseAmountCents(body.amount);
    if (body.amount != null && body.amount !== "" && manual == null) return json({ error: "amount" }, 400);
    const confirmCents = Number.isInteger(body.confirmCents) ? body.confirmCents : null;
    const r = await extendRental(id, { actor: admin.email, newEndDate, newEndTime, manualAmountCents: manual, confirmCents, notify: body.notify === true, note: str(body.note, 1000), idempotencyKey });
    if (!r.ok) {
      const extra = "conflict" in r ? { conflict: r.conflict } : "quote" in r ? { quote: r.quote } : {};
      return json({ error: r.error, ...extra }, r.error === "not_found" ? 404 : ["end", "hours", "amount"].includes(r.error) ? 400 : 409);
    }
    return json({ ok: true, duplicate: r.duplicate, email: "email" in r ? r.email : "none", contractVersion: "contractVersion" in r ? r.contractVersion : null, contract: "contract" in r ? r.contract : null, ...(await detail(id)) });
  }
  const action = body?.action as Action;
  if (!["cancel", "no_show", "handover"].includes(action)) return json({ error: "action" }, 400);
  if (action === "cancel" && !(REASONS as readonly string[]).includes(body?.reason)) return json({ error: "reason" }, 400);
  // Предаване: по избор действителният момент (ISO) – за въвеждане след факта; не в бъдещето
  let at: Date | null = null;
  if (action === "handover" && body?.handedOverAt != null && body.handedOverAt !== "") {
    const t = typeof body.handedOverAt === "string" ? Date.parse(body.handedOverAt) : NaN;
    if (!Number.isFinite(t)) return json({ error: "handed_over_at" }, 400);
    at = new Date(t);
  }
  const r = await act(id, action, { actor: admin.email, reason: body?.reason, note: typeof body?.note === "string" ? body.note : "", notify: body?.notify === true, at });
  if (!r.ok) return json({ error: r.error, ...(r.booking ? await detail(id) : {}) }, r.error === "not_found" ? 404 : r.error === "handed_over_at" ? 400 : 409);
  return json({ ok: true, email: r.email, ...(await detail(id)) });
};

export const config: Config = {
  path: ["/api/admin/bookings", "/api/admin/bookings/:id"],
  method: ["GET", "POST"],
};
