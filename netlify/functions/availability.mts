import type { Config } from "@netlify/functions";
import { and, eq, gte, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings } from "../../db/schema.js";

// GET /api/availability – заети периоди по автомобили от потвърдените резервации.
// Връща само ключа на автомобила и датите (без лични данни): { passat: [["2026-06-01","2026-06-05"]], ... }
export default async () => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({ carId: bookings.carId, start: bookings.startDate, end: bookings.endDate })
    .from(bookings)
    .where(
      and(eq(bookings.status, "confirmed"), isNotNull(bookings.startDate), isNotNull(bookings.endDate), gte(bookings.endDate, today)),
    );
  const out: Record<string, [string, string][]> = {};
  for (const r of rows) if (r.carId && r.start && r.end) (out[r.carId] ||= []).push([r.start, r.end]);
  return Response.json(out, { headers: { "Cache-Control": "no-store" } });
};

export const config: Config = {
  path: "/api/availability",
  method: "GET",
};
