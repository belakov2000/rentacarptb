import type { Config } from "@netlify/functions";
import { desc, inArray, or, gt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { emailLog } from "../../db/schema.js";
import { json, requireAdmin } from "../../server/auth.js";

// GET /api/admin/emails – писма, които изискват внимание: неуспешни (failed), с неясен резултат (unknown – Brevo може
// да е приел писмото, но отговорът не е стигнал; не се повтарят автоматично до клиенти) и повторени опити.
// Адресите в лога са маскирани, а грешките – без ключове и тайни връзки.
export default async (req: Request) => {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const counts = await db.select({ status: emailLog.status, n: sql<number>`count(*)::int` }).from(emailLog).groupBy(emailLog.status);
  const rows = await db
    .select({
      id: emailLog.id, at: emailLog.at, kind: emailLog.kind, bookingId: emailLog.bookingId, recipient: emailLog.recipient,
      subject: emailLog.subject, status: emailLog.status, error: emailLog.error, attempts: emailLog.attempts,
      nextAttemptAt: emailLog.nextAttemptAt, sentAt: emailLog.sentAt,
    })
    .from(emailLog)
    .where(or(inArray(emailLog.status, ["failed", "unknown", "queued", "sending"]), gt(emailLog.attempts, 1)))
    .orderBy(desc(emailLog.at))
    .limit(100);
  return json({ counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), rows });
};

export const config: Config = {
  path: "/api/admin/emails",
  method: ["GET"],
};
