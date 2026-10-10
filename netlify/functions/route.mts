import type { Config } from "@netlify/functions";

// GET /api/route?destination=… – разстояние по пътен маршрут от нашия адрес до въведения адрес: { km: 12.4 }
// Основно се ползва Google Maps (Routes API) – същото разстояние като в Google Maps. Нужна е променлива GOOGLE_MAPS_API_KEY.
// Без ключ (или ако Google не отговори) адресът се намира с OpenStreetMap (Nominatim), а маршрутът – с OSRM.
const OFFICE_ADDRESS = "бул. Дунав 10, Пловдив, България";
// Координати на бул. Дунав 10, Пловдив (началната точка за доставка и връщане от адрес)
const BASE = { lat: 42.1622, lon: 24.7366 };
const UA = "rentacar-ptb.com booking distance (rentaptb_stroi@abv.bg)";

type Place = { lat: number; lon: number; name: string };

async function geocode(q: string, bgOnly: boolean): Promise<Place | null> {
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.search = new URLSearchParams({ q, format: "json", limit: "1", "accept-language": "bg", ...(bgOnly ? { countrycodes: "bg" } : {}) }).toString();
  const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) return null;
  const [p] = (await r.json()) as { lat: string; lon: string; display_name: string }[];
  return p ? { lat: +p.lat, lon: +p.lon, name: p.display_name } : null;
}

// Първо търсим точния адрес, после без данни за блок/вход/етаж/апартамент и накрая извън България
async function findPlace(addr: string) {
  const short = addr.replace(/(^|[,\s])(бл|вх|ет|ап)(\.\s*|\s+)[\wА-я-]+/gi, "").trim();
  return (await geocode(addr, true)) || (short !== addr && (await geocode(short, true))) || (await geocode(addr, false));
}

// Разстояние по маршрута, който Google Maps предлага по подразбиране
async function googleKm(dest: string): Promise<{ km: number; place: string } | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters" },
    body: JSON.stringify({
      origin: { address: OFFICE_ADDRESS },
      destination: { address: dest },
      travelMode: "DRIVE",
      languageCode: "bg",
      regionCode: "bg",
    }),
  });
  const j = (await r.json().catch(() => null)) as { routes?: { distanceMeters?: number }[] } | null;
  if (!r.ok) {
    console.error("Google Routes error", r.status, JSON.stringify(j).slice(0, 300));
    return null;
  }
  const m = j?.routes?.[0]?.distanceMeters;
  return typeof m === "number" ? { km: Math.round(m / 100) / 10, place: dest } : null;
}

const cached = (body: object) =>
  Response.json(body, {
    // Едно и също търсене се кешира в CDN за един ден (до следващото публикуване на сайта)
    headers: { "Cache-Control": "public, max-age=0, must-revalidate", "Netlify-CDN-Cache-Control": "public, durable, max-age=86400" },
  });

export default async (req: Request) => {
  const dest = (new URL(req.url).searchParams.get("destination") || "").trim().slice(0, 200);
  if (dest.length < 3) return Response.json({ error: "Missing destination" }, { status: 400 });
  try {
    const g = await googleKm(dest).catch((e) => (console.error(e), null));
    if (g) return cached({ ...g, source: "google" });
    const p = await findPlace(dest);
    if (!p) return Response.json({ error: "Address not found" }, { status: 404 });
    const r = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${BASE.lon},${BASE.lat};${p.lon},${p.lat}?overview=false`,
      { headers: { "User-Agent": UA } },
    );
    const j = (await r.json().catch(() => null)) as { code?: string; routes?: { distance: number }[] } | null;
    if (!r.ok || j?.code !== "Ok" || !j.routes?.length) return Response.json({ error: "No route" }, { status: 502 });
    const km = Math.round(j.routes[0].distance / 100) / 10;
    return cached({ km, place: p.name, source: "osm" });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Routing failed" }, { status: 502 });
  }
};

export const config: Config = {
  path: "/api/route",
  method: "GET",
};
