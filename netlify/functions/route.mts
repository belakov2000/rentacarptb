import type { Config } from "@netlify/functions";

// GET /api/route?destination=… – разстояние по пътен маршрут от нашия адрес до въведения адрес: { km: 12.4, rate: 1, local: true }
// rate е цената на км: 1,00 € в Пловдив и околните села (вкл. летище Пловдив и Асеновград), 0,70 € извън тази зона.
// Основно се ползва Google Maps (Routes API) – същото разстояние като в Google Maps. Нужна е променлива GOOGLE_MAPS_API_KEY.
// Без ключ (или ако Google не отговори) адресът се намира с OpenStreetMap (Nominatim), а маршрутът – с OSRM.
const OFFICE_ADDRESS = "бул. Дунав 10, Пловдив, България";
// Координати на бул. Дунав 10, Пловдив (началната точка за доставка и връщане от адрес)
const BASE = { lat: 42.1622, lon: 24.7366 };
const UA = "rentacar-ptb.com booking distance (rentaptb_stroi@abv.bg)";

type Place = { lat: number; lon: number; name: string };

// Зона „Пловдив и района“ (1,00 €/км): гр. Пловдив, околните села, летище Пловдив (Крумово) и Асеновград.
// Многоъгълник от точки [дължина, ширина]; адресите извън него се таксуват по 0,70 €/км.
const LOCAL_RATE = 1, RATE = 0.7;
const LOCAL_ZONE: [number, number][] = [
  [24.58, 42.24], // Костиево / Радиново
  [24.72, 42.26], // Цалапица – Царацово
  [24.88, 42.26], // Трилистник / Калековец
  [24.95, 42.20], // Маноле
  [24.92, 42.12], // Рогош (без Садово)
  [24.93, 42.04], // Крумово / летище Пловдив
  [24.93, 41.98], // Асеновград (изток)
  [24.84, 41.97], // Асеновград (юг)
  [24.75, 42.01], // Куклен
  [24.63, 42.04], // Брестник / Белащица
  [24.58, 42.12], // Кадиево / Строево (запад)
];
const inZone = (lat: number, lon: number) => {
  let inside = false;
  for (let i = 0, j = LOCAL_ZONE.length - 1; i < LOCAL_ZONE.length; j = i++) {
    const [xi, yi] = LOCAL_ZONE[i], [xj, yj] = LOCAL_ZONE[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const zone = (p: { lat: number; lon: number } | null) => {
  const local = !!p && inZone(p.lat, p.lon);
  return { local, rate: local ? LOCAL_RATE : RATE };
};

// Област Пловдив – при еднакви имена на улици се предпочитат адресите тук
const PLOVDIV_BOX = "24.45,42.35,25.05,41.95";

// Ако клиентът не е посочил населено място, адресът е в Пловдив (иначе „Свобода 73“ се намира в с. Свобода, Добрич)
const withCity = (addr: string) =>
  /пловдив|plovdiv|(^|[\s,])(гр|с|град|село)(\.|\s)/i.test(addr) ? addr : `${addr}, Пловдив`;

async function geocode(q: string, bgOnly: boolean): Promise<Place | null> {
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.search = new URLSearchParams({ q, format: "json", limit: "1", "accept-language": "bg", viewbox: PLOVDIV_BOX, ...(bgOnly ? { countrycodes: "bg" } : {}) }).toString();
  const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) return null;
  const [p] = (await r.json()) as { lat: string; lon: string; display_name: string }[];
  return p ? { lat: +p.lat, lon: +p.lon, name: p.display_name } : null;
}

// Първо търсим точния адрес, после без данни за блок/вход/етаж/апартамент и накрая извън България
async function findPlace(addr: string) {
  const full = withCity(addr);
  if (full !== addr) {
    const p = await geocode(full, true);
    if (p) return p;
  }
  const short = addr.replace(/(^|[,\s])(бл|вх|ет|ап)(\.\s*|\s+)[\wА-я-]+/gi, "").trim();
  return (await geocode(addr, true)) || (short !== addr && (await geocode(short, true))) || (await geocode(addr, false));
}

// Разстояние по маршрута, който Google Maps предлага по подразбиране
async function googleKm(dest: string): Promise<{ km: number; place: string; end: { lat: number; lon: number } | null } | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters,routes.legs.endLocation" },
    body: JSON.stringify({
      origin: { address: OFFICE_ADDRESS },
      destination: { address: withCity(dest) },
      travelMode: "DRIVE",
      languageCode: "bg",
      regionCode: "bg",
    }),
  });
  type LatLng = { latitude?: number; longitude?: number };
  const j = (await r.json().catch(() => null)) as { routes?: { distanceMeters?: number; legs?: { endLocation?: { latLng?: LatLng } }[] }[] } | null;
  if (!r.ok) {
    console.error("Google Routes error", r.status, JSON.stringify(j).slice(0, 300));
    return null;
  }
  const m = j?.routes?.[0]?.distanceMeters;
  const ll = j?.routes?.[0]?.legs?.at(-1)?.endLocation?.latLng;
  const end = typeof ll?.latitude === "number" && typeof ll?.longitude === "number" ? { lat: ll.latitude, lon: ll.longitude } : null;
  return typeof m === "number" ? { km: Math.round(m / 100) / 10, place: dest, end } : null;
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
    if (g) {
      // Ако Google не върне координати на адреса, зоната се определя чрез OpenStreetMap
      const end = g.end || (await findPlace(dest).catch(() => null));
      return cached({ km: g.km, place: g.place, ...zone(end), source: "google" });
    }
    const p = await findPlace(dest);
    if (!p) return Response.json({ error: "Address not found" }, { status: 404 });
    const r = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${BASE.lon},${BASE.lat};${p.lon},${p.lat}?overview=false`,
      { headers: { "User-Agent": UA } },
    );
    const j = (await r.json().catch(() => null)) as { code?: string; routes?: { distance: number }[] } | null;
    if (!r.ok || j?.code !== "Ok" || !j.routes?.length) return Response.json({ error: "No route" }, { status: 502 });
    const km = Math.round(j.routes[0].distance / 100) / 10;
    return cached({ km, place: p.name, ...zone(p), source: "osm" });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Routing failed" }, { status: 502 });
  }
};

export const config: Config = {
  path: "/api/route",
  method: "GET",
};
