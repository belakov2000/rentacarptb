import type { Config } from "@netlify/functions";
import { dueEmails } from "../../server/email.js";
import { retry, RETRY_KINDS, UNCERTAIN_RETRY_KINDS } from "../../server/notify.js";
import { recordJob } from "../../server/settings.js";

// На всеки 5 минути: повторен опит за неизпратените писма (до фирмата за нова заявка, до клиента за получена заявка,
// за решението, отмяната и удължаването). Писмо със статус sent не се изпраща повторно – защитата е в server/email.ts (dedupe_key).
// Писмата до клиенти с несигурен резултат (unknown) не се повтарят автоматично – остават в лога за проверка.
export default async () => {
  let n = 0;
  for (const row of await dueEmails(RETRY_KINDS, 20, UNCERTAIN_RETRY_KINDS)) {
    n++;
    const r = await retry(row.kind, row.bookingId, row.dedupeKey).catch((e) => ({ result: "failed", error: String((e as Error)?.message).slice(0, 200) }));
    console.log("Email retry", row.kind, row.id, r?.result ?? "skipped");
  }
  await recordJob("email-retry", { retried: n });
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
