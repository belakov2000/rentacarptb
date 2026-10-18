import type { Config, Context } from "@netlify/functions";
import { carActive, checkInput, createQuote, parseQuoteBody } from "../../server/quote.js";
import { inflight, lookupBudget, quoteLimit, readJson, tooMany, who } from "../../server/limits.js";

// POST /api/quote – сървърна ценова оферта за формата за резервация (server/quote.ts).
// Тяло (до 4 KB): { carId, startDate, startTime, endDate, endTime, seats, delivery: адрес | null, return: адрес | null, abroad: [код],
//   deliveryPin / returnPin: { lat, lon } | null – точка, потвърдена от клиента на картата }
// 200: { quote, expiresAt, days, lines, totalCents, total, depositCents, legs } – ключът се подава с резервацията
// 400: { error } – невалидни данни (dates | past | order | hours | car | seats | country | service | address | pin)
// 409: { error: "car_inactive" }
// 413: { error: "too_large" }
// 429: { error: "rate_limited", scope, retryAfter } – твърде много заявки (server/limits.ts); заглавка Retry-After
// 502: { error: "route", leg: "del" | "ret", reason } – разстоянието не може да бъде изчислено (reason: not_found | ambiguous | imprecise | terminal | no_route | …);
//      няма оферта и няма нулева доставка. ambiguous – намерени са само места в друго населено място / на друга улица
//      imprecise – намерена е само улицата / населеното място, не въведеният номер (няма цена до произволна точка)
//      terminal – Летище София без посочен терминал (браузърът предлага избор на Терминал 1 / 2)
//      pin_town / pin_far – потвърденият пин е в друго населено място / твърде далеч от намерената улица
// 409: { error: "route", leg, reason: "pin", pin: { lat, lon, found: "street" | "place" } } – намерена е само улицата / населеното
//      място; клиентът посочва и потвърждава точното място на картата (deliveryPin / returnPin: { lat, lon })
// Офертата не блокира автомобила. Адресите не се записват и не се пишат в логовете.
const json = (b: object, status = 200) => Response.json(b, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // Проверките на данните са преди броячите и преди всяка външна заявка
  const body = await readJson(req);
  if (body === "too_large") return json({ error: "too_large" }, 413);
  const parsed = parseQuoteBody(body);
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  const err = checkInput(parsed.input);
  if (err) return json({ error: err }, 400);
  try {
    const w = await who(req, context?.ip);
    const lim = await quoteLimit(w);
    if (!lim.ok) return tooMany(lim);
    return await inflight(w, async () => {
      if (!(await carActive(parsed.input.carId))) return json({ error: "car_inactive" }, 409);
      let budgetFail: { scope: string; retryAfter: number } | null = null;
      const budget = async () => { const b = await lookupBudget(w); if (!b.ok) budgetFail = b; return b.ok; };
      const q = await createQuote(parsed.input, { budget });
      if (!q.ok && q.error === "route" && q.reason === "limited") return tooMany(budgetFail || { scope: "lookup", retryAfter: 60 });
      // Нужен пин: 409 с началната точка за картата (не е грешка на доставчика)
      if (!q.ok && q.error === "route" && q.reason === "pin") return json({ error: "route", leg: q.leg, reason: "pin", pin: q.pin }, 409);
      if (!q.ok) return q.error === "route" ? json({ error: "route", leg: q.leg, reason: q.reason }, 502) : json({ error: q.error }, 400);
      return json(q.view);
    }, (retryAfter) => tooMany({ scope: "inflight:ip", retryAfter }));
  } catch (e) {
    console.error("Quote failed", (e as Error)?.name);
    return json({ error: "server" }, 500);
  }
};

export const config: Config = {
  path: "/api/quote",
  method: ["POST"],
};
