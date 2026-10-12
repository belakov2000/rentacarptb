import type { Config } from "@netlify/functions";
import { runBackup } from "../../server/backup.js";

// Всеки час: копие на базата веднъж на ден и довършване на копирането на новите договори и документи.
// При грешка runBackup я записва (status/<среда>.json и booking_events) – администраторът я вижда в панела.
export default async () => {
  const report = await runBackup();
  console.log("Backup", JSON.stringify({ db: report.database.key, skipped: report.database.skipped, files: report.files }));
};

export const config: Config = {
  schedule: "17 * * * *",
};
