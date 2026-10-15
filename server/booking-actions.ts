import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookingEvents, bookings } from "../db/schema.js";
import { startTimeOf } from "../db/slots.js";
import { queueEmail } from "./email.js";
import { closedKey, sendClosed } from "./notify.js";

// Действия по вече потвърдена резервация – общи за страницата от имейла (/api/bookings/:id/manage) и за админ панела.
//   cancel   – предварителна отмяна; възможна веднага след потвърждаването, докато автомобилът не е предаден
//   no_show  – „Клиентът не се яви“; възможно чак след часа за получаване (Europe/Sofia), докато автомобилът не е предаден
//   handover – отбелязва действителното предаване; след него отмяна и неявяване не са възможни
// Изтичането на часа за получаване НЕ означава, че наемът е започнал – започнал е само при отбелязано предаване.
// Промяната е условна (status = confirmed и без предаване) – повторно или едновременно действие не променя статуса
// втори път и не праща второ писмо. Записът не се изтрива: остава с краен статус, причина, време и извършител,
// а в booking_events – история. Отменената резервация не блокира автомобила: наличността и проверката за застъпване
// броят само status = confirmed (заедно с буфера), затова периодът се освобождава веднага.
type Booking = typeof bookings.$inferSelect;
export type Action = "cancel" | "no_show" | "handover";
export const REASONS = ["customer", "owner", "other"] as const;
export const REASON_BG: Record<string, string> = { customer: "Клиентът се отказа", owner: "Отмяна от собственика", other: "Друга причина", no_show: "Клиентът не се яви" };
export const STATUS_LABEL: Record<string, string> = { pending: "Очаква потвърждение", confirmed: "Потвърдена", rejected: "Отказана", cancelled: "Отменена", no_show: "Неявяване" };

// Текущото местно време в Пловдив като „гггг-мм-дд чч:мм“ (лятното часово време се отчита от Intl)
export function sofiaNow(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
export const pickupAt = (b: Pick<Booking, "startDate" | "startTime" | "pickup">) => (b.startDate ? `${b.startDate} ${startTimeOf(b.startTime, b.pickup)}` : "");
export const pickupPassed = (b: Pick<Booking, "startDate" | "startTime" | "pickup">, now = new Date()) => !!b.startDate && pickupAt(b) <= sofiaNow(now);

export function allowed(b: Booking, now = new Date()) {
  const open = b.status === "confirmed" && !b.handedOverAt;
  return { cancel: open, no_show: open && pickupPassed(b, now), handover: open };
}

export type Result = { ok: true; booking: Booking; email: "sent" | "queued" | "none" } | { ok: false; error: "not_found" | "state" | "too_early" | "reason"; booking?: Booking };

export async function act(id: string, action: Action, o: { actor: string; reason?: string; note?: string; notify?: boolean; now?: Date }): Promise<Result> {
  const now = o.now || new Date();
  const reason = action === "no_show" ? "no_show" : action === "cancel" ? String(o.reason || "") : "";
  if (action === "cancel" && !(REASONS as readonly string[]).includes(reason)) return { ok: false, error: "reason" };
  const note = action === "handover" ? "" : String(o.note || "").trim().slice(0, 1000);
  const notify = action !== "handover" && !!o.notify;
  const out = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
    if (!b) return { ok: false as const, error: "not_found" as const };
    const can = allowed(b, now);
    if (!can[action]) return { ok: false as const, error: action === "no_show" && can.cancel ? ("too_early" as const) : ("state" as const), booking: b };
    const set =
      action === "handover"
        ? { handedOverAt: now, handedOverBy: o.actor, updatedAt: now }
        : { status: action === "cancel" ? "cancelled" : "no_show", closedAt: now, closedBy: o.actor, closeReason: reason, closeNote: note, updatedAt: now };
    const [u] = await tx
      .update(bookings)
      .set(set)
      .where(and(eq(bookings.id, id), eq(bookings.status, "confirmed"), isNull(bookings.handedOverAt)))
      .returning();
    if (!u) return { ok: false as const, error: "state" as const, booking: b };
    // Без лични данни и без бележката в историята – бележката е в close_note
    await tx.insert(bookingEvents).values({
      bookingId: id, actor: o.actor, action: `booking.${action}`,
      details: action === "handover" ? {} : { reason, notify, from: "confirmed", to: u.status, hasNote: !!note },
    });
    if (notify) await queueEmail(tx, "customer-closed", closedKey(id), id, u.email);
    return { ok: true as const, booking: u };
  });
  if (!out.ok) return out;
  // Писмото до клиента – веднъж, след успешната промяна (dedupe по резервация); при грешка се опитва отново от email-retry
  let email: "sent" | "queued" | "none" = "none";
  if (notify) {
    const r = await sendClosed(out.booking).catch(() => ({ result: "failed" as const }));
    email = r.result === "sent" || r.result === "duplicate" ? "sent" : "queued";
  }
  return { ok: true, booking: out.booking, email };
}

// Линкът от имейла до собственика важи до 30 дни след края на наема (без дати – 60 дни след заявката).
// След това управлението е само след вход в админ панела. Токенът не става безсрочен.
export function linkExpired(b: Pick<Booking, "endDate" | "createdAt">, now = new Date()) {
  const until = b.endDate ? Date.parse(`${b.endDate}T23:59:59Z`) + 30 * 864e5 : new Date(b.createdAt).getTime() + 60 * 864e5;
  return now.getTime() > until;
}
