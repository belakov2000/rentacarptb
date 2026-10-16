import type { Config, Context } from "@netlify/functions";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings, cars } from "../../db/schema.js";
import { json, requireAdmin } from "../../server/auth.js";
import { calendar, cancelBlock, carBlocksAll, carHistory, createBlock, listCars, updateCar } from "../../server/fleet.js";

// Автомобили и календар в админ панела (само за администратор; промените – само от същия сайт). Логиката е в server/fleet.ts.
// GET  /api/admin/cars                         – автомобили: активност, текуща заетост, следваща резервация, блокирани периоди, срокове
// GET  /api/admin/cars/:id                     – автомобил, всички блокирани периоди (и отменените) и история на промените
// POST /api/admin/cars/:id { status?, inspectionDue?, insuranceDue?, serviceDue?, note? } – активност и срокове
// POST /api/admin/cars/:id/blocks { startDate, startTime, endDate, endTime, kind: service|personal|other, note?, idempotencyKey }
// POST /api/admin/cars/:id/blocks/:block { action: "cancel" }
// GET  /api/admin/calendar?from=гггг-мм-дд&days=1..31
const CAR_RE = /^[a-z0-9-]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request, context: Context) => {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean); // api admin cars :id blocks :block
  if (parts[2] === "calendar") {
    const from = url.searchParams.get("from") || "";
    const days = Number(url.searchParams.get("days") || 14);
    if (!DATE_RE.test(from) || !Number.isInteger(days) || days < 1 || days > 31) return json({ error: "period" }, 400);
    return json(await calendar(from, days));
  }
  const id = context.params?.id || parts[3] || "";
  if (!id) return req.method === "GET" ? json({ cars: await listCars() }) : json({ error: "method" }, 405);
  if (!CAR_RE.test(id)) return json({ error: "not_found" }, 404);
  if (req.method === "GET") {
    const [car] = await db.select().from(cars).where(eq(cars.id, id));
    if (!car) return json({ error: "not_found" }, 404);
    return json({ car, blocks: await carBlocksAll(id), history: await carHistory(id) });
  }
  const body = await req.json().catch(() => null);
  if (parts[4] === "blocks") {
    if (parts[5]) {
      const blockId = Number(parts[5]);
      if (!Number.isInteger(blockId) || body?.action !== "cancel") return json({ error: "invalid" }, 400);
      const r = await cancelBlock(id, blockId, admin.email);
      return r.ok ? json({ ok: true, block: r.block }) : json({ error: r.error }, 409);
    }
    const r = await createBlock(id, body, admin.email);
    if (!r.ok) {
      // Чакащи заявки в същия период не се засягат, но се показват
      return json({ error: r.error, ...("conflict" in r ? { conflict: r.conflict } : {}) }, r.error === "not_found" ? 404 : ["booking_conflict", "block_overlap", "key"].includes(r.error) ? 409 : 400);
    }
    const pending = await db.select({ id: bookings.id, pickup: bookings.pickup, dropoff: bookings.dropoff }).from(bookings)
      .where(and(eq(bookings.carId, id), inArray(bookings.status, ["pending"]), lte(bookings.startDate, r.block.endDate), gte(bookings.endDate, r.block.startDate)));
    return json({ ok: true, duplicate: r.duplicate, block: r.block, pendingOverlap: pending }, r.duplicate ? 200 : 201);
  }
  const r = await updateCar(id, body, admin.email);
  if (!r.ok) return json({ error: r.error }, r.error === "not_found" ? 404 : 400);
  // Деактивиране: съществуващите резервации остават; показва се колко са
  const upcoming = await db.select({ id: bookings.id, status: bookings.status }).from(bookings)
    .where(and(eq(bookings.carId, id), inArray(bookings.status, ["confirmed", "pending"]), gte(bookings.endDate, new Date().toISOString().slice(0, 10))));
  return json({ ok: true, car: r.car, upcoming: { confirmed: upcoming.filter((b) => b.status === "confirmed").length, pending: upcoming.filter((b) => b.status === "pending").length } });
};

export const config: Config = {
  path: ["/api/admin/cars", "/api/admin/cars/:id", "/api/admin/cars/:id/blocks", "/api/admin/cars/:id/blocks/:block", "/api/admin/calendar"],
  method: ["GET", "POST"],
};
