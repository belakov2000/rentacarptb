import type { Config } from "@netlify/functions";
import { checkStatus, dueChecks, terminalConfig } from "../../server/card-pay.js";
import { recordJob } from "../../server/settings.js";

// На всеки 5 минути: „Проверка за статус на трансакция“ (TRTYPE=90) за плащания с карта без окончателен резултат –
// напр. клиентът е затворил браузъра и BACKREF не е получен (P-OM-41, т. 2.1, 4.2, 9.5.4). Резултатът след 16 мин. е окончателен;
// след 24 ч. APGW не пази данни – опитът се отбелязва като „неизвестен“ и собственикът получава известие за ръчна проверка.
// Планираните функции на Netlify се изпълняват само в публикувания (production) deploy; в Preview проверката е от страницата
// за плащане и от админ панела.
export default async () => {
  const cfg = terminalConfig();
  if (!cfg.ok) return;
  const out: Record<string, number> = {};
  for (const a of await dueChecks()) {
    const r = await checkStatus(a).catch(() => "network");
    out[r] = (out[r] || 0) + 1;
  }
  await recordJob("card-status", out);
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
