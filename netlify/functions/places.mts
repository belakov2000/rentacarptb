import type { Config, Context } from "@netlify/functions";
import { autocomplete, placesKey, SESSION_RE } from "../../server/places.js";
import { placesLimit, tooMany, who } from "../../server/limits.js";

// GET /api/places?input=…&session=<32 hex>&lang=bg|en|de – предложения от Google за адреса за доставка / връщане (server/places.ts)
// 200: { suggestions: [{ id, main, secondary, types }] } – до 5 предложения в България; браузърът показва атрибуция „Google Maps“
// 400: невалиден текст или ключ на сесията; 429: твърде много заявки (server/limits.ts);
// 503: { error: "unavailable" } – няма ключ за Google (браузърът продължава без предложения); 502: грешка на Google.
// Отговорът не се кешира (правилата на Google за предложенията). Текстът не се записва и не се пише в логовете.
const json = (b: object, status = 200) => Response.json(b, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });

export default async (req: Request, context: Context) => {
  const u = new URL(req.url);
  const input = (u.searchParams.get("input") || "").trim().replace(/\s+/g, " ");
  const session = u.searchParams.get("session") || "";
  // Проверките са преди броячите и преди заявката към Google: 3–120 знака, поне 2 букви, без HTML и адреси на сайтове
  if (input.length < 3 || input.length > 120 || (input.match(/\p{L}/gu) || []).length < 2 || /[\u0000-\u001f<>{}]|https?:|www\./i.test(input) || !SESSION_RE.test(session))
    return json({ error: "bad_request" }, 400);
  if (!placesKey()) return json({ error: "unavailable" }, 503);
  try {
    const w = await who(req, context?.ip);
    const lim = await placesLimit(w);
    if (!lim.ok) return tooMany(lim);
    const r = await autocomplete(input, session, u.searchParams.get("lang") || "bg");
    if (r === "unavailable") return json({ error: "unavailable" }, 503);
    if (r === "error") return json({ error: "provider" }, 502);
    return json({ suggestions: r });
  } catch (e) {
    console.error("Places failed", (e as Error)?.name);
    return json({ error: "server" }, 500);
  }
};

export const config: Config = {
  path: "/api/places",
  method: "GET",
};
