import type { Config } from "@netlify/functions";
import { json, requireAdmin } from "../../server/auth.js";
import { BUFFER_MIN } from "../../db/slots.js";
import { HOURS } from "../../db/hours.js";
import { getReminders, jobStatus, parseReminders, REMINDER_LIMITS, saveReminders } from "../../server/settings.js";
import { backupStatus } from "../../server/backup.js";
import { mailAllowed } from "../../mail/index.js";

// Настройки и автоматизации (само за администратор).
// GET  /api/admin/settings – действащите настройки: часова зона, буфер, работно време (само за четене – задават се в кода
//      и са общи за сайта и сървъра), напомнянията до клиента (променят се тук) и последното изпълнение на автоматичните задачи.
// POST /api/admin/settings { reminders } – запис на напомнянията; ползват се от функцията customer-emails при следващото ѝ изпълнение.
// Не се връщат пароли, API ключове или токени – само дали пощенската услуга е настроена.
const JOBS = [
  { key: "customer-emails", schedule: "*/15 * * * *", label: "Напомняния и писма до клиентите" },
  { key: "email-retry", schedule: "*/5 * * * *", label: "Повторни опити за неизпратени писма" },
  { key: "backup", schedule: "17 * * * *", label: "Резервни копия" },
];
export default async (req: Request) => {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    const value = parseReminders(body?.reminders);
    if (!value) return json({ error: "invalid", limits: REMINDER_LIMITS }, 400);
    if (value.pickup24.hours <= value.handover.hours || value.return24.hours <= value.returnSoon.hours) return json({ error: "order" }, 400);
    await saveReminders(value, admin.email);
  }
  const reminders = await getReminders();
  const jobs = Object.fromEntries((await jobStatus()).map((j) => [j.key.slice(4), j.value]));
  const backup = await backupStatus().catch(() => null);
  return json({
    timezone: "Europe/Sofia", bufferMinutes: BUFFER_MIN, hours: HOURS, reminders, limits: REMINDER_LIMITS,
    mailConfigured: !!process.env.BREVO_API_KEY, mailAllowed: mailAllowed(),
    jobs: JOBS.map((j) => ({ ...j, last: j.key === "backup" ? (backup ? { at: (backup as any).lastSuccessAt || null, warning: (backup as any).warning || "" } : null) : jobs[j.key] || null })),
  });
};

export const config: Config = { path: "/api/admin/settings", method: ["GET", "POST"] };
