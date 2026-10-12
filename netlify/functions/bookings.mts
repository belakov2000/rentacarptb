import type { Config, Context } from "@netlify/functions";
import { and, eq, gte, lte, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookingEvents, bookings } from "../../db/schema.js";
import { parseTotalCents, totalReviewOf } from "../../db/money.js";
import { addDays, endTimeOf, minutes, overlaps, startTimeOf } from "../../db/slots.js";
import { kmRate, parseContract, type ContractData } from "../../contract/index.js";
import { btn, esc, OWNER_EMAIL, wrapMail } from "../../mail/index.js";
import { contractDataKey, contracts, saveContract } from "../../server/contracts.js";
import { queueEmail } from "../../server/email.js";
import { decisionKey, ownerNewKey, receivedKey, saveOwnerOutbox, sendCustomerReceived, sendDecision, sendOwnerNew } from "../../server/notify.js";

// Резервации с потвърждение от фирмата.
// POST /api/bookings                 – записва заявката, праща имейл до фирмата с бутони „Потвърди“ / „Откажи“ и потвърждение до клиента, че заявката е получена
// GET  /api/bookings/:id?t=…         – статус на заявката за страницата „Благодарим“ на клиента
// GET  /api/bookings/:id/manage?key=… – страница за фирмата с данните и бутоните (линкът е само в имейла)
// POST /api/bookings/:id/manage?key=… – потвърждава или отказва и праща имейл до клиента; поправя километрите в договора
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
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
// Транзакционно заключване (освобождава се автоматично в края на транзакцията). Ключът е текст, затова съществува
// за всеки автомобил – и за такъв, който още няма ред в таблицата cars.
const lock = (q: Tx, key: string) => q.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

// Потвърдена резервация за същия автомобил, която се застъпва с периода [start startTime, end endTime].
// Между връщане и следващо получаване трябва да има поне BUFFER_MIN минути (напр. върнат в 12:00 → свободен от 13:00).
async function findConflict(carId: string, start: string, end: string, startTime = "", endTime = "", exceptId = "", q: Pick<typeof db, "select"> = db) {
  if (!carId || !start || !end) return null;
  // По дати търсим с един ден резерва – буферът може да мине през полунощ
  const rows = await q
    .select({
      id: bookings.id,
      name: bookings.name,
      pickup: bookings.pickup,
      dropoff: bookings.dropoff,
      startDate: bookings.startDate,
      endDate: bookings.endDate,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.carId, carId),
        eq(bookings.status, "confirmed"),
        lte(bookings.startDate, addDays(end, 1)),
        gte(bookings.endDate, addDays(start, -1)),
        ...(exceptId ? [ne(bookings.id, exceptId)] : []),
      ),
    );
  const a = minutes(start, startTimeOf(startTime));
  const z = minutes(end, endTimeOf(endTime));
  const c = rows.find(
    (r) =>
      r.startDate &&
      r.endDate &&
      overlaps(a, z, minutes(r.startDate, startTimeOf(r.startTime, r.pickup)), minutes(r.endDate, endTimeOf(r.endTime, r.dropoff))),
  );
  return c ? { id: c.id, name: c.name, pickup: c.pickup, dropoff: c.dropoff } : null;
}

// ===== Страница за фирмата =====
function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{font-family:Arial,sans-serif;background:#f3f5f9;color:#0f1b2d;margin:0;padding:24px}main{max-width:560px;margin:0 auto;background:#fff;border-radius:22px;padding:26px}h1{font-size:1.5rem;margin:0 0 14px}
.kv div{display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-bottom:1px solid #e6e9ef}.kv span{color:#5b6577}.badge{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:700;margin-bottom:12px}
.pending{background:#fff4cc}.confirmed{background:#d9f5e3;color:#11643a}.rejected{background:#fde2e0;color:#9b1c13}
button{font:inherit;font-weight:700;border:0;border-radius:999px;padding:14px 22px;cursor:pointer;width:100%;margin-top:10px}.ok{background:#1a8f4c;color:#fff}.no{background:#c0392b;color:#fff}
textarea,input{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #cdd3dd;border-radius:12px;min-height:70px}select{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #cdd3dd;border-radius:12px;margin-top:8px;background:#fff}label{display:block;font-weight:700;margin:16px 0 6px;font-size:.9rem}</style></head>
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

function managePage(b: Booking, origin: string, msg = "", conflict: { name: string; pickup: string; dropoff: string } | null = null, cd: ContractData | null = null) {
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
    `<h1>Резервация</h1><span class="badge ${b.status}">${STATUS_BG[b.status] || b.status}</span>${msg ? `<p><b>${esc(msg)}</b></p>` : ""}${warn}<div class="kv">${kv}</div><p><a href="${esc(contractLink(origin, b))}" style="display:block;text-align:center;background:#0f1b2d;color:#fff;padding:14px 22px;border-radius:999px;font-weight:700;text-decoration:none;margin-top:16px">📄 Изтегли попълнения договор за наем</a></p>${actions}${kmForm(cd)}`,
  );
}

export default async (req: Request, context: Context) => {
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
      total: str(body.total, 200),
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
    if (await findConflict(b.carId, b.startDate || "", b.endDate || "", b.startTime, b.endTime)) {
      return Response.json({ error: "busy" }, { status: 409 });
    }
    const requestKey = REQUEST_KEY_RE.test(str(body.requestKey, 100)) ? str(body.requestKey, 100) : null;
    const row = { id: rnd(1), viewToken: rnd(2), adminToken: rnd(2), ...b, requestKey, totalCents: parseTotalCents(b.total), totalReview: totalReviewOf(b.total) };

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
      const [ins] = await tx.insert(bookings).values(row).returning();
      // Състоянието на известията се записва заедно с резервацията – ако функцията прекъсне, email-retry ги изпраща
      await queueEmail(tx, "owner-new", ownerNewKey(ins.id), ins.id, OWNER_EMAIL);
      await queueEmail(tx, "customer-received", receivedKey(ins.id), ins.id, ins.email);
      await tx.insert(bookingEvents).values({ bookingId: ins.id, actor: "customer", action: "booking.created", details: {} });
      return { saved: ins, duplicate: false };
    });
    if (duplicate) {
      if (saved.email.toLowerCase() !== b.email.toLowerCase()) return Response.json({ error: "Invalid request" }, { status: 400 });
      return Response.json({ id: saved.id, token: saved.viewToken, status: saved.status, duplicate: true }, { status: 200 });
    }

    const manage = `${url.origin}/api/bookings/${saved.id}/manage?key=${saved.adminToken}`;
    // Попълненият договор за наем се пази на сървъра (линк в имейла) и се прикача към имейла.
    // Ако не може да се генерира, заявката пак се изпраща.
    let hasContract = false;
    try {
      const data = parseContract(body.contract, b.name, b.carId);
      if (!data) console.error("Contract data missing in the booking request");
      else hasContract = !!(await saveContract(saved.id, data, "customer", "Заявка от сайта"));
    } catch (e) {
      console.error("Contract could not be generated", (e as Error)?.message);
    }
    const ownerMail = (attached: boolean) =>
      wrapMail(
        `<p style="font-size:17px"><b>Нова заявка за наем от сайта.</b> Потвърдете или откажете – клиентът ще получи имейл и ще види решението на сайта.</p>` +
          `<p>${btn(manage, "Потвърди резервацията", "#1a8f4c")}${btn(manage, "Откажи", "#c0392b")}</p>` +
          (hasContract
            ? `<p>📄 <b>Договорът за наем е попълнен</b> с данните на клиента и автомобила – готов за печат.${attached ? " Прикачен е към този имейл." : ""}</p>` +
              `<p>${btn(contractLink(url.origin, saved), "Изтегли договора за наем", "#0f1b2d")}</p>`
            : `<p>Договорът за наем не можа да бъде попълнен автоматично за тази заявка.</p>`) +
          `<pre style="white-space:pre-wrap;font-family:Arial,sans-serif;background:#f3f5f9;padding:16px;border-radius:12px">${esc(message).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</pre>`,
      );
    const subject = `Нова заявка за наем: ${b.car} – ${b.name}`;
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
  const conflict = b.status === "pending" ? await findConflict(b.carId, b.startDate || "", b.endDate || "", b.startTime, b.endTime, b.id) : null;
  const cd = ((await contracts().get(contractDataKey(id), { type: "json" }).catch(() => null)) as ContractData | null) || null;
  if (req.method !== "POST") return managePage(b, url.origin, "", conflict, cd);

  const form = await req.formData().catch(() => null);
  const action = form?.get("action");

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
  if (action === "confirm" && conflict) return managePage(b, url.origin, "Резервацията не е потвърдена – датите вече са заети.", conflict, cd);
  if (b.status !== "pending") return managePage(b, url.origin, "Тази резервация вече е обработена.", null, cd);

  const note = typeof form?.get("note") === "string" ? String(form!.get("note")).trim().slice(0, 1000) : "";
  // Заключване на автомобила и повторна проверка за застъпване вътре в транзакцията: втора едновременна заявка изчаква
  // първата да приключи и вижда нейното потвърждение
  const out = await db.transaction(async (tx) => {
    if (action === "confirm") {
      await lock(tx, "car:" + b.carId);
      const c = await findConflict(b.carId, b.startDate || "", b.endDate || "", b.startTime, b.endTime, b.id, tx);
      if (c) return { conflict: c, updated: null };
    }
    const [u] = await tx
      .update(bookings)
      .set({ status: action === "confirm" ? "confirmed" : "rejected", note, decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(bookings.id, id), eq(bookings.status, "pending")))
      .returning();
    if (u) {
      await queueEmail(tx, "customer-decision", decisionKey(u.id), u.id, u.email);
      await tx.insert(bookingEvents).values({ bookingId: u.id, actor: "owner-link", action: action === "confirm" ? "booking.confirm" : "booking.reject", details: {} });
    }
    return { conflict: null, updated: u ?? null };
  });
  if (out.conflict) return managePage(b, url.origin, "Резервацията не е потвърдена – датите вече са заети.", out.conflict, cd);
  const updated = out.updated;
  if (!updated) return managePage(b, url.origin, "Тази резервация вече е обработена.", null, cd);

  const sent = await sendDecision(updated).catch((e) => ({ result: "failed" as const, error: String((e as Error)?.message) }));
  if (sent.result === "uncertain") {
    return managePage(updated, url.origin, `Решението е записано и клиентът го вижда на сайта. Връзката с пощенската услуга прекъсна и не е сигурно дали имейлът до ${updated.email} е изпратен – няма да бъде изпратен повторно автоматично; при нужда се свържете с клиента.`, null, cd);
  }
  if (sent.result !== "sent") {
    return managePage(updated, url.origin, `Решението е записано и клиентът го вижда на сайта, но имейлът до ${updated.email} не беше изпратен. Ще опитаме отново автоматично; при нужда се свържете с клиента.`, null, cd);
  }
  return managePage(
    updated,
    url.origin,
    action === "confirm" ? "Резервацията е потвърдена. Клиентът получи имейл." : "Резервацията е отказана. Клиентът получи имейл.",
    null,
    cd,
  );
};

export const config: Config = {
  path: ["/api/bookings", "/api/bookings/:id", "/api/bookings/:id/manage", "/api/bookings/:id/contract"],
  method: ["GET", "POST"],
};
