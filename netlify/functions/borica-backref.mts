import type { Config } from "@netlify/functions";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings } from "../../db/schema.js";
import { esc } from "../../mail/index.js";
import { fieldsOf } from "../../server/borica.js";
import { applyResult, matchResponse, terminalConfig } from "../../server/card-pay.js";
import { breakdownTable, html, msg, t, testBanner } from "../../server/card-page.js";
import { statusLink } from "../../server/stage.js";
import type { Breakdown } from "../../mail/card.js";

// BACKREF – адресът, на който БОРИКА връща резултата от „Плащане“ през браузъра на клиента (HTTP POST, т. 2.1 и 3.2).
// Адресът се задава от банката за терминала. Тук: проверка на подписа с публичния ключ на APGW за средата, на терминала,
// типа, поръчката и NONCE; при ACTION 0 / RC 00 – и на сумата и валутата спрямо записания опит. Само тогава плащането се записва.
// Повторно изпращане на същия отговор не създава второ плащане и не праща нови писма (server/card-pay.ts → applyResult).
// Невалиден или непознат отговор не променя нищо; клиентът вижда, че резултатът се проверява.
export default async (req: Request) => {
  const url = new URL(req.url);
  const raw = req.method === "POST" ? await req.formData().catch(() => null) : url.searchParams;
  const f = fieldsOf(raw ? ([...(raw as any).entries()] as [string, unknown][]) : []);
  const cfg = terminalConfig();
  if (!cfg.ok) {
    console.warn("BORICA response received without payment configuration", cfg.reason);
    return html("bg", t("bg", "pendingH"), `<h1>${esc(t("bg", "title"))}</h1>${msg("bg", "warn", "unknownH", "unknownInfo")}`, 503);
  }
  const m = await matchResponse(cfg.t, f, "backref");
  if (!m.ok) {
    // Само кодът на причината и номерът на поръчката – без подписа и без други данни от отговора. Не се пише в базата:
    // адресът е публичен и неподписани заявки не трябва да пълнят историята.
    console.warn("BORICA response rejected", m.reason, /^\d{6}$/.test(f.ORDER || "") ? f.ORDER : "");
    return html("bg", t("bg", "pendingH"), `<h1>${esc(t("bg", "title"))}</h1>${msg("bg", "warn", "unknownH", "unknownInfo")}<hr>${msg("en", "warn", "unknownH", "unknownInfo")}`, 400);
  }
  const r = await applyResult(m.attempt.id, f, "backref");
  const [b] = await db.select().from(bookings).where(eq(bookings.id, r.attempt.bookingId));
  const L = b.lang;
  const back = `<a class="btn dark" href="${esc(statusLink(b))}">${esc(t(L, "back"))}</a>`;
  // CARDHOLDERINFO от ACS на издателя трябва да бъде показано на картодържателя (табл. 2)
  const info = f.CARDHOLDERINFO ? `<p><b>${esc(t(L, "bankInfo"))}:</b> ${esc(f.CARDHOLDERINFO)}</p>` : "";
  const head = `${testBanner(L, r.attempt.mode)}<h1>${esc(t(L, "title"))}</h1>`;
  if (r.state === "paid") return html(L, t(L, "okH"), `${head}${msg(L, "ok", r.duplicate ? "isPaid" : "okH", "okInfo")}${breakdownTable(r.attempt.breakdown as Breakdown, L)}${info}${back}`);
  if (r.state === "declined") return html(L, t(L, "declinedH"), `${head}${msg(L, "bad", "declinedH", "declinedInfo")}${f.STATUSMSG ? `<p class="hint">${esc(f.STATUSMSG)}</p>` : ""}${info}${back}`);
  if (r.state === "mismatch") return html(L, t(L, "unknownH"), `${head}${msg(L, "bad", "unknownH", "unknownInfo")}${info}${back}`);
  return html(L, t(L, "pendingH"), `${head}${msg(L, "warn", "pendingH", "pendingInfo")}${info}${back}`);
};

export const config: Config = {
  path: "/api/payments/borica/backref",
  method: ["POST", "GET"],
};
