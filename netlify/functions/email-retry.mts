import type { Config } from "@netlify/functions";
import { dueEmails } from "../../server/email.js";
import { retry, RETRY_KINDS, UNCERTAIN_RETRY_KINDS } from "../../server/notify.js";

// На всеки 5 минути: повторен опит за неизпратените писма (до фирмата за нова заявка, до клиента за получена заявка
// и за решението). Писмо със статус sent не се изпраща повторно – защитата е в server/email.ts (dedupe_key).
// Писмата до клиенти с несигурен резултат (unknown) не се повтарят автоматично – остават в лога за проверка.
export default async () => {
  for (const row of await dueEmails(RETRY_KINDS, 20, UNCERTAIN_RETRY_KINDS)) {
    const r = await retry(row.kind, row.bookingId).catch((e) => ({ result: "failed", error: String((e as Error)?.message).slice(0, 200) }));
    console.log("Email retry", row.kind, row.id, r?.result ?? "skipped");
  }
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
