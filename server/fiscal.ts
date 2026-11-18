// All monetary values in immutable sale snapshots are integer euro cents.
import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookings, payments, fiscalSales, fiscalSeries } from "../db/schema.js";
import { queueEmail, sendLogged } from "./email.js";
import { OWNER_EMAIL } from "../mail/index.js";
import type { Breakdown } from "../mail/card.js";
import { KIND_BG, REVENUE_KINDS } from "./payments.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Booking = typeof bookings.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Sale = typeof fiscalSales.$inferSelect;
export const SHOP = "RF0008363";
export const seller = {
  name: "Рента ПТБ Строй ЕООД",
  eik: "208817102",
  address: "4027 Пловдив, бул. Дунав № 10, ет. 8, ап. 20",
  contact: "+359 877 748 693",
};
export const localStamp = (d: Date) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Sofia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);
export const money = (c: number) => (c / 100).toFixed(2);
export type Item = {
  name: string;
  qty: number;
  unit: number;
  discount: number;
};
export type Snapshot = {
  shop: string;
  supplier: typeof seller;
  buyer: string;
  email: string;
  name: string;
  order: string;
  orderDate: string;
  eventDate: string;
  serviceDate: string;
  advance: boolean;
  method: string;
  rrn: string;
  terminal: string;
  externalDoc: string;
  externalDate?: string;
  amount: number;
  items: Item[];
  vatGroup: "А";
  vatReason: string;
};
const names: Record<string, string> = {
  seats: "Детско столче",
  chains: "Вериги",
  second_driver: "Втори шофьор",
  delivery: "Доставка до адрес",
  return: "Прибиране от адрес",
  abroad: "Пътуване в чужбина",
};
export const lineTotal = (i: Item) => i.qty * i.unit - i.discount;
export function saleItems(b: Booking, p: Payment, card?: Breakdown): Item[] {
  const rental =
    "Наем на " +
    b.car +
    (b.startDate && b.endDate
      ? " (" + b.startDate + " – " + b.endDate + ")"
      : "");
  const price = (b.priceCheck as any)?.server;
  const source = card
    ? [
        {
          code: "rent",
          qty: card.days,
          unitCents: card.unitCents,
          cents: card.rentCents,
        },
        ...card.extras,
      ]
    : p.kind === "final" &&
        b.totalCents === p.amountCents &&
        Array.isArray(price?.lines)
      ? price.lines
      : null;
  if (source) {
    const discount = card
      ? card.renty10Cents + card.cardDiscountCents
      : -source
          .filter((l: any) => l.cents < 0)
          .reduce((s: number, l: any) => s + l.cents, 0);
    const items: Item[] = source
      .filter((l: any) => l.cents > 0)
      .map((l: any) => {
        const byUnit = l.qty && l.qty * l.unitCents === l.cents;
        return {
          name:
            l.code === "rent"
              ? rental
              : (names[l.code] || l.code) + (l.country ? " " + l.country : ""),
          qty: byUnit ? l.qty : 1,
          unit: byUnit ? l.unitCents : l.cents,
          discount: l.code === "rent" ? discount : 0,
        };
      });
    if (
      items.length &&
      items.reduce((sum, i) => sum + lineTotal(i), 0) === p.amountCents
    )
      return items;
  }
  return [
    {
      name: (KIND_BG[p.kind] || "Плащане") + " — " + rental,
      qty: 1,
      unit: p.amountCents,
      discount: 0,
    },
  ];
}
export async function allocate(tx: Tx, series: string) {
  await tx
    .insert(fiscalSeries)
    .values({
      id: series,
      next: series === "invoice" ? 1000000001 : 1,
      last: series === "invoice" ? 9999999999 : 999999999,
    })
    .onConflictDoNothing();
  const [r] = await tx
    .update(fiscalSeries)
    .set({ next: sql`${fiscalSeries.next}+1` })
    .where(
      and(
        eq(fiscalSeries.id, series),
        lte(fiscalSeries.next, fiscalSeries.last),
      ),
    )
    .returning({ next: fiscalSeries.next });
  return r ? String(r.next - 1).padStart(10, "0") : null;
}
export function buildSnapshot(
  b: Booking,
  p: Payment,
  card?: { rrn: string; terminal: string; breakdown: Breakdown },
): Snapshot {
  if (!p.paidAt) throw new Error("Missing payment date");
  return {
    shop: SHOP,
    supplier: seller,
    buyer: b.invoice?.trim() || "",
    name: b.name,
    email: b.email,
    order: b.id,
    orderDate: localStamp(b.createdAt).slice(0, 10),
    serviceDate: b.returnedAt ? localStamp(b.returnedAt).slice(0, 10) : "",
    eventDate: localStamp(p.paidAt).slice(0, 10),
    advance: !b.returnedAt || p.paidAt < b.returnedAt,
    amount: p.amountCents,
    method: card ? "vpos" : p.method,
    rrn: card?.rrn || "",
    terminal: card?.terminal || "",
    externalDoc: "",
    items: saleItems(b, p, card?.breakdown),
    vatGroup: "А",
    vatReason: "ДДС не се начислява — чл. 113, ал. 9 ЗДДС.",
  };
}
export async function recordSale(
  tx: Tx,
  b: Booking,
  p: Payment,
  card?: { rrn: string; terminal: string; breakdown: Breakdown },
) {
  if (!p.paidAt || p.currency !== "EUR" || !REVENUE_KINDS.includes(p.kind))
    return;
  const [existing] = await tx
    .select()
    .from(fiscalSales)
    .where(eq(fiscalSales.id, p.id));
  if (existing) return;
  const receipt = card ? await allocate(tx, "receipt") : null;
  if (card && !receipt) throw new Error("Receipt number range exhausted");
  const buyer = b.invoice?.trim() || "";
  const invoice = buyer ? await allocate(tx, "invoice") : null;
  const snapshot = buildSnapshot(b, p, card);
  await tx
    .insert(fiscalSales)
    .values({
      id: p.id,
      bookingId: b.id,
      receipt,
      invoice,
      invoiceIssuedAt: invoice ? new Date() : null,
      snapshot,
      issuedAt: new Date(),
    });
  for (const kind of [
    ...(receipt ? ["sale-receipt"] : []),
    ...(buyer ? ["sale-invoice"] : []),
  ]) {
    await queueEmail(tx, kind, kind + ":" + p.id, b.id, b.email);
  }
}
export async function deliverFiscal(kind: string, id: string) {
  if (!["sale-receipt", "sale-invoice"].includes(kind)) return null;
  const sale = await db.transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(fiscalSales)
      .where(eq(fiscalSales.id, id))
      .for("update");
    if (!s) return null;
    if (
      kind === "sale-invoice" &&
      !s.invoice &&
      (s.snapshot as Snapshot).buyer
    ) {
      const number = await allocate(tx, "invoice");
      if (!number) return null;
      const [updated] = await tx
        .update(fiscalSales)
        .set({ invoice: number, invoiceIssuedAt: new Date() })
        .where(eq(fiscalSales.id, id))
        .returning();
      return updated;
    }
    return s;
  });
  if (!sale) return null;
  const snap = sale.snapshot as Snapshot,
    invoice = kind === "sale-invoice",
    num = invoice ? sale.invoice : sale.receipt;
  if (!num || (!invoice && !snap.rrn)) return null;
  const { fiscalPdf } = await import("./fiscal-pdf.js");
  const pdf = await fiscalPdf(sale, invoice),
    label = invoice ? "Фактура" : "Документ за продажба";
  return sendLogged(kind, kind + ":" + id, sale.bookingId, {
    to: snap.email,
    toName: snap.name,
    replyTo: OWNER_EMAIL,
    subject: label + " № " + num,
    html:
      "<p>Прилагаме " +
      label.toLowerCase() +
      " № " +
      num +
      " за плащането по резервацията Ви.</p>",
    attachment: [
      {
        name: (invoice ? "invoice-" : "sale-") + num + ".pdf",
        content: Buffer.from(pdf).toString("base64"),
      },
    ],
  });
}
export async function deliverSale(id: string) {
  for (const kind of ["sale-receipt", "sale-invoice"])
    await deliverFiscal(kind, id);
}
