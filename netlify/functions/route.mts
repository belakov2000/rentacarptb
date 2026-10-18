import type { Config } from "@netlify/functions";
import { routeTo } from "../../server/route.js";

// GET /api/route?destination=… – разстояние по пътен маршрут от нашия адрес до въведения адрес: { km: 12.4, rate: 1, local: true }
// Изчислението е в server/route.ts (същото се ползва и от сървърната проверка на цената).

const cached = (body: object) =>
  Response.json(body, {
    // Едно и също търсене се кешира в CDN за един ден (до следващото публикуване на сайта)
    headers: { "Cache-Control": "public, max-age=0, must-revalidate", "Netlify-CDN-Cache-Control": "public, durable, max-age=86400" },
  });

export default async (req: Request) => {
  const dest = (new URL(req.url).searchParams.get("destination") || "").trim().slice(0, 200);
  if (dest.length < 3) return Response.json({ error: "Missing destination" }, { status: 400 });
  try {
    const r = await routeTo(dest);
    if (r === "not_found") return Response.json({ error: "Address not found" }, { status: 404 });
    if (r === "no_route") return Response.json({ error: "No route" }, { status: 502 });
    return cached(r);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Routing failed" }, { status: 502 });
  }
};

export const config: Config = {
  path: "/api/route",
  method: "GET",
};
