// Проверка на резултата от търсенето на адрес (OpenStreetMap / Nominatim) преди изчисляване на маршрута.
// Намереното място се приема само ако е в населеното място от адреса и (ако е посочена улица) на същата улица.
// Причина: „гр. Пловдив, пл. Централен 1“ се намираше като „пл. Централен“ в с. Бяла река (общ. Първомай) – „Пловдив“
// съвпада и с името на областта – и сайтът изчисляваше 49,8 км × 0,70 € вместо маршрут до центъра на Пловдив.
// Без външни заявки и без база – само правилата (проверява ги tests/geocode.test.ts).

export type NomResult = {
  lat: string; lon: string; display_name: string; name?: string; addresstype?: string; place_rank?: number;
  address?: Record<string, string>;
};
export type Place = { lat: number; lon: number; name: string };

// Сравнение без значение на азбуката, главните букви, кавичките и препинателните знаци („Plovdiv“ = „Пловдив“)
const LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sht", ъ: "a", ь: "y", ю: "yu", я: "ya", ѝ: "i",
};
export const fold = (s: string) =>
  String(s || "").toLowerCase().replace(/[а-яѝ]/g, (c) => LAT[c] ?? c).replace(/[^a-z0-9]+/g, " ").trim();

const PLOVDIV = "plovdiv";
const TOWN_RE = /^(гр|град|с|село|gr|grad|s|selo)(\.\s*|\s+)(.+)$/i;
const ADMIN_RE = /^(обл|област|общ|община|obl|obsht)(\.\s*|\s+)/i;
const STREET_RE = /^(ул|улица|бул|булевард|пл|площад|ul|bul|blvd|pl)(\.\s*|\s+)(.+)$/i;
const AREA_RE = /^(жк|ж\.\s*к|кв|квартал|zhk|kv)(\.\s*|\s+)(.+)$/i;
// Думите за вида на улицата не участват в сравнението („бул. Дунав“ = „булевард Дунав“ = „Дунав“)
const KIND_WORDS = new Set(["ul", "ulitsa", "bul", "bulevard", "blvd", "pl", "ploshtad", "zhk", "zh", "k", "kv", "kvartal", "str", "street"]);
const core = (s: string) => fold(s).split(" ").filter((w) => !KIND_WORDS.has(w)).join(" ");
// Номер и данни за блок / вход / етаж / апартамент в края на улицата
const stripNo = (s: string) => s.split(/\s(бл|вх|ет|ап)(\.|\s)/i)[0].replace(/\s*(№|no\.?)?\s*\d+[а-яa-z]?\s*$/i, "").trim();

// towns / street – за сравнение (fold); townText / streetText – както са въведени (без „гр.“ / „ул.“), за заявките
export type Parsed = { towns: string[]; street: string | null; area: boolean; townText: string | null; streetText: string | null };

// Населено място и улица от въведения адрес. Без посочено населено място адресът е в Пловдив (както и при търсенето).
// Самостоятелна част без цифри („Асеновград, ул. …“) също се приема за населено място.
export function parseAddr(addr: string): Parsed {
  const parts = String(addr || "").split(",").map((p) => p.trim()).filter(Boolean);
  const explicit: string[] = [], bare: string[] = [];
  let street: string | null = null, area = false, townText: string | null = null, streetText: string | null = null;
  // streetText остава с „ул.“ / „бул.“ – структурираното търсене различава „бул. Дунав“ от „ул. Дунав“
  const setStreet = (name: string, part: string, isArea = false) => {
    if (street != null) return;
    street = core(stripNo(name)); streetText = part.split(/\s(бл|вх|ет|ап)(\.|\s)/i)[0].trim(); area = isArea;
  };
  for (const p of parts) {
    let m: RegExpExecArray | null;
    if ((m = TOWN_RE.exec(p))) { explicit.push(fold(stripNo(m[3]))); townText ??= stripNo(m[3]); }
    else if (ADMIN_RE.test(p)) continue;
    else if ((m = STREET_RE.exec(p))) setStreet(m[3], p);
    else if ((m = AREA_RE.exec(p))) setStreet(m[3], p, true);
    else if (fold(p) === PLOVDIV) { explicit.push(PLOVDIV); townText ??= p; }
    else if (!/\d/.test(p)) bare.push(fold(p));
    else setStreet(p, p); // „Свобода 73“ – улица без „ул.“
  }
  const mentionsPlovdiv = parts.some((p) => fold(p).split(" ").includes(PLOVDIV));
  // Част без цифри, която съдържа „Пловдив“ („Летище Пловдив“), е обект, а не населено място
  const towns = explicit.length ? explicit : mentionsPlovdiv ? (street ? [PLOVDIV] : []) : [PLOVDIV, ...bare];
  return { towns: [...new Set(towns.filter(Boolean))], street: street || null, area, townText: townText ?? (towns[0] === PLOVDIV ? "Пловдив" : null), streetText };
}

// Заявките към Nominatim по ред: свободен текст; улица + населено място (структурирано търсене – Nominatim
// понякога не намира „гр. … , ул. …“ като свободен текст); без „гр.“ / „ул.“. Спира се при първия приет резултат.
export function queriesFor(addr: string, full: string): Record<string, string>[] {
  const p = parseAddr(addr);
  const out: Record<string, string>[] = [{ q: full }];
  if (p.streetText && p.townText && !p.area) {
    // Номерът се подава преди улицата („10 бул. Дунав“ не се намира, „бул. Дунав 10“ – да)
    out.push({ street: p.streetText, city: p.townText });
    const plain = [p.streetText.replace(STREET_RE, "$3"), p.townText].join(", ");
    if (plain !== full) out.push({ q: plain });
  }
  return out;
}

const VILLAGE_TYPES = new Set(["village", "hamlet", "isolated_dwelling"]);
const localityOf = (r: NomResult) => {
  const a = r.address || {};
  return fold(a.city || a.town || a.village || a.hamlet || a.isolated_dwelling || "");
};
const streetNames = (r: NomResult, area: boolean) => {
  const a = r.address || {};
  const keys = area ? ["suburb", "neighbourhood", "quarter", "residential", "city_district"] : ["road", "pedestrian", "square", "footway", "cycleway", "path", "place"];
  return [r.name || "", ...keys.map((k) => a[k] || "")].map(core).filter(Boolean);
};
const sameStreet = (want: string, have: string) => {
  const w = ` ${want} `, h = ` ${have} `;
  return h.includes(w) || w.includes(h);
};

// Приема ли се резултатът за този адрес
export function accepts(p: Parsed, r: NomResult) {
  if (!r.address) return false; // без подробности за адреса мястото не може да бъде проверено
  if (p.towns.length && !p.towns.includes(localityOf(r))) return false;
  if (!p.street) return true;
  if (streetNames(r, p.area).some((n) => sameStreet(p.street!, n))) return true;
  // Селата често нямат улици в OpenStreetMap – тогава се приема центърът на селото
  return VILLAGE_TYPES.has(String(r.addresstype || "")) && (r.place_rank ?? 0) < 26;
}

// Първият резултат, който отговаря на адреса. "ambiguous" – има резултати, но никой не е в посоченото населено място /
// на посочената улица (клиентът трябва да уточни адреса); null – няма резултати.
export function pickPlace(addr: string, results: NomResult[]): Place | "ambiguous" | null {
  if (!results.length) return null;
  const p = parseAddr(addr);
  const hit = results.find((r) => accepts(p, r));
  return hit ? { lat: +hit.lat, lon: +hit.lon, name: hit.display_name } : "ambiguous";
}

// Проверка на крайната точка от друг доставчик (Google): населеното място в нея (обратно търсене) трябва да е посоченото
export function townMatches(addr: string, r: NomResult | null) {
  const p = parseAddr(addr);
  if (!p.towns.length) return true;
  return !!r && p.towns.includes(localityOf(r));
}
