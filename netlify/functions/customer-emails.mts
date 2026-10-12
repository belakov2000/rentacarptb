import type { Config } from "@netlify/functions";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings } from "../../db/schema.js";
import { lifecycleMail, type CustomerMailKind } from "../../mail/customer.js";
import { OWNER_EMAIL, sendMail } from "../../mail/index.js";

// На всеки 15 минути праща автоматичните писма до клиентите с потвърдени резервации:
// напомняне 24 ч. преди получаване, инструкции за предаването 3 ч. преди него,
// напомняне за връщане 24 ч. и 3 ч. преди връщането и молба за отзив 2 ч. след края на наема.
const HOUR = 3600_000;
const DEFAULT_TIME = "10:00"; // ако клиентът не е посочил час
const COLUMN = {
  pickup24: "pickupReminderAt",
  handover: "handoverInfoAt",
  return24: "returnReminderAt",
  returnSoon: "returnSoonAt",
  review: "reviewRequestAt",
} as const satisfies Record<Exclude<CustomerMailKind, "received">, keyof typeof bookings.$inferSelect>;
type Kind = keyof typeof COLUMN;

// Местна дата и час в София → момент във времето (отчита лятното часово време)
function sofia(date: string, time: string) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time || DEFAULT_TIME).split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Sofia", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(guess))
      .map((x) => [x.type, Number(x.value)]),
  );
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess;
  return guess - offset;
}
const ymd = (ms: number) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Sofia" });

export default async () => {
  const now = Date.now();
  // Само резервации около днешния ден – по-старите отдавна са получили всичко
  const rows = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.status, "confirmed"), lte(bookings.startDate, ymd(now + 2 * 24 * HOUR)), gte(bookings.endDate, ymd(now - 3 * 24 * HOUR))));

  for (const b of rows) {
    if (!b.startDate || !b.endDate) continue;
    const start = sofia(b.startDate, b.startTime);
    const end = sofia(b.endDate, b.endTime);
    const decided = b.decidedAt?.getTime() ?? 0;
    // Кога става време за писмото и до кога има смисъл; skip – писмото се пропуска (напр. резервацията е потвърдена късно)
    const plan: Record<Kind, { due: number; until: number; skip?: boolean }> = {
      pickup24: { due: start - 24 * HOUR, until: start - 3 * HOUR, skip: decided > start - 24 * HOUR },
      handover: { due: start - 3 * HOUR, until: start },
      return24: { due: end - 24 * HOUR, until: end - 3 * HOUR, skip: end - 24 * HOUR < start || decided > end - 24 * HOUR },
      returnSoon: { due: end - 3 * HOUR, until: end, skip: end - 3 * HOUR < start },
      review: { due: end + 2 * HOUR, until: end + 2 * 24 * HOUR },
    };
    for (const kind of Object.keys(COLUMN) as Kind[]) {
      const col = COLUMN[kind];
      const p = plan[kind];
      if (b[col] || now < p.due) continue;
      // Първо отбелязваме писмото, за да не се изпрати два пъти при застъпване на две изпълнения
      const [claimed] = await db
        .update(bookings)
        .set({ [col]: new Date() })
        .where(and(eq(bookings.id, b.id), isNull(bookings[col])))
        .returning({ id: bookings.id });
      if (!claimed || p.skip || now >= p.until) continue;
      const mail = lifecycleMail(kind, b);
      try {
        await sendMail(b.email, b.name, mail.subject, mail.html, OWNER_EMAIL, undefined, b.lang, mail.preheader);
      } catch (e) {
        console.error(`Customer email "${kind}" for booking ${b.id} failed`, e);
        // Опитваме отново при следващото изпълнение
        await db.update(bookings).set({ [col]: null }).where(eq(bookings.id, b.id));
      }
    }
  }
};

export const config: Config = {
  schedule: "*/15 * * * *",
};
