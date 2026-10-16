import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { bookings, carBlocks, cars } from "../../db/schema.js";
import { addDays, BUFFER_MIN, endTimeOf, startTimeOf } from "../../db/slots.js";
import { sofiaToday } from "../../db/hours.js";
import { activeBlocksIn, busySpan, confirmedIn, SPAN_COLS } from "../../server/conflicts.js";

// GET /api/availability – заети периоди по автомобили (същите правила като сървърната проверка server/conflicts.ts):
//  • потвърдени резервации – от получаването до договореното връщане, до реалното връщане при приключен наем
//    или до момента при просрочен наем с предаване и без връщане;
//  • активни блокирани периоди (сервиз, лична употреба и др.) от админ панела;
//  • неактивен автомобил – зает за следващите 2 години (нови заявки не се приемат).
// Връща само ключа на автомобила, датите и часовете (без лични данни и без причини):
// { buffer: 60, cars: { passat: [["2026-06-01","2026-06-05","12:00","12:00"]], ... } }
// buffer – минути между връщане и следващо получаване на същия автомобил (прилага се и около блокираните периоди).
export const INACTIVE_DAYS = 730;
export default async () => {
  const today = sofiaToday();
  const from = addDays(today, -1), to = addDays(today, INACTIVE_DAYS);
  const out: Record<string, [string, string, string, string][]> = {};
  const add = (carId: string, p: [string, string, string, string]) => carId && (out[carId] ||= []).push(p);
  const rows = await db.select(SPAN_COLS).from(bookings).where(confirmedIn(from, to));
  for (const r of rows) {
    const s = busySpan(r);
    if (s) add(r.carId, [s.from[0], s.to[0], s.from[1], s.to[1]]);
  }
  const blocks = await db.select().from(carBlocks).where(activeBlocksIn(from, to));
  for (const b of blocks) add(b.carId, [b.startDate, b.endDate, startTimeOf(b.startTime), endTimeOf(b.endTime)]);
  for (const c of await db.select({ id: cars.id, status: cars.status }).from(cars))
    if (c.status !== "active") add(c.id, [today, to, "00:00", "23:59"]);
  return Response.json({ buffer: BUFFER_MIN, cars: out }, { headers: { "Cache-Control": "no-store" } });
};

export const config: Config = {
  path: "/api/availability",
  method: "GET",
};
