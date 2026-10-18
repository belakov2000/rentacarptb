// Проверка на резултата от търсенето на адрес (OpenStreetMap / Nominatim) преди изчисляване на маршрута.
// Намереното място се приема само ако е в населеното място от адреса и (ако е посочена улица) на същата улица.
// Причина: „гр. Пловдив, пл. Централен 1“ се намираше като „пл. Централен“ в с. Бяла река (общ. Първомай) – „Пловдив“
// съвпада и с името на областта – и сайтът изчисляваше 49,8 км × 0,70 € вместо маршрут до центъра на Пловдив.
// Точност (precision) на намереното място:
//   "house"  – намерен е въведеният номер на сградата (address.house_number съвпада);
//   "street" – намерена е само улицата (номерът липсва в OpenStreetMap или не е въведен);
//   "place"  – само населеното място (адрес без улица, напр. „с. Брестник“, или село без улици в OpenStreetMap).
// Цена се изчислява само при "house" (server/route.ts); "street" и "place" → отказ „imprecise“ (уточняване / обаждане).
// Без външни заявки и без база – само правилата (проверява ги tests/geocode.test.ts).

export type NomResult = {
  lat: string; lon: string; display_name: string; name?: string; addresstype?: string; place_rank?: number;
  address?: Record<string, string>;
};
// "poi" – проверен обект без стандартен адрес (летище / терминал – matchPoi() по-долу)
export type Precision = "house" | "street" | "place" | "poi";
export type Place = { lat: number; lon: number; name: string; precision: Precision };

// Сравнение без значение на азбуката, главните букви, кавичките и препинателните знаци („Plovdiv“ = „Пловдив“)
const LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sht", ъ: "a", ь: "y", ю: "yu", я: "ya", ѝ: "i",
  і: "i", // кирилско „І“ в римски цифри („Александър І“)
};
export const fold = (s: string) =>
  String(s || "").toLowerCase().replace(/[а-яѝі]/g, (c) => LAT[c] ?? c)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // „Aéroport“ = „Aeroport“ (кирилицата вече е заменена)
    .replace(/[^a-z0-9]+/g, " ").trim();

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

// towns / street – за сравнение (fold); townText / streetText – както са въведени (без „гр.“ / „ул.“), за заявките;
// number – номерът на сградата от улицата („10“, „10а“), ако е въведен
// bare – населеното място е въведено без „гр.“ / „с.“ (може да е и квартал на Пловдив: „Кършияка, ул. …“)
export type Parsed = { towns: string[]; bare: boolean; street: string | null; area: boolean; townText: string | null; streetText: string | null; number: string | null };
const NUMBER_RE = /(?:^|\s)(?:№\s*|no\.?\s*)?(\d+[а-яa-z]?)\s*$/i;

// Населено място и улица от въведения адрес. Без посочено населено място адресът е в Пловдив (както и при търсенето).
// Самостоятелна част без цифри („Асеновград, ул. …“) също се приема за населено място.
export function parseAddr(addr: string): Parsed {
  const parts = String(addr || "").split(",").map((p) => p.trim()).filter(Boolean);
  const explicit: string[] = [], bare: string[] = [], bareText: string[] = [];
  let street: string | null = null, area = false, townText: string | null = null, streetText: string | null = null, number: string | null = null, villageNo: string | null = null;
  // streetText остава с „ул.“ / „бул.“ – структурираното търсене различава „бул. Дунав“ от „ул. Дунав“
  const setStreet = (name: string, part: string, isArea = false) => {
    if (street != null) return;
    street = core(stripNo(name)); streetText = part.split(/\s(бл|вх|ет|ап)(\.|\s)/i)[0].trim(); area = isArea;
    number = isArea ? null : NUMBER_RE.exec(streetText)?.[1] ?? null;
  };
  for (const p of parts) {
    let m: RegExpExecArray | null;
    if ((m = TOWN_RE.exec(p))) {
      explicit.push(fold(stripNo(m[3]))); townText ??= stripNo(m[3]);
      villageNo ??= NUMBER_RE.exec(m[3])?.[1] ?? null; // „с. Брестник 5“ – номер в село без улици
    }
    else if (ADMIN_RE.test(p) || /^(бл|вх|ет|ап|блок|вход|етаж|апартамент)(\.\s*|\s+)/i.test(p)) continue; // област / община, блок / вход / етаж
    else if ((m = STREET_RE.exec(p))) setStreet(m[3], p);
    else if ((m = AREA_RE.exec(p))) setStreet(m[3], p, true);
    else if (fold(p) === PLOVDIV) { explicit.push(PLOVDIV); townText ??= p; }
    else if (!/\d/.test(p)) { bare.push(fold(p)); bareText.push(p); }
    else setStreet(p, p); // „Свобода 73“ – улица без „ул.“
  }
  const mentionsPlovdiv = parts.some((p) => fold(p).split(" ").includes(PLOVDIV));
  // Част без цифри, която съдържа „Пловдив“ („Летище Пловдив“), е обект, а не населено място
  const isBare = !explicit.length && !mentionsPlovdiv && bare.length > 0;
  const towns = explicit.length ? explicit : mentionsPlovdiv ? (street ? [PLOVDIV] : []) : isBare ? bare : [PLOVDIV];
  townText ??= isBare ? bareText[0] : towns[0] === PLOVDIV ? "Пловдив" : null;
  return { towns: [...new Set(towns.filter(Boolean))], bare: isBare, street: street || null, area, townText, streetText, number: street ? number : villageNo };
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

// Населеното място от адреса съвпада ли с резултата (име без „гр.“ може да е и квартал / район на града)
const townOk = (p: Parsed, r: NomResult) => {
  if (!p.towns.length) return true;
  if (p.towns.includes(localityOf(r))) return true;
  const a = r.address || {};
  return p.bare && ["suburb", "quarter", "neighbourhood", "city_district"].some((k) => a[k] && p.towns.includes(core(a[k])));
};
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

// Номерът от резултата съвпада ли с въведения („10“ = „10“, „10А“ = „10а“, „10-12“ съдържа „10“ и „12“)
const sameNumber = (want: string, have: string | undefined) =>
  !!have && String(have).split(/[;,\s]+|(?<=\d)-(?=\d)/).map(fold).filter(Boolean).includes(fold(want));

// Точността, с която резултатът отговаря на адреса; null – не се приема (друго населено място / друга улица)
export function accepts(p: Parsed, r: NomResult): Precision | null {
  if (!r.address) return null; // без подробности за адреса мястото не може да бъде проверено
  if (!townOk(p, r)) return null;
  if (!p.street) return p.number && sameNumber(p.number, r.address.house_number) ? "house" : "place";
  if (streetNames(r, p.area).some((n) => sameStreet(p.street!, n))) return p.number && sameNumber(p.number, r.address.house_number) ? "house" : "street";
  // Селата често нямат улици в OpenStreetMap – тогава се приема центърът на селото
  return VILLAGE_TYPES.has(String(r.addresstype || "")) && (r.place_rank ?? 0) < 26 ? "place" : null;
}

const RANK: Record<Precision, number> = { house: 3, street: 2, place: 1 };
// Най-точният резултат, който отговаря на адреса (при равна точност – първият). "ambiguous" – има резултати, но никой
// не е в посоченото населено място / на посочената улица (клиентът трябва да уточни адреса); null – няма резултати.
export function pickPlace(addr: string, results: NomResult[]): Place | "ambiguous" | null {
  if (!results.length) return null;
  const p = parseAddr(addr);
  let best: Place | null = null;
  for (const r of results) {
    const precision = accepts(p, r);
    if (precision && (!best || RANK[precision] > RANK[best.precision])) best = { lat: +r.lat, lon: +r.lon, name: r.display_name, precision };
  }
  return best ?? "ambiguous";
}

// Проверка на крайната точка от друг доставчик (Google) чрез обратно търсене: същото населено място (иначе null) и
// точността – „house“ само ако в точката е въведеният номер на въведената улица
export function endPrecision(addr: string, r: NomResult | null): Precision | null {
  const p = parseAddr(addr);
  if (!r || !r.address) return p.towns.length ? null : "place";
  if (!townOk(p, r)) return null;
  if (!p.street) return p.number && sameNumber(p.number, r.address.house_number) ? "house" : "place";
  return streetNames(r, p.area).some((n) => sameStreet(p.street!, n)) && p.number && sameNumber(p.number, r.address.house_number) ? "house" : "street";
}

// ===== Обекти без стандартен адрес =====
// Проверени обекти без стандартен адрес (улица и номер): летищата. Маршрутът се изчислява на сървъра до автомобилната
// точка пред входа на терминала (публичния път пред сградата), не до центъра на летището или пистата.
// Точката е само крайна точка за изчисляване на маршрута – не означава, че там е разрешено спиране или че достъпът е безплатен.
// Източник: OpenStreetMap (18.10.2026) – сградата на терминала (aeroway=terminal) и входовете ѝ; точката е най-близката точка
// на път за автомобили пред входа / фасадата, определена с OSRM nearest (3–25 м):
//   Летище София, Терминал 1 – сграда way/89155443 (южна фасада; входове не са отбелязани в OpenStreetMap);
//   Летище София, Терминал 2 – сграда way/53563578, вход node/1034001277, път way/89092791;
//   Летище Пловдив – сграда way/194571760 (източна фасада, откъм публичния път).
// Терминал 1 и Терминал 2 са на около 1 км един от друг и не са взаимозаменяеми: при неясен терминал → "terminal"
// (клиентът избира терминала), никога първият резултат. Проверява го tests/places.test.ts.

export type Poi = { id: string; name: string; lat: number; lon: number };
export const POIS: Record<string, Poi> = {
  "sof-t1": { id: "sof-t1", name: "Летище София, Терминал 1", lat: 42.689058, lon: 23.402457 },
  "sof-t2": { id: "sof-t2", name: "Летище София, Терминал 2", lat: 42.688069, lon: 23.414214 },
  pdv: { id: "pdv", name: "Летище Пловдив", lat: 42.076899, lon: 24.844729 },
};

// След fold() текстът е на латиница, с малки букви и интервали вместо препинателни знаци
const POI_AIRPORT = /\b(letishte|letishteto|airport|flughafen|aerogara|aeroport)\b/;
const POI_SOFIA = /\b(sofiya|sofia|sofija|vasil levski|sof|lbsf)\b/;
const POI_PLOVDIV = /\b(plovdiv|plowdiw|krumovo|pdv|lbpd)\b/;
// Посочена улица / квартал → обикновен адрес (строга проверка на улица и номер), не обект
const POI_STREET = /\b(ul|ulitsa|bul|bulevard|blvd|zhk|kv|kvartal|str|strasse|street)\b/;
// „Терминал 2“, „Terminal 2“, „Т2“, „T 2“
const POI_TERMINAL = /\b(?:terminal|terminala|t)\s*(\d+)\b/g;

// Обектът в адреса: Poi; "terminal" – Летище София без надеждно посочен терминал (няма, два или непознат номер);
// "ambiguous" – посочени са две летища; null – не е обект (обикновен адрес).
export function matchPoi(addr: string): Poi | "terminal" | "ambiguous" | null {
  const t = fold(addr);
  if (!POI_AIRPORT.test(t) || POI_STREET.test(t)) return null;
  const sof = POI_SOFIA.test(t), pdv = POI_PLOVDIV.test(t);
  if (sof && pdv) return "ambiguous";
  if (pdv) return POIS.pdv;
  if (!sof) return null;
  const terms = new Set([...t.matchAll(POI_TERMINAL)].map((m) => m[1]));
  // Всяко друго число в текста („Терминал 1 или 2“) прави терминала неясен
  const nums = t.match(/\d+/g) || [];
  if (terms.size !== 1 || nums.some((x) => !terms.has(x))) return "terminal";
  const n = [...terms][0];
  return n === "1" ? POIS["sof-t1"] : n === "2" ? POIS["sof-t2"] : "terminal";
}
