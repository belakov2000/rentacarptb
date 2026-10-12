import type { Config } from "@netlify/functions";
import { audit, json, requireAdmin } from "../../server/auth.js";
import { backupStatus, listSnapshots, runBackup, verifyBackup } from "../../server/backup.js";

// GET  /api/admin/backups – състояние (последно успешно копие / грешка), списък с копията и проверка на последното
// GET  /api/admin/backups?status – само състоянието (за предупреждението на всяка страница)
// POST /api/admin/backups – прави копие веднага
export default async (req: Request) => {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  if (req.method === "POST") {
    try {
      const report = await runBackup(true);
      await audit(admin.email, "backup.run", { key: report.database.key });
      return json({ report, status: await backupStatus() });
    } catch {
      // Грешката вече е записана от runBackup – панелът показва предупреждението
      return json({ error: "backup_failed", status: await backupStatus() }, 500);
    }
  }
  // Леко запитване за предупреждението в горната част на панела
  if (new URL(req.url).searchParams.has("status")) return json({ status: await backupStatus() });
  const [snapshots, check, status] = await Promise.all([listSnapshots(), verifyBackup(), backupStatus()]);
  await audit(admin.email, "backup.verify", { ok: check.ok, snapshot: check.snapshot ?? null });
  return json({ snapshots, check, status });
};

export const config: Config = {
  path: "/api/admin/backups",
  method: ["GET", "POST"],
};
