import type { Config, Context } from "@netlify/functions";
import { and, eq, gte, lte, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookings } from "../../db/schema.js";

// Резервации с потвърждение от фирмата.
// POST /api/bookings                 – записва заявката и праща имейл до фирмата с бутони „Потвърди“ / „Откажи“
// GET  /api/bookings/:id?t=…         – статус на заявката за страницата „Благодарим“ на клиента
// GET  /api/bookings/:id/manage?key=… – страница за фирмата с данните и бутоните (линкът е само в имейла)
// POST /api/bookings/:id/manage?key=… – потвърждава или отказва и праща имейл до клиента
const OWNER_EMAIL = process.env.BOOKING_OWNER_EMAIL || "rentaptb_stroi@abv.bg";
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || OWNER_EMAIL;
const SENDER_NAME = "Rent a Car PTB";
const PHONE = "0877748693";
const ID_RE = /^[a-f0-9]{32}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CAR_RE = /^[a-z0-9-]{1,40}$/;

const rnd = (n: number) => Array.from({ length: n }, () => crypto.randomUUID().replace(/-/g, "")).join("");
const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Текстова версия на писмото – пощенските услуги (Gmail, Abv и др.) гледат по-благосклонно на писма, които имат и HTML, и текст
const toText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|tr|div|pre|h\d)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, "$2: $1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

async function sendMail(to: string, toName: string, subject: string, html: string, replyTo?: string) {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error("BREVO_API_KEY is not set");
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      to: [{ email: to, name: toName || to }],
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
      subject,
      htmlContent: `<!doctype html><html><head><meta charset="utf-8"><title>${esc(subject)}</title></head><body>${html}</body></html>`,
      textContent: toText(html),
    }),
  });
  if (!r.ok) throw new Error(`Brevo error ${r.status}: ${await r.text()}`);
}

const btn = (href: string, label: string, bg: string, fg = "#fff") =>
  `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:${fg};padding:14px 26px;border-radius:999px;font-weight:700;text-decoration:none;margin:4px 8px 4px 0">${esc(label)}</a>`;
const wrapMail = (body: string) =>
  `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0f1b2d;max-width:600px">${body}</div>`;

type Booking = typeof bookings.$inferSelect;

// Потвърдена резервация за същия автомобил, която се застъпва с периода [start, end]
async function findConflict(carId: string, start: string, end: string, exceptId = "") {
  if (!carId || !start || !end) return null;
  const [c] = await db
    .select({ id: bookings.id, name: bookings.name, pickup: bookings.pickup, dropoff: bookings.dropoff })
    .from(bookings)
    .where(
      and(
        eq(bookings.carId, carId),
        eq(bookings.status, "confirmed"),
        lte(bookings.startDate, end),
        gte(bookings.endDate, start),
        ...(exceptId ? [ne(bookings.id, exceptId)] : []),
      ),
    )
    .limit(1);
  return c || null;
}

// ===== Имейл до клиента след решението на фирмата =====
const CUSTOMER: Record<string, Record<string, string>> = {
  bg: {
    okSubj: "Резервацията ви е потвърдена – Rent a Car PTB",
    noSubj: "Резервацията ви не може да бъде потвърдена – Rent a Car PTB",
    hi: "Здравейте, {name}!",
    ok: "Радваме се да потвърдим вашата резервация. Очакваме ви!",
    no: "За съжаление не можем да потвърдим вашата резервация за избрания период.",
    note: "Съобщение от нас:",
    car: "Автомобил", pickup: "Получаване", dropoff: "Връщане", total: "Общо за услугите", deposit: "Гаранционен депозит",
    q: "Въпроси? Обадете ни се на {phone} или отговорете на този имейл.",
    pay: "Плащане", bank: "По банков път срещу фактура (фирма)", bankp: "По банков път срещу фактура (физическо лице)", cash: "В брой на място при получаване (с касов бон)",
    bankInfo: "Ще ви изпратим фактура с банковите ни данни за плащане.",
    cashInfo: "Плащането е в брой при получаване на автомобила – ще ви издадем касов бон.",
  },
  en: {
    okSubj: "Your booking is confirmed – Rent a Car PTB",
    noSubj: "Your booking could not be confirmed – Rent a Car PTB",
    hi: "Hello {name},",
    ok: "We are happy to confirm your booking. See you soon!",
    no: "Unfortunately we cannot confirm your booking for the selected period.",
    note: "Message from us:",
    car: "Car", pickup: "Pick-up", dropoff: "Return", total: "Total for services", deposit: "Security deposit",
    q: "Questions? Call us on {phone} or reply to this email.",
    pay: "Payment", bank: "Bank transfer against invoice (company)", bankp: "Bank transfer against invoice (private person)", cash: "Cash on pick-up (with fiscal receipt)",
    bankInfo: "We will send you an invoice with our bank details for payment.",
    cashInfo: "Payment is in cash when you pick up the car – you will receive a fiscal receipt.",
  },
  de: {
    okSubj: "Ihre Buchung ist bestätigt – Rent a Car PTB",
    noSubj: "Ihre Buchung konnte nicht bestätigt werden – Rent a Car PTB",
    hi: "Hallo {name},",
    ok: "Wir freuen uns, Ihre Buchung zu bestätigen. Bis bald!",
    no: "Leider können wir Ihre Buchung für den gewählten Zeitraum nicht bestätigen.",
    note: "Nachricht von uns:",
    car: "Fahrzeug", pickup: "Abholung", dropoff: "Rückgabe", total: "Gesamt für Leistungen", deposit: "Kaution",
    q: "Fragen? Rufen Sie uns an unter {phone} oder antworten Sie auf diese E-Mail.",
    pay: "Zahlung", bank: "Banküberweisung gegen Rechnung (Firma)", bankp: "Banküberweisung gegen Rechnung (Privatperson)", cash: "Bar bei Abholung (mit Kassenbon)",
    bankInfo: "Wir senden Ihnen eine Rechnung mit unseren Bankdaten zur Zahlung.",
    cashInfo: "Die Zahlung erfolgt bar bei Abholung des Fahrzeugs – Sie erhalten einen Kassenbon.",
  },
};

function customerMail(b: Booking) {
  const t = CUSTOMER[b.lang] || CUSTOMER.bg;
  const ok = b.status === "confirmed";
  const row = (k: string, v: string) =>
    v ? `<tr><td style="padding:4px 14px 4px 0;color:#5b6577">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>` : "";
  const html = wrapMail(
    `<p>${esc(t.hi.replace("{name}", b.name))}</p>` +
      `<p style="font-size:18px"><b>${esc(ok ? t.ok : t.no)}</b></p>` +
      (b.note ? `<p>${esc(t.note)}<br>${esc(b.note).replace(/\n/g, "<br>")}</p>` : "") +
      `<table style="border-collapse:collapse;margin:14px 0">${row(t.car, b.car)}${row(t.pickup, b.pickup)}${row(t.dropoff, b.dropoff)}${ok ? row(t.total, b.total) + row(t.deposit, "100 €") + row(t.pay, t[b.payment] || "") : ""}</table>` +
      (ok && t[b.payment] ? `<p>${esc(b.payment === "cash" ? t.cashInfo : t.bankInfo)}</p>` : "") +
      `<p>${esc(t.q.replace("{phone}", PHONE))}</p><p>Рента ПТБ Строй ЕООД<br>гр. Пловдив, бул. Дунав 10</p>`,
  );
  return { subject: ok ? t.okSubj : t.noSubj, html };
}

// ===== Страница за фирмата =====
function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{font-family:Arial,sans-serif;background:#f3f5f9;color:#0f1b2d;margin:0;padding:24px}main{max-width:560px;margin:0 auto;background:#fff;border-radius:22px;padding:26px}h1{font-size:1.5rem;margin:0 0 14px}
.kv div{display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-bottom:1px solid #e6e9ef}.kv span{color:#5b6577}.badge{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:700;margin-bottom:12px}
.pending{background:#fff4cc}.confirmed{background:#d9f5e3;color:#11643a}.rejected{background:#fde2e0;color:#9b1c13}
button{font:inherit;font-weight:700;border:0;border-radius:999px;padding:14px 22px;cursor:pointer;width:100%;margin-top:10px}.ok{background:#1a8f4c;color:#fff}.no{background:#c0392b;color:#fff}
textarea{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #cdd3dd;border-radius:12px;min-height:70px}label{display:block;font-weight:700;margin:16px 0 6px;font-size:.9rem}</style></head>
<body><main>${body}</main></body></html>`,
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
const STATUS_BG: Record<string, string> = { pending: "Очаква потвърждение", confirmed: "Потвърдена", rejected: "Отказана" };

function managePage(b: Booking, msg = "", conflict: { name: string; pickup: string; dropoff: string } | null = null) {
  const kv = [
    ["Клиент", b.name], ["Телефон", b.phone], ["Имейл", b.email], ["Автомобил", b.car],
    ["Получаване", b.pickup], ["Връщане", b.dropoff], ["Общо", b.total], ["Плащане", PAY_BG[b.payment] || ""],
  ].map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v || "-")}</b></div>`).join("") +
    (b.invoice ? `<div><span>Данни за фактура</span><b style="white-space:pre-line;text-align:right">${esc(b.invoice)}</b></div>` : "");
  const warn = conflict && b.status === "pending"
    ? `<p class="badge rejected" style="display:block;border-radius:14px">Внимание: автомобилът вече е потвърден за ${esc(conflict.name)} (${esc(conflict.pickup)} → ${esc(conflict.dropoff)}). Тази заявка не може да бъде потвърдена за същите дати.</p>`
    : "";
  const actions =
    b.status === "pending"
      ? `<form method="post"><label for="note">Съобщение до клиента (по избор)</label><textarea id="note" name="note" maxlength="1000" placeholder="Напр. час и място за среща или причина за отказ"></textarea>
<button class="ok" name="action" value="confirm">✓ Потвърди резервацията</button>
<button class="no" name="action" value="reject" onclick="return confirm('Сигурни ли сте, че искате да откажете резервацията?')">✕ Откажи резервацията</button></form>`
      : `<p>Решението е взето${b.decidedAt ? " на " + esc(b.decidedAt.toLocaleString("bg-BG", { timeZone: "Europe/Sofia" })) : ""}. Клиентът е уведомен по имейл и на сайта.</p>`;
  return page(
    "Резервация – " + b.name,
    `<h1>Резервация</h1><span class="badge ${b.status}">${STATUS_BG[b.status] || b.status}</span>${msg ? `<p><b>${esc(msg)}</b></p>` : ""}${warn}<div class="kv">${kv}</div>${actions}`,
  );
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const id = context.params.id;

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
      total: str(body.total, 200),
      carId: CAR_RE.test(str(body.carId, 40)) ? str(body.carId, 40) : "",
      startDate: DATE_RE.test(str(body.startDate, 10)) ? str(body.startDate, 10) : null,
      endDate: DATE_RE.test(str(body.endDate, 10)) ? str(body.endDate, 10) : null,
      payment: ["bank", "bankp", "cash"].includes(body.payment) ? body.payment : "",
      invoice: ["bank", "bankp"].includes(body.payment) ? str(body.invoice, 1000) : "",
    };
    if (b.startDate && b.endDate && b.startDate > b.endDate) return Response.json({ error: "Invalid dates" }, { status: 400 });
    const message = str(body.message, 20000);
    if (!b.name || !/^\S+@\S+\.\S+$/.test(b.email) || !b.phone || !b.car || !b.pickup || !b.dropoff || !message) {
      return Response.json({ error: "Missing fields" }, { status: 400 });
    }
    if (await findConflict(b.carId, b.startDate || "", b.endDate || "")) {
      return Response.json({ error: "busy" }, { status: 409 });
    }
    const row = { id: rnd(1), viewToken: rnd(2), adminToken: rnd(2), ...b };
    await db.insert(bookings).values(row);

    const manage = `${url.origin}/api/bookings/${row.id}/manage?key=${row.adminToken}`;
    try {
      await sendMail(
        OWNER_EMAIL,
        "Rent a Car PTB",
        `Нова заявка за наем: ${b.car} – ${b.name}`,
        wrapMail(
          `<p style="font-size:17px"><b>Нова заявка за наем от сайта.</b> Потвърдете или откажете – клиентът ще получи имейл и ще види решението на сайта.</p>` +
            `<p>${btn(manage, "Потвърди резервацията", "#1a8f4c")}${btn(manage, "Откажи", "#c0392b")}</p>` +
            `<pre style="white-space:pre-wrap;font-family:Arial,sans-serif;background:#f3f5f9;padding:16px;border-radius:12px">${esc(message).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</pre>`,
        ),
        b.email,
      );
    } catch (e) {
      console.error(e);
      await db.delete(bookings).where(eq(bookings.id, row.id));
      // Причината от Brevo (без ключа) – показва се в резервния имейл до фирмата, за да се види какво да се поправи
      const detail = String((e as Error)?.message || e).replace(/xkeysib-[\w-]+/g, "***").slice(0, 400);
      return Response.json({ error: "Email could not be sent", detail }, { status: 502 });
    }
    return Response.json({ id: row.id, token: row.viewToken, status: "pending" }, { status: 201 });
  }

  if (!ID_RE.test(id)) return new Response("Not found", { status: 404 });
  const manage = url.pathname.endsWith("/manage");

  // ===== Статус за клиента =====
  if (!manage) {
    const t = url.searchParams.get("t") || "";
    if (!TOKEN_RE.test(t)) return new Response("Not found", { status: 404 });
    const [b] = await db
      .select({ status: bookings.status, note: bookings.note })
      .from(bookings)
      .where(and(eq(bookings.id, id), eq(bookings.viewToken, t)));
    if (!b) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(b, { headers: { "Cache-Control": "no-store" } });
  }

  // ===== Страница за фирмата =====
  const key = url.searchParams.get("key") || "";
  if (!TOKEN_RE.test(key)) return page("Не е намерена", "<h1>Резервацията не е намерена</h1>", 404);
  const [b] = await db.select().from(bookings).where(and(eq(bookings.id, id), eq(bookings.adminToken, key)));
  if (!b) return page("Не е намерена", "<h1>Резервацията не е намерена</h1>", 404);

  // GET само показва страницата – решението става с бутон (POST), за да не се задейства от предварителни прегледи на линкове
  const conflict = b.status === "pending" ? await findConflict(b.carId, b.startDate || "", b.endDate || "", b.id) : null;
  if (req.method !== "POST") return managePage(b, "", conflict);

  const form = await req.formData().catch(() => null);
  const action = form?.get("action");
  if (action !== "confirm" && action !== "reject") return managePage(b, "", conflict);
  if (action === "confirm" && conflict) return managePage(b, "Резервацията не е потвърдена – датите вече са заети.", conflict);
  if (b.status !== "pending") return managePage(b, "Тази резервация вече е обработена.");

  const note = typeof form?.get("note") === "string" ? String(form!.get("note")).trim().slice(0, 1000) : "";
  const [updated] = await db
    .update(bookings)
    .set({ status: action === "confirm" ? "confirmed" : "rejected", note, decidedAt: new Date() })
    .where(and(eq(bookings.id, id), eq(bookings.status, "pending")))
    .returning();
  if (!updated) return managePage(b, "Тази резервация вече е обработена.");

  const mail = customerMail(updated);
  try {
    await sendMail(updated.email, updated.name, mail.subject, mail.html, OWNER_EMAIL);
  } catch (e) {
    console.error(e);
    return managePage(updated, `Решението е записано и клиентът го вижда на сайта, но имейлът до ${updated.email} не беше изпратен. Моля, свържете се с клиента.`);
  }
  return managePage(
    updated,
    action === "confirm" ? "Резервацията е потвърдена. Клиентът получи имейл." : "Резервацията е отказана. Клиентът получи имейл.",
  );
};

export const config: Config = {
  path: ["/api/bookings", "/api/bookings/:id", "/api/bookings/:id/manage"],
  method: ["GET", "POST"],
};
