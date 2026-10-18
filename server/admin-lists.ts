import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookings, emailLog, payments, cars } from "../db/schema.js";
import { sofiaLocal, sofiaToday } from "../db/hours.js";
import { addDays, endTimeOf, startTimeOf } from "../db/slots.js";
import { summarize } from "./payments.js";

// Общи списъци за админ панела: началното табло и филтрите в „Резервации“ използват едни и същи правила,
// затова броят на всеки показател съвпада със записите, които се отварят от него. „Днес“ е по българско време.
//   pending      – чакащи заявки
//   pickup_today – потвърдени с получаване днес (планирано; дали е предаден се вижда от handedOverAt)
//   return_today – потвърдени с договорено връщане днес (планирано; дали е върнат – от returnedAt)
//   active       – текущи наеми: отбелязано реално предаване, без отбелязано връщане
//   overdue      – текущи наеми, чийто договорен край е минал (няма отбелязано реално връщане)
//   no_handover  – потвърдени, часът за получаване е минал, а предаване не е отбелязано (изисква уточняване – не се приема,
//                  че автомобилът е предаден)
//   deposit_open – държан гаранционен депозит (получен минус възстановен > 0) при приключен наем или закрита резервация
export const VIEWS = ["pending", "pickup_today", "return_today", "active", "overdue", "no_handover", "deposit_open"] as const;
export type View = (typeof VIEWS)[number];

export const LIST = {
  id: bookings.id, status: bookings.status, car: bookings.car, carId: bookings.carId, name: bookings.name, phone: bookings.phone, email: bookings.email,
  pickup: bookings.pickup, dropoff: bookings.dropoff, startDate: bookings.startDate, startTime: bookings.startTime, endDate: bookings.endDate, endTime: bookings.endTime,
  stage: bookings.stage, docsInvitedAt: bookings.docsInvitedAt,
  total: bookings.total, createdAt: bookings.createdAt, handedOverAt: bookings.handedOverAt, returnedAt: bookings.returnedAt, closedAt: bookings.closedAt, closeReason: bookings.closeReason,
};
export type ListRow = { [K in keyof typeof LIST]: (typeof bookings.$inferSelect)[K] };

const nowLocal = (now: Date) => sofiaLocal(now).join(" ");
const pickupLocal = (r: ListRow) => (r.startDate ? `${r.startDate} ${startTimeOf(r.startTime, r.pickup)}` : "");
const endLocal = (r: ListRow) => (r.endDate ? `${r.endDate} ${endTimeOf(r.endTime, r.dropoff)}` : "");

// Условие в базата за всеки изглед (без часовете – те се проверяват след това в viewMatch)
export function viewWhere(v: View, now = new Date()): SQL {
  const today = sofiaToday(now);
  const confirmed = eq(bookings.status, "confirmed");
  switch (v) {
    case "pending": return eq(bookings.status, "pending");
    case "pickup_today": return and(confirmed, eq(bookings.startDate, today))!;
    case "return_today": return and(confirmed, eq(bookings.endDate, today))!;
    case "active": return and(confirmed, isNotNull(bookings.handedOverAt), isNull(bookings.returnedAt))!;
    case "overdue": return and(confirmed, isNotNull(bookings.handedOverAt), isNull(bookings.returnedAt), lte(bookings.endDate, today))!;
    case "no_handover": return and(confirmed, isNull(bookings.handedOverAt), lte(bookings.startDate, today))!;
    case "deposit_open":
      return and(
        or(isNotNull(bookings.returnedAt), inArray(bookings.status, ["cancelled", "no_show", "rejected"])),
        sql`exists (select 1 from ${payments} p where p.booking_id = "bookings"."id" and p.kind = 'security')`,
      )!;
  }
}
// Точна проверка по местно време (часът на връщане / получаване) и по плащанията
export function viewMatch(v: View, r: ListRow, now: Date, securityHeld = 0) {
  const n = nowLocal(now);
  if (v === "overdue") return !!r.endDate && endLocal(r) < n;
  if (v === "no_handover") return !!r.startDate && pickupLocal(r) <= n;
  if (v === "deposit_open") return securityHeld > 0;
  return true;
}

async function heldByBooking(ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const list = await db.select().from(payments).where(inArray(payments.bookingId, ids));
  const by = new Map<string, typeof list>();
  for (const p of list) by.set(p.bookingId, [...(by.get(p.bookingId) || []), p]);
  return new Map([...by].map(([id, l]) => [id, summarize(l).securityHeld]));
}

export async function viewRows(v: View, now = new Date(), extra: SQL[] = []) {
  const rows = (await db.select(LIST).from(bookings).where(and(viewWhere(v, now), ...extra)).orderBy(desc(bookings.createdAt)).limit(1000)) as ListRow[];
  const held = v === "deposit_open" ? await heldByBooking(rows.map((r) => r.id)) : new Map<string, number>();
  return rows.filter((r) => viewMatch(v, r, now, held.get(r.id) || 0));
}

// ===== Търсене, филтри, сортиране и странициране на списъка „Резервации“ =====
export const STATUS_FILTER: Record<string, string[]> = { confirmed: ["confirmed"], pending: ["pending"], closed: ["cancelled", "no_show", "rejected"] };
export const SORTS = {
  created_desc: [desc(bookings.createdAt)], created_asc: [asc(bookings.createdAt)],
  pickup_desc: [desc(bookings.startDate), desc(bookings.startTime), desc(bookings.createdAt)], pickup_asc: [asc(bookings.startDate), asc(bookings.startTime), asc(bookings.createdAt)],
} as const;
export const PAGE = 50;
export function searchWhere(q: string): SQL | undefined {
  q = q.trim().slice(0, 100);
  if (!q) return undefined;
  const like = `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
  const digits = q.replace(/\D/g, "");
  return or(
    ilike(bookings.name, like), ilike(bookings.email, like), ilike(bookings.car, like), ilike(bookings.carId, like),
    ...(/^[a-f0-9]{3,32}$/i.test(q) ? [ilike(bookings.id, q.toLowerCase() + "%")] : []),
    ...(digits.length >= 3 ? [sql`regexp_replace(${bookings.phone}, '\\D', '', 'g') like ${"%" + digits + "%"}`] : [ilike(bookings.phone, like)]),
  );
}
export function sortRows(rows: ListRow[], sort: keyof typeof SORTS) {
  const t = (r: ListRow) => new Date(r.createdAt as any).getTime() || 0;
  const cmp: Record<string, (a: ListRow, b: ListRow) => number> = {
    created_desc: (a, b) => t(b) - t(a), created_asc: (a, b) => t(a) - t(b),
    pickup_desc: (a, b) => (pickupLocal(b) > pickupLocal(a) ? 1 : pickupLocal(b) < pickupLocal(a) ? -1 : t(b) - t(a)),
    pickup_asc: (a, b) => (pickupLocal(a) > pickupLocal(b) ? 1 : pickupLocal(a) < pickupLocal(b) ? -1 : t(a) - t(b)),
  };
  return rows.sort(cmp[sort]);
}

// ===== Начално табло =====
const DUE_WARN_DAYS = 30;
export async function dashboard(now = new Date()) {
  const today = sofiaToday(now);
  const lists: Partial<Record<View, ListRow[]>> = {};
  for (const v of VIEWS) lists[v] = await viewRows(v, now);
  const sortBy = (l: ListRow[], f: (r: ListRow) => string) => l.sort((a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0));
  sortBy(lists.pickup_today!, pickupLocal);
  sortBy(lists.return_today!, endLocal);
  sortBy(lists.active!, endLocal);
  sortBy(lists.overdue!, endLocal);
  const emailCounts = await db.select({ status: emailLog.status, n: sql<number>`count(*)::int` }).from(emailLog).where(inArray(emailLog.status, ["failed", "unknown"])).groupBy(emailLog.status);
  // Срокове на автомобилите (технически преглед, застраховка, обслужване) – изтекли или до 30 дни
  const until = addDays(today, DUE_WARN_DAYS);
  const carRows = await db.select().from(cars).orderBy(cars.sort);
  const carDue: { carId: string; car: string; kind: string; date: string; overdue: boolean }[] = [];
  for (const c of carRows)
    for (const [kind, d] of [["inspection", c.inspectionDue], ["insurance", c.insuranceDue], ["service", c.serviceDue]] as const)
      if (d && d <= until) carDue.push({ carId: c.id, car: `${c.brand} ${c.model}`, kind, date: d, overdue: d < today });
  const cut = (l: ListRow[]) => l.slice(0, 20);
  return {
    today, now: nowLocal(now),
    counts: Object.fromEntries(VIEWS.map((v) => [v, lists[v]!.length])),
    lists: Object.fromEntries(VIEWS.map((v) => [v, cut(lists[v]!)])),
    emails: Object.fromEntries(emailCounts.map((c) => [c.status, c.n])),
    carDue,
  };
}

