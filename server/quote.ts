import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { cars, priceQuotes } from "../db/schema.js";
import { minutes } from "../db/slots.js";
import { sofiaToday, withinHours } from "../db/hours.js";
import type { ContractData } from "../contract/index.js";
import { ABROAD, fmtCents, MAX_SEATS, price, PRICING_VERSION, SEAT_DAY, TIERS, type Leg, type Line } from "./pricing.js";
import { cachedRoute, normAddr, validAddr, validPin, type CacheResult, type Pin } from "./route.js";

// Сървърна ценова оферта (етап 2 – сървърът определя цената).
// 1) POST /api/quote: автомобил, дати, часове, места (адресите за доставка / връщане), столчета и държави →
//    сървърът изчислява маршрутите (кеш route_cache в базата, server/route.ts) и цената (server/pricing.ts) и връща разбивката, сумата и таен ключ.
// 2) POST /api/bookings приема резервация само с ключа на валидна оферта: неизтекла, неизползвана, за същите входни данни
//    и със същата сума, каквато клиентът е видял (quoteTotalCents). Цената се изчислява отново по текущите правила –
//    ако е различна, резервацията НЕ се записва, а браузърът показва новата сума и иска ново потвърждение.
// Офертата не блокира наличност – заетостта се проверява при подаването и при потвърждението, както досега.
// Веригите и вторият водач не се предлагат в този етап – заявка с тях се отказва (service).

export const QUOTE_TTL_MS = 30 * 60_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type QuoteInput = {
  carId: string; startDate: string; startTime: string; endDate: string; endTime: string;
  seats: number; del: string | null; ret: string | null; abroad: string[];
  // Точка, посочена и потвърдена от клиента на картата (когато за адреса е намерена само улицата / населеното място)
  delPin?: Pin | null; retPin?: Pin | null;
};
export type InputError = "dates" | "past" | "order" | "hours" | "car" | "seats" | "country" | "service" | "address" | "pin";

// Отпечатък на входните данни: адресите участват само като хеш (нормализирани, без значение на главни/малки букви)
export function inputHash(i: QuoteInput) {
  const a = (v: string | null) => (v ? sha(normAddr(v).toLowerCase()) : null);
  // Потвърдените пинове участват в отпечатъка – офертата е за точно тези местоположения (до 6 знака)
  const pt = (p?: Pin | null) => (p ? `${Math.round(p.lat * 1e6) / 1e6},${Math.round(p.lon * 1e6) / 1e6}` : null);
  const pl = i.delPin || i.retPin ? [[pt(i.delPin), pt(i.retPin)]] : [];
  return sha(JSON.stringify([i.carId, i.startDate, i.startTime, i.endDate, i.endTime, i.seats, a(i.del), a(i.ret), [...i.abroad].sort(), ...pl]));
}

// Проверка на входните данни – същите правила като при подаването на резервацията (работно време, не по-рано от днес)
export function checkInput(i: QuoteInput, today = sofiaToday()): InputError | "" {
  if (!DATE_RE.test(i.startDate) || !DATE_RE.test(i.endDate) || !TIME_RE.test(i.startTime) || !TIME_RE.test(i.endTime)) return "dates";
  if (i.startDate < today) return "past";
  if (minutes(i.endDate, i.endTime) < minutes(i.startDate, i.startTime)) return "order";
  if (!withinHours(i.startDate, i.startTime) || !withinHours(i.endDate, i.endTime)) return "hours";
  if (!TIERS[i.carId]) return "car";
  if (!Number.isInteger(i.seats) || i.seats < 0 || i.seats > MAX_SEATS) return "seats";
  if (new Set(i.abroad).size !== i.abroad.length || i.abroad.some((c) => !ABROAD.some(([k]) => k === c))) return "country";
  // Адресът се проверява преди търсенето при доставчика (server/route.ts → validAddr)
  for (const a of [i.del, i.ret]) if (a != null && !validAddr(a)) return "address";
  // Пин без адрес към него или извън България
  for (const [a, pn] of [[i.del, i.delPin], [i.ret, i.retPin]] as const) if (pn && (a == null || !validPin(pn))) return "pin";
  return "";
}

const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
// Адрес до 300 знака (по-дългият се отказва като невалиден, не се съкращава до „друг“ адрес)
const addrOf = (v: unknown) => (typeof v === "string" && v.trim() ? (v.length > 300 ? "\u0000" : normAddr(v)) : null);
// { lat, lon } от браузъра; празно → null; друга форма → невалиден пин (отказва се в checkInput)
const pinOf = (v: unknown): Pin | null => {
  if (v == null) return null;
  const o = v as any;
  return { lat: typeof o?.lat === "number" ? o.lat : NaN, lon: typeof o?.lon === "number" ? o.lon : NaN, ...(o?.free === true ? { free: true } : {}) };
};
const hidden = (o: any) => !!(o && typeof o === "object" && (o.chains || o.secondDriver || o.second_driver));

// Тялото на /api/quote
export function parseQuoteBody(b: any): { input: QuoteInput } | { error: InputError } {
  if (!b || typeof b !== "object") return { error: "dates" };
  if (hidden(b) || hidden(b.services) || b.extras != null) return { error: "service" };
  if (Array.isArray(b.abroad) && b.abroad.length > ABROAD.length) return { error: "country" };
  const abroad = Array.isArray(b.abroad) ? b.abroad.map((c: unknown) => s(c, 4)) : [];
  const seats = b.seats == null ? 0 : typeof b.seats === "number" ? b.seats : NaN;
  return {
    input: {
      carId: s(b.carId, 40), startDate: s(b.startDate, 10), startTime: s(b.startTime, 5), endDate: s(b.endDate, 10), endTime: s(b.endTime, 5),
      seats, del: addrOf(b.delivery), ret: addrOf(b.return), abroad,
      delPin: pinOf(b.deliveryPin), retPin: pinOf(b.returnPin),
    },
  };
}

// Входните данни на подадената резервация – от същите полета, от които се попълва договорът (contract):
// столчета (seatN), адреси за доставка / връщане и държави (по името от формата). Сумите от браузъра не се ползват.
export function bookingInput(b: { carId: string; startDate: string; startTime: string; endDate: string; endTime: string }, body: any): { input: QuoteInput } | { error: InputError } {
  const c = body?.contract && typeof body.contract === "object" ? body.contract : null;
  if (hidden(body) || hidden(c) || hidden(body?.services) || body?.extras != null) return { error: "service" };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const seats = c && (n(c.seat) > 0 || n(c.seatDay) > 0) ? (Number.isInteger(c.seatN) ? c.seatN : NaN) : 0;
  const abroad: string[] = [];
  for (const a of c && Array.isArray(c.abroad) ? c.abroad.slice(0, 20) : []) {
    const hit = ABROAD.find(([, name]) => name === s(a?.name, 60));
    if (!hit) return { error: "country" };
    abroad.push(hit[0]);
  }
  const leg = (v: any) => (v && typeof v === "object" ? addrOf(v.addr) : null);
  // Потвърдените пинове идват отделно от договора (pins: { del, ret })
  const pins = body?.pins && typeof body.pins === "object" ? body.pins : {};
  return { input: { ...b, seats, del: c ? leg(c.del) : null, ret: c ? leg(c.ret) : null, abroad, delPin: pinOf(pins.del), retPin: pinOf(pins.ret) } };
}

export const carActive = async (carId: string) => {
  const [car] = await db.select({ status: cars.status }).from(cars).where(eq(cars.id, carId));
  return !car || car.status === "active";
};

// precision – точност на намереното място (server/geocode.ts): house | street (само улицата – приблизително) | place
type LegRoute = { km: number; rate: number; source: string; precision?: string };
type Legs = { del?: LegRoute; ret?: LegRoute };
// reason "pin" – намерена е само улицата / населеното място; pin – началната точка за картата (клиентът потвърждава мястото)
export type RouteFail = { leg: "del" | "ret"; reason: Exclude<CacheResult, object> | "pin"; pin?: { lat: number; lon: number; found: string } };
export type RouteFn = (addr: string, pin?: Pin | null) => Promise<CacheResult>;

// Маршрутите се изчисляват на сървъра; при неуспех няма оферта (нито нулева доставка, нито км от браузъра)
// pois – имената на разпознатите обекти (само за отговора към браузъра; в базата не се записват – там няма адреси)
type Pois = { del?: string; ret?: string };
async function routeLegs(i: QuoteInput, route: RouteFn, timeoutMs: number): Promise<{ legs: Legs; pois: Pois } | RouteFail> {
  const legs: Legs = {}, pois: Pois = {};
  for (const [k, addr, pin] of [["del", i.del, i.delPin], ["ret", i.ret, i.retPin]] as const) {
    if (!addr) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      route(addr, pin ?? null).catch((e) => (console.error("Route failed", (e as Error)?.name), "error" as const)),
      new Promise<"timeout">((res) => (timer = setTimeout(() => res("timeout"), timeoutMs))),
    ]);
    clearTimeout(timer);
    if (typeof r === "string") return { leg: k, reason: r };
    if ("pin" in r) return { leg: k, reason: "pin", pin: { lat: r.lat, lon: r.lon, found: r.found } };
    legs[k] = { km: r.km, rate: r.rate, source: r.source, precision: r.precision };
    if (r.poi) pois[k] = r.poi;
  }
  return { legs, pois };
}

const priceOf = (i: QuoteInput, legs: Legs) =>
  price({
    carId: i.carId, startDate: i.startDate, startTime: i.startTime, endDate: i.endDate, endTime: i.endTime, seats: i.seats,
    del: legs.del ? { km: legs.del.km, rate: legs.del.rate } : null, ret: legs.ret ? { km: legs.ret.km, rate: legs.ret.rate } : null, abroad: i.abroad,
  });

type QuoteRow = typeof priceQuotes.$inferSelect;
const leg = (l: LegRoute, poi?: string) => ({ km: l.km, rate: l.rate, precision: l.precision ?? null, ...(poi ? { poi } : {}) });
// Отговорът за браузъра: разбивка, сума, депозит (отделно), км и тарифа за всеки адрес и срок на офертата
export function quoteView(token: string, q: Pick<QuoteRow, "days" | "lines" | "totalCents" | "depositCents" | "legs" | "expiresAt" | "version">, pois: Pois = {}) {
  const legs = q.legs as Legs;
  return {
    quote: token, version: q.version, expiresAt: q.expiresAt.toISOString(), days: q.days, lines: q.lines as Line[],
    totalCents: q.totalCents, total: fmtCents(q.totalCents), depositCents: q.depositCents,
    legs: { del: legs.del ? leg(legs.del, pois.del) : null, ret: legs.ret ? leg(legs.ret, pois.ret) : null },
  };
}

export async function createQuote(i: QuoteInput, o: { route?: RouteFn; budget?: () => Promise<boolean>; timeoutMs?: number; now?: Date } = {}) {
  const r = await routeLegs(i, o.route || ((a, pin) => cachedRoute(a, { budget: o.budget, pin })), o.timeoutMs ?? 10_000);
  if (!("legs" in r)) return { ok: false as const, error: "route" as const, ...r };
  const p = priceOf(i, r.legs);
  if (!p.ok) return { ok: false as const, error: p.error };
  const token = Array.from({ length: 2 }, () => crypto.randomUUID().replace(/-/g, "")).join("");
  const now = o.now || new Date();
  const [row] = await db
    .insert(priceQuotes)
    .values({
      id: sha(token), inputHash: inputHash(i),
      input: { carId: i.carId, startDate: i.startDate, startTime: i.startTime, endDate: i.endDate, endTime: i.endTime, seats: i.seats, del: !!i.del, ret: !!i.ret, abroad: i.abroad },
      legs: r.legs, version: PRICING_VERSION, days: p.days, lines: p.lines, totalCents: p.totalCents, depositCents: p.depositCents,
      createdAt: now, expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
    })
    .returning();
  // Автоматично изтриване на изтекли оферти още няма – предложеното правило е в quoteCleanupSql() (изпълнява се ръчно)
  return { ok: true as const, token, row, view: quoteView(token, row, r.pois) };
}

export type QuoteFail = "quote_required" | "quote_expired" | "quote_mismatch" | "quote_used" | "price_changed";
const TOKEN_RE = /^[a-f0-9]{64}$/;

// Проверка на офертата при подаването (преди транзакцията). Еднократното използване се записва в транзакцията (claimQuote).
export async function verifyQuote(token: unknown, i: QuoteInput, shownCents: unknown, now = new Date()) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return { ok: false as const, error: "quote_required" as QuoteFail };
  const [q] = await db.select().from(priceQuotes).where(eq(priceQuotes.id, sha(token)));
  if (!q) return { ok: false as const, error: "quote_required" as QuoteFail };
  if (q.inputHash !== inputHash(i)) return { ok: false as const, error: "quote_mismatch" as QuoteFail };
  if (q.bookingId) return { ok: false as const, error: "quote_used" as QuoteFail, row: q };
  if (q.expiresAt.getTime() <= now.getTime()) return { ok: false as const, error: "quote_expired" as QuoteFail };
  // Цената се изчислява отново по текущите правила (със запазените км от офертата – без нова заявка за маршрут)
  const p = priceOf(i, q.legs as Legs);
  if (!p.ok || q.version !== PRICING_VERSION || p.totalCents !== q.totalCents || shownCents !== q.totalCents)
    return { ok: false as const, error: "price_changed" as QuoteFail, currentCents: p.ok ? p.totalCents : null };
  return { ok: true as const, row: q, price: p };
}

// В транзакцията на резервацията: офертата се маркира като използвана само ако още е свободна
export async function claimQuote(tx: any, id: string, bookingId: string) {
  const [u] = await tx.update(priceQuotes).set({ bookingId, usedAt: new Date() }).where(and(eq(priceQuotes.id, id), isNull(priceQuotes.bookingId))).returning({ id: priceQuotes.id });
  return !!u;
}

// Снимка на сървърната цена за резервацията (bookings.price_check, статус „server“) – без адресите
export function priceSnapshot(q: QuoteRow) {
  return {
    version: q.version, status: "server" as const, quotedAt: q.createdAt.toISOString(),
    server: { days: q.days, lines: q.lines as Line[], totalCents: q.totalCents, depositCents: q.depositCents },
    route: q.legs as Legs,
  };
}

// Договорът се попълва със сървърните стойности: дати, брой дни, наем, столчета, км и тарифа, такси за чужбина.
// Останалите данни (клиент, документи, адреси) са от формата.
export function contractWithPrice(d: ContractData, b: QuoteInput, q: QuoteRow): ContractData {
  const lines = q.lines as Line[], legs = q.legs as Legs;
  const rent = lines.find((l) => l.code === "rent")!, seats = lines.find((l) => l.code === "seats");
  const leg = (l: ContractData["del"], s?: { km: number; rate: number }): ContractData["del"] => (l && s ? { addr: l.addr, km: s.km, rate: s.rate } : null);
  return {
    ...d, carId: b.carId, d1: b.startDate, t1: b.startTime, d2: b.endDate, t2: b.endTime,
    days: q.days, rent: rent.cents / 100,
    seat: seats ? seats.cents / 100 : 0, seatN: b.seats, seatDay: b.seats ? (b.seats * Math.round(SEAT_DAY * 100)) / 100 : 0,
    del: leg(d.del, legs.del), ret: leg(d.ret, legs.ret),
    abroad: lines.filter((l) => l.code === "abroad").map((l) => ({ name: ABROAD.find(([k]) => k === l.country)![1], fee: l.cents / 100 })),
  };
}

// Предложено правило за почистване (НЕ се изпълнява автоматично): неизползвани оферти, изтекли преди повече от 7 дни.
// Използваните (booking_id) остават – към тях е вързана резервацията. dryRun връща само броя.
export const QUOTE_RETENTION_DAYS = 7;
export async function quoteCleanup(o: { dryRun: boolean; limit?: number }) {
  const where = sql`booking_id is null and expires_at < now() - make_interval(days => ${QUOTE_RETENTION_DAYS})`;
  if (o.dryRun) return Number(rowsOf(await db.execute(sql`select count(*)::int n from price_quotes where ${where}`))[0].n);
  return rowsOf(await db.execute(sql`delete from price_quotes where id in (select id from price_quotes where ${where} limit ${o.limit ?? 5000}) returning id`)).length;
}
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);
