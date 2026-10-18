import type { Config, Context } from "@netlify/functions";
import { cachedRoute, validAddr } from "../../server/route.js";
import { inflight, lookupBudget, routeLimit, tooMany, who } from "../../server/limits.js";

// GET /api/route?destination=… – разстояние по пътен маршрут от нашия адрес до въведения адрес: { km: 12.4, rate: 1, local: true }
// Изчислението и кешът са в server/route.ts (същите като за сървърната оферта /api/quote).
// Сайтът вече взема разстоянието от /api/quote; този адрес остава за отворени по-стари версии на страницата.
// Отговорът е само за показване – /api/bookings не приема километри от браузъра.
// Ограничения (server/limits.ts): брой заявки и едновременни заявки по IP, бюджет за търсене при доставчика; 429 при превишаване.
const cached = (body: object) =>
  Response.json(body, {
    // Едно и също търсене се кешира в CDN за един ден (до следващото публикуване на сайта)
    headers: { "Cache-Control": "public, max-age=0, must-revalidate", "Netlify-CDN-Cache-Control": "public, durable, max-age=86400" },
  });

export default async (req: Request, context: Context) => {
  const raw = new URL(req.url).searchParams.get("destination") || "";
  // Невалидният адрес не стига до броячите и до доставчика
  if (!validAddr(raw)) return Response.json({ error: "Missing destination" }, { status: 400 });
  try {
    const w = await who(req, context?.ip);
    const lim = await routeLimit(w);
    if (!lim.ok) return tooMany(lim);
    return await inflight(w, async () => {
      let budgetFail: { scope: string; retryAfter: number } | null = null;
      const r = await cachedRoute(raw, { budget: async () => { const b = await lookupBudget(w); if (!b.ok) budgetFail = b; return b.ok; } });
      if (r === "limited") return tooMany(budgetFail || { scope: "lookup", retryAfter: 60 });
      if (r === "not_found") return Response.json({ error: "Address not found" }, { status: 404 });
      if (typeof r === "string") return Response.json({ error: "No route" }, { status: 502 });
      return cached({ km: r.km, place: r.place, local: r.local, rate: r.rate, source: r.source });
    }, (retryAfter) => tooMany({ scope: "inflight:ip", retryAfter }));
  } catch (e) {
    console.error("Route failed", (e as Error)?.name);
    return Response.json({ error: "Routing failed" }, { status: 502 });
  }
};

export const config: Config = {
  path: "/api/route",
  method: "GET",
};
