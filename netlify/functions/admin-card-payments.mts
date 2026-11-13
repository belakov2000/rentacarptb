import type { Config, Context } from "@netlify/functions";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings, cardPayments } from "../../db/schema.js";
import { audit, json, requireAdmin } from "../../server/auth.js";
import { blockOf, breakdown, cardState, checkStatus, configDiagnostics, envNames, issueLink, payMode, releaseUnknown, sendLink, terminalConfig } from "../../server/card-pay.js";
import { envKind } from "../../server/stores.js";

// Плащане с карта (БОРИКА) по резервация – само за администратор (Netlify Identity, роля admin; промените – само от същия сайт).
// GET  /api/admin/card-payments?booking=:id – настройка на средата (без стойностите), сума, връзки и опити
// POST /api/admin/card-payments { bookingId, action: "send_link" } – нова защитена връзка (предишните се отменят) и писмо до клиента
// POST /api/admin/card-payments { bookingId, action: "check" }     – проверка за статус (TRTYPE=90) на опитите без окончателен резултат
// POST /api/admin/card-payments { bookingId, action: "release", attemptId, confirm, note } – опит с неизвестен резултат става
//      неуспешен (нов опит е разрешен) само след ръчна проверка в Merchant Portal, че трансакцията не е успешна
// Нищо тук не отбелязва плащане – плащане се записва само от проверен отговор на БОРИКА.
const ID_RE = /^[a-f0-9]{32}$/;

export default async (req: Request, _context: Context) => {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.json().catch(() => null) : null;
  const id = req.method === "POST" ? String(body?.bookingId || "") : url.searchParams.get("booking") || "";
  if (!ID_RE.test(id)) return json({ error: "not_found" }, 404);
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id));
  if (!b) return json({ error: "not_found" }, 404);
  const cfg = terminalConfig();
  const mode = payMode();
  const config = { available: cfg.ok, reason: cfg.ok ? "" : cfg.reason, mode, envKind: envKind(), variables: mode ? Object.values(envNames(mode)) : [], terminal: cfg.ok ? cfg.t.terminal : "", currency: cfg.ok ? cfg.t.currency : "" };

  // Диагностика на ключовете само при недостъпна конфигурация – без стойности на ключове, пароли или променливи
  if (!cfg.ok && mode && (cfg.reason === "key" || cfg.reason === "missing" || cfg.reason === "currency")) Object.assign(config, { diagnostics: configDiagnostics() });
  if (req.method === "GET") return json({ config, block: blockOf(b), breakdown: breakdown(b), paidAt: b.cardPaidAt, ...(await cardState(id)) });

  if (body?.action === "send_link") {
    const block = blockOf(b);
    if (block) return json({ error: "block", block }, 409);
    const { link, url: payUrl } = await issueLink(b, admin.email);
    const r = await sendLink(b, link).catch(() => ({ result: "failed" as const }));
    await audit(admin.email, "card.link_sent", { email: r?.result ?? "none" }, id);
    // Връзката се показва и на администратора (напр. в Preview, където писма не се изпращат)
    return json({ ok: true, url: payUrl, expiresAt: link.expiresAt, email: r?.result ?? "none", configured: cfg.ok });
  }
  if (body?.action === "check") {
    const open = await db.select().from(cardPayments).where(eq(cardPayments.bookingId, id));
    const results: string[] = [];
    for (const a of open.filter((x) => x.status === "redirected")) results.push(await checkStatus(a).catch(() => "network"));
    await audit(admin.email, "card.status_checked", { results }, id);
    return json({ ok: true, results });
  }
  // Опит с неизвестен резултат: освобождава се само ръчно, с изрично потвърдена проверка в Merchant Portal
  if (body?.action === "release") {
    const note = String(body.note || "").trim().slice(0, 200);
    if (body.confirm !== "merchant-portal-not-successful" || note.length < 3) return json({ error: "confirm" }, 400);
    const [a] = await db.select().from(cardPayments).where(eq(cardPayments.id, String(body.attemptId || "")));
    if (!a || a.bookingId !== id) return json({ error: "not_found" }, 404);
    const u = await releaseUnknown(a.id, admin.email, note);
    if (!u) return json({ error: "state" }, 409);
    return json({ ok: true });
  }
  return json({ error: "action" }, 400);
};

export const config: Config = {
  path: "/api/admin/card-payments",
  method: ["GET", "POST"],
};
