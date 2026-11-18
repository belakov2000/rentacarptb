import type { Config } from "@netlify/functions";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  bookingEvents,
  fiscalSales,
  payments,
  bookings,
} from "../../db/schema.js";
import { json, requireAdmin } from "../../server/auth.js";
import {
  report,
  auditXml,
  validatedXml,
  validMonth,
} from "../../server/fiscal-report.js";
import {
  SHOP,
  localStamp,
  type Snapshot,
  buildSnapshot,
  deliverFiscal,
} from "../../server/fiscal.js";
import { fiscalPdf } from "../../server/fiscal-pdf.js";

const attachment = (bytes: Uint8Array, mime: string, filename: string) =>
  new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": 'attachment; filename="' + filename + '"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

export default async function handler(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const q = new URL(req.url).searchParams;
  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || !/^[a-f0-9]{32}$/.test(body.payment || ""))
      return json({ error: "Невалидно плащане." }, 400);
    const result = await db.transaction(async (tx) => {
      const [p] = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, body.payment))
        .for("update");
      if (
        !p ||
        !p.paidAt ||
        !["received", "refunded"].includes(p.status) ||
        !["final", "deposit", "partial", "extra"].includes(p.kind)
      )
        return false;
      const [sale] = await tx
        .select()
        .from(fiscalSales)
        .where(eq(fiscalSales.id, p.id))
        .for("update");
      if (body.rrn) {
        if (!sale?.receipt || !/^\d{12}$/.test(body.rrn)) return false;
        const snap = sale.snapshot as Snapshot;
        if (snap.method !== "vpos" || snap.rrn) return false;
        await tx
          .update(fiscalSales)
          .set({ snapshot: { ...snap, rrn: body.rrn } })
          .where(eq(fiscalSales.id, p.id));
      } else {
        if (
          !["cash", "bank"].includes(p.method) ||
          !/^\d{1,10}$/.test(body.doc || "") ||
          !/^\d{4}-\d{2}-\d{2}$/.test(body.date || "")
        )
          return false;
        const parsed = new Date(body.date + "T12:00:00Z");
        if (
          !Number.isFinite(+parsed) ||
          parsed.toISOString().slice(0, 10) !== body.date ||
          body.date > localStamp(new Date()).slice(0, 10)
        )
          return false;
        const [b] = await tx
          .select()
          .from(bookings)
          .where(eq(bookings.id, p.bookingId));
        const snap = sale ? (sale.snapshot as Snapshot) : buildSnapshot(b, p);
        if (snap.externalDate) return false;
        const snapshot = {
          ...snap,
          externalDoc: body.doc,
          externalDate: body.date,
        };
        if (sale)
          await tx
            .update(fiscalSales)
            .set({ snapshot })
            .where(eq(fiscalSales.id, p.id));
        else
          await tx
            .insert(fiscalSales)
            .values({
              id: p.id,
              bookingId: p.bookingId,
              snapshot,
              issuedAt: new Date(),
            });
      }
      await tx
        .insert(bookingEvents)
        .values({
          actor: admin.email,
          bookingId: p.bookingId,
          action: "fiscal.reference",
          details: {
            payment: p.id,
            field: body.rrn ? "rrn" : "externalDocument",
          },
        });
      return true;
    });
    if (!result)
      return json(
        {
          error:
            "Провери номера, датата и вида на плащането. Потвърден реквизит се запазва еднократно.",
        },
        409,
      );
    if (body.rrn)
      await deliverFiscal("sale-receipt", body.payment).catch(() => null);
    return json({ ok: true });
  }
  if (q.has("payment")) {
    const [sale] = await db
      .select()
      .from(fiscalSales)
      .where(eq(fiscalSales.id, q.get("payment") || ""));
    const invoice = q.get("kind") === "invoice";
    if (
      !sale ||
      !(invoice ? sale.invoice : sale.receipt) ||
      (!invoice && !(sale.snapshot as Snapshot).rrn)
    )
      return json({ error: "Липсва документ." }, 404);
    return attachment(
      await fiscalPdf(sale, invoice),
      "application/pdf",
      (invoice ? "invoice-" + sale.invoice : "sale-" + sale.receipt) + ".pdf",
    );
  }
  const month = q.get("month") || "";
  if (!validMonth(month)) return json({ error: "Избери отчетен месец." }, 400);
  const result = await report(month);
  if (q.get("format") === "xml") {
    if (result.issues.length || !result.orders.length)
      return json({ error: "Няма готов за подаване отчет." }, 409);
    return attachment(
      await validatedXml(auditXml(result)),
      "application/xml",
      SHOP + "_" + month + ".xml",
    );
  }
  const docs = await db
    .select()
    .from(fiscalSales)
    .where(
      sql`to_char((${fiscalSales.issuedAt} at time zone 'UTC') at time zone 'Europe/Sofia','YYYY-MM') = ${month}`,
    )
    .orderBy(desc(fiscalSales.issuedAt));
  return json({
    month,
    orders: result.orders.map((o) => ({
      order: o.snapshot.order,
      amount: o.snapshot.amount,
      doc: o.doc,
    })),
    refunds: result.refunds,
    issues: result.issues,
    documents: docs
      .filter((d) => d.invoice || d.receipt)
      .map((d) => ({
        id: d.id,
        order: d.bookingId,
        date: localStamp(d.issuedAt).slice(0, 10),
        invoice: d.invoice,
        receipt: d.receipt,
        missingRrn: !!d.receipt && !(d.snapshot as Snapshot).rrn,
      })),
  });
}
export const config: Config = {
  path: "/api/admin/fiscal",
  method: ["GET", "POST"],
};
