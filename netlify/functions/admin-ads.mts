import type { Config, Context } from "@netlify/functions";
import { and, desc, eq, gte, isNull, lte, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { adSpend } from "../../db/schema.js";
import { parseAmountCents } from "../../db/money.js";
import { audit, json, requireAdmin } from "../../server/auth.js";
import { utmValue } from "../../server/attribution.js";
import { loadReport, nextDay, sofiaMidnight } from "../../server/ad-report.js";
import { sofiaToday } from "../../db/hours.js";

// Реклами: отчет по кампания и вариант и ръчно въведен действителен рекламен разход (само за администратор).
// GET  /api/admin/ads/report?from=YYYY-MM-DD&to=YYYY-MM-DD[&paidUntil=YYYY-MM-DD] – виж server/ad-report.ts
// GET  /api/admin/ads/spend                 – въведените разходи (без изтритите)
// POST /api/admin/ads/spend { campaign, content, periodStart, periodEnd, amount, note?, idempotencyKey } – нов запис за разход в EUR
// POST /api/admin/ads/spend/:id { action: "correct", amount, note?, idempotencyKey } – корекция: старият запис се закрива
//      и се заменя с нов за същата кампания, вариант и период (в една транзакция – сумата не се брои два пъти)
// POST /api/admin/ads/spend/:id { action: "delete" } – логическо изтриване (записът остава в базата)
// Ограниченията са в базата (db/schema.ts): уникален idempotencyKey и без застъпващи се активни периоди за една кампания
// и вариант. Повторно изпращане със същия ключ връща вече записания разход (200, duplicate); застъпване → 409 overlap.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[\w-]{8,100}$/;
type Spend = typeof adSpend.$inferSelect;
// Код на грешката от PostgreSQL (drizzle я обвива в cause)
const pgCode = (e: unknown): string => (e as any)?.cause?.code || (e as any)?.code || "";
const pgConstraint = (e: unknown): string => (e as any)?.cause?.constraint || (e as any)?.constraint || "";
const noteOf = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 500) : "");
// Активните записи за същата кампания и вариант, чийто период се застъпва – за съобщението до администратора
const overlapping = (campaign: string, content: string, start: string, end: string, exceptId = 0) =>
  db.select({ id: adSpend.id, periodStart: adSpend.periodStart, periodEnd: adSpend.periodEnd, amountCents: adSpend.amountCents }).from(adSpend)
    .where(and(eq(adSpend.campaign, campaign), eq(adSpend.content, content), isNull(adSpend.deletedAt), lte(adSpend.periodStart, end), gte(adSpend.periodEnd, start), ...(exceptId ? [ne(adSpend.id, exceptId)] : [])));
const byKey = async (key: string) => (await db.select().from(adSpend).where(eq(adSpend.idempotencyKey, key)))[0];
// Същата форма, изпратена повторно: ключът е записан със същите данни
const sameRequest = (r: Spend, v: { campaign: string; content: string; periodStart: string; periodEnd: string; amountCents: number; replacesId?: number | null }) =>
  r.campaign === v.campaign && r.content === v.content && r.periodStart === v.periodStart && r.periodEnd === v.periodEnd && r.amountCents === v.amountCents && (r.replacesId ?? null) === (v.replacesId ?? null);
const validDate = (s: unknown): s is string => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().startsWith(s);

export default async (req: Request, context: Context) => {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const url = new URL(req.url);
  const parts = url.pathname.split("/");
  const what = parts[4] || "";
  const id = context.params?.id || parts[5] || "";

  if (what === "report" && req.method === "GET") {
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    if (!validDate(from) || !validDate(to) || from > to) return json({ error: "period" }, 400);
    // Плащанията се отчитат до края на избрания ден (по българско време) или до момента на отчета
    const pu = url.searchParams.get("paidUntil");
    if (pu && !validDate(pu)) return json({ error: "paid_until" }, 400);
    const until = pu && pu < sofiaToday() ? new Date(sofiaMidnight(nextDay(pu)).getTime() - 1) : new Date();
    return json(await loadReport(from, to, until));
  }
  if (what !== "spend") return json({ error: "not_found" }, 404);
  if (req.method === "GET") {
    const rows = await db.select().from(adSpend).where(isNull(adSpend.deletedAt)).orderBy(desc(adSpend.periodStart), desc(adSpend.id)).limit(500);
    return json({ rows });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "invalid" }, 400);
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (id) {
    if (!/^\d{1,9}$/.test(id) || !["delete", "correct"].includes(body.action)) return json({ error: "invalid" }, 400);
    if (body.action === "delete") {
      const [r] = await db.update(adSpend).set({ deletedAt: new Date(), deletedBy: admin.email }).where(and(eq(adSpend.id, Number(id)), isNull(adSpend.deletedAt))).returning({ id: adSpend.id, amountCents: adSpend.amountCents });
      if (!r) return json({ error: "not_found" }, 404);
      await audit(admin.email, "ad_spend.delete", { id: r.id, amountCents: r.amountCents });
      return json({ ok: true });
    }
    // ===== Корекция =====
    const amountCents = parseAmountCents(body.amount);
    if (amountCents == null) return json({ error: "amount" }, 400);
    if (!KEY_RE.test(idempotencyKey)) return json({ error: "key" }, 400);
    const prev = await byKey(idempotencyKey);
    if (prev) return prev.replacesId === Number(id) && prev.amountCents === amountCents ? json({ ok: true, duplicate: true, row: prev }) : json({ error: "key_conflict" }, 409);
    try {
      const r = await db.transaction(async (tx) => {
        const [old] = await tx.select().from(adSpend).where(eq(adSpend.id, Number(id))).for("update");
        if (!old) return { error: "not_found" as const };
        // Вече изтрит или коригиран (напр. едновременна втора корекция) – не се заменя втори път
        if (old.deletedAt) return { error: "already_replaced" as const };
        await tx.update(adSpend).set({ deletedAt: new Date(), deletedBy: admin.email }).where(eq(adSpend.id, old.id));
        const [row] = await tx.insert(adSpend).values({
          campaign: old.campaign, content: old.content, periodStart: old.periodStart, periodEnd: old.periodEnd, amountCents, currency: "EUR",
          note: noteOf(body.note) || old.note, createdBy: admin.email, idempotencyKey, replacesId: old.id,
        }).returning();
        return { row, old };
      });
      if ("error" in r) return json({ error: r.error }, r.error === "not_found" ? 404 : 409);
      await audit(admin.email, "ad_spend.correct", { id: r.row.id, replaces: r.old.id, from: r.old.amountCents, to: amountCents });
      return json({ ok: true, row: r.row }, 201);
    } catch (e) {
      // Едновременна корекция със същия ключ – връща записаната
      if (pgCode(e) === "23505") { const p = await byKey(idempotencyKey); if (p) return json({ ok: true, duplicate: true, row: p }); }
      throw e;
    }
  }
  // ===== Нов разход =====
  const campaign = utmValue(body.campaign);
  const content = body.content == null || body.content === "" ? "" : utmValue(body.content);
  const amountCents = parseAmountCents(body.amount);
  if (!campaign) return json({ error: "campaign" }, 400);
  if (content == null) return json({ error: "content" }, 400);
  if (!validDate(body.periodStart) || !validDate(body.periodEnd) || body.periodStart > body.periodEnd) return json({ error: "period" }, 400);
  if (amountCents == null) return json({ error: "amount" }, 400);
  if (!KEY_RE.test(idempotencyKey)) return json({ error: "key" }, 400);
  const v = { campaign, content, periodStart: body.periodStart as string, periodEnd: body.periodEnd as string, amountCents };
  const duplicateOf = async () => {
    const p = await byKey(idempotencyKey);
    return p && (sameRequest(p, v) ? json({ ok: true, duplicate: true, row: p }) : json({ error: "key_conflict" }, 409));
  };
  const dup = await duplicateOf();
  if (dup) return dup;
  try {
    const [r] = await db.insert(adSpend).values({ ...v, currency: "EUR", note: noteOf(body.note), createdBy: admin.email, idempotencyKey }).returning();
    await audit(admin.email, "ad_spend.create", { id: r.id, campaign, content, periodStart: r.periodStart, periodEnd: r.periodEnd, amountCents });
    return json({ ok: true, row: r }, 201);
  } catch (e) {
    const code = pgCode(e);
    // Едновременно повторно изпращане: уникалният ключ спира втория запис – връща се първият
    if (code === "23505") { const d2 = await duplicateOf(); if (d2) return d2; }
    // Застъпване с активен запис (ограничението ad_spend_no_overlap) – и когато двете заявки са едновременни
    if (code === "23P01" || pgConstraint(e) === "ad_spend_no_overlap")
      return json({ error: "overlap", conflicts: await overlapping(campaign, content, v.periodStart, v.periodEnd) }, 409);
    throw e;
  }
};

export const config: Config = {
  path: ["/api/admin/ads/report", "/api/admin/ads/spend", "/api/admin/ads/spend/:id"],
  method: ["GET", "POST"],
};
