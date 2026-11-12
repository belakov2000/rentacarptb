import type { Config, Context } from "@netlify/functions";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings, cardPayments } from "../../db/schema.js";
import { esc } from "../../mail/index.js";
import { tranDateText, type Breakdown } from "../../mail/card.js";
import { sameOrigin } from "../../server/auth.js";
import { blockOf, breakdown, cardholderOf, checkLink, refreshOpen, startPayment, terminalConfig } from "../../server/card-pay.js";
import { breakdownTable, html, msg, redirectForm, sofiaTime, t, testBanner } from "../../server/card-page.js";
import { statusLink } from "../../server/stage.js";

// Защитена връзка за плащане с карта: /pay/:id?k=<таен ключ от имейла>
// GET  – разбивка на сумата и формуляр (име на картодържателя на латиница и адрес – задължителни данни в M_INFO, табл. 3)
// POST – създава опит (нов ORDER и NONCE), подписва заявката на сървъра и пренасочва браузъра към БОРИКА.
// Сумата е изчислена на сървъра от резервацията – браузърът подава само името и адреса на картодържателя.
// GET никога не започва плащане. Повторно натискане не създава втори опит, докато предишният няма окончателен резултат.
type Booking = typeof bookings.$inferSelect;

async function paidPage(b: Booking) {
  const [a] = b.cardPaymentId ? await db.select().from(cardPayments).where(eq(cardPayments.id, b.cardPaymentId)) : [];
  const L = b.lang;
  if (!a) return html(L, t(L, "isPaid"), msg(L, "ok", "isPaid", "okInfo"));
  const rows = [[t(L, "paid"), (a.amountCents / 100).toFixed(2).replace(".", ",") + " " + a.currency], [t(L, "tranDate"), tranDateText(a.tranDate) || sofiaTime(a.resolvedAt || new Date(), L)], [t(L, "tranRef"), a.rrn || ""], [t(L, "approval"), a.approval || ""], [t(L, "order"), a.orderNo]]
    .filter(([, v]) => v).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  return html(L, t(L, "isPaid"), `${testBanner(L, a.mode)}<h1>${esc(t(L, "title"))}</h1>${msg(L, "ok", "isPaid", "okInfo")}${breakdownTable(a.breakdown as Breakdown, L)}<table>${rows}</table><p class="hint">${esc(t(L, "notInvoice"))}</p><a class="btn dark" href="${esc(statusLink(b))}">${esc(t(L, "back"))}</a>`);
}

function formPage(b: Booking, url: URL, mode: string, err = "", holder = { name: "", addr: "" }) {
  const L = b.lang, bd = breakdown(b)!;
  const amount = (bd.payCents / 100).toFixed(2).replace(".", ",") + " €";
  return html(L, t(L, "title"), `${testBanner(L, mode)}<h1>${esc(t(L, "title"))}</h1><p class="hint">${esc(t(L, "booking"))} № ${esc(b.id.slice(0, 6).toUpperCase())} · ${esc(b.car)}<br>${esc(t(L, "pickup"))}: ${esc(b.pickup)}<br>${esc(t(L, "dropoff"))}: ${esc(b.dropoff)}</p>
${breakdownTable(bd, L)}${err ? `<div class="box bad">${esc(t(L, err))}</div>` : ""}
<form method="post" action="${esc(url.pathname + url.search)}"><label for="cn">${esc(t(L, "cardholder"))}</label><input id="cn" name="cardholder" required minlength="2" maxlength="45" pattern="[A-Za-z][A-Za-z .'\\-]{1,44}" autocomplete="cc-name" autocapitalize="characters" value="${esc(holder.name)}">
<label for="ad">${esc(t(L, "bill"))}</label><input id="ad" name="address" required minlength="3" maxlength="50" autocomplete="street-address" value="${esc(holder.addr)}">
<button>${esc(t(L, "payBtn", { amount }))}</button></form><p class="hint">${esc(t(L, "linkSafe"))}</p>`);
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const id = context.params?.id || url.pathname.split("/")[2] || "";
  const link = await checkLink(id, url.searchParams.get("k") || "");
  if (!link.ok) return html("bg", t("bg", "invalid"), `<h1>${esc(t("bg", "title"))}</h1>${msg("bg", "bad", "invalid", "invalidInfo")}<hr>${msg("en", "bad", "invalid", "invalidInfo")}`, 410);
  let b = link.booking;
  const L = b.lang;
  if (b.cardPaidAt) return paidPage(b);
  const cfg = terminalConfig();
  if (!cfg.ok) {
    // Без конфигурация (липсващ сертификат / ключ / настройка) – ясна недостъпност; нищо не се записва като платено
    console.warn("Card payment unavailable", cfg.reason);
    return html(L, t(L, "unavail"), `<h1>${esc(t(L, "title"))}</h1>${msg(L, "warn", "unavail", "unavailInfo")}`, 503);
  }
  // Окончателен резултат от предишни опити, ако има такива (напр. клиентът е затворил страницата на банката)
  await refreshOpen(b.id);
  [b] = await db.select().from(bookings).where(eq(bookings.id, b.id));
  if (b.cardPaidAt) return paidPage(b);
  const block = blockOf(b);
  if (block) return html(L, t(L, "blocked"), `<h1>${esc(t(L, "title"))}</h1>${msg(L, "bad", "blocked", "blockedInfo")}`, 409);

  if (req.method === "POST") {
    // CSRF: Origin на сайта, или (ако браузърът не праща Origin) Sec-Fetch-Site: same-origin
    const o = req.headers.get("origin");
    if (!sameOrigin(req) && !((!o || o === "null") && req.headers.get("sec-fetch-site") === "same-origin")) return new Response("Forbidden", { status: 403 });
    const form = await req.formData().catch(() => null);
    const raw = { name: String(form?.get("cardholder") ?? "").slice(0, 100), addr: String(form?.get("address") ?? "").slice(0, 100) };
    const holder = cardholderOf(raw.name, raw.addr);
    if (!holder) return formPage(b, url, cfg.t.mode, "inputErr", raw);
    const r = await startPayment(b, link.link.id, holder);
    if (r.ok) return redirectForm(L, r.action, r.fields);
    if (r.error === "paid") return paidPage((await db.select().from(bookings).where(eq(bookings.id, b.id)))[0]);
    if (r.error === "in_progress") return inProgress(b, url, cfg.t.mode);
    if (r.error === "review") return html(L, t(L, "review"), `<h1>${esc(t(L, "title"))}</h1>${msg(L, "bad", "review", "reviewInfo")}`, 409);
    if (r.error === "input") return formPage(b, url, cfg.t.mode, "inputErr", raw);
    return html(L, t(L, "unavail"), `<h1>${esc(t(L, "title"))}</h1>${msg(L, "warn", "unavail", "unavailInfo")}`, 503);
  }
  // Опит без окончателен резултат: не се предлага второ плащане
  const [open] = await db.select().from(cardPayments).where(and(eq(cardPayments.bookingId, b.id), eq(cardPayments.status, "redirected"))).orderBy(desc(cardPayments.createdAt)).limit(1);
  if (open) return inProgress(b, url, cfg.t.mode);
  const [unknown] = await db.select({ id: cardPayments.id }).from(cardPayments).where(and(eq(cardPayments.bookingId, b.id), eq(cardPayments.status, "unknown"))).limit(1);
  if (unknown) return html(L, t(L, "review"), `<h1>${esc(t(L, "title"))}</h1>${msg(L, "bad", "review", "reviewInfo")}`, 409);
  return formPage(b, url, cfg.t.mode);
};

function inProgress(b: Booking, url: URL, mode: string) {
  const L = b.lang;
  return html(L, t(L, "inProgress"), `${testBanner(L, mode)}<h1>${esc(t(L, "title"))}</h1><div class="box warn"><b>${esc(t(L, "inProgress"))}</b></div><p>${esc(t(L, "inProgressInfo"))}</p><a class="btn dark" href="${esc(url.pathname + url.search)}">${esc(t(L, "check"))}</a>`, 409);
}

export const config: Config = {
  path: "/pay/:id",
  method: ["GET", "POST"],
};
