// Google Places API (New): предложения за адрес (Autocomplete) и проверка на избраното място (Place Details).
// Ключът е само на сървъра (GOOGLE_MAPS_API_KEY – същият като за Routes API); браузърът вика /api/places и никога не вижда ключа.
// Сесии: браузърът създава случаен ключ на сесията за всяко търсене в едно поле; предложенията и проверката на избора
// (Place Details със същия ключ) са една сесия за таксуване. Резултатът е само за България (includedRegionCodes: bg),
// без ограничаване до Пловдив. Предложенията не се кешират и не се записват; Place ID може да се пази (изключение в
// правилата на Google). В базата не се пазят координати – само км и тарифата (server/route.ts, route_cache).
// В логовете няма адреси, въведен текст и отговори на Google – само кодове на грешки.
import type { GPlace } from "./geocode.js";

export const placesKey = () => process.env.GOOGLE_MAPS_API_KEY || "";
export const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;
export const SESSION_RE = /^[a-f0-9]{32}$/;
const LANGS = ["bg", "en", "de"];

export type Suggestion = { id: string; main: string; secondary: string; types: string[] };

export async function autocomplete(input: string, session: string, lang: string): Promise<Suggestion[] | "unavailable" | "error"> {
  const key = placesKey();
  if (!key) return "unavailable";
  const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.text.text,suggestions.placePrediction.types",
    },
    body: JSON.stringify({ input, sessionToken: session, includedRegionCodes: ["bg"], regionCode: "bg", languageCode: LANGS.includes(lang) ? lang : "bg", includeQueryPredictions: false }),
  }).catch((e) => (console.error("Places autocomplete failed", (e as Error)?.name), null));
  if (!r) return "error";
  const j: any = await r.json().catch(() => null);
  if (!r.ok) {
    console.error("Places autocomplete error", r.status, String(j?.error?.status || "").slice(0, 40));
    return "error";
  }
  const out: Suggestion[] = [];
  for (const s of Array.isArray(j?.suggestions) ? j.suggestions : []) {
    const p = s?.placePrediction;
    if (!p || !PLACE_ID_RE.test(String(p.placeId || ""))) continue;
    const main = String(p.structuredFormat?.mainText?.text || p.text?.text || "").slice(0, 150);
    const secondary = String(p.structuredFormat?.secondaryText?.text || "").slice(0, 150);
    if (main) out.push({ id: p.placeId, main, secondary, types: (Array.isArray(p.types) ? p.types : []).slice(0, 10).map(String) });
  }
  return out.slice(0, 5);
}

// Подробности за избраното място (само полетата, нужни за проверката: SKU Place Details Essentials).
// null – мястото не съществува / невалиден ID; изключение – мрежова грешка или грешка на Google (извикващият решава).
export async function placeDetails(id: string, session: string | null): Promise<GPlace | null> {
  const key = placesKey();
  if (!key) throw new Error("places_unavailable");
  const u = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`);
  u.search = new URLSearchParams({ languageCode: "bg", regionCode: "bg", ...(session && SESSION_RE.test(session) ? { sessionToken: session } : {}) }).toString();
  const r = await fetch(u, { headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "id,formattedAddress,location,addressComponents,types" } });
  const j: any = await r.json().catch(() => null);
  if (r.status === 404 || (r.status === 400 && j?.error?.status === "INVALID_ARGUMENT")) return null;
  if (!r.ok) {
    console.error("Place details error", r.status, String(j?.error?.status || "").slice(0, 40));
    throw new Error("place_details_" + r.status);
  }
  return j;
}
