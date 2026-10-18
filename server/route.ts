// Разстояние по пътен маршрут от нашия адрес до адрес за доставка / връщане и цена на км.
// Общо за /api/route (браузърът) и за сървърната проверка на цената (server/pricing.ts) – един и същ алгоритъм.
// rate е цената на км: 1,00 € в Пловдив и околните села (вкл. летище Пловдив и Асеновград), 0,70 € извън тази зона.
// Основно се ползва Google Maps (Routes API) – същото разстояние като в Google Maps. Нужна е променлива GOOGLE_MAPS_API_KEY.
// Без ключ (или ако Google не отговори) адресът се намира с OpenStreetMap (Nominatim), а маршрутът – с OSRM.
// И двата доставчика тръгват от едни и същи координати (BASE). Намереното място се приема само ако е в посоченото
// населено място и на посочената улица (server/geocode.ts); иначе клиентът трябва да уточни адреса („ambiguous“).
// Цена се изчислява само до потвърдена сграда (точност „house“ – въведеният номер е намерен на въведената улица).
// Намерена само улица (номерът липсва или не е въведен) или само населено място → „imprecise“: няма оферта,
// клиентът уточнява адреса или се обажда. Адресът не се заменя с точка от улицата или центъра на селото.
// Проверени обекти без улица и номер (Летище София – Терминал 1 / 2, Летище Пловдив; server/geocode.ts → matchPoi): маршрутът
// е до автомобилната точка пред терминала; при неясен терминал → „terminal“ (клиентът избира терминала).
// Намерена само улицата / населеното място (номерът липсва в OpenStreetMap): не се представя като точен адрес и не се отказва –
// сървърът връща „pin“ с началната точка, клиентът посочва и изрично потвърждава мястото на картата, а маршрутът е до
// потвърдения пин. Пинът се приема само в посоченото населено място (обратно търсене) и до PIN_MAX_KM от намерената точка.
// cachedRoute() пази резултатите в базата (route_cache) и при едновременни заявки за един адрес пита доставчика само веднъж.
// В логовете няма адреси и отговори на доставчика – само кодове на грешки.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { endPrecision, matchPoi, POIS, pickPlace, queriesFor, type NomResult, type Place, type Precision } from "./geocode.js";
// Началната точка за доставка и връщане от адрес – обектът „Рента ПТБ Строй – Rent a Car Plovdiv“, бул. Дунав 10, Пловдив.
// Източник: точката (pin) на обекта в Google Maps, предоставена от собственика – https://maps.app.goo.gl/EfXpFUUBAbxecxue8
// (параметрите !3d / !4d на мястото, не центърът на картата @…). Ширина, дължина. Предишната точка 42.1622, 24.7366 беше
// на около 310 м източно по булеварда. OSRM приема точките като „дължина,ширина“, Google – latLng { latitude, longitude }.
export const BASE = { lat: 42.1615692, lon: 24.7329252 };
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

// Адресът в дадена точка до сграда (за проверка на крайната точка от Google: населено място, улица, номер)
async function reverse(p: { lat: number; lon: number }): Promise<NomResult | null> {
  const u = new URL("https://nominatim.openstreetmap.org/reverse");
  u.search = new URLSearchParams({ lat: String(p.lat), lon: String(p.lon), format: "jsonv2", addressdetails: "1", zoom: "18", "accept-language": "bg" }).toString();
  const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" } });
  const j = r.ok ? await r.json().catch(() => null) : null;
  return j && j.address ? j : null;
}

// Първо търсим точния адрес, после без данни за блок/вход/етаж/апартамент и накрая извън България. Спира се при
// намерена сграда; иначе се връща най-точното приетото място (улица / населено място – за отказ „imprecise“).
// "ambiguous" – намерени са само места в друго населено място или на друга улица.
const RANK = { house: 3, street: 2, place: 1 } as const;
async function findPlace(addr: string): Promise<Place | "ambiguous" | null> {
  const short = addr.replace(/(^|[,\s])(бл|вх|ет|ап)(\.\s*|\s+)[\wА-я-]+/gi, "").trim();
  let ambiguous = false, best: Place | null = null;
  const qs = [...queriesFor(addr, withCity(addr)), ...(short !== addr ? queriesFor(short, withCity(short)) : [])];
  for (const q of qs) {
    const p = pickPlace(addr, await geocode(q, true));
    if (p === "ambiguous") ambiguous = true;
    else if (p && (!best || RANK[p.precision] > RANK[best.precision])) best = p;
    if (best?.precision === "house") return best;
  }
  if (best) return best;
  if (ambiguous) return "ambiguous";
  return pickPlace(addr, await geocode(addr, false));
}

// Разстояние по маршрута, който Google Maps предлага по подразбиране – до адрес или до точка (проверен обект)
async function googleKm(dest: string | { lat: number; lon: number }): Promise<{ km: number; place: string; end: { lat: number; lon: number } | null } | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters,routes.legs.endLocation" },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: BASE.lat, longitude: BASE.lon } } },
      destination: typeof dest === "string" ? { address: withCity(dest) } : { location: { latLng: { latitude: dest.lat, longitude: dest.lon } } },
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
  return typeof m === "number" ? { km: Math.round(m / 100) / 10, place: typeof dest === "string" ? dest : "", end } : null;
}

// precision: "house" – потвърдена сграда; "pin" – точка, посочена и потвърдена от клиента на картата;
// "poi" – проверен обект (poi – името му, напр. „Летище София, Терминал 2“)
export type Route = { km: number; place: string; local: boolean; rate: number; source: "google" | "osm"; precision: Precision; poi?: string; poiId?: string };
// Намерена е само улицата / населеното място: нужен е потвърден пин; lat / lon – началната точка за картата
export type NeedPin = { pin: true; lat: number; lon: number; found: "street" | "place" };
// imprecise – (без начална точка) не е намерено конкретно място; terminal – Летище София без надеждно посочен терминал;
// pin_town – пинът е в друго населено място; pin_far – пинът е твърде далеч от намерената улица / населено място
export type RouteError = "not_found" | "no_route" | "ambiguous" | "imprecise" | "terminal" | "pin_town" | "pin_far";
export type Pin = { lat: number; lon: number };
export const PIN_MAX_KM = 3;
// Пин в България (приблизителни граници) с точност до 6 знака след десетичната точка
export const validPin = (p: unknown): p is Pin => {
  const o = p as any;
  return !!o && typeof o.lat === "number" && typeof o.lon === "number" && o.lat >= 41.2 && o.lat <= 44.25 && o.lon >= 22.35 && o.lon <= 28.65;
};
const roundPin = (p: Pin): Pin => ({ lat: Math.round(p.lat * 1e6) / 1e6, lon: Math.round(p.lon * 1e6) / 1e6 });
const kmBetween = (a: Pin, b: Pin) => {
  const r = (x: number) => (x * Math.PI) / 180;
  return 6371 * Math.hypot(r(b.lon - a.lon) * Math.cos(r((a.lat + b.lat) / 2)), r(b.lat - a.lat));
};

// Маршрут с OSRM от офиса до точка (ред „дължина,ширина“)
async function osrmKm(p: { lat: number; lon: number }): Promise<number | null> {
  const r = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${BASE.lon},${BASE.lat};${p.lon},${p.lat}?overview=false`,
    { headers: { "User-Agent": UA } },
  );
  const j = (await r.json().catch(() => null)) as { code?: string; routes?: { distance: number }[] } | null;
  if (!r.ok || j?.code !== "Ok" || !j.routes?.length) return null;
  return Math.round(j.routes[0].distance / 100) / 10;
}

// Маршрут до потвърден пин: населеното място в пина (обратно търсене) трябва да е посоченото, и да е близо до намереното място
async function routeToPin(dest: string, pin: Pin, near: Pin | null): Promise<Route | RouteError> {
  if (near && kmBetween(pin, near) > PIN_MAX_KM) return "pin_far";
  const at = await reverse(pin);
  if (!at || !endPrecision(dest, at)) return "pin_town";
  const g = await googleKm(pin).catch((e) => (console.error("Google Routes failed", (e as Error)?.name), null));
  const km = g ? g.km : await osrmKm(pin);
  if (km == null) return "no_route";
  return { km, place: "", ...zone(pin), source: g ? "google" : "osm", precision: "pin" };
}

// Разстояние до адреса или причината да няма такова. Мрежовите грешки се пропускат нагоре (извикващият решава).
export async function routeTo(dest: string): Promise<Route | NeedPin | RouteError> {
  // Проверен обект: без търсене на адрес – маршрут до автомобилната точка на обекта (Google, иначе OSRM)
  const poi = matchPoi(dest);
  if (poi === "terminal" || poi === "ambiguous") return poi;
  if (poi) {
    const pg = await googleKm(poi).catch((e) => (console.error("Google Routes failed", (e as Error)?.name), null));
    const km = pg ? pg.km : await osrmKm(poi);
    if (km == null) return "no_route";
    return { km, place: poi.name, ...zone(poi), source: pg ? "google" : "osm", precision: "poi", poi: poi.name, poiId: poi.id };
  }
  const g = await googleKm(dest).catch((e) => (console.error("Google Routes failed", (e as Error)?.name), null));
  if (g) {
    // Разстоянието от Google се приема само ако крайната му точка (обратно търсене) е въведеният номер в посоченото
    // населено място; друго населено място → ambiguous. Иначе (без точка, само улица) – резервният път по-долу.
    if (g.end) {
      const at = await reverse(g.end).catch(() => null);
      const precision = at && endPrecision(dest, at);
      if (precision === "house") return { km: g.km, place: g.place, ...zone(g.end), source: "google", precision };
      if (at && !precision) return "ambiguous";
    }
  }
  const p = await findPlace(dest);
  if (p === "ambiguous") return p;
  if (!p) return "not_found";
  // Само улица / населено място: не е точен адрес – клиентът потвърждава мястото с пин (маршрутът е до пина)
  if (p.precision === "street" || p.precision === "place") return { pin: true, lat: p.lat, lon: p.lon, found: p.precision };
  if (p.precision !== "house") return "imprecise";
  const km = await osrmKm(p);
  if (km == null) return "no_route";
  return { km, place: p.name, ...zone(p), source: "osm", precision: p.precision };
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
// Пин: ключът е по адреса и координатите на пина. Версия 5: само улица → пин (вместо отказ). Версия 4: проверени обекти (летищата, отделни терминали); версия 3: цена само до потвърден номер (версия 2 приемаше и точка от улицата); проверка на населеното място и улицата;
// точната начална точка (pin на офиса).
// Началната точка е част от ключа – при нова точка старите разстояния не се използват. Записите от версии 1–3 не се четат
// (не се изтриват – изтичат сами след 24 ч).
const CACHE_VERSION = "5";
export const ROUTE_VERSION = `${CACHE_VERSION}@${BASE.lat},${BASE.lon}`;
export const ROUTE_CACHE = { okTtlMs: 24 * 3600_000, failTtlMs: 15_000, errorTtlMs: 5_000, claimMs: 20_000, waitMs: 12_000, pollMs: 150 };
const cacheKey = (dest: string, pin?: Pin | null) =>
  "v" + CACHE_VERSION + "/" + createHash("sha256").update(ROUTE_VERSION + "\n" + normAddr(dest).toLowerCase() + (pin ? `\npin:${pin.lat},${pin.lon}` : "")).digest("hex");
const secs = (ms: number) => ms / 1000;
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export type CacheResult = Route | NeedPin | RouteError | "limited" | "timeout" | "error";

export async function cachedRoute(dest: string, o: { budget?: () => Promise<boolean>; pin?: Pin | null } = {}): Promise<CacheResult> {
  if (!validAddr(dest)) return "not_found";
  if (o.pin != null && !validPin(o.pin)) return "pin_town";
  const pin = o.pin ? roundPin(o.pin) : null;
  // С пин: първо адресът (обикновено от кеша) – друго населено място остава отказ; началната точка ограничава пина
  let near: Pin | null = null;
  if (pin) {
    const base = await cachedRoute(dest, { budget: o.budget });
    if (base === "ambiguous" || base === "terminal" || base === "limited" || base === "timeout" || base === "error") return base;
    if (typeof base === "object" && "pin" in base) near = { lat: base.lat, lon: base.lon };
    if (typeof base === "object" && !("pin" in base) && base.precision === "poi") return base; // летищата – проверената точка
  }
  const key = cacheKey(dest, pin);
  const deadline = Date.now() + ROUTE_CACHE.waitMs;
  for (;;) {
    const [row] = rowsOf(await db.execute(sql`select status, km, rate, local, source, precision, reason, expires_at > now() as fresh from route_cache where key = ${key}`));
    if (row?.fresh && row.status === "ok") {
      // При обект в reason е само публичният му ключ (напр. „sof-t2“) – името е от списъка POIS, без адреса
      const poi = row.precision === "poi" ? POIS[String(row.reason)] : null;
      return { km: Number(row.km), rate: Number(row.rate), local: !!row.local, source: row.source, precision: row.precision, place: "", ...(poi ? { poi: poi.name, poiId: poi.id } : {}) };
    }
    if (row?.fresh && row.status === "fail") {
      const m = /^pin:(street|place):(-?[\d.]+),(-?[\d.]+)$/.exec(String(row.reason));
      return m ? { pin: true, found: m[1] as "street" | "place", lat: +m[2], lon: +m[3] } : (row.reason as RouteError | "error");
    }
    if (!row?.fresh) {
      // Опит да бъде заето търсенето: успява само една заявка (нов ред или изтекъл / изоставен ред)
      const token = randomUUID();
      const claimed = rowsOf(await db.execute(sql`
        insert into route_cache (key, status, claim_token, claimed_at, expires_at) values (${key}, 'pending', ${token}, now(), now() + make_interval(secs => ${secs(ROUTE_CACHE.claimMs)}))
        on conflict (key) do update set status = 'pending', claim_token = excluded.claim_token, claimed_at = now(), expires_at = excluded.expires_at, km = null, rate = null, local = null, source = null, precision = null, reason = null
        where route_cache.expires_at <= now()
        returning key`)).length > 0;
      if (claimed) return lookup(key, token, dest, o.budget, pin, near);
    }
    if (Date.now() >= deadline) return "timeout";
    await sleep(ROUTE_CACHE.pollMs);
  }
}

async function lookup(key: string, token: string, dest: string, budget?: () => Promise<boolean>, pin?: Pin | null, near?: Pin | null): Promise<CacheResult> {
  const save = (status: "ok" | "fail", ttlMs: number, v: { km?: number; rate?: number; local?: boolean; source?: string; precision?: string; reason?: string }) =>
    db.execute(sql`update route_cache set status = ${status}, km = ${v.km ?? null}, rate = ${v.rate ?? null}, local = ${v.local ?? null}, source = ${v.source ?? null}, precision = ${v.precision ?? null},
      reason = ${v.reason ?? null}, expires_at = now() + make_interval(secs => ${secs(ttlMs)}) where key = ${key} and claim_token = ${token}`).catch(() => null);
  // Бюджетът се отчита само от заявката, която наистина ще пита доставчика
  if (budget && !(await budget())) {
    await db.execute(sql`delete from route_cache where key = ${key} and claim_token = ${token} and status = 'pending'`).catch(() => null);
    return "limited";
  }
  let r: Route | NeedPin | RouteError;
  try {
    r = pin ? await routeToPin(normAddr(dest), pin, near ?? null) : await routeTo(normAddr(dest));
  } catch (e) {
    console.error("Route lookup failed", (e as Error)?.name);
    await save("fail", ROUTE_CACHE.errorTtlMs, { reason: "error" });
    return "error";
  }
  // Нужен пин: началната точка (от OpenStreetMap) се пази като причина – без адреса; толкова дълго, колкото и маршрутите
  if (typeof r === "object" && "pin" in r) await save("fail", ROUTE_CACHE.okTtlMs, { reason: `pin:${r.found}:${r.lat},${r.lon}` });
  else if (typeof r === "string") await save("fail", ROUTE_CACHE.failTtlMs, { reason: r });
  else await save("ok", ROUTE_CACHE.okTtlMs, { km: r.km, rate: r.rate, local: r.local, source: r.source, precision: r.precision, reason: r.poiId });
  return r;
}
