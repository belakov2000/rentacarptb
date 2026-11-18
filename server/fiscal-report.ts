import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookings, payments, cardPayments, fiscalSales } from "../db/schema.js";
import {
  localStamp,
  money,
  lineTotal,
  SHOP,
  seller,
  type Snapshot,
} from "./fiscal.js";
import { REVENUE_KINDS } from "./payments.js";
import { readFile } from "node:fs/promises";
import { validateXML } from "xmllint-wasm";
import iconv from "iconv-lite";

const xmlText = (v: unknown) =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const field = (key: string, v: unknown) =>
  "<" + key + ">" + xmlText(v) + "</" + key + ">";
export const validMonth = (m: string) => /^20\d\d-(0[1-9]|1[0-2])$/.test(m);
type Order = { snapshot: Snapshot; doc: string; date: string; paym: number };
type Refund = { order: string; amount: number; date: string; method: number };
type Problem = { booking: string; message: string; payment?: string };
export async function report(month: string) {
  if (!validMonth(month)) throw new Error("Невалиден месец");
  // DB timestamps are expressed in UTC without time zone.
  const inMonth = (col: any) =>
    sql`to_char((${col} at time zone 'UTC') at time zone 'Europe/Sofia','YYYY-MM') = ${month}`;
  const done = await db
    .select()
    .from(bookings)
    .where(inMonth(bookings.returnedAt));
  const orders: Order[] = [],
    refunds: Refund[] = [],
    issues: Problem[] = [];
  const ids = done.map((b) => b.id);
  const paid = ids.length
    ? await db.select().from(payments).where(inArray(payments.bookingId, ids))
    : [];
  const sales = ids.length
    ? await db
        .select()
        .from(fiscalSales)
        .where(inArray(fiscalSales.bookingId, ids))
    : [];
  const attempts = ids.length
    ? await db
        .select()
        .from(cardPayments)
        .where(inArray(cardPayments.bookingId, ids))
    : [];
  const byPayment = new Map(sales.map((s) => [s.id, s]));
  const cardModes = new Map(attempts.map((a) => ["borica:" + a.id, a.mode]));
  for (const b of done) {
    const received = paid.filter(
      (p) =>
        p.bookingId === b.id &&
        p.paidAt &&
        ["received", "refunded"].includes(p.status) &&
        REVENUE_KINDS.includes(p.kind),
    );
    const live = received.filter(
      (p) => cardModes.get(p.idempotencyKey || "") !== "test",
    );
    if (received.length && !live.length) continue;
    const issue = (message: string, payment?: string) =>
      issues.push({ booking: b.id, message, payment });
    if (!live.length) {
      issue("Приключен наем без записано получено плащане.");
      continue;
    }
    if (live.length > 1) {
      issue(
        "Няколко плащания за една поръчка. Нужна е счетоводна сверка за разделени плащания.",
      );
      continue;
    }
    const p = live[0],
      sale = byPayment.get(p.id);
    if (!sale) {
      issue(
        ["cash", "bank"].includes(p.method)
          ? "Въведи действителния номер на бон или документ за плащането."
          : "Липсва документален запис за полученото плащане.",
        p.id,
      );
      continue;
    }
    const s = sale.snapshot as Snapshot;
    if (b.totalReview || b.totalCents == null || b.totalCents !== s.amount) {
      issue("Получената сума не съвпада с окончателната цена на наема.");
      continue;
    }
    const paym =
      s.method === "vpos"
        ? 2
        : s.method === "bank"
          ? 1
          : s.method === "cash"
            ? 6
            : 0;
    if (!paym) {
      issue("Нужна е проверка на платежния метод.");
      continue;
    }
    if (paym === 2 && (!s.rrn || !s.terminal)) {
      issue("Липсва проверена банкова референция или терминал.", p.id);
      continue;
    }
    const doc =
      paym === 2
        ? sale.receipt
        : paym === 6
          ? s.externalDoc
          : sale.invoice || s.externalDoc;
    if (!doc || !/^\d{1,10}$/.test(doc)) {
      issue(
        "Въведи действителния номер на бон или документ (до 10 цифри).",
        p.id,
      );
      continue;
    }
    orders.push({
      snapshot: s,
      doc,
      date:
        paym === 2
          ? localStamp(sale.issuedAt).slice(0, 10)
          : paym === 1 && sale.invoice
            ? localStamp(sale.invoiceIssuedAt || sale.issuedAt).slice(0, 10)
            : s.externalDate || s.eventDate,
      paym,
    });
  }
  const returns = await db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.kind, "refund"),
        eq(payments.status, "received"),
        inMonth(payments.paidAt),
      ),
    );
  for (const r of returns) {
    const [p] = r.refundOf
      ? await db.select().from(payments).where(eq(payments.id, r.refundOf))
      : [];
    if (p?.kind === "security") continue;
    if (!p || !r.paidAt || r.currency !== "EUR") {
      issues.push({
        booking: r.bookingId,
        message: "Непълни данни за възстановяване.",
      });
      continue;
    }
    if (p.idempotencyKey?.startsWith("borica:")) {
      const [attempt] = await db
        .select()
        .from(cardPayments)
        .where(eq(cardPayments.id, p.idempotencyKey.slice(7)));
      if (attempt?.mode === "test") continue;
    }
    refunds.push({
      order: r.bookingId,
      date: localStamp(r.paidAt).slice(0, 10),
      amount: r.amountCents,
      method:
        r.method === "bank"
          ? 1
          : r.method === "card"
            ? 2
            : r.method === "cash"
              ? 3
              : 4,
    });
  }
  if (!orders.length && refunds.length)
    issues.push({
      booking: "",
      message:
        "Месец само с възстановявания. Схемата на НАП изисква поръчка. Предай справката за възстановявания на счетоводителя.",
    });
  orders.sort((a, b) => a.snapshot.order.localeCompare(b.snapshot.order));
  return { month, orders, refunds, issues };
}
export function auditXml(
  r: Awaited<ReturnType<typeof report>>,
  today = new Date(),
) {
  if (r.issues.length || !r.orders.length)
    throw new Error("Няма готов за подаване отчет.");
  const orderRows = r.orders.map(({ snapshot: s, doc, date, paym }) => {
    const base = s.items.reduce((sum, i) => sum + i.unit * i.qty, 0),
      discount = s.items.reduce((sum, i) => sum + i.discount, 0);
    if (base - discount !== s.amount || s.items.some((i) => lineTotal(i) < 0))
      throw new Error("Грешка в сумата на поръчката.");
    const arts = s.items
      .map(
        (i) =>
          "<artenum>" +
          field("art_name", i.name) +
          field("art_quant", i.qty) +
          field("art_price", money(i.unit)) +
          field("art_vat_rate", 0) +
          field("art_vat", "0.00") +
          field("art_sum", money(lineTotal(i))) +
          "</artenum>",
      )
      .join("");
    return (
      "<orderenum>" +
      field("ord_n", s.order) +
      field("ord_d", s.orderDate) +
      field("doc_n", doc) +
      field("doc_date", date) +
      "<art>" +
      arts +
      "</art>" +
      field("ord_total1", money(base)) +
      field("ord_disc", money(discount)) +
      field("ord_vat", "0.00") +
      field("ord_total2", money(s.amount)) +
      field("paym", paym) +
      (paym === 2 ? field("pos_n", s.terminal) + field("trans_n", s.rrn) : "") +
      "</orderenum>"
    );
  });
  const ret = r.refunds.map(
    (x) =>
      "<rorderenum>" +
      field("r_ord_n", x.order) +
      field("r_amount", money(x.amount)) +
      field("r_date", x.date) +
      field("r_paym", x.method) +
      "</rorderenum>",
  );
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<audit>' +
    field("eik", seller.eik) +
    field("e_shop_n", SHOP) +
    field("domain_name", "rentacar-ptb.com") +
    field("e_shop_type", 1) +
    field("creation_date", localStamp(today).slice(0, 10)) +
    field("mon", r.month.slice(5)) +
    field("god", r.month.slice(0, 4)) +
    "<order>" +
    orderRows.join("\n") +
    "</order>" +
    field("r_ord", new Set(r.refunds.map((x) => x.order)).size) +
    (ret.length ? "<rorder>" + ret.join("\n") + "</rorder>" : "") +
    field("r_total", money(r.refunds.reduce((sum, x) => sum + x.amount, 0))) +
    "</audit>"
  );
}
export async function validatedXml(xml: string) {
  const schema = iconv
    .decode(
      await readFile("server/fiscal-assets/dec_audit.xsd"),
      "windows-1251",
    )
    .replace(/WINDOWS-1251/i, "UTF-8");
  const result = await validateXML({ xml, schema });
  if (!result.valid)
    throw new Error("XML не премина проверката по схемата на НАП.");
  const encoded = xml
    .replace('encoding="UTF-8"', 'encoding="windows-1251"')
    .replace(/[^\x00-\x7f]/gu, (c) =>
      iconv.decode(iconv.encode(c, "windows-1251"), "windows-1251") === c
        ? c
        : "&#" + c.codePointAt(0) + ";",
    );
  return iconv.encode(encoded, "windows-1251");
}
