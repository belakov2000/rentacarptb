// Разстояние по пътен маршрут от нашия адрес до адрес за доставка / връщане и цена на км.
// Общо за /api/route (браузърът) и за сървърната проверка на цената (server/pricing.ts) – един и същ алгоритъм.
// rate е цената на км: 1,00 € в Пловдив и околните села (вкл. летище Пловдив и Асеновград), 0,70 € извън тази зона.
// Основно се ползва Google Maps (Routes API) – същото разстояние като в Google Maps. Нужна е променлива GOOGLE_MAPS_API_KEY.
// Без ключ (или ако Google не отговори) адресът се намира с OpenStreetMap (Nominatim), а маршрутът – с OSRM.
// И двата доставчика тръгват от едни и същи координати (BASE). Намереното място се приема само ако е в посоченото
// населено място и на посочената улица (server/geocode.ts); иначе клиентът трябва да уточни адреса („ambiguous“).
// cachedRoute() пази резултатите в базата (route_cache) и при едновременни заявки за един адрес пита доставчика само веднъж.
// В логовете няма адреси и отговори на доставчика – само кодове на грешки.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { pickPlace, queriesFor, townMatches, type NomResult, type Place } from "./geocode.js";
// Координати на бул. Дунав 10, Пловдив (началната точка за доставка и връщане от адрес) – ширина, дължина.
// OSRM приема точките като „дължина,ширина“, Google – latLng { latitude, longitude }.
export const BASE = { lat: 42.1622, lon: 24.7366 };
const UA = "rentacar-ptb.com booking distance (rentaptb_stroi@abv.bg)";

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

// До 5 резултата с подробности за адреса (населено място, улица) – проверяват се в pickPlace()
async function geocode(q: string | Record<string, string>, bgOnly: boolean): Promise<NomResult[]> {
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.search = new URLSearchParams({ ...(typeof q === "string" ? { q } : q), format: "jsonv2", addressdetails: "1", limit: "5", "accept-language": "bg", viewbox: PLOVDIV_BOX, ...(bgOnly ? { countrycodes: "bg" } : {}) }).toString();
  const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  return Array.isArray(j) ? j : [];
}

// Населеното място в дадена точка (за проверка на крайната точка от Google)
async function reverse(p: { lat: number; lon: number }): Promise<NomResult | null> {
  const u = new URL("https://nominatim.openstreetmap.org/reverse");
  u.search = new URLSearchParams({ lat: String(p.lat), lon: String(p.lon), format: "jsonv2", addressdetails: "1", zoom: "14", "accept-language": "bg" }).toString();
  const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" } });
  const j = r.ok ? await r.json().catch(() => null) : null;
  return j && j.address ? j : null;
}

// Първо търсим точния адрес, после без данни за блок/вход/етаж/апартамент и накрая извън България.
// "ambiguous" – намерени са само места в друго населено място или на друга улица.
async function findPlace(addr: string): Promise<Place | "ambiguous" | null> {
  const short = addr.replace(/(^|[,\s])(бл|вх|ет|ап)(\.\s*|\s+)[\wА-я-]+/gi, "").trim();
  let ambiguous = false;
  const qs = [...queriesFor(addr, withCity(addr)), ...(short !== addr ? queriesFor(short, withCity(short)) : [])];
  for (const q of qs) {
    const p = pickPlace(addr, await geocode(q, true));
    if (p && p !== "ambiguous") return p;
    if (p === "ambiguous") ambiguous = true;
  }
  if (ambiguous) return "ambiguous";
  return pickPlace(addr, await geocode(addr, false));
}

// Разстояние по маршрута, който Google Maps предлага по подразбиране
async function googleKm(dest: string): Promise<{ km: number; place: string; end: { lat: number; lon: number } | null } | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters,routes.legs.endLocation" },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: BASE.lat, longitude: BASE.lon } } },
      destination: { address: withCity(dest) },
      travelMode: "DRIVE",
      languageCode: "bg",
      regionCode: "bg",
    }),
  });
  type LatLng = { latitude?: number; longitude?: number };
  const j = (await r.json().catch(() => null)) as { routes?: { distanceMeters?: number; legs?: { endLocation?: { latLng?: LatLng } }[] }[] } | null;
  if (!r.ok) {
    // Само кодът на грешката – отговорът може да съдържа адреса
    console.error("Google Routes error", r.status, String((j as any)?.error?.status || "").slice(0, 40));
    return null;
  }
  const m = j?.routes?.[0]?.distanceMeters;
  const ll = j?.routes?.[0]?.legs?.at(-1)?.endLocation?.latLng;
  const end = typeof ll?.latitude === "number" && typeof ll?.longitude === "number" ? { lat: ll.latitude, lon: ll.longitude } : null;
  return typeof m === "number" ? { km: Math.round(m / 100) / 10, place: dest, end } : null;
}

export type Route = { km: number; place: string; local: boolean; rate: number; source: "google" | "osm" };
export type RouteError = "not_found" | "no_route" | "ambiguous";

// Разстояние до адреса или причината да няма такова. Мрежовите грешки се пропускат нагоре (извикващият решава).
export async function routeTo(dest: string): Promise<Route | RouteError> {
  const g = await googleKm(dest).catch((e) => (console.error("Google Routes failed", (e as Error)?.name), null));
  if (g) {
    // Крайната точка от Google трябва да е в посоченото населено място; без нея зоната се определя чрез OpenStreetMap.
    // Непроверима точка не получава тарифа „по подразбиране“ – тогава се ползва резервният път по-долу.
    if (g.end) {
      const town = await reverse(g.end).catch(() => null);
      if (town && townMatches(dest, town)) return { km: g.km, place: g.place, ...zone(g.end), source: "google" };
      if (town) return "ambiguous";
    } else {
      const p = await findPlace(dest).catch(() => null);
      if (p === "ambiguous") return p;
      if (p) return { km: g.km, place: g.place, ...zone(p), source: "google" };
    }
  }
  const p = await findPlace(dest);
  if (p === "ambiguous") return p;
  if (!p) return "not_found";
  const r = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${BASE.lon},${BASE.lat};${p.lon},${p.lat}?overview=false`,
    { headers: { "User-Agent": UA } },
  );
  const j = (await r.json().catch(() => null)) as { code?: string; routes?: { distance: number }[] } | null;
  if (!r.ok || j?.code !== "Ok" || !j.routes?.length) return "no_route";
  const km = Math.round(j.routes[0].distance / 100) / 10;
  return { km, place: p.name, ...zone(p), source: "osm" };
}

// ===== Проверка на адреса преди търсене при доставчика =====
// 5–200 знака, поне 3 букви, без управляващи знаци, адреси на сайтове и HTML. Невалидният адрес не стига до доставчика.
export const normAddr = (a: string) => String(a || "").trim().replace(/\s+/g, " ").slice(0, 200);
export function validAddr(a: unknown) {
  if (typeof a !== "string" || a.length > 300) return false;
  const n = normAddr(a);
  return n.length >= 5 && n.length <= 200 && (n.match(/\p{L}/gu) || []).length >= 3 && !/[\u0000-\u001f\u007f<>{}]|https?:|www\./i.test(n);
}

// ===== Кеш и едно търсене за адрес =====
// Ключ: хеш на нормализирания адрес (без значение на главни/малки букви) и версията на правилата. В базата са само
// км, тарифа, зона и източник – без адреса и без намереното място.
// Едновременни заявки за един адрес (и от различни инстанции на функциите): първата „заема“ търсенето (status pending),
// останалите изчакват резултата ѝ. Заето търсене, което не е завършило за CLAIM_MS (прекъсната функция), може да бъде заето
// отново. Едно търсене може да направи няколко заявки към доставчиците (Google + OpenStreetMap за зоната или резервния път).
// Грешките се помнят кратко (FAIL_TTL_MS), за да не се повтарят веднага, но повторен опит след това пита отново.
// Версия 2: проверка на населеното място и улицата (резултатите от версия 1 вече не се използват)
const CACHE_VERSION = "2";
export const ROUTE_CACHE = { okTtlMs: 24 * 3600_000, failTtlMs: 15_000, errorTtlMs: 5_000, claimMs: 20_000, waitMs: 12_000, pollMs: 150 };
const cacheKey = (dest: string) => "v" + CACHE_VERSION + "/" + createHash("sha256").update(normAddr(dest).toLowerCase()).digest("hex");
const secs = (ms: number) => ms / 1000;
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export type CacheResult = Route | RouteError | "limited" | "timeout" | "error";

export async function cachedRoute(dest: string, o: { budget?: () => Promise<boolean> } = {}): Promise<CacheResult> {
  if (!validAddr(dest)) return "not_found";
  const key = cacheKey(dest);
  const deadline = Date.now() + ROUTE_CACHE.waitMs;
  for (;;) {
    const [row] = rowsOf(await db.execute(sql`select status, km, rate, local, source, reason, expires_at > now() as fresh from route_cache where key = ${key}`));
    if (row?.fresh && row.status === "ok") return { km: Number(row.km), rate: Number(row.rate), local: !!row.local, source: row.source, place: "" };
    if (row?.fresh && row.status === "fail") return row.reason as RouteError | "error";
    if (!row?.fresh) {
      // Опит да бъде заето търсенето: успява само една заявка (нов ред или изтекъл / изоставен ред)
      const token = randomUUID();
      const claimed = rowsOf(await db.execute(sql`
        insert into route_cache (key, status, claim_token, claimed_at, expires_at) values (${key}, 'pending', ${token}, now(), now() + make_interval(secs => ${secs(ROUTE_CACHE.claimMs)}))
        on conflict (key) do update set status = 'pending', claim_token = excluded.claim_token, claimed_at = now(), expires_at = excluded.expires_at, km = null, rate = null, local = null, source = null, reason = null
        where route_cache.expires_at <= now()
        returning key`)).length > 0;
      if (claimed) return lookup(key, token, dest, o.budget);
    }
    if (Date.now() >= deadline) return "timeout";
    await sleep(ROUTE_CACHE.pollMs);
  }
}

async function lookup(key: string, token: string, dest: string, budget?: () => Promise<boolean>): Promise<CacheResult> {
  const save = (status: "ok" | "fail", ttlMs: number, v: { km?: number; rate?: number; local?: boolean; source?: string; reason?: string }) =>
    db.execute(sql`update route_cache set status = ${status}, km = ${v.km ?? null}, rate = ${v.rate ?? null}, local = ${v.local ?? null}, source = ${v.source ?? null},
      reason = ${v.reason ?? null}, expires_at = now() + make_interval(secs => ${secs(ttlMs)}) where key = ${key} and claim_token = ${token}`).catch(() => null);
  // Бюджетът се отчита само от заявката, която наистина ще пита доставчика
  if (budget && !(await budget())) {
    await db.execute(sql`delete from route_cache where key = ${key} and claim_token = ${token} and status = 'pending'`).catch(() => null);
    return "limited";
  }
  let r: Route | RouteError;
  try {
    r = await routeTo(normAddr(dest));
  } catch (e) {
    console.error("Route lookup failed", (e as Error)?.name);
    await save("fail", ROUTE_CACHE.errorTtlMs, { reason: "error" });
    return "error";
  }
  if (typeof r === "string") await save("fail", ROUTE_CACHE.failTtlMs, { reason: r });
  else await save("ok", ROUTE_CACHE.okTtlMs, { km: r.km, rate: r.rate, local: r.local, source: r.source });
  return r;
}
