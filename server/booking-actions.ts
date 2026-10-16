import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookingEvents, bookings, cars } from "../db/schema.js";
import { startTimeOf } from "../db/slots.js";
import { findConflict, lock, type Conflict } from "./conflicts.js";
import { queueEmail } from "./email.js";
import { closedKey, decisionKey, sendClosed, sendDecision } from "./notify.js";

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

// ===== Решение по чакаща заявка (pending → confirmed / rejected) =====
// Общо за страницата от имейла до фирмата и за админ панела („Резервации → Чакащи → Управление“).
//   confirm – само ако заявката има дати, часът за получаване още не е минал (Europe/Sofia), автомобилът е активен и няма
//             потвърдена резервация или активен блокиран период, които се застъпват (с буфера BUFFER_MIN).
//             Проверката е в транзакция със заключване на автомобила – две конфликтни заявки не могат да бъдат потвърдени едновременно.
//   reject  – винаги възможен, докато заявката е pending (и за стари заявки без дати или с минали дати).
// Промяната е условна (status = pending): повторно или едновременно действие (от админа и от имейла) не презаписва вече взето
// решение и не праща второ писмо. message – съобщение до клиента (само от страницата в имейла, влиза в писмото);
// internalNote – вътрешна бележка, НЕ се изпраща на клиента. Не се създават плащания, възстановявания или събития към Meta.
export type Decision = "confirm" | "reject";
export type DecideError = "not_found" | "state" | "no_dates" | "expired" | "car_inactive" | "busy";
export type DecideResult =
  | { ok: true; booking: Booking; email: "sent" | "queued" | "uncertain" | "none" }
  | { ok: false; error: DecideError; booking?: Booking; conflict?: Conflict };

// Може ли чакащата заявка да бъде потвърдена по дати (без проверка за заетост) – за бутона и за съобщението в панела
export function confirmBlock(b: Pick<Booking, "status" | "startDate" | "endDate" | "startTime" | "pickup">, now = new Date()): DecideError | "" {
  if (b.status !== "pending") return "state";
  if (!b.startDate || !b.endDate) return "no_dates";
  if (pickupPassed(b, now)) return "expired";
  return "";
}

export async function decide(
  id: string,
  decision: Decision,
  o: { actor: string; internalNote?: string; message?: string; notify?: boolean; now?: Date },
): Promise<DecideResult> {
  const now = o.now || new Date();
  const internalNote = String(o.internalNote || "").trim().slice(0, 1000);
  const message = String(o.message || "").trim().slice(0, 1000);
  const notify = !!o.notify;
  const out = await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(bookings).where(eq(bookings.id, id));
    if (!cur) return { ok: false as const, error: "not_found" as const };
    // Заключване на автомобила преди заключването на реда – същият ред като при всяко потвърждаване, без взаимно блокиране
    if (decision === "confirm" && cur.carId) await lock(tx, "car:" + cur.carId);
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
    if (b.status !== "pending") return { ok: false as const, error: "state" as const, booking: b };
    if (decision === "confirm") {
      const blocked = confirmBlock(b, now);
      if (blocked) return { ok: false as const, error: blocked, booking: b };
      if (b.carId) {
        const [car] = await tx.select({ status: cars.status }).from(cars).where(eq(cars.id, b.carId));
        if (car && car.status !== "active") return { ok: false as const, error: "car_inactive" as const, booking: b };
      }
      const c = await findConflict(b.carId, b.startDate!, b.endDate!, b.startTime, b.endTime, b.id, tx);
      if (c) return { ok: false as const, error: "busy" as const, booking: b, conflict: c };
    }
    const [u] = await tx
      .update(bookings)
      .set({ status: decision === "confirm" ? "confirmed" : "rejected", note: message, decidedAt: now, decidedBy: o.actor, decisionNote: internalNote, updatedAt: now })
      .where(and(eq(bookings.id, id), eq(bookings.status, "pending")))
      .returning();
    if (!u) return { ok: false as const, error: "state" as const, booking: b };
    // Без лични данни и без текста на бележката в историята – бележката е в decision_note
    await tx.insert(bookingEvents).values({
      bookingId: id, actor: o.actor, action: `booking.${decision}`,
      details: { notify, from: "pending", to: u.status, hasNote: !!internalNote, hasMessage: !!message },
    });
    if (notify) await queueEmail(tx, "customer-decision", decisionKey(id), id, u.email);
    return { ok: true as const, booking: u };
  });
  if (!out.ok) return out;
  let email: "sent" | "queued" | "uncertain" | "none" = "none";
  if (notify) {
    const r = await sendDecision(out.booking).catch(() => ({ result: "failed" as const }));
    email = r.result === "sent" || r.result === "duplicate" ? "sent" : r.result === "uncertain" ? "uncertain" : "queued";
  }
  return { ok: true, booking: out.booking, email };
}

// Линкът от имейла до собственика важи до 30 дни след края на наема (без дати – 60 дни след заявката).
// След това управлението е само след вход в админ панела. Токенът не става безсрочен.
export function linkExpired(b: Pick<Booking, "endDate" | "createdAt">, now = new Date()) {
  const until = b.endDate ? Date.parse(`${b.endDate}T23:59:59Z`) + 30 * 864e5 : new Date(b.createdAt).getTime() + 60 * 864e5;
  return now.getTime() > until;
}
