// Симулирана сървърна оферта (/api/quote) за браузърните тестове, които подменят /api/*.
// Цената е изчислена със същия код като на сървъра (server/pricing.ts); маршрутът е синтетичен: 10 км × 1,00 €/км.
import { fmtCents, price } from "../../server/pricing.ts";

export const QUOTE_TOKEN = "e".repeat(64);
export function fakeQuote(b, km = 10, rate = 1) {
  const leg = (a) => (a ? { km, rate } : null);
  const p = price({ carId: b.carId, startDate: b.startDate, startTime: b.startTime, endDate: b.endDate, endTime: b.endTime, seats: b.seats || 0, del: leg(b.delivery), ret: leg(b.return), abroad: b.abroad || [] });
  if (!p.ok) return { status: 400, json: { error: p.error } };
  return { status: 200, json: { quote: QUOTE_TOKEN, version: "test", expiresAt: new Date(Date.now() + 30 * 60e3).toISOString(), days: p.days, lines: p.lines, totalCents: p.totalCents, total: fmtCents(p.totalCents), depositCents: p.depositCents, legs: { del: leg(b.delivery), ret: leg(b.return) } } };
}
export const fulfillQuote = (r) => { const q = fakeQuote(r.request().postDataJSON() || {}); return r.fulfill({ status: q.status, json: q.json }); };
