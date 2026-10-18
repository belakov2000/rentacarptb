// Сървърно изчисление на цената по действащите правила на сайта (index.html – CARS/tiers, SEAT, ABROAD, KM, span(), quote()).
// Етап 2 – сървърът определя цената: /api/quote (server/quote.ts) изчислява офертата, а /api/bookings записва само
// сума и разбивка от валидна сървърна оферта. Сумата от браузъра не се приема. Записаната резервация (total / totalCents),
// договорът, писмата и админ панелът ползват тази сума. Старите резервации не се преизчисляват.
// Константите тук трябва да съвпадат с index.html – проверява го tests/pricing.test.ts.
// Всички суми са цели евроцентове.

export const PRICING_VERSION = "2026-10-18.2";

// Дневна цена (евро) по брой дни: 1–15 / 16–30 / над 30. Цените вече са крайните (промоцията „−20%“ е само надпис).
const T20 = [20, 18, 15], T25 = [25, 23, 20];
export const TIERS: Record<string, readonly number[]> = { punto: T20, ka: T20, ibiza: T25, golf: T25, passat: T25 };
export const SEAT_DAY = 3; // детско столче, за брой на ден
export const MAX_SEATS = 2; // формата предлага 1 или 2
// Вътрешни правила за следващите етапи – още не се предлагат на клиентите: /api/quote и /api/bookings ги отказват
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
// discount – отстъпка RENTY10 (отрицателна сума; само върху наема), добавя се при подаването на документите
export type Line = { code: "rent" | "seats" | "chains" | "second_driver" | "delivery" | "return" | "abroad" | "discount"; cents: number; qty?: number; unitCents?: number; km?: number; rate?: number; country?: string };
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

// ===== Текст на сумите (същият формат като fmt() на сайта и db/money.ts: „50 €“, „12,40 €“) =====
export const fmtCents = (c: number) => {
  const s = (c / 100).toFixed(2).replace(".", ",");
  return (s.endsWith(",00") ? s.slice(0, -3) : s) + " €";
};
const kmTxt = (km: number) => String(km).replace(".", ",");
const rateTxt = (r: number) => r.toFixed(2).replace(".", ",") + " €/км";
export const countryName = (code: string) => ABROAD.find(([k]) => k === code)?.[1] || code;

// Разбивката като редове текст – за известието до фирмата (без адреси и лични данни)
export function priceLines(p: { days: number; lines: Line[]; totalCents: number; depositCents: number }) {
  const out = p.lines.map((l) => {
    if (l.code === "rent") return `Наем: ${p.days} ${p.days === 1 ? "ден" : "дни"} × ${fmtCents(l.unitCents!)} = ${fmtCents(l.cents)}`;
    if (l.code === "seats") return `Детско столче: ${l.qty! / p.days} бр. × ${p.days} ${p.days === 1 ? "ден" : "дни"} × ${fmtCents(l.unitCents!)} = ${fmtCents(l.cents)}`;
    if (l.code === "delivery") return `Доставка до адрес: ${kmTxt(l.km!)} км × ${rateTxt(l.rate!)} = ${fmtCents(l.cents)}`;
    if (l.code === "return") return `Връщане от адрес: ${kmTxt(l.km!)} км × ${rateTxt(l.rate!)} = ${fmtCents(l.cents)}`;
    if (l.code === "abroad") return `Пътуване в чужбина – ${countryName(l.country!)}: ${fmtCents(l.cents)}`;
    if (l.code === "chains") return `Вериги за сняг: ${p.days} ${p.days === 1 ? "ден" : "дни"} × ${fmtCents(l.unitCents!)} = ${fmtCents(l.cents)}`;
    if (l.code === "second_driver") return `Втори (допълнителен) водач: ${p.days} ${p.days === 1 ? "ден" : "дни"} × ${fmtCents(l.unitCents!)} = ${fmtCents(l.cents)}`;
    if (l.code === "discount") return `Отстъпка RENTY10 (10% от наема): −${fmtCents(-l.cents)}`;
    return `${l.code}: ${fmtCents(l.cents)}`;
  });
  return [...out, `Общо за услугите: ${fmtCents(p.totalCents)}`, `Гаранционен депозит (не е част от сумата): ${fmtCents(p.depositCents)}`];
}
