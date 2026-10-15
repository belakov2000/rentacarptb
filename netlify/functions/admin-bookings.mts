import type { Config, Context } from "@netlify/functions";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookingEvents, bookings, emailLog } from "../../db/schema.js";
import { json, requireAdmin } from "../../server/auth.js";
import { act, allowed, pickupAt, REASONS, type Action } from "../../server/booking-actions.js";

// Резервации в админ панела (само за вписан администратор с роля "admin"; промените – само от същия сайт).
// GET  /api/admin/bookings?status=confirmed|pending|closed|all – списък (последните 300 по дата на получаване)
// GET  /api/admin/bookings/:id – подробности, възможни действия, история и писма
// POST /api/admin/bookings/:id { action: cancel | no_show | handover, reason?, note?, notify? }
//      – същите действия като страницата от имейла (server/booking-actions.ts); извършителят е имейлът на администратора
const ID_RE = /^[a-f0-9]{32}$/;
const LIST = {
  id: bookings.id, status: bookings.status, car: bookings.car, carId: bookings.carId, name: bookings.name, phone: bookings.phone,
  pickup: bookings.pickup, dropoff: bookings.dropoff, startDate: bookings.startDate, startTime: bookings.startTime, endDate: bookings.endDate, endTime: bookings.endTime,
  total: bookings.total, createdAt: bookings.createdAt, handedOverAt: bookings.handedOverAt, closedAt: bookings.closedAt, closeReason: bookings.closeReason,
};
const STATUS_FILTER: Record<string, string[]> = { confirmed: ["confirmed"], pending: ["pending"], closed: ["cancelled", "no_show", "rejected"] };

async function detail(id: string) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id));
  if (!b) return null;
  const events = await db.select({ at: bookingEvents.at, actor: bookingEvents.actor, action: bookingEvents.action, details: bookingEvents.details })
    .from(bookingEvents).where(eq(bookingEvents.bookingId, id)).orderBy(asc(bookingEvents.at));
  const emails = await db.select({ at: emailLog.at, kind: emailLog.kind, status: emailLog.status, recipient: emailLog.recipient })
    .from(emailLog).where(eq(emailLog.bookingId, id)).orderBy(asc(emailLog.at));
  // Без токените за достъп – те остават само в имейла до фирмата
  const { viewToken: _v, adminToken: _a, ...safe } = b;
  return { booking: { ...safe, pickupAt: pickupAt(b) }, can: allowed(b), events, emails };
}

export default async (req: Request, context: Context) => {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const id = context.params?.id || new URL(req.url).pathname.split("/")[4] || "";
  if (!id) {
    if (req.method !== "GET") return json({ error: "method" }, 405);
    const st = new URL(req.url).searchParams.get("status") || "confirmed";
    const q = db.select(LIST).from(bookings);
    const rows = await (STATUS_FILTER[st] ? q.where(inArray(bookings.status, STATUS_FILTER[st])) : q).orderBy(desc(bookings.startDate), desc(bookings.createdAt)).limit(300);
    return json({ rows });
  }
  if (!ID_RE.test(id)) return json({ error: "not_found" }, 404);
  if (req.method === "GET") {
    const d = await detail(id);
    return d ? json(d) : json({ error: "not_found" }, 404);
  }
  const body = await req.json().catch(() => null);
  const action = body?.action as Action;
  if (!["cancel", "no_show", "handover"].includes(action)) return json({ error: "action" }, 400);
  if (action === "cancel" && !(REASONS as readonly string[]).includes(body?.reason)) return json({ error: "reason" }, 400);
  const r = await act(id, action, { actor: admin.email, reason: body?.reason, note: typeof body?.note === "string" ? body.note : "", notify: body?.notify === true });
  if (!r.ok) return json({ error: r.error, ...(r.booking ? await detail(id) : {}) }, r.error === "not_found" ? 404 : 409);
  return json({ ok: true, email: r.email, ...(await detail(id)) });
};

export const config: Config = {
  path: ["/api/admin/bookings", "/api/admin/bookings/:id"],
  method: ["GET", "POST"],
};
