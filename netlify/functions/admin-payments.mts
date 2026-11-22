import type { Config, Context } from "@netlify/functions";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookingEvents, bookings, payments } from "../../db/schema.js";
import { parseAmountCents } from "../../db/money.js";
import { json, requireAdmin } from "../../server/auth.js";
import { recordSale, deliverSale } from "../../server/fiscal.js";
import { finance, KINDS, METHODS, refundableLeft, summarize } from "../../server/payments.js";

// Плащания по резервации в админ панела (само за администратор; промените – само от същия сайт).
// GET  /api/admin/payments?booking=:id – плащанията по резервацията и обобщение (приход за наема, гаранционен депозит, очаквани)
// GET  /api/admin/payments             – последните 200 плащания по всички резервации
// POST /api/admin/payments { bookingId, kind, method, amount, status, paidAt?, note?, txnId?, refundOf?, idempotencyKey }
//      – ново плащане или възстановяване (kind = refund с refundOf към получено плащане по същата резервация, до оставащата сума)
// POST /api/admin/payments/:id { status: received | failed, paidAt? } – очаквано плащане става получено или неуспешно
// Записите не се изтриват; всяка промяна се записва в историята (booking_events).
const ID_RE = /^[a-f0-9]{32}$/;
const KEY_RE = /^[\w-]{8,100}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
// Дата и час на плащането: ISO от браузъра; не в бъдещето и не преди 2020 г.
function paidAtOf(v: unknown) {
  if (v == null || v === "") return new Date();
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) && t <= Date.now() + 5 * 60_000 && t >= Date.UTC(2020, 0, 1) ? new Date(t) : null;
}

function earlyReturn(b: {returnedAt: Date | null; endDate: string | null; endTime: string | null}) {
  if (!b.returnedAt || !b.endDate || !b.endTime) return false;
  const actual = new Intl.DateTimeFormat("sv-SE", {timeZone:"Europe/Sofia",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(b.returnedAt);
  return actual < b.endDate + " " + b.endTime;
}

async function forBooking(bookingId: string) {
  const list = await db.select().from(payments).where(eq(payments.bookingId, bookingId)).orderBy(payments.createdAt);
  const [b] = await db.select({ returnedAt: bookings.returnedAt, endDate: bookings.endDate,endTime: bookings.endTime, status: bookings.status, totalCents: bookings.totalCents, totalReview: bookings.totalReview }).from(bookings).where(eq(bookings.id, bookingId));
  // finance: договорена сума, остатък / надплащане и гаранционен депозит (server/payments.ts) – само показване, без нови записи
  return { earlyReturn: !!b && earlyReturn(b), payments: list.map((p) => ({ ...p, refundable: refundableLeft(p, list) })), summary: summarize(list), finance: b ? finance(b, list) : null };
}

export default async (req: Request, context: Context) => {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const url = new URL(req.url);
  const id = context.params?.id || url.pathname.split("/")[4] || "";

  if (req.method === "GET") {
    const bookingId = url.searchParams.get("booking") || "";
    if (bookingId) return ID_RE.test(bookingId) ? json(await forBooking(bookingId)) : json({ error: "not_found" }, 404);
    const rows = await db
      .select({ id: payments.id, bookingId: payments.bookingId, amountCents: payments.amountCents, currency: payments.currency, method: payments.method, kind: payments.kind, status: payments.status, paidAt: payments.paidAt, refundOf: payments.refundOf, createdAt: payments.createdAt, createdBy: payments.createdBy, name: bookings.name, car: bookings.car })
      .from(payments)
      .innerJoin(bookings, eq(bookings.id, payments.bookingId))
      .orderBy(desc(payments.createdAt))
      .limit(200);
    return json({ rows });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "invalid" }, 400);

  if (!id && body.action === "settleEarlyReturn") {
    if (!ID_RE.test(body.bookingId || "")) return json({ error:"not_found" },404);
    const changed = await db.transaction(async tx => {
      const [b] = await tx.select().from(bookings).where(eq(bookings.id,body.bookingId)).for("update");
      if (!b || !earlyReturn(b)) return false;
      const list = await tx.select().from(payments).where(eq(payments.bookingId,b.id));
      const f = finance(b,list);
      if (f.balanceState !== "due" || f.expected || f.nonEur || f.rentalNet <= 0 ||
          f.agreedCents !== body.previousCents || f.rentalNet !== body.finalCents) return false;
      await tx.update(bookings).set({totalCents:f.rentalNet,total:(f.rentalNet / 100).toFixed(2).replace(".",",") + " €",updatedAt:new Date()}).where(eq(bookings.id,b.id));
      await tx.insert(bookingEvents).values({bookingId:b.id, actor:admin.email,action:"booking.early_return_settled",
        details:{oldTotalCents:f.agreedCents,newTotalCents:f.rentalNet,reason:"Предсрочно връщане по взаимно съгласие"}});
      return true;
    });
    return changed ? json({ok:true}) : json({error:"Обнови резервацията и провери сумите."},409);
  }

  // ===== Промяна на статуса на очаквано плащане =====
  if (id) {
    if (!ID_RE.test(id)) return json({ error: "not_found" }, 404);
    const status = body.status;
    if (status !== "received" && status !== "failed") return json({ error: "status" }, 400);
    const paidAt = status === "received" ? paidAtOf(body.paidAt) : null;
    if (status === "received" && !paidAt) return json({ error: "paid_at" }, 400);
    const r = await db.transaction(async (tx) => {
      // Същият ред на заключване като при ново плащане и при започване на плащане с карта (server/card-pay.ts → startPayment):
      // първо резервацията, после плащането
      const [ref] = await tx.select({ bookingId: payments.bookingId }).from(payments).where(eq(payments.id, id));
      if (!ref) return { error: "not_found" as const };
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, ref.bookingId)).for("update");
      const [p] = await tx.select().from(payments).where(eq(payments.id, id)).for("update");
      if (!p) return { error: "not_found" as const };
      if (p.status !== "expected") return { error: "not_expected" as const, bookingId: p.bookingId };
      const [updated] = await tx.update(payments).set({ status, paidAt, updatedBy: admin.email, updatedAt: new Date() }).where(and(eq(payments.id, id), eq(payments.status, "expected"))).returning();
      if (status === "received") await recordSale(tx,booking,updated);
      await tx.insert(bookingEvents).values({ bookingId: p.bookingId, actor: admin.email, action: "payment.status", details: { payment: id, kind: p.kind, from: "expected", to: status, amountCents: p.amountCents } });
      return { bookingId: p.bookingId };
    });
    if ("error" in r) return json({ error: r.error, ...(r.bookingId ? await forBooking(r.bookingId) : {}) }, r.error === "not_found" ? 404 : 409);
    if(status==="received") await deliverSale(id).catch(()=>console.error("Fiscal email queued",id));
    return json({ ok: true, ...(await forBooking(r.bookingId)) });
  }

  // ===== Ново плащане или възстановяване =====
  const bookingId = str(body.bookingId, 40);
  const kind = body.kind, method = body.method, status = body.status;
  const amountCents = parseAmountCents(body.amount);
  const idempotencyKey = str(body.idempotencyKey, 100);
  if (!ID_RE.test(bookingId)) return json({ error: "not_found" }, 404);
  if (!(KINDS as readonly string[]).includes(kind)) return json({ error: "kind" }, 400);
  if (!(METHODS as readonly string[]).includes(method)) return json({ error: "method" }, 400);
  if (!["expected", "received"].includes(status)) return json({ error: "status" }, 400);
  if (!amountCents || amountCents <= 0) return json({ error: "amount" }, 400);
  if (!KEY_RE.test(idempotencyKey)) return json({ error: "key" }, 400);
  const paidAt = status === "received" ? paidAtOf(body.paidAt) : null;
  if (status === "received" && !paidAt) return json({ error: "paid_at" }, 400);
  const refundOf = kind === "refund" ? str(body.refundOf, 40) : null;
  if (kind === "refund" && !ID_RE.test(refundOf || "")) return json({ error: "refund_of" }, 400);

  const r = await db.transaction(async (tx) => {
    // Заключване на резервацията: плащанията по нея (и проверката за остатъка при възстановяване) се записват едно след друго
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
    if (!b) return { error: "not_found" as const };
    // Повторно изпращане на същата форма връща вече записаното плащане
    const [same] = await tx.select().from(payments).where(eq(payments.idempotencyKey, idempotencyKey));
    if (same) return same.bookingId === bookingId ? { duplicate: true } : { error: "key" as const };
    if (refundOf) {
      const list = await tx.select().from(payments).where(eq(payments.bookingId, bookingId));
      const o = list.find((p) => p.id === refundOf);
      if (!o || o.kind === "refund") return { error: "refund_of" as const };
      if (amountCents > refundableLeft(o, list)) return { error: "refund_amount" as const };
    }
    const pid = crypto.randomUUID().replace(/-/g, "");
    const [payment] = await tx.insert(payments).values({
      id: pid, bookingId, amountCents, currency: "EUR", method, kind, status, paidAt, refundOf,
      txnId: str(body.txnId, 120), note: str(body.note, 1000), idempotencyKey, createdBy: admin.email,
    }).returning();
    if(status === "received") await recordSale(tx,b,payment);
    await tx.insert(bookingEvents).values({ bookingId, actor: admin.email, action: kind === "refund" ? "payment.refund" : "payment.create", details: { payment: pid, kind, status, amountCents, ...(refundOf ? { refundOf } : {}) } });
    return { duplicate: false, paymentId:pid };
  });
  if ("error" in r) return json({ error: r.error, ...(r.error === "not_found" || r.error === "key" ? {} : await forBooking(bookingId)) }, r.error === "not_found" ? 404 : r.error === "key" ? 409 : 400);
  if (r.paymentId && status==="received") await deliverSale(r.paymentId).catch(()=>console.error("Fiscal email queued",r.paymentId));
  return json({ ok: true, duplicate: r.duplicate, ...(await forBooking(bookingId)) }, r.duplicate ? 200 : 201);
};

export const config: Config = {
  path: ["/api/admin/payments", "/api/admin/payments/:id"],
  method: ["GET", "POST"],
};
