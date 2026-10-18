import type { Config } from "@netlify/functions";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookingExtensions, bookings } from "../../db/schema.js";
import { addDays } from "../../db/slots.js";
import { sofiaLocal, sofiaToUtc } from "../../db/hours.js";
import { lifecycleMail, type CustomerMailKind } from "../../mail/customer.js";
import { OWNER_EMAIL } from "../../mail/index.js";
import { sendLogged } from "../../server/email.js";
import { getReminders, recordJob, type Reminders } from "../../server/settings.js";
import { docsReminders } from "../../server/stage.js";

// На всеки 5 минути праща автоматичните писма до клиентите с потвърдени резервации (само status = confirmed –
// отказаните, отменените и неявилите се не получават нищо):
//   напомняне преди получаване и инструкции за предаването, напомняне преди връщане (две) – часовете и включването
//   са в Настройки и автоматизации (server/settings.ts; по подразбиране 24 ч. и 3 ч.), и молба за отзив 2 ч. след края.
// Защита от двойно изпращане: колоната на писмото в bookings се отбелязва преди изпращането, а email_log има ключ.
// Ключът на напомнянията за връщане включва края на наема при удължена резервация – след удължаване (колоните се
// изчистват) клиентът получава напомняне за новия край, а старото не се изпраща.
// Всяко писмо има краен срок (until) – след промяна на настройките или включване не се изпращат писма за минали моменти.
// Получаването се пропуска след отбелязано предаване, връщането – след отбелязано реално връщане.
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
type Booking = typeof bookings.$inferSelect;

function plan(b: Booking, r: Reminders) {
  const start = sofiaToUtc(b.startDate!, b.startTime || DEFAULT_TIME);
  const end = sofiaToUtc(b.endDate!, b.endTime || DEFAULT_TIME);
  const decided = b.decidedAt?.getTime() ?? 0;
  const p1 = r.pickup24.hours * HOUR, p2 = r.handover.hours * HOUR, r1 = r.return24.hours * HOUR, r2 = r.returnSoon.hours * HOUR;
  // Кога става време за писмото и до кога има смисъл; skip – писмото се пропуска (напр. резервацията е потвърдена късно)
  const out: Record<Kind, { due: number; until: number; skip?: boolean; off?: boolean }> = {
    // Договорено: само напомнянията 24 ч преди получаване и връщане; 3-часовите (инструкции за предаването и второто
    // напомняне за връщане) са премахнати – изключени независимо от настройките
    pickup24: { due: start - p1, until: start, skip: decided > start - p1 || !!b.handedOverAt, off: !r.pickup24.enabled },
    handover: { due: start - p2, until: start, skip: true, off: true },
    return24: { due: end - r1, until: end, skip: end - r1 < start || decided > end - r1 || !!b.returnedAt, off: !r.return24.enabled },
    returnSoon: { due: end - r2, until: end, skip: true, off: true },
    review: { due: end + 2 * HOUR, until: end + 2 * 24 * HOUR },
  };
  return out;
}

export default async () => {
  const now = Date.now();
  const { value: reminders } = await getReminders();
  const ahead = Math.ceil(Math.max(reminders.pickup24.hours, reminders.return24.hours) / 24) + 2;
  const [today] = sofiaLocal(now);
  // Само резервации около днешния ден – по-старите отдавна са получили всичко
  const rows = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.status, "confirmed"), lte(bookings.startDate, addDays(today, ahead)), gte(bookings.endDate, addDays(today, -3))));
  const extended = new Set(
    rows.length
      ? (await db.selectDistinct({ id: bookingExtensions.bookingId }).from(bookingExtensions).where(inArray(bookingExtensions.bookingId, rows.map((b) => b.id)))).map((x) => x.id)
      : [],
  );
  let sent = 0, failed = 0;
  for (const b of rows) {
    if (!b.startDate || !b.endDate) continue;
    const p = plan(b, reminders);
    for (const kind of Object.keys(COLUMN) as Kind[]) {
      const col = COLUMN[kind];
      const k = p[kind];
      // Изключено напомняне не се отбелязва – ако бъде включено, се изпраща само докато срокът му не е минал
      if (b[col] || now < k.due || k.off) continue;
      // Първо отбелязваме писмото, за да не се изпрати два пъти при застъпване на две изпълнения
      const [claimed] = await db
        .update(bookings)
        .set({ [col]: new Date() })
        .where(and(eq(bookings.id, b.id), isNull(bookings[col])))
        .returning({ id: bookings.id });
      if (!claimed || k.skip || now >= k.until) continue;
      const target = kind === "pickup24" || kind === "handover" ? b.startDate : b.endDate;
      const mail = lifecycleMail(kind, b, { tomorrow: addDays(sofiaLocal(now)[0], 1) === target });
      const key = (kind === "return24" || kind === "returnSoon") && extended.has(b.id) ? `${kind}:${b.id}:${b.endDate}T${b.endTime}` : `${kind}:${b.id}`;
      // Записва се в email_log; писмо, което вече е изпратено, не се праща втори път
      const r = await sendLogged(kind, key, b.id, {
        to: b.email, toName: b.name, subject: mail.subject, html: mail.html, replyTo: OWNER_EMAIL, lang: b.lang, preheader: mail.preheader,
      }).catch((e) => ({ result: "failed" as const, error: String((e as Error)?.message) }));
      // При несигурен резултат (uncertain) писмото не се праща отново – клиентът може вече да го е получил
      if (r.result === "failed") {
        failed++;
        console.error(`Customer email "${kind}" for booking ${b.id} failed: ${r.error}`);
        // Опитваме отново при следващото изпълнение
        await db.update(bookings).set({ [col]: null }).where(eq(bookings.id, b.id));
      } else if (r.result === "sent") sent++;
    }
  }
  // Двуетапни заявки: напомняне за документите (15 мин след поканата) и RENTY10 (2 ч, при маркетингово съгласие)
  const docs = await docsReminders(new Date(now)).catch((e) => (console.error("Docs reminders failed", (e as Error)?.name), 0));
  await recordJob("customer-emails", { checked: rows.length, sent: sent + docs, failed });
};

export const config: Config = {
  // На всеки 5 мин – напомнянето за документите е 15 мин след поканата
  schedule: "*/5 * * * *",
};
