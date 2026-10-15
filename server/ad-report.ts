import { and, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { adSpend, bookings, payments } from "../db/schema.js";
import { summarize, type Pay } from "./payments.js";
import { variantLabel } from "./attribution.js";

// Отчет „Реклами: заявки и ROAS“ по кампания (utm_campaign) и вариант (utm_content).
// Кохорта: заявките, СЪЗДАДЕНИ в избрания период (дати по българско време, включително). По тях се отчитат плащанията,
// получени до момента paidUntil – и такива след края на периода (приходът често идва по-късно от заявката).
// Приход = нетно получени плащания за наема и услугите (deposit/partial/final/extra) след възстановяванията;
// гаранционните депозити (security) и връщането им не влизат (server/payments.ts).
// Разход = само ръчно въведеният действителен разход, чийто период е изцяло в избрания период. Записи, които само
// частично се застъпват, не се разпределят по дни (не се измислят суми). За такъв вариант разходът е „непълен“
// (spendIncomplete): разход, CPL, цена за резервация с плащане и ROAS не се изчисляват, докато избраният период
// не обхване записите изцяло.
// ROAS = нетен получен приход / рекламен разход – възвръщаемост на рекламния разход, не печалба.
// Отчетът е по записаните UTM параметри и не съвпада непременно с атрибуцията в Meta Ads Manager.

// Начало на деня (00:00 в Europe/Sofia) като момент в UTC. Смяната на часовото време в България е в 03:00/04:00,
// затова отместването в полунощ UTC на същата дата е и отместването в местната полунощ.
export function sofiaMidnight(day: string) {
  const utc = Date.parse(day + "T00:00:00Z");
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Sofia", timeZoneName: "shortOffset" }).formatToParts(utc).find((x) => x.type === "timeZoneName")?.value || "";
  const h = Number(/GMT([+-]\d+)/.exec(p)?.[1] || 0);
  return new Date(utc - h * 3600_000);
}
export const nextDay = (day: string) => new Date(Date.parse(day + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);

export type ReportBooking = { id: string; status: string; utmCampaign: string | null; utmContent: string | null; utmSource: string | null; utmMedium: string | null };
export type ReportSpend = { id: number; campaign: string; content: string; periodStart: string; periodEnd: string; amountCents: number; currency: string };
export type Row = {
  campaign: string | null; content: string | null; label: string; sources: string[];
  leads: number; confirmed: number; paid: number; revenueCents: number; spendCents: number | null; spendIncomplete: boolean;
  cplCents: number | null; costPerPaidCents: number | null; roas: number | null;
};
// Потвърдени: включително по-късно отменените или с неявяване (тези статуси са възможни само след потвърждение)
const CONFIRMED = ["confirmed", "cancelled", "no_show"];
const NONE = "\u0000none";

export function buildReport(o: { from: string; to: string; paidUntil: Date; bookings: ReportBooking[]; payments: Pay[]; spend: ReportSpend[] }) {
  const key = (campaign: string | null, content: string | null) => (campaign == null ? NONE : campaign + "\u0000" + (content || ""));
  const rows = new Map<string, Row>();
  const row = (campaign: string | null, content: string | null) => {
    const k = key(campaign, content);
    if (!rows.has(k))
      rows.set(k, {
        campaign, content: campaign == null ? null : content || "", label: campaign == null ? "Няма записан източник" : variantLabel(content) || "(без вариант)",
        sources: [], leads: 0, confirmed: 0, paid: 0, revenueCents: 0, spendCents: null, spendIncomplete: false, cplCents: null, costPerPaidCents: null, roas: null,
      });
    return rows.get(k)!;
  };
  const byBooking = new Map<string, Pay[]>();
  for (const p of o.payments) byBooking.set(p.bookingId, [...(byBooking.get(p.bookingId) || []), p]);
  let nonEur = 0;
  for (const b of o.bookings) {
    const r = row(b.utmCampaign, b.utmContent);
    const src = [b.utmSource, b.utmMedium].filter(Boolean).join(" / ");
    if (src && !r.sources.includes(src)) r.sources.push(src);
    r.leads++;
    if (CONFIRMED.includes(b.status)) r.confirmed++;
    const s = summarize(byBooking.get(b.id) || [], o.paidUntil);
    nonEur += s.nonEur;
    if (s.rentalNet > 0) r.paid++;
    r.revenueCents += s.rentalNet;
  }
  const partial: ReportSpend[] = [];
  let nonEurSpend = 0;
  for (const s of o.spend) {
    if (s.currency !== "EUR") { nonEurSpend++; continue; }
    const inside = s.periodStart >= o.from && s.periodEnd <= o.to;
    const overlaps = s.periodStart <= o.to && s.periodEnd >= o.from;
    if (!overlaps) continue;
    const r = row(s.campaign, s.content);
    if (!inside) { partial.push(s); r.spendIncomplete = true; continue; }
    r.spendCents = (r.spendCents ?? 0) + s.amountCents;
  }
  for (const r of rows.values()) {
    // Непълен разход → нито сума, нито показатели от нея („Непълен разход“ в панела)
    if (r.spendIncomplete) { r.spendCents = null; r.cplCents = r.costPerPaidCents = r.roas = null; continue; }
    // Няма разход или нулев знаменател → null („Няма данни“)
    r.cplCents = r.spendCents != null && r.leads > 0 ? Math.round(r.spendCents / r.leads) : null;
    r.costPerPaidCents = r.spendCents != null && r.paid > 0 ? Math.round(r.spendCents / r.paid) : null;
    r.roas = r.spendCents != null && r.spendCents > 0 ? r.revenueCents / r.spendCents : null;
  }
  const list = [...rows.values()].sort((a, b) => (a.campaign == null ? 1 : b.campaign == null ? -1 : (a.campaign + a.content).localeCompare(b.campaign + b.content)));
  return { from: o.from, to: o.to, paidUntil: o.paidUntil.toISOString(), rows: list, partialSpend: partial, warnings: { nonEurPayments: nonEur, nonEurSpend } };
}

export async function loadReport(from: string, to: string, paidUntil: Date) {
  const bs = await db
    .select({ id: bookings.id, status: bookings.status, utmCampaign: bookings.utmCampaign, utmContent: bookings.utmContent, utmSource: bookings.utmSource, utmMedium: bookings.utmMedium })
    .from(bookings)
    .where(and(gte(bookings.createdAt, sofiaMidnight(from)), lt(bookings.createdAt, sofiaMidnight(nextDay(to)))));
  const ps = bs.length
    ? await db
        .select({ id: payments.id, bookingId: payments.bookingId, amountCents: payments.amountCents, currency: payments.currency, kind: payments.kind, status: payments.status, paidAt: payments.paidAt, refundOf: payments.refundOf })
        .from(payments)
        .where(inArray(payments.bookingId, bs.map((b) => b.id)))
    : [];
  const spend = await db
    .select({ id: adSpend.id, campaign: adSpend.campaign, content: adSpend.content, periodStart: adSpend.periodStart, periodEnd: adSpend.periodEnd, amountCents: adSpend.amountCents, currency: adSpend.currency })
    .from(adSpend)
    .where(and(isNull(adSpend.deletedAt), lte(adSpend.periodStart, to), gte(adSpend.periodEnd, from)));
  return buildReport({ from, to, paidUntil, bookings: bs, payments: ps, spend });
}
