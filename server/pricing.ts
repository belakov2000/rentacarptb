// Сървърно изчисление на цената по действащите правила на сайта (index.html – CARS/tiers, SEAT, ABROAD, KM, span(), quote()).
// Етап 1 – само наблюдение (observe): сървърът изчислява цената и я сравнява с подадената от браузъра, но НЕ я налага.
// Записаната резервация, сумата total, договорът и писмата остават по данните от браузъра. Наблюдението още НЕ защитава
// от подадена неправилна цена – само показва разликите (bookings.price_check / price_check_status).
// Константите тук трябва да съвпадат с index.html – проверява го tests/pricing.test.ts.
// Всички суми са цели евроцентове.

export const PRICING_VERSION = "2026-10-18.1";

// Дневна цена (евро) по брой дни: 1–15 / 16–30 / над 30. Цените вече са крайните (промоцията „−20%“ е само надпис).
const T20 = [20, 18, 15], T25 = [25, 23, 20];
export const TIERS: Record<string, readonly number[]> = { punto: T20, ka: T20, ibiza: T25, golf: T25, passat: T25 };
export const SEAT_DAY = 3; // детско столче, за брой на ден
export const MAX_SEATS = 2; // формата предлага 1 или 2
// Вътрешни правила за следващите етапи – още не се предлагат на клиентите и не идват от формата
export const CHAINS_DAY = 3.5; // зимни вериги, един комплект за автомобила, на ден
export const SECOND_DRIVER_DAY = 3; // втори (допълнителен) водач, на ден
export const DEPOSIT = 100; // гаранционен депозит – не влиза в сумата
export const KM_RATES = [1, 0.7];
// Пътуване в чужбина: еднократна такса за държава (код, име във формата, такса)
export const ABROAD: readonly (readonly [string, string, number])[] = [
  ["gr", "Гърция", 100], ["tr", "Турция", 130], ["ro", "Румъния", 110], ["rs", "Сърбия", 110], ["mk", "Северна Македония", 110],
  ["hu", "Унгария", 130], ["al", "Албания", 130], ["at", "Австрия", 150], ["de", "Германия", 180], ["es", "Испания", 190], ["it", "Италия", 190],
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const cents = (eur: number) => Math.round(eur * 100);

// Брой дни като на сайта (span) и при удължаване (rentalDays): всеки започнат период от 24 часа е ден, минимум 1
export function days(d1: string, t1: string, d2: string, t2: string) {
  const ms = Date.parse(`${d2}T${t2}:00Z`) - Date.parse(`${d1}T${t1}:00Z`);
  return ms < 0 ? -1 : Math.max(1, Math.ceil(ms / 864e5 - 1e-9));
}
export const dailyRate = (carId: string, d: number) => {
  const t = TIERS[carId];
  return t ? t[d > 30 ? 2 : d > 15 ? 1 : 0] : null;
};

export type Leg = { km: number; rate: number } | null;
export type PriceInput = {
  carId: string; startDate: string; startTime: string; endDate: string; endTime: string;
  seats: number; del: Leg; ret: Leg; abroad: string[]; chains?: boolean; secondDriver?: boolean;
};
export type Line = { code: "rent" | "seats" | "chains" | "second_driver" | "delivery" | "return" | "abroad"; cents: number; qty?: number; unitCents?: number; km?: number; rate?: number; country?: string };
export type Price = { ok: true; days: number; dailyCents: number; rentCents: number; lines: Line[]; totalCents: number; depositCents: number } | { ok: false; error: "car" | "dates" | "order" | "seats" | "km" | "country" };

export function price(i: PriceInput): Price {
  if (!DATE_RE.test(i.startDate) || !DATE_RE.test(i.endDate) || !TIME_RE.test(i.startTime) || !TIME_RE.test(i.endTime)) return { ok: false, error: "dates" };
  const d = days(i.startDate, i.startTime, i.endDate, i.endTime);
  if (d < 0) return { ok: false, error: "order" };
  const r = dailyRate(i.carId, d);
  if (r == null) return { ok: false, error: "car" };
  if (!Number.isInteger(i.seats) || i.seats < 0 || i.seats > MAX_SEATS) return { ok: false, error: "seats" };
  const lines: Line[] = [{ code: "rent", cents: cents(r) * d, qty: d, unitCents: cents(r) }];
  if (i.seats) lines.push({ code: "seats", cents: cents(SEAT_DAY) * i.seats * d, qty: i.seats * d, unitCents: cents(SEAT_DAY) });
  if (i.chains) lines.push({ code: "chains", cents: cents(CHAINS_DAY) * d, qty: d, unitCents: cents(CHAINS_DAY) });
  if (i.secondDriver) lines.push({ code: "second_driver", cents: cents(SECOND_DRIVER_DAY) * d, qty: d, unitCents: cents(SECOND_DRIVER_DAY) });
  for (const [code, l] of [["delivery", i.del], ["return", i.ret]] as const) {
    if (!l) continue;
    if (!Number.isFinite(l.km) || l.km < 0 || !KM_RATES.includes(l.rate)) return { ok: false, error: "km" };
    lines.push({ code, cents: cents(l.km * l.rate), km: l.km, rate: l.rate });
  }
  for (const c of i.abroad) {
    const a = ABROAD.find(([k]) => k === c);
    if (!a) return { ok: false, error: "country" };
    lines.push({ code: "abroad", cents: cents(a[2]), country: c });
  }
  return { ok: true, days: d, dailyCents: cents(r), rentCents: cents(r) * d, lines, totalCents: lines.reduce((t, l) => t + l.cents, 0), depositCents: cents(DEPOSIT) };
}

// ===== Наблюдение: сравнение със заявката от браузъра =====
// status: match – еднакво; mismatch – има разлика (reasons); incomplete – сравнението не може да бъде завършено
// (напр. маршрутът не е изчислен на сървъра – тогава НЕ се приема нито нулева доставка, нито стойността от браузъра);
// error – неочаквана грешка. Адресите не се записват – само км, тарифа и източник на маршрута.
export type RouteFn = (addr: string) => Promise<{ km: number; rate: number; source: string } | string>;
export type Check = {
  version: string; status: "match" | "mismatch" | "incomplete" | "error"; reasons: string[];
  // Сума от браузъра − сървърна сума (центове); null – няма с какво да се сравни
  diffCents: number | null;
  server: { days: number; dailyCents: number; rentCents: number; lines: Line[]; totalCents: number } | null;
  client: { totalCents: number | null; days: number | null; rentCents: number | null; seats: number; del: Leg; ret: Leg };
  route: { del?: { km: number; rate: number; source: string } | string; ret?: { km: number; rate: number; source: string } | string };
};

type Booking = { carId: string; startDate: string | null; startTime: string; endDate: string | null; endTime: string; totalCents: number | null };
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const legOf = (v: any): { addr: string; km: number | null; rate: number | null } | null =>
  v && typeof v === "object" && typeof v.addr === "string" && v.addr.trim() ? { addr: v.addr.trim().slice(0, 200), km: numOrNull(v.km), rate: numOrNull(v.rate) } : null;

export async function observe(b: Booking, contract: unknown, route: RouteFn, o: { timeoutMs?: number } = {}): Promise<Check> {
  const c = (contract && typeof contract === "object" ? contract : null) as Record<string, any> | null;
  const reasons: string[] = [];
  const seats = c ? Math.floor(numOrNull(c.seatN) ?? 0) * (numOrNull(c.seat) || numOrNull(c.seatDay) ? 1 : 0) : 0;
  const del = c ? legOf(c.del) : null, ret = c ? legOf(c.ret) : null;
  const client: Check["client"] = {
    totalCents: b.totalCents, days: c ? numOrNull(c.days) : null, rentCents: c && numOrNull(c.rent) != null ? cents(c.rent) : null, seats,
    del: del && del.km != null && del.rate != null ? { km: del.km, rate: del.rate } : null,
    ret: ret && ret.km != null && ret.rate != null ? { km: ret.km, rate: ret.rate } : null,
  };
  const out = (status: Check["status"], server: Check["server"] = null, routeInfo: Check["route"] = {}): Check => ({
    version: PRICING_VERSION, status, reasons, server, client, route: routeInfo,
    diffCents: server && client.totalCents != null ? client.totalCents - server.totalCents : null,
  });
  if (!c) return reasons.push("no_contract"), out("incomplete");
  if (!b.startDate || !b.endDate) return reasons.push("no_dates"), out("incomplete");

  // Държави – по името от формата (браузърът праща имената); непознато име е разлика, не се пропуска
  const abroad: string[] = [];
  for (const a of Array.isArray(c.abroad) ? c.abroad.slice(0, 20) : []) {
    const hit = ABROAD.find(([, n]) => n === String(a?.name ?? "").trim());
    if (hit) abroad.push(hit[0]);
    else reasons.push("unknown_country");
  }

  // Маршрутите се изчисляват отново на сървъра; при неуспех – incomplete (без нула и без стойността от браузъра)
  const routeInfo: Check["route"] = {};
  const timeout = o.timeoutMs ?? 10_000;
  const legs: Record<"del" | "ret", Leg> = { del: null, ret: null };
  for (const [k, l] of [["del", del], ["ret", ret]] as const) {
    if (!l) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([route(l.addr).catch(() => "error"), new Promise<string>((res) => (timer = setTimeout(() => res("timeout"), timeout)))]);
    clearTimeout(timer);
    routeInfo[k] = r;
    if (typeof r === "string") reasons.push(`route_${k}_${r}`);
    else legs[k] = { km: r.km, rate: r.rate };
  }
  if ((del && !legs.del) || (ret && !legs.ret)) return out("incomplete", null, routeInfo);

  const p = price({ carId: b.carId, startDate: b.startDate, startTime: b.startTime, endDate: b.endDate, endTime: b.endTime, seats, del: legs.del, ret: legs.ret, abroad });
  if (!p.ok) return reasons.push(`server_${p.error}`), out(p.error === "seats" || p.error === "country" ? "mismatch" : "incomplete", null, routeInfo);
  const server = { days: p.days, dailyCents: p.dailyCents, rentCents: p.rentCents, lines: p.lines, totalCents: p.totalCents };
  // Браузърът е показал сума без доставката (разстоянието не е било изчислено) – сумата не може да бъде сравнена
  if (b.totalCents == null) return reasons.push("client_total_unparsed"), out("incomplete", server, routeInfo);
  if (client.days !== p.days) reasons.push("days");
  if (client.rentCents !== p.rentCents) reasons.push("rent");
  for (const k of ["del", "ret"] as const) {
    const s = legs[k], cl = client[k];
    if (s && (!cl || cl.km !== s.km)) reasons.push(`km_${k}`);
    if (s && cl && cl.rate !== s.rate) reasons.push(`rate_${k}`);
  }
  if (b.totalCents !== p.totalCents) reasons.push("total");
  return out(reasons.length ? "mismatch" : "match", server, routeInfo);
}
