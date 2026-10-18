import type { Config, Context } from "@netlify/functions";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookingEvents, bookings, cars } from "../../db/schema.js";
import { minutes } from "../../db/slots.js";
import { sofiaToday, withinHours } from "../../db/hours.js";
import { addressError, kmRate, parseContract, type ContractData } from "../../contract/index.js";
import { btn, esc, OWNER_EMAIL, wrapMail } from "../../mail/index.js";
import { contractDataKey, contracts, saveContract } from "../../server/contracts.js";
import { maskEmail, queueEmail } from "../../server/email.js";
import { langOf, langSwitch, localize, type Lang } from "../../server/manage-i18n.js";
import { act, allowed, confirmBlock, decide, linkExpired, pickupAt, REASON_BG, REASONS, STATUS_LABEL, type Action, type DecideError } from "../../server/booking-actions.js";
import { findConflict, lock, type Conflict } from "../../server/conflicts.js";
import { parseAttribution } from "../../server/attribution.js";
import { documentsOf } from "../../server/documents.js";
import { ownerNewKey, receivedKey, saveOwnerOutbox, sendCustomerReceived, sendOwnerNew } from "../../server/notify.js";
import { ownerRequestText, withServerPrice } from "../../server/request-text.js";
import { fmtCents, priceLines } from "../../server/pricing.js";
import { bookingInput, checkInput, claimQuote, contractWithPrice, priceSnapshot, verifyQuote, type QuoteFail } from "../../server/quote.js";
import { driversInfo, driversOf, STAGE_LABEL, statusView, submitDocuments } from "../../server/stage.js";

// Резервации с потвърждение от фирмата.
// POST /api/bookings                 – записва заявката, праща имейл до фирмата с бутони „Потвърди“ / „Откажи“ и потвърждение до клиента, че заявката е получена.
//                                       Цената е само от валидна сървърна оферта (/api/quote, server/quote.ts) – сумата от браузъра не се приема.
// GET  /api/bookings/:id?t=…         – статус на заявката за страницата „Благодарим“ на клиента
// GET  /api/bookings/:id/manage?key=… – страница за фирмата с данните и бутоните (линкът е само в имейла)
// POST /api/bookings/:id/manage?key=… – потвърждава или отказва и праща имейл до клиента; поправя километрите в договора;
//                                       за потвърдена резервация: отмяна, „Клиентът не се яви“ и „Автомобилът е предаден“
//                                       (на две стъпки – първата само показва потвърждение, втората изпълнява с токен за стъпката)
// Линкът за управление изтича 30 дни след края на наема – след това управлението е в админ панела (/admin/bookings/:id).
// GET  /api/bookings/:id/contract?key=… – попълненият договор за наем (.docx), линкът е само в имейла и на страницата за фирмата
// Напомнянията преди получаване/връщане и молбата за отзив се пращат от функцията customer-emails.
// Имейлите се записват в email_log преди изпращането; неуспешните се опитват отново от функцията email-retry.
// Потвърждаването е в транзакция със заключване на автомобила – две конфликтни резервации не могат да бъдат потвърдени едновременно.
const ID_RE = /^[a-f0-9]{32}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CAR_RE = /^[a-z0-9-]{1,40}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const rnd = (n: number) => Array.from({ length: n }, () => crypto.randomUUID().replace(/-/g, "")).join("");
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const REQUEST_KEY_RE = /^[\w-]{8,100}$/;
const DUPLICATE_WINDOW_MS = 10 * 60_000;
const contractLink = (origin: string, b: { id: string; adminToken: string }) => `${origin}/api/bookings/${b.id}/contract?key=${b.adminToken}`;

type Booking = typeof bookings.$inferSelect;


// ===== Страница за фирмата =====
// Език на страницата за управление (?lang=en|de; по подразбиране български) – за всяка заявка поотделно
const REQ = new AsyncLocalStorage<{ lang: Lang; url: URL }>();
const pageLang = () => REQ.getStore()?.lang || "bg";
function page(title: string, body: string, status = 200) {
  const r = REQ.getStore();
  if (r && r.url.searchParams.get("key")) body = langSwitch(r.url, r.lang) + body;
  return new Response(
    localize(`<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{font-family:Arial,sans-serif;background:#f3f5f9;color:#0f1b2d;margin:0;padding:24px}main{max-width:560px;margin:0 auto;background:#fff;border-radius:22px;padding:26px}h1{font-size:1.5rem;margin:0 0 14px}
.kv div{display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-bottom:1px solid #e6e9ef}.kv span{color:#5b6577}.badge{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:700;margin-bottom:12px}
.pending{background:#fff4cc}.confirmed{background:#d9f5e3;color:#11643a}.rejected,.cancelled,.no_show{background:#fde2e0;color:#9b1c13}
.box{margin-top:22px;padding-top:6px;border-top:1px solid #e6e9ef}.box h2{font-size:1.1rem;margin:14px 0 4px}.hint{color:#5b6577;font-size:.88rem;margin:6px 0}
.opt{display:flex;gap:10px;align-items:center;font-weight:600;margin:8px 0}.opt input{width:auto;min-height:0;margin:0}a.back{display:block;text-align:center;margin-top:12px;color:#0f1b2d;font-weight:700}
.dark{background:#0f1b2d;color:#fff}.langs{text-align:right;margin:0 0 8px;font-size:.9rem}.langs a{color:#0f1b2d;padding:6px}.langs b{padding:6px}
button{font:inherit;font-weight:700;border:0;border-radius:999px;padding:14px 22px;cursor:pointer;width:100%;margin-top:10px}.ok{background:#1a8f4c;color:#fff}.no{background:#c0392b;color:#fff}
textarea,input{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #cdd3dd;border-radius:12px;min-height:70px}select{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #cdd3dd;border-radius:12px;margin-top:8px;background:#fff}label{display:block;font-weight:700;margin:16px 0 6px;font-size:.9rem}</style></head>
<body><main>${body}</main></body></html>`, pageLang()),
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

const PAY_BG: Record<string, string> = {
  bankp: "По банков път – физическо лице (фактура)",
  bank: "По банков път – фирма (фактура)",
  cash: "В брой на място с касов бон",
};
const STATUS_BG = STATUS_LABEL;

// Форма за поправка на километрите за доставка / връщане от адрес (договорът се попълва наново)
function kmForm(cd: ContractData | null) {
  const legs = cd ? ([["kmDel", "Доставка до", cd.del], ["kmRet", "Връщане от", cd.ret]] as const).filter(([, , l]) => l) : [];
  if (!legs.length) return "";
  const fields = legs
    .map(([n, label, l]) => {
      const r = kmRate(l!.rate);
      const opt = (v: number, t: string) => `<option value="${v}"${r === v ? " selected" : ""}>${t}</option>`;
      return `<label for="${n}">${esc(label)}: ${esc(l!.addr)}</label><input id="${n}" name="${n}" inputmode="decimal" placeholder="км" value="${l!.km != null ? String(l!.km).replace(".", ",") : ""}"><select name="${n}Rate" aria-label="Цена на км">${opt(1, "1,00 EUR/км – Пловдив и района")}${opt(0.7, "0,70 EUR/км – извън Пловдив и района")}</select>`;
    })
    .join("");
  return `<form method="post" style="margin-top:22px;padding-top:6px;border-top:1px solid #e6e9ef"><p style="margin:10px 0 0"><b>Километри в договора</b> (по пътен маршрут от бул. Дунав 10; 1,00 EUR/км в Пловдив, околните села, летище Пловдив и Асеновград, 0,70 EUR/км извън тях). Ако разстоянието в Google Maps или зоната са различни, поправете ги тук – договорът се попълва наново.</p>${fields}<button class="ok" style="background:#0f1b2d" name="action" value="km">Запази километрите и обнови договора</button></form>`;
}

// ===== Управление на потвърдена резервация (отмяна, неявяване, предаване) =====
const sofia = (d: Date) => d.toLocaleString("bg-BG", { timeZone: "Europe/Sofia" });
const bgAt = (s: string) => (s ? s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4) + " " + s.slice(11) : "");
const ACTOR_BG = (a: string) => (a === "owner-link" ? "собственик (линк от имейла)" : a);
const ACTIONS: Record<Action, { ask: string; yes: string; done: string }> = {
  cancel: { ask: "Да отменим ли резервацията? Автомобилът ще бъде освободен за нови резервации.", yes: "Да, отмени резервацията", done: "Резервацията е отменена. Автомобилът е освободен за нови резервации." },
  no_show: { ask: "Да отбележим ли, че клиентът не се яви? Резервацията ще бъде закрита и автомобилът ще бъде освободен за нови резервации.", yes: "Да, клиентът не се яви", done: "Резервацията е закрита като неявяване. Автомобилът е освободен за нови резервации." },
  handover: { ask: "Да отбележим ли, че автомобилът е предаден на клиента? След това отмяна и „Клиентът не се яви“ няма да са възможни.", yes: "Да, автомобилът е предаден", done: "Отбелязано е, че автомобилът е предаден. Наемът е започнал." },
};
// Токен за втората стъпка: зависи от тайния ключ и от текущото състояние – остарял или подправен формуляр не се изпълнява
async function stepToken(b: Booking, action: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${b.adminToken}:${b.id}:${action}:${b.status}:${b.updatedAt?.getTime() ?? 0}:${b.handedOverAt?.getTime() ?? 0}`));
  return Buffer.from(h).toString("hex");
}
const notifyBox = (id: string) => `<label class="opt"><input type="checkbox" name="notify" value="1" id="${id}" checked> Изпрати имейл на клиента</label>`;
function lifecycle(b: Booking) {
  if (b.status === "cancelled" || b.status === "no_show") {
    const kv = [["Причина", REASON_BG[b.closeReason] || b.closeReason], ["Кога", b.closedAt ? sofia(b.closedAt) : ""], ["От", ACTOR_BG(b.closedBy)], ["Вътрешна бележка", b.closeNote]]
      .filter(([, v]) => v).map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
    return `<div class="box"><h2>${b.status === "cancelled" ? "Резервацията е отменена" : "Клиентът не се яви"}</h2><div class="kv">${kv}</div><p class="hint">Автомобилът е освободен. Записът остава в историята.</p></div>`;
  }
  if (b.status !== "confirmed") return "";
  if (b.handedOverAt)
    return `<div class="box"><h2>Автомобилът е предаден</h2><p class="hint">Предаден на ${esc(sofia(b.handedOverAt))} (${esc(ACTOR_BG(b.handedOverBy))}). Наемът е започнал – отмяна и „Клиентът не се яви“ не са възможни. Приключването или прекратяването на започнал наем се урежда отделно.</p></div>`;
  const can = allowed(b);
  const reasons = REASONS.map((r, i) => `<label class="opt"><input type="radio" name="reason" value="${r}"${i ? "" : " checked"}> ${esc(REASON_BG[r])}</label>`).join("");
  return `<div class="box"><h2>Отмяна на резервацията</h2><p class="hint">Възможна веднага, включително дни преди получаването, докато автомобилът не е предаден. Не се извършват плащания или възстановявания.</p>
<form method="post">${reasons}<label for="cnote">Вътрешна бележка (по избор, не се изпраща на клиента)</label><textarea id="cnote" name="note" maxlength="1000"></textarea>${notifyBox("cn")}
<button class="no" name="action" value="cancel">Отмени резервацията</button></form></div>
<div class="box"><h2>Клиентът не се яви</h2>${can.no_show
    ? `<form method="post"><label for="nnote">Вътрешна бележка (по избор, не се изпраща на клиента)</label><textarea id="nnote" name="note" maxlength="1000"></textarea>${notifyBox("nn")}<button class="no" name="action" value="no_show">Клиентът не се яви</button></form>`
    : `<p class="hint">Достъпно след часа за получаване: ${esc(bgAt(pickupAt(b)))} (време в България).</p>`}</div>
<div class="box"><h2>Предаване на автомобила</h2><p class="hint">Отбележете, когато клиентът получи автомобила. След това отмяна и неявяване няма да са възможни.</p><form method="post"><button class="dark" name="action" value="handover">Автомобилът е предаден</button></form></div>`;
}
async function confirmPage(b: Booking, origin: string, action: Action, reason: string, note: string, notify: boolean) {
  const a = ACTIONS[action];
  const kv = [["Автомобил", b.car], ["Получаване", b.pickup], ["Връщане", b.dropoff], ["Статус", STATUS_BG[b.status] || b.status], ...(action === "cancel" ? [["Причина", REASON_BG[reason]]] : []), ...(note ? [["Вътрешна бележка", note]] : [])]
    .map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v || "-")}</b></div>`).join("");
  const mail = action === "handover" ? "" : `<p><b>${notify ? `Ще бъде изпратен имейл до клиента (${esc(maskEmail(b.email))}) с номера, автомобила, периода и новия статус. Вътрешната бележка не се изпраща.` : "Няма да бъде изпратен имейл до клиента."}</b></p>`;
  const hidden = (n: string, v: string) => `<input type="hidden" name="${n}" value="${esc(v)}">`;
  return page(
    "Потвърждение – " + b.name,
    `<h1>Потвърдете действието</h1><span class="badge ${b.status}">${esc(STATUS_BG[b.status] || b.status)}</span><div class="kv">${kv}</div><p style="font-size:1.05rem"><b>${esc(a.ask)}</b></p>${mail}
<form method="post">${hidden("action", action)}${hidden("reason", reason)}${hidden("note", note)}${hidden("notify", notify ? "1" : "0")}${hidden("step", await stepToken(b, action))}
<button class="${action === "handover" ? "dark" : "no"}">${esc(a.yes)}</button></form><a class="back" href="${esc(manageLink(origin, b))}">Назад, без промяна</a>`,
  );
}
const manageLink = (origin: string, b: { id: string; adminToken: string }) => `${origin}/api/bookings/${b.id}/manage?key=${b.adminToken}${pageLang() === "bg" ? "" : "&lang=" + pageLang()}`;

// Защо чакащата заявка не може да бъде потвърдена (общо за страницата от имейла; панелът има свои текстове)
const DECIDE_MSG: Record<DecideError, string> = {
  not_found: "Резервацията не е намерена.",
  state: "Тази резервация вече е обработена.",
  no_dates: "Заявката няма записани дати на получаване и връщане и не може да бъде потвърдена. Можете да я откажете и да се свържете с клиента за нова заявка.",
  expired: "Часът за получаване по тази заявка вече е минал и тя не може да бъде потвърдена. Можете да я откажете и да се свържете с клиента за нова заявка.",
  car_inactive: "Автомобилът е отбелязан като неактивен и заявката не може да бъде потвърдена.",
  busy: "Резервацията не е потвърдена – датите вече са заети.",
  docs_pending: "Документите на клиента още не са получени. Окончателното потвърждение е възможно след подаването им.",
};
const conflictText = (c: Conflict) =>
  c.kind === "booking"
    ? `Внимание: автомобилът вече е потвърден за ${c.name} (${c.pickup} → ${c.dropoff}).`
    : `Внимание: автомобилът е блокиран за периода ${c.startDate} – ${c.endDate}${c.reason ? ` (${c.reason})` : ""}.`;

// Двуетапна заявка: водачи, услуги и етап на документите (без данни от документите)
function stageInfo(b: Booking) {
  const d = driversInfo(b);
  if (!b.stage || !d) return "";
  const rows = [
    ["Водачи", `${d.requesterDrives ? "Заявителят" : "Друг човек (заявителят не шофира)"}${d.count === 2 ? " + втори допълнителен водач" : ""}${d.names.length ? ": " + d.names.join(", ") : ""}`],
    ["Услуги", [b.chains && "вериги", b.secondDriver && "втори водач"].filter(Boolean).join(", ") || "—"],
    ["Документи", b.docsSubmittedAt ? `получени ${b.docsSubmittedAt.toLocaleString("bg-BG", { timeZone: "Europe/Sofia" })} (${Array.isArray(b.documents) ? b.documents.length : 0} снимки – в админ панела)` : b.stage === "docs" ? "очакват се" : "—"],
  ];
  return `<div class="kv">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div>`;
}

function managePage(b: Booking, origin: string, msg = "", conflict: Conflict | null = null, cd: ContractData | null = null) {
  const kv = [
    ["Клиент", b.name], ["Телефон", b.phone], ["Имейл", b.email], ["Автомобил", b.car],
    ["Получаване", b.pickup], ["Връщане", b.dropoff], ["Общо", b.total], ["Плащане", PAY_BG[b.payment] || ""],
  ].map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v || "-")}</b></div>`).join("") +
    (b.invoice ? `<div><span>Данни за фактура</span><b style="white-space:pre-line;text-align:right">${esc(b.invoice)}</b></div>` : "");
  const blocked = b.status === "pending" ? confirmBlock(b) : "";
  const warn = blocked
    ? `<p class="badge rejected" style="display:block;border-radius:14px">${esc(DECIDE_MSG[blocked])}</p>`
    : conflict && b.status === "pending"
      ? `<p class="badge rejected" style="display:block;border-radius:14px">${esc(conflictText(conflict))} Тази заявка не може да бъде потвърдена за същите дати.</p>`
      : "";
  const actions =
    b.status === "pending"
      ? `<form method="post"><label for="note">Съобщение до клиента (по избор)</label><textarea id="note" name="note" maxlength="1000" placeholder="Напр. час и място за среща или причина за отказ"></textarea>
${blocked || b.stage === "docs" ? "" : `<button class="ok" name="action" value="confirm">${b.stage === "request" ? "✓ Одобри и покани за документи" : b.stage === "review" ? "✓ Окончателно потвърди" : "✓ Потвърди резервацията"}</button>`}
<button class="no" name="action" value="reject" onclick="return confirm('Сигурни ли сте, че искате да откажете резервацията?')">✕ Откажи резервацията</button></form>`
      : `<p>Решението е взето${b.decidedAt ? " на " + esc(b.decidedAt.toLocaleString("bg-BG", { timeZone: "Europe/Sofia" })) : ""}. Клиентът вижда статуса на сайта.</p>` + lifecycle(b);
  return page(
    "Резервация – " + b.name,
    `<h1>Резервация</h1><span class="badge ${b.status}">${STATUS_BG[b.status] || b.status}</span>${b.stage && b.status === "pending" ? ` <span class="badge pending">${esc(STAGE_LABEL[b.stage] || b.stage)}</span>` : ""}${msg ? `<p><b>${esc(msg)}</b></p>` : ""}${warn}${stageInfo(b)}<div class="kv">${kv}</div><p><a href="${esc(contractLink(origin, b))}" style="display:block;text-align:center;background:#0f1b2d;color:#fff;padding:14px 22px;border-radius:999px;font-weight:700;text-decoration:none;margin-top:16px">📄 Изтегли попълнения договор за наем</a></p>${actions}${kmForm(cd)}`,
  );
}

// Защо подаването без валидна оферта не е прието (показва се от сайта; по-старите версии на страницата получават 409)
const QUOTE_MSG: Record<QuoteFail, string> = {
  quote_required: "Сайтът е обновен. Презаредете страницата и потвърдете цената отново – попълнените данни се пазят.",
  quote_expired: "Офертата е изтекла. Цената се изчислява отново – проверете я и потвърдете.",
  quote_mismatch: "Данните за резервацията са променени след изчисляването на цената. Проверете новата цена и потвърдете.",
  quote_used: "Тази оферта вече е използвана. Цената се изчислява отново – проверете я и потвърдете.",
  price_changed: "Цената е променена. Проверете новата сума и потвърдете отново.",
};

export default (req: Request, context: Context) => {
  const url = new URL(req.url);
  return REQ.run({ lang: langOf(url.searchParams.get("lang")), url }, () => handle(req, context));
};

async function handle(req: Request, context: Context) {
  const url = new URL(req.url);
  const id = context.params.id || url.pathname.split("/")[3];

  // ===== Нова заявка от сайта =====
  if (!id) {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return Response.json({ error: "Invalid body" }, { status: 400 });
    const b = {
      name: str(body.name, 120),
      email: str(body.email, 200),
      phone: str(body.phone, 40),
      lang: ["bg", "en", "de"].includes(body.lang) ? body.lang : "bg",
      car: str(body.car, 120),
      pickup: str(body.pickup),
      dropoff: str(body.dropoff),
      carId: CAR_RE.test(str(body.carId, 40)) ? str(body.carId, 40) : "",
      startDate: DATE_RE.test(str(body.startDate, 10)) ? str(body.startDate, 10) : null,
      endDate: DATE_RE.test(str(body.endDate, 10)) ? str(body.endDate, 10) : null,
      startTime: TIME_RE.test(str(body.startTime ?? body.contract?.t1, 5)) ? str(body.startTime ?? body.contract?.t1, 5) : "",
      endTime: TIME_RE.test(str(body.endTime ?? body.contract?.t2, 5)) ? str(body.endTime ?? body.contract?.t2, 5) : "",
      payment: ["bank", "bankp", "cash"].includes(body.payment) ? body.payment : "",
      invoice: ["bank", "bankp"].includes(body.payment) ? str(body.invoice, 1000) : "",
    };
    if (b.startDate && b.endDate && b.startDate > b.endDate) return Response.json({ error: "Invalid dates" }, { status: 400 });
    const message = str(body.message, 20000);
    if (!b.name || !/^\S+@\S+\.\S+$/.test(b.email) || !b.phone || !b.car || !b.pickup || !b.dropoff || !message) {
      return Response.json({ error: "Missing fields" }, { status: 400 });
    }
    // Дати и часове са задължителни и се проверяват и тук, не само в браузъра (заявката може да бъде променена ръчно):
    // получаване не по-рано от днес (Europe/Sofia), връщане не преди получаване, двата часа – в работното време (db/hours.ts).
    // Важи само за нови заявки – записаните резервации и решенията по тях не се проверяват наново.
    if (!b.startDate || !b.endDate || !b.startTime || !b.endTime) return Response.json({ error: "Missing dates" }, { status: 400 });
    if (b.startDate < sofiaToday() || minutes(b.endDate, b.endTime) < minutes(b.startDate, b.startTime)) {
      return Response.json({ error: "Invalid dates" }, { status: 400 });
    }
    if (!withinHours(b.startDate, b.startTime) || !withinHours(b.endDate, b.endTime)) return Response.json({ error: "hours" }, { status: 400 });
    // Новата кратка форма (flow: 2) – без документи и снимки; те се подават след първото одобрение (server/stage.ts)
    const flow2 = body.flow === 2;
    // Адрес по документа (град / село, населено място, адрес; област и община – за българска лична карта)
    const addrErr = flow2 ? "" : addressError(body.contract);
    if (addrErr) return Response.json({ error: "address", detail: addrErr }, { status: 400 });
    // Неактивен автомобил (админ панел → Автомобили) не приема нови заявки; съществуващите резервации остават
    if (b.carId) {
      const [car] = await db.select({ status: cars.status }).from(cars).where(eq(cars.id, b.carId));
      if (car && car.status !== "active") return Response.json({ error: "busy" }, { status: 409 });
    }
    if (await findConflict(b.carId, b.startDate || "", b.endDate || "", b.startTime, b.endTime)) {
      return Response.json({ error: "busy" }, { status: 409 });
    }
    const requestKey = REQUEST_KEY_RE.test(str(body.requestKey, 100)) ? str(body.requestKey, 100) : null;
    // Сървърна цена: входните данни (автомобил, дати, часове, столчета, адреси, държави) трябва да съвпадат с офертата.
    // Сумите, тарифите и километрите от браузъра не се ползват. Вериги и втори водач още не се предлагат (service).
    const qi = bookingInput({ carId: b.carId, startDate: b.startDate, startTime: b.startTime, endDate: b.endDate, endTime: b.endTime }, body);
    const qiErr = "error" in qi ? qi.error : checkInput(qi.input);
    if (qiErr || "error" in qi) return Response.json({ error: "invalid_services", detail: qiErr }, { status: 400 });
    const vq = await verifyQuote(body.quote, qi.input, body.quoteTotalCents);
    if (!vq.ok) {
      // Повторно изпращане на вече записана заявка (същият requestKey) връща записаната резервация, дори офертата вече да е използвана
      const [prev] = requestKey ? await db.select().from(bookings).where(eq(bookings.requestKey, requestKey)) : [];
      if (prev && prev.email.toLowerCase() === b.email.toLowerCase()) return Response.json({ id: prev.id, token: prev.viewToken, status: prev.status, duplicate: true }, { status: 200 });
      // Само кодът – без данни за клиента (броят на quote_required показва колко отворени по-стари страници засяга преходът)
      console.warn("Booking rejected", vq.error);
      const cur = "currentCents" in vq && vq.currentCents != null ? { currentCents: vq.currentCents, currentTotal: fmtCents(vq.currentCents) } : {};
      return Response.json({ error: vq.error, detail: QUOTE_MSG[vq.error], ...cur }, { status: 409 });
    }
    const q = vq.row;
    const drivers = flow2 ? driversOf(body.drivers, !!qi.input.secondDriver, { del: qi.input.del, ret: qi.input.ret }) : null;
    if (flow2 && !drivers) return Response.json({ error: "drivers" }, { status: 400 });
    // Рекламен източник (UTM) – само проверени стойности от едно посещение; при невалиден или липсващ – без източник (server/attribution.ts)
    const utm = parseAttribution(body.attribution);
    const row = {
      id: rnd(1), viewToken: rnd(2), adminToken: rnd(2), ...b, requestKey,
      total: fmtCents(q.totalCents), totalCents: q.totalCents, totalReview: "",
      priceCheck: priceSnapshot(q), priceCheckStatus: "server", priceCheckedAt: new Date(),
      ...utm, documents: flow2 ? null : documentsOf(message, url.origin),
      ...(flow2 ? { stage: "request", marketingConsent: body.marketingConsent === true, chains: !!qi.input.chains, secondDriver: !!qi.input.secondDriver, drivers } : {}),
    };

    // Повторно или едновременно изпращане на същата заявка връща вече записаната резервация – без втора резервация и без нови имейли.
    // 1) същият requestKey (уникален индекс в базата); 2) за по-стари страници без ключ – същият клиент, автомобил и период в последните 10 минути.
    const fingerprint = [b.email.toLowerCase(), b.carId, b.startDate, b.startTime, b.endDate, b.endTime].join("|");
    const { saved, duplicate } = await db.transaction(async (tx) => {
      await lock(tx, "booking-request:" + fingerprint);
      if (requestKey) await lock(tx, "booking-request-key:" + requestKey);
      const [byKey] = requestKey ? await tx.select().from(bookings).where(eq(bookings.requestKey, requestKey)) : [];
      if (byKey) return { saved: byKey, duplicate: true };
      const [same] =
        b.startDate && b.endDate
          ? await tx
              .select()
              .from(bookings)
              .where(
                and(
                  sql`lower(${bookings.email}) = ${b.email.toLowerCase()}`,
                  eq(bookings.carId, b.carId),
                  eq(bookings.startDate, b.startDate),
                  eq(bookings.endDate, b.endDate),
                  eq(bookings.startTime, b.startTime),
                  eq(bookings.endTime, b.endTime),
                  eq(bookings.status, "pending"),
                  gte(bookings.createdAt, new Date(Date.now() - DUPLICATE_WINDOW_MS)),
                ),
              )
              .limit(1)
          : [];
      if (same) return { saved: same, duplicate: true };
      // Една оферта – една резервация (едновременно подаване със същата оферта и различен ключ)
      if (!(await claimQuote(tx, q.id, row.id))) return { saved: null, duplicate: false };
      const [ins] = await tx.insert(bookings).values(row).returning();
      // Състоянието на известията се записва заедно с резервацията – ако функцията прекъсне, email-retry ги изпраща
      await queueEmail(tx, "owner-new", ownerNewKey(ins.id), ins.id, OWNER_EMAIL);
      await queueEmail(tx, "customer-received", receivedKey(ins.id), ins.id, ins.email);
      await tx.insert(bookingEvents).values({ bookingId: ins.id, actor: "customer", action: "booking.created", details: utm ? { utm: true } : {} });
      return { saved: ins, duplicate: false };
    });
    if (!saved) return Response.json({ error: "quote_used", detail: QUOTE_MSG.quote_used }, { status: 409 });
    if (duplicate) {
      if (saved.email.toLowerCase() !== b.email.toLowerCase()) return Response.json({ error: "Invalid request" }, { status: 400 });
      return Response.json({ id: saved.id, token: saved.viewToken, status: saved.status, duplicate: true }, { status: 200 });
    }

    const manage = `${url.origin}/api/bookings/${saved.id}/manage?key=${saved.adminToken}`;
    // Попълненият договор за наем се пази на сървъра (линк в имейла) и се прикача към имейла.
    // Ако не може да се генерира, заявката пак се изпраща.
    let hasContract = false;
    try {
      // Кратката заявка няма данни на водача – договорът се попълва след подаването на документите
      const data = flow2 ? null : parseContract(body.contract, b.name, b.carId);
      if (!data && !flow2) console.error("Contract data missing in the booking request");
      else hasContract = !!(await saveContract(saved.id, contractWithPrice(data, qi.input, q), "customer", "Заявка от сайта"));
    } catch (e) {
      console.error("Contract could not be generated", (e as Error)?.message);
    }
    const photos = Array.isArray(saved.documents) ? saved.documents.length : 0;
    const dr = driversInfo(saved);
    const ownerMail = (attached: boolean) =>
      flow2 ? wrapMail(
        `<p style="font-size:17px"><b>Нова заявка за наем (кратка форма) — първо одобрение.</b> Ако автомобилът е наличен, одобрете – клиентът получава покана да изпрати документите.</p>` +
          `<p>${btn(manage, "Одобри и покани за документи", "#1a8f4c")}${btn(manage, "Откажи", "#c0392b")}${btn(manage, "Управление на резервацията", "#0f1b2d")}</p>` +
          `<p style="color:#5b6577;font-size:13px">Отварянето на линка не одобрява нищо – решението е с бутон на страницата. Окончателното потвърждение е след проверката на документите.</p>` +
          `<p>Водачи: ${dr?.requesterDrives ? "заявителят" : "друг човек (заявителят не шофира)"}${saved.secondDriver ? " + втори допълнителен водач" : ""}${saved.chains ? " · вериги" : ""}</p>` +
          `<pre style="white-space:pre-wrap;font-family:Arial,sans-serif;background:#f3f5f9;padding:16px;border-radius:12px">${esc(ownerRequestText(withServerPrice(message, priceLines(vq.price))))}</pre>`,
      ) : wrapMail(
        `<p style="font-size:17px"><b>Нова заявка за наем от сайта.</b> Потвърдете или откажете – клиентът ще получи имейл и ще види решението на сайта.</p>` +
          `<p>${btn(manage, "Потвърди резервацията", "#1a8f4c")}${btn(manage, "Откажи", "#c0392b")}${btn(manage, "Управление на резервацията", "#0f1b2d")}</p>` +
          `<p style="color:#5b6577;font-size:13px">„Управление на резервацията“: статус, отмяна, „Клиентът не се яви“ и предаване на автомобила. Отварянето на линка не променя нищо – всяко действие се потвърждава отделно.</p>` +
          (hasContract
            ? `<p>📄 <b>Договорът за наем е попълнен</b> с данните на клиента и автомобила – готов за печат.${attached ? " Прикачен е към този имейл." : ""}</p>` +
              `<p>${btn(contractLink(url.origin, saved), "Изтегли договора за наем", "#0f1b2d")}</p>`
            : `<p>Договорът за наем не можа да бъде попълнен автоматично за тази заявка.</p>`) +
          // Без ЕГН, номера на документи, адрес по документа и линкове към снимките (server/request-text.ts) –
          // те са в прикачения договор и в админ панела след вход. Снимките не се прикачват и не се изпращат като линкове.
          (photos ? `<p>🪪 <b>Снимки на документите: ${photos}</b> – отварят се само след вход в админ панела.</p><p>${btn(`${url.origin}/admin/bookings/${saved.id}`, "Отвори в админ панела", "#0f1b2d")}</p>` : "") +
          // Цената в писмото е сървърната (разбивка от офертата) – редовете за сумите от браузъра се махат
          `<pre style="white-space:pre-wrap;font-family:Arial,sans-serif;background:#f3f5f9;padding:16px;border-radius:12px">${esc(ownerRequestText(withServerPrice(message, priceLines(vq.price))))}</pre>`,
      );
    const subject = `${flow2 ? "Нова заявка (първо одобрение)" : "Нова заявка за наем"}: ${b.car} – ${b.name}`;
    // Резервацията остава записана и при неуспешен имейл: писмото се пази за повторен опит, а сайтът праща и резервното известие
    let notified = false;
    try {
      await saveOwnerOutbox(saved.id, { subject, html: ownerMail(true), htmlNoAttachment: ownerMail(false), replyTo: b.email });
      notified = (await sendOwnerNew(saved.id))?.result === "sent";
    } catch (e) {
      console.error("Owner email failed, it will be retried", (e as Error)?.message);
    }
    // Потвърждение до клиента, че заявката е получена – ако не стигне, се опитва отново по-късно; заявката остава валидна
    await sendCustomerReceived(saved).catch((e) => console.error("Request-received email failed, it will be retried", (e as Error)?.message));
    return Response.json({ id: saved.id, token: saved.viewToken, status: "pending", ...(notified ? {} : { notify: "failed" }) }, { status: 201 });
  }

  if (!ID_RE.test(id)) return new Response("Not found", { status: 404 });

  // ===== Договор за наем (.docx) за фирмата =====
  if (url.pathname.endsWith("/contract")) {
    const key = url.searchParams.get("key") || "";
    if (!TOKEN_RE.test(key)) return page("Не е намерен", "<h1>Договорът не е намерен</h1>", 404);
    const [b] = await db.select({ id: bookings.id }).from(bookings).where(and(eq(bookings.id, id), eq(bookings.adminToken, key)));
    const file = b && (await contracts().getWithMetadata(id, { type: "arrayBuffer" }));
    if (!file) return page("Не е намерен", "<h1>Договорът не е намерен</h1>", 404);
    const name = String(file.metadata?.name || "Dogovor-naem.docx");
    return new Response(file.data, {
      headers: {
        "Content-Type": DOCX,
        "Content-Disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  const manage = url.pathname.endsWith("/manage");

  // ===== Статус за клиента и подаване на документите (двуетапна заявка) =====
  if (!manage) {
    const t = url.searchParams.get("t") || "";
    if (!TOKEN_RE.test(t)) return new Response("Not found", { status: 404 });
    const [b] = await db.select().from(bookings).where(and(eq(bookings.id, id), eq(bookings.viewToken, t)));
    if (!b) return Response.json({ error: "Not found" }, { status: 404 });
    if (url.pathname.endsWith("/documents")) {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const body = await req.json().catch(() => null);
      const r = await submitDocuments(b, body);
      if (!r.ok) return Response.json({ error: r.error, field: r.field, index: r.index }, { status: r.error === "stage" ? 409 : 400, headers: { "Cache-Control": "no-store" } });
      return Response.json(statusView(r.booking), { headers: { "Cache-Control": "no-store" } });
    }
    // Старите резервации: само статус и съобщение (както досега); двуетапните – и данните за страницата на заявката
    return Response.json(b.stage ? statusView(b) : { status: b.status, note: b.note }, { headers: { "Cache-Control": "no-store" } });
  }

  // ===== Страница за фирмата =====
  const key = url.searchParams.get("key") || "";
  if (!TOKEN_RE.test(key)) return page("Не е намерена", "<h1>Резервацията не е намерена</h1>", 404);
  const [b] = await db.select().from(bookings).where(and(eq(bookings.id, id), eq(bookings.adminToken, key)));
  if (!b) return page("Не е намерена", "<h1>Резервацията не е намерена</h1>", 404);
  // Изтекъл линк: нищо не се показва и не се променя – управлението продължава след вход в админ панела
  if (linkExpired(b))
    return page("Линкът е изтекъл", `<h1>Линкът е изтекъл</h1><p>Линкът за управление от имейла важи до 30 дни след края на наема. Управлявайте резервацията след вход в админ панела.</p><p><a href="${esc(url.origin)}/admin/bookings/${b.id}" style="display:block;text-align:center;background:#0f1b2d;color:#fff;padding:14px 22px;border-radius:999px;font-weight:700;text-decoration:none">Към админ панела</a></p>`, 410);

  // GET само показва страницата – решението става с бутон (POST), за да не се задейства от предварителни прегледи на линкове
  const conflict = b.status === "pending" ? await findConflict(b.carId, b.startDate || "", b.endDate || "", b.startTime, b.endTime, b.id) : null;
  const cd = ((await contracts().get(contractDataKey(id), { type: "json" }).catch(() => null)) as ContractData | null) || null;
  if (req.method !== "POST") return managePage(b, url.origin, "", conflict, cd);

  const form = await req.formData().catch(() => null);
  const action = form?.get("action");

  // Отмяна, неявяване и предаване: първата заявка само показва потвърждение; промяна има само при втората заявка
  // с валиден токен за стъпката (вързан с текущото състояние). Линкът сам по себе си (GET) никога не променя статус.
  if (action === "cancel" || action === "no_show" || action === "handover") {
    const f = (n: string) => String(form?.get(n) ?? "");
    const reason = action === "cancel" ? (REASONS as readonly string[]).includes(f("reason")) ? f("reason") : "" : "";
    const note = action === "handover" ? "" : f("note").trim().slice(0, 1000);
    const notify = f("notify") === "1";
    const can = allowed(b);
    if (!can[action])
      return managePage(b, url.origin, action === "no_show" && can.cancel ? "„Клиентът не се яви“ е достъпно едва след часа за получаване." : "Действието не е възможно при текущия статус на резервацията.", null, cd);
    if (action === "cancel" && !reason) return managePage(b, url.origin, "Изберете причина за отмяната.", null, cd);
    const step = f("step");
    if (!step) return confirmPage(b, url.origin, action, reason, note, notify);
    if (step !== (await stepToken(b, action))) return managePage(b, url.origin, "Формулярът е остарял – статусът междувременно е променен. Проверете и опитайте отново.", null, cd);
    const r = await act(b.id, action, { actor: "owner-link", reason, note, notify });
    if (!r.ok) return managePage(r.booking || b, url.origin, r.error === "too_early" ? "„Клиентът не се яви“ е достъпно едва след часа за получаване." : "Действието вече е изпълнено или не е възможно при текущия статус.", null, cd);
    const mailMsg = action === "handover" ? "" : r.email === "sent" ? " Клиентът получи имейл." : r.email === "queued" ? " Имейлът до клиента не беше изпратен веднага – ще бъде опитан отново автоматично." : " Не е изпратен имейл до клиента.";
    return managePage(r.booking, url.origin, ACTIONS[action].done + mailMsg, null, cd);
  }

  // Поправка на километрите – договорът се генерира наново със същите данни и новото разстояние
  if (action === "km") {
    if (!cd) return managePage(b, url.origin, "Данните на договора не са намерени.", conflict, cd);
    const km = (name: string) => {
      const v = Number(String(form?.get(name) ?? "").trim().replace(",", "."));
      return Number.isFinite(v) && v >= 0 && v < 5000 ? Math.round(v * 10) / 10 : null;
    };
    const next: ContractData = {
      ...cd,
      del: cd.del ? { ...cd.del, km: km("kmDel"), rate: kmRate(Number(form?.get("kmDelRate") ?? cd.del.rate)) } : null,
      ret: cd.ret ? { ...cd.ret, km: km("kmRet"), rate: kmRate(Number(form?.get("kmRetRate") ?? cd.ret.rate)) } : null,
    };
    try {
      await saveContract(id, next, "owner-link", "Поправка на километрите");
    } catch (e) {
      console.error("Contract could not be regenerated", e);
      return managePage(b, url.origin, "Договорът не можа да бъде обновен. Опитайте отново.", conflict, cd);
    }
    return managePage(b, url.origin, "Километрите са записани – изтеглете договора отново.", conflict, next);
  }
  if (action !== "confirm" && action !== "reject") return managePage(b, url.origin, "", conflict, cd);
  if (b.status !== "pending") return managePage(b, url.origin, "Тази резервация вече е обработена.", null, cd);

  // Съобщението от формата е до клиента (влиза в писмото). Решението е общо с админ панела (server/booking-actions.ts):
  // повторна проверка на датите, автомобила и заетостта в транзакция със заключване на автомобила.
  const note = typeof form?.get("note") === "string" ? String(form!.get("note")).trim().slice(0, 1000) : "";
  const r = await decide(b.id, action, { actor: "owner-link", message: note, notify: true });
  if (!r.ok) {
    if (r.error === "busy") return managePage(r.booking || b, url.origin, DECIDE_MSG.busy, r.conflict || null, cd);
    return managePage(r.booking || b, url.origin, DECIDE_MSG[r.error], null, cd);
  }
  const updated = r.booking;
  if (r.email === "uncertain") {
    return managePage(updated, url.origin, `Решението е записано и клиентът го вижда на сайта. Връзката с пощенската услуга прекъсна и не е сигурно дали имейлът до ${updated.email} е изпратен – няма да бъде изпратен повторно автоматично; при нужда се свържете с клиента.`, null, cd);
  }
  if (r.email !== "sent") {
    return managePage(updated, url.origin, `Решението е записано и клиентът го вижда на сайта, но имейлът до ${updated.email} не беше изпратен. Ще опитаме отново автоматично; при нужда се свържете с клиента.`, null, cd);
  }
  return managePage(
    updated,
    url.origin,
    action === "confirm" ? (r.step === "approved" ? "Заявката е одобрена. Клиентът получи покана да изпрати документите." : "Резервацията е потвърдена. Клиентът получи имейл.") : "Резервацията е отказана. Клиентът получи имейл.",
    null,
    cd,
  );
}

export const config: Config = {
  path: ["/api/bookings", "/api/bookings/:id", "/api/bookings/:id/manage", "/api/bookings/:id/contract", "/api/bookings/:id/documents"],
  method: ["GET", "POST"],
};
