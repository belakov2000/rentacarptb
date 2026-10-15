import type { Config, Context } from "@netlify/functions";
import { and, desc, eq, isNull } from "drizzle-orm";
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
// POST /api/admin/ads/spend { campaign, content, periodStart, periodEnd, amount, note? } – нов запис за разход в EUR
// POST /api/admin/ads/spend/:id { action: "delete" } – логическо изтриване (записът остава в базата)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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
  if (id) {
    if (!/^\d{1,9}$/.test(id) || body.action !== "delete") return json({ error: "invalid" }, 400);
    const [r] = await db.update(adSpend).set({ deletedAt: new Date() }).where(and(eq(adSpend.id, Number(id)), isNull(adSpend.deletedAt))).returning({ id: adSpend.id, amountCents: adSpend.amountCents });
    if (!r) return json({ error: "not_found" }, 404);
    await audit(admin.email, "ad_spend.delete", { id: r.id, amountCents: r.amountCents });
    return json({ ok: true });
  }
  const campaign = utmValue(body.campaign);
  const content = body.content == null || body.content === "" ? "" : utmValue(body.content);
  const amountCents = parseAmountCents(body.amount);
  if (!campaign) return json({ error: "campaign" }, 400);
  if (content == null) return json({ error: "content" }, 400);
  if (!validDate(body.periodStart) || !validDate(body.periodEnd) || body.periodStart > body.periodEnd) return json({ error: "period" }, 400);
  if (amountCents == null) return json({ error: "amount" }, 400);
  const [r] = await db
    .insert(adSpend)
    .values({ campaign, content, periodStart: body.periodStart, periodEnd: body.periodEnd, amountCents, currency: "EUR", note: typeof body.note === "string" ? body.note.trim().slice(0, 500) : "", createdBy: admin.email })
    .returning();
  await audit(admin.email, "ad_spend.create", { id: r.id, campaign, content, periodStart: r.periodStart, periodEnd: r.periodEnd, amountCents });
  return json({ ok: true, row: r }, 201);
};

export const config: Config = {
  path: ["/api/admin/ads/report", "/api/admin/ads/spend", "/api/admin/ads/spend/:id"],
  method: ["GET", "POST"],
};
