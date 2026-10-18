import { and, inArray, eq, gte, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookings, carBlocks } from "../db/schema.js";
import { addDays, endTimeOf, minutes, overlaps, startTimeOf } from "../db/slots.js";
import { sofiaLocal } from "../db/hours.js";

// Заетост на автомобил – обща за новите заявки от сайта и за потвърждаването (от имейла и от админ панела).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Q = Pick<typeof db, "select">;

// Транзакционно заключване (освобождава се автоматично в края на транзакцията). Ключът е текст, затова съществува
// за всеки автомобил – и за такъв, който още няма ред в таблицата cars.
export const lock = (q: Tx, key: string) => q.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

// Период, през който потвърдена резервация заема автомобила (местно време), без буфера:
//  • от договореното получаване;
//  • до реалното връщане (returnedAt), ако наемът е приключен – по-ранно връщане освобождава автомобила по-рано
//    (след буфера), а договорените дати остават непроменени в резервацията;
//  • наем с отбелязано предаване и без отбелязано връщане след договорения край (просрочен) – до текущия момент,
//    защото автомобилът физически не е върнат;
//  • иначе – до договореното връщане.
export type Span = { carId: string; startDate: string | null; endDate: string | null; startTime: string; endTime: string; pickup: string; dropoff: string; handedOverAt: Date | null; returnedAt: Date | null };
export function busySpan(r: Span, now = new Date()): { from: [string, string]; to: [string, string]; overdue: boolean } | null {
  if (!r.startDate || !r.endDate) return null;
  const from: [string, string] = [r.startDate, startTimeOf(r.startTime, r.pickup)];
  let to: [string, string] = [r.endDate, endTimeOf(r.endTime, r.dropoff)];
  let overdue = false;
  if (r.returnedAt) to = sofiaLocal(r.returnedAt);
  else if (r.handedOverAt) {
    const n = sofiaLocal(now);
    if (minutes(...n) > minutes(...to)) (to = n), (overdue = true);
  }
  if (minutes(...to) < minutes(...from)) to = from;
  return { from, to, overdue };
}
export const SPAN_COLS = {
  carId: bookings.carId, startDate: bookings.startDate, endDate: bookings.endDate, startTime: bookings.startTime, endTime: bookings.endTime,
  pickup: bookings.pickup, dropoff: bookings.dropoff, handedOverAt: bookings.handedOverAt, returnedAt: bookings.returnedAt,
};
// Потвърдените резервации, които може да заемат автомобил в дните [from, to]: по дати или незавършен наем с предаване
// Двуетапни заявки след първото одобрение (очакват / проверяват се документите) също заемат автомобила
export const confirmedIn = (from: string, to: string) =>
  and(
    or(eq(bookings.status, "confirmed"), and(eq(bookings.status, "pending"), inArray(bookings.stage, ["docs", "review"]))),
    isNotNull(bookings.startDate),
    isNotNull(bookings.endDate),
    lte(bookings.startDate, to),
    or(gte(bookings.endDate, from), and(isNotNull(bookings.handedOverAt), isNull(bookings.returnedAt))),
  );
export const activeBlocksIn = (from: string, to: string) => and(isNull(carBlocks.cancelledAt), lte(carBlocks.startDate, to), gte(carBlocks.endDate, from));

export type Conflict = { kind: "booking"; id: string; name: string; pickup: string; dropoff: string } | { kind: "block"; id: number; startDate: string; endDate: string; startTime: string; endTime: string; reason: string; blockKind: string };

// Потвърдена резервация или активен блокиран период (ремонт, обслужване) за същия автомобил, които се застъпват с периода
// [start startTime, end endTime]. Между тях трябва да има поне BUFFER_MIN минути (напр. върнат в 12:00 → свободен от 13:00).
// Отменените блокирани периоди (cancelled_at), чакащите, отказаните и отменените заявки не заемат автомобила.
// Резервацията заема автомобила за busySpan (реално връщане / просрочен наем – виж по-горе).
export async function findConflict(carId: string, start: string, end: string, startTime = "", endTime = "", exceptId = "", q: Q = db): Promise<Conflict | null> {
  if (!carId || !start || !end) return null;
  const a = minutes(start, startTimeOf(startTime));
  const z = minutes(end, endTimeOf(endTime));
  // По дати търсим с един ден резерва – буферът може да мине през полунощ
  const from = addDays(start, -1), to = addDays(end, 1);
  const rows = await q
    .select({ id: bookings.id, name: bookings.name, ...SPAN_COLS })
    .from(bookings)
    .where(and(eq(bookings.carId, carId), confirmedIn(from, to), ...(exceptId ? [ne(bookings.id, exceptId)] : [])));
  const c = rows.find((r) => {
    const s = busySpan(r);
    return !!s && overlaps(a, z, minutes(...s.from), minutes(...s.to));
  });
  if (c) return { kind: "booking", id: c.id, name: c.name, pickup: c.pickup, dropoff: c.dropoff };
  const blocks = await q.select().from(carBlocks).where(and(eq(carBlocks.carId, carId), activeBlocksIn(from, to)));
  const bl = blocks.find((x) => overlaps(a, z, minutes(x.startDate, startTimeOf(x.startTime)), minutes(x.endDate, endTimeOf(x.endTime))));
  return bl ? { kind: "block", id: bl.id, startDate: bl.startDate, endDate: bl.endDate, startTime: bl.startTime, endTime: bl.endTime, reason: bl.reason, blockKind: bl.kind } : null;
}
