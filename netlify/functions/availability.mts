import type { Config } from "@netlify/functions";
import { and, eq, gte, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings } from "../../db/schema.js";
import { addDays, BUFFER_MIN, endTimeOf, startTimeOf } from "../../db/slots.js";
import { isProduction } from "../../server/stores.js";

// GET /api/availability – заети периоди по автомобили от потвърдените резервации.
// Връща само ключа на автомобила, датите и часовете (без лични данни):
// { buffer: 60, cars: { passat: [["2026-06-01","2026-06-05","12:00","12:00"]], ... } }
// buffer – минути между връщане и следващо получаване на същия автомобил.
// promoDemo – true извън продукция (по средата от Netlify, не по адреса): сайтът показва демонстрационния badge „−20%“.
export default async () => {
  const from = addDays(new Date().toISOString().slice(0, 10), -1);
  const rows = await db
    .select({
      carId: bookings.carId,
      start: bookings.startDate,
      end: bookings.endDate,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      pickup: bookings.pickup,
      dropoff: bookings.dropoff,
    })
    .from(bookings)
    .where(
      and(eq(bookings.status, "confirmed"), isNotNull(bookings.startDate), isNotNull(bookings.endDate), gte(bookings.endDate, from)),
    );
  const cars: Record<string, [string, string, string, string][]> = {};
  for (const r of rows)
    if (r.carId && r.start && r.end)
      (cars[r.carId] ||= []).push([r.start, r.end, startTimeOf(r.startTime, r.pickup), endTimeOf(r.endTime, r.dropoff)]);
  return Response.json({ buffer: BUFFER_MIN, cars, promoDemo: !isProduction() }, { headers: { "Cache-Control": "no-store" } });
};

export const config: Config = {
  path: "/api/availability",
  method: "GET",
};
