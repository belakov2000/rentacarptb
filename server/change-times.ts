import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookings, bookingEvents } from "../db/schema.js";
import { withinHours } from "../db/hours.js";
import { lock, findConflict } from "./conflicts.js";
import { rentalDays, sofiaNow, readContractData } from "./booking-actions.js";
import { saveContract } from "./contracts.js";

// Corrections before handover, on the existing dates and with the same billed
// days. A change affecting the price requires a new quote, never a silent total.
export async function changeTimes(id: string, startTime: string, endTime: string, expectedUpdatedAt: string, actor: string) {
  if (![startTime, endTime].every(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return { ok: false, error: "time" };
  const out = await db.transaction(async tx => {
    const [cur] = await tx.select().from(bookings).where(eq(bookings.id, id));
    if (!cur) return { ok: false as const, error: "not_found" };
    await lock(tx, "car:" + cur.carId);
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
    if (!["pending", "confirmed"].includes(b.status) || b.handedOverAt || b.returnedAt || !b.startDate || !b.endDate) return { ok: false as const, error: "state" };
    if ((b.updatedAt?.toISOString() || "") !== expectedUpdatedAt) return { ok: false as const, error: "changed" };
    if (`${b.startDate} ${startTime}` <= sofiaNow() || `${b.endDate} ${endTime}` <= `${b.startDate} ${startTime}`) return { ok: false as const, error: "time" };
    if (!withinHours(b.startDate, startTime) || !withinHours(b.endDate, endTime)) return { ok: false as const, error: "hours" };
    if (rentalDays(b.startDate, startTime, b.endDate, endTime) !== rentalDays(b.startDate, b.startTime, b.endDate, b.endTime)) return { ok: false as const, error: "reprice" };
    const conflict = await findConflict(b.carId, b.startDate, b.endDate, startTime, endTime, id, tx);
    if (conflict) return { ok: false as const, error: "busy", conflict };
    const label = (date: string, time: string, previous: string) => `${date.split("-").reverse().join(".")} ${time}` + previous.replace(/^.*?\d{2}:\d{2}/, "");
    const [u] = await tx.update(bookings).set({ startTime, endTime,
      pickup: label(b.startDate, startTime, b.pickup), dropoff: label(b.endDate, endTime, b.dropoff), updatedAt: new Date(),
      pickupReminderAt: null, returnReminderAt: null, returnSoonAt: null,
    }).where(eq(bookings.id, id)).returning();
    await tx.insert(bookingEvents).values({ bookingId: id, actor, action: "booking.times", details: { from: { startTime: b.startTime, endTime: b.endTime }, to: { startTime, endTime } } });
    return { ok: true as const, booking: u };
  });
  if (!out.ok) return out;
  let contract = "not_required";
  const cd = await readContractData(id);
  if (cd) {
    try { await saveContract(id, { ...cd, t1: startTime, t2: endTime }, actor, "Промяна на часовете"); contract = "saved"; }
    catch { contract = "failed"; }
  }
  return { ...out, contract };
}
