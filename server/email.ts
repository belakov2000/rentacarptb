import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailLog } from "../db/schema.js";
import { sendMail, type Attachment } from "../mail/index.js";

// Надеждно изпращане на имейли с лог (email_log) и защита от дублиране.
// Всяко писмо има dedupeKey (напр. „owner-new:<резервация>“). Записът в лога се прави ПРЕДИ изпращането;
// писмо със статус sent никога не се изпраща повторно; failed се опитва отново от email-retry до MAX_ATTEMPTS пъти.
// unknown: мрежова грешка след изпращането – Brevo може вече да е приел писмото. Такова писмо НЕ се повтаря автоматично,
// освен ако извикващият изрично го позволи (retryUncertain – само за известието до фирмата, където пропуснато
// известие е по-лошо от дублирано; повторното писмо е с отбелязано „[Повторно известие]“ в темата).
const UNCERTAIN_DELAY_MS = 30 * 60_000;
export const MAX_ATTEMPTS = 6;
const STALE_MS = 10 * 60_000; // „sending“ по-старо от това се смята за прекъснато и може да се опита отново
const backoffMs = (attempt: number) => Math.min(6 * 3600_000, 5 * 60_000 * 2 ** (attempt - 1)); // 5 мин, 10, 20 … до 6 ч.

// Само начало на имейла и домейнът – достатъчно за проверка, без пълния адрес в лога
export const maskEmail = (e: string) => {
  const [u, d] = String(e).split("@");
  return d ? `${u.slice(0, 2)}***@${d}` : "***";
};
// Без ключове, тайни връзки, токени и имейл адреси в записаните грешки
export const sanitizeError = (e: unknown) =>
  String((e as Error)?.message || e)
    .replace(/xkeysib-[\w-]+/g, "***")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "***")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "***@***")
    .slice(0, 400);

type Mail = { to: string; toName: string; subject: string; html: string; replyTo?: string; attachment?: Attachment[]; lang?: string; preheader?: string };
export type SendResult = "sent" | "failed" | "uncertain" | "duplicate" | "busy";

// Записва писмото като „queued“ (напр. в същата транзакция като резервацията), без да го изпраща
export async function queueEmail(q: Pick<typeof db, "insert">, kind: string, dedupeKey: string, bookingId: string | null, to: string) {
  await q.insert(emailLog).values({ kind, dedupeKey, bookingId, recipient: maskEmail(to), status: "queued" }).onConflictDoNothing();
}

// Взима правото да изпрати писмото. Връща id на записа или причина да не се изпраща.
async function claim(kind: string, dedupeKey: string, bookingId: string | null, to: string, subject: string, retryUncertain: boolean): Promise<{ id: number; prev: string } | "duplicate" | "busy"> {
  const [created] = await db
    .insert(emailLog)
    .values({ kind, dedupeKey, bookingId, recipient: maskEmail(to), subject: subject.slice(0, 200), status: "sending", attempts: 1 })
    .onConflictDoNothing()
    .returning();
  if (created) return { id: created.id, prev: "" };
  const [cur] = await db.select({ status: emailLog.status }).from(emailLog).where(eq(emailLog.dedupeKey, dedupeKey));
  const claimable = ["queued", "failed", ...(retryUncertain ? ["unknown"] : [])];
  // Вече има запис: изпращаме само ако е в опашката, неуспешен или прекъснат – с условна промяна, за да не го вземат два процеса
  const [taken] = await db
    .update(emailLog)
    .set({ status: "sending", attempts: sql`${emailLog.attempts} + 1`, subject: subject.slice(0, 200), updatedAt: new Date() })
    .where(
      and(
        eq(emailLog.dedupeKey, dedupeKey),
        lt(emailLog.attempts, MAX_ATTEMPTS),
        or(inArray(emailLog.status, claimable), and(eq(emailLog.status, "sending"), lt(emailLog.updatedAt, new Date(Date.now() - STALE_MS)))),
      ),
    )
    .returning({ id: emailLog.id });
  if (taken) return { id: taken.id, prev: cur?.status ?? "" };
  const [row] = await db.select({ status: emailLog.status }).from(emailLog).where(eq(emailLog.dedupeKey, dedupeKey));
  return row?.status === "sent" ? "duplicate" : "busy";
}

export async function sendLogged(
  kind: string, dedupeKey: string, bookingId: string | null, m: Mail, opts: { retryUncertain?: boolean } = {},
): Promise<{ result: SendResult; error?: string }> {
  const c = await claim(kind, dedupeKey, bookingId, m.to, m.subject, !!opts.retryUncertain);
  if (typeof c !== "object") return { result: c };
  const { id } = c;
  // След несигурен резултат фирмата вижда, че това може да е второ копие на същото писмо
  const subject = c.prev === "unknown" ? `[Повторно известие] ${m.subject}` : m.subject;
  try {
    await sendMail(m.to, m.toName, subject, m.html, m.replyTo, m.attachment, m.lang, m.preheader);
  } catch (e) {
    const error = sanitizeError(e);
    if ((e as { uncertain?: boolean })?.uncertain) {
      await db
        .update(emailLog)
        .set({ status: "unknown", error, updatedAt: new Date(), nextAttemptAt: new Date(Date.now() + UNCERTAIN_DELAY_MS) })
        .where(eq(emailLog.id, id));
      return { result: "uncertain", error };
    }
    const [r] = await db.select({ attempts: emailLog.attempts }).from(emailLog).where(eq(emailLog.id, id));
    await db
      .update(emailLog)
      .set({ status: "failed", error, updatedAt: new Date(), nextAttemptAt: new Date(Date.now() + backoffMs(r?.attempts ?? 1)) })
      .where(eq(emailLog.id, id));
    return { result: "failed", error };
  }
  await db.update(emailLog).set({ status: "sent", error: "", sentAt: new Date(), updatedAt: new Date(), nextAttemptAt: null }).where(eq(emailLog.id, id));
  return { result: "sent" };
}

// Писма за повторен опит: в опашката (по-стари от 2 мин.), неуспешни с настъпил срок или прекъснати;
// с несигурен резултат (unknown) – само за видовете в uncertainKinds
export async function dueEmails(kinds: string[], limit = 20, uncertainKinds: string[] = []) {
  const now = new Date();
  return db
    .select()
    .from(emailLog)
    .where(
      and(
        inArray(emailLog.kind, kinds),
        lt(emailLog.attempts, MAX_ATTEMPTS),
        or(
          and(eq(emailLog.status, "queued"), lt(emailLog.at, new Date(now.getTime() - 2 * 60_000))),
          and(eq(emailLog.status, "failed"), or(isNull(emailLog.nextAttemptAt), lte(emailLog.nextAttemptAt, now))),
          and(eq(emailLog.status, "sending"), lt(emailLog.updatedAt, new Date(now.getTime() - STALE_MS))),
          ...(uncertainKinds.length ? [and(eq(emailLog.status, "unknown"), inArray(emailLog.kind, uncertainKinds), lte(emailLog.nextAttemptAt, now))] : []),
        ),
      ),
    )
    .limit(limit);
}
