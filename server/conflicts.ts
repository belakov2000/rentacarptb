import { and, eq, gte, isNull, lte, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookings, carBlocks } from "../db/schema.js";
import { addDays, endTimeOf, minutes, overlaps, startTimeOf } from "../db/slots.js";

// Заетост на автомобил – обща за новите заявки от сайта и за потвърждаването (от имейла и от админ панела).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Q = Pick<typeof db, "select">;

// Транзакционно заключване (освобождава се автоматично в края на транзакцията). Ключът е текст, затова съществува
// за всеки автомобил – и за такъв, който още няма ред в таблицата cars.
export const lock = (q: Tx, key: string) => q.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

export type Conflict = { kind: "booking"; id: string; name: string; pickup: string; dropoff: string } | { kind: "block"; id: number; startDate: string; endDate: string; reason: string };

// Потвърдена резервация или активен блокиран период (ремонт, обслужване) за същия автомобил, които се застъпват с периода
// [start startTime, end endTime]. Между тях трябва да има поне BUFFER_MIN минути (напр. върнат в 12:00 → свободен от 13:00).
// Отменените блокирани периоди (cancelled_at) и неподвърдените заявки не заемат автомобила.
export async function findConflict(carId: string, start: string, end: string, startTime = "", endTime = "", exceptId = "", q: Q = db): Promise<Conflict | null> {
  if (!carId || !start || !end) return null;
  const a = minutes(start, startTimeOf(startTime));
  const z = minutes(end, endTimeOf(endTime));
  // По дати търсим с един ден резерва – буферът може да мине през полунощ
  const from = addDays(start, -1), to = addDays(end, 1);
  const rows = await q
    .select({
      id: bookings.id, name: bookings.name, pickup: bookings.pickup, dropoff: bookings.dropoff,
      startDate: bookings.startDate, endDate: bookings.endDate, startTime: bookings.startTime, endTime: bookings.endTime,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.carId, carId),
        eq(bookings.status, "confirmed"),
        lte(bookings.startDate, to),
        gte(bookings.endDate, from),
        ...(exceptId ? [ne(bookings.id, exceptId)] : []),
      ),
    );
  const c = rows.find(
    (r) => r.startDate && r.endDate && overlaps(a, z, minutes(r.startDate, startTimeOf(r.startTime, r.pickup)), minutes(r.endDate, endTimeOf(r.endTime, r.dropoff))),
  );
  if (c) return { kind: "booking", id: c.id, name: c.name, pickup: c.pickup, dropoff: c.dropoff };
  const blocks = await q
    .select()
    .from(carBlocks)
    .where(and(eq(carBlocks.carId, carId), isNull(carBlocks.cancelledAt), lte(carBlocks.startDate, to), gte(carBlocks.endDate, from)));
  const bl = blocks.find((x) => overlaps(a, z, minutes(x.startDate, startTimeOf(x.startTime)), minutes(x.endDate, endTimeOf(x.endTime))));
  return bl ? { kind: "block", id: bl.id, startDate: bl.startDate, endDate: bl.endDate, reason: bl.reason } : null;
}
