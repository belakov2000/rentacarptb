// Двуетапна заявка за наем (новата кратка форма на сайта):
//   1) кратка заявка без документи (stage = request) → 2) първо одобрение (stage = docs) – покана за документи по имейл
//   → 3) клиентът подава документите на страницата за състоянието (stage = review) – „Получени документи — очакват проверка“
//   → 4) второ (окончателно) одобрение – status = confirmed, stage = done.
// Одобренията са в server/booking-actions.ts → decide() (общо за бутона от служебния имейл и за админ панела).
// Тук: водачите, подаването на документите, договорът, RENTY10 и писмата / напомнянията за документите.
// Старите резервации (stage = null) не се засягат.
import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookingEvents, bookings, priceQuotes } from "../db/schema.js";
import { addressError, docAddress, parseContract, type ContractData } from "../contract/index.js";
import { btn, esc, mailFooter, mailRow, OWNER_EMAIL, PHONE, wrapMail, type Attachment } from "../mail/index.js";
import { contracts, saveContract } from "./contracts.js";
import { sendLogged } from "./email.js";
import { fmtCents, type Line } from "./pricing.js";
import { contractWithPrice, type QuoteInput } from "./quote.js";
import { deployContext, store } from "./stores.js";

type Booking = typeof bookings.$inferSelect;
export const STAGE_LABEL: Record<string, string> = {
  request: "Очаква първо одобрение", docs: "Одобрена – очакват се документите", review: "Получени документи — очакват проверка", done: "Окончателно потвърдена",
};

// Адресът на сайта за линковете в писмата (в Deploy Preview – адресът на Preview; писмата там не се изпращат)
export const siteOrigin = () => (deployContext() === "production" ? process.env.URL : process.env.DEPLOY_PRIME_URL || process.env.URL) || "";
// Страницата за състоянието на заявката и подаването на документите (един и същ адрес за целия процес)
export const statusLink = (b: Pick<Booking, "id" | "viewToken">, origin = siteOrigin()) => `${origin}/?b=${b.id}&t=${b.viewToken}#blagodarim`;

// ===== Заявител и водачи =====
// Кратката форма: заявителят (име, телефон, имейл) и дали той ще шофира; вторият допълнителен водач е услуга (3 €/ден).
// Различен единствен водач (заявителят не шофира) не е втори водач и не се таксува.
export type Drivers = { requesterDrives: boolean; count: 1 | 2; names: string[]; addr: { del: string | null; ret: string | null }; requester?: import("./requester.js").Requester; comment?: string };
export function driversOf(v: unknown, secondDriver: boolean, addr: { del: string | null; ret: string | null }): Drivers | null {
  const o = v as any;
  if (!o || typeof o !== "object" || typeof o.requesterDrives !== "boolean") return null;
  return { requesterDrives: o.requesterDrives, count: secondDriver ? 2 : 1, names: [], addr };
}
export const driversInfo = (b: Booking) => (b.drivers && typeof b.drivers === "object" ? (b.drivers as Drivers) : null);

// ===== RENTY10 =====
// Изпраща се 2 ч след поканата само при маркетингово съгласие и незавършени документи. Валиден е 24 ч от действителното
// изпращане, само за тази резервация и само веднъж (проверява се на сървъра при подаването на документите). 10% от наема.
export const COUPON = { code: "RENTY10", validMs: 24 * 3600_000, pct: 10 };
export function couponState(b: Booking, now = new Date()) {
  const until = b.couponSentAt ? new Date(b.couponSentAt.getTime() + COUPON.validMs) : null;
  const available = !!(b.status === "pending" && b.stage === "docs" && !b.handedOverAt && until && !b.couponUsedAt && now < until);
  return { available, until: available ? until!.toISOString() : null, used: !!b.couponUsedAt };
}

// ===== Изглед за клиента (GET /api/bookings/:id?t=…) – без данни от документите =====
export function statusView(b: Booking, now = new Date()) {
  const d = driversInfo(b);
  return {
    status: b.status, note: b.note, stage: b.stage, name: b.name, phone: b.phone, car: b.car, carId: b.carId,
    startDate: b.startDate, startTime: b.startTime, endDate: b.endDate, endTime: b.endTime, pickup: b.pickup, dropoff: b.dropoff,
    total: b.total, totalCents: b.totalCents, payment: b.payment, lines: (b.priceCheck as any)?.server?.lines ?? null,
    ...(d ? { drivers: { count: d.count, requesterDrives: d.requesterDrives, names: d.names } } : {}),
    coupon: b.stage ? couponState(b, now) : null,
  };
}

// ===== Подаване на документите (POST /api/bookings/:id/documents?t=…) =====
const DOC_ID_RE = /^[a-f0-9]{64}$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHOTO_LABEL: Record<string, string> = { idf: "лична карта / паспорт – лице", idb: "лична карта / паспорт – гръб", dlf: "шофьорска книжка – лице", dlb: "шофьорска книжка – гръб" };
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
export type DocsError = "stage" | "drivers" | "fields" | "address" | "photos" | "coupon" | "quote";
type DriverDocs = ContractData & { photos: Record<string, string>; dlname: string };

function driverDocs(v: any): { d: DriverDocs } | { error: DocsError; field?: string } {
  if (!v || typeof v !== "object") return { error: "fields" };
  const c = {
    citizen: str(v.citizen, 80), idt: v.idt === "pass" ? "pass" : "id", idn: str(v.idn, 40), egn: str(v.egn, 20), idd: str(v.idd, 10), idp: str(v.idp, 120),
    region: str(v.region, 80), municipality: str(v.municipality, 80), placeType: v.placeType === "city" || v.placeType === "village" ? v.placeType : "", city: str(v.city, 80), addr: str(v.addr, 200),
    dln: str(v.dln, 40), dld: str(v.dld, 10), dlp: str(v.dlp, 120),
  };
  const name = str(v.name, 120);
  for (const [k, ok] of [["name", !!name], ["citizen", !!c.citizen], ["idn", !!c.idn], ["egn", c.idt === "pass" || !!c.egn], ["idd", DATE_RE.test(c.idd)], ["idp", !!c.idp],
    ["dln", !!c.dln], ["dld", DATE_RE.test(c.dld)], ["dlp", !!c.dlp]] as const)
    if (!ok) return { error: "fields", field: k };
  const ae = addressError(c);
  if (ae) return { error: "address", field: ae };
  const photos: Record<string, string> = {};
  for (const k of Object.keys(PHOTO_LABEL)) {
    const id = str(v.photos?.[k], 64);
    if (!DOC_ID_RE.test(id)) return { error: "photos", field: k };
    photos[k] = id;
  }
  const d = parseContract({ ...c, d1: "", t1: "", d2: "", t2: "", del: null, ret: null, abroad: [] }, name, "")!;
  return { d: { ...d, photos, dlname: str(v.dlname, 120) || name } };
}

const days = (n: number) => `${n} ${n === 1 ? "ден" : "дни"}`;
// Редовете на приложението към договора (вериги, втори водач с данните му, заявител, отстъпка)
function appendix(b: Booking, d: Drivers, list: DriverDocs[], lines: Line[], totalCents: number): string[] {
  const out: string[] = [];
  const ln = (code: string) => lines.find((l) => l.code === code);
  const ch = ln("chains"), sd = ln("second_driver"), dc = ln("discount");
  if (ch) out.push(`Вериги за сняг: ${days(ch.qty!)} × ${fmtCents(ch.unitCents!)} = ${fmtCents(ch.cents)}.`);
  const s = list[1];
  if (s) {
    out.push(`Втори (допълнителен) водач: ${s.name}${s.citizen ? `, гражданство ${s.citizen}` : ""}; ${s.idt === "pass" ? "паспорт" : "лична карта"} № ${s.idn}${s.egn ? `, ЕГН ${s.egn}` : ""}, издаден${s.idt === "pass" ? "" : "а"} на ${s.idd} от ${s.idp}; адрес: ${docAddress(s)}; шофьорска книжка № ${s.dln}, издадена на ${s.dld} от ${s.dlp}.`);
    if (sd) out.push(`Такса за втори водач: ${days(sd.qty!)} × ${fmtCents(sd.unitCents!)} = ${fmtCents(sd.cents)}.`);
  }
  if (!d.requesterDrives) out.push(`Заявител (не е водач): ${b.name}, тел. ${b.phone}, ${b.email}.`);
  if (dc) out.push(`Отстъпка ${COUPON.code} (${COUPON.pct}% от наема): −${fmtCents(-dc.cents)}.`);
  if (d.requester) out.push(`Заявител: ${b.name}; дата на раждане: ${d.requester.birthDate}; телефон: ${b.phone}; имейл: ${b.email}.`);
  out.push(`Начин на плащане: ${b.payment === "cash" ? "В брой на място с касов бон" : "По банков път"}.`);
  if (b.invoice) out.push(`Данни за фактура: ${b.invoice}`);
  if (d.comment) out.push(`Коментар към заявката: ${d.comment}`);
  if (!out.length) return [];
  return ["Приложение – допълнителни условия по заявката", ...out, `Обща сума за услугите: ${fmtCents(totalCents)} (гаранционният депозит не е включен).`];
}

export async function submitDocuments(b: Booking, body: any, now = new Date()): Promise<{ ok: true; booking: Booking } | { ok: false; error: DocsError; field?: string; index?: number }> {
  if (body?.documentsConsent !== true) return { ok: false, error: "fields", field: "documentsConsent" };
  if (b.status !== "pending" || b.stage !== "docs") return { ok: false, error: "stage" };
  const info = driversInfo(b);
  if (!info) return { ok: false, error: "drivers" };
  const raw = Array.isArray(body?.drivers) ? body.drivers : [];
  if (raw.length !== info.count) return { ok: false, error: "drivers" };
  const list: DriverDocs[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = driverDocs(raw[i]);
    if ("error" in r) return { ok: false, error: r.error, field: r.field, index: i };
    list.push(r.d);
  }
  // Снимките трябва да са качени на този сайт (хранилище documents) и да не се повтарят
  const ids = list.flatMap((d) => Object.values(d.photos));
  if (new Set(ids).size !== ids.length) return { ok: false, error: "photos" };
  for (const id of ids) if (!(await store("documents").getMetadata(id).catch(() => null))) return { ok: false, error: "photos" };
  // RENTY10 – само ако е изпратен за тази резервация, неизползван и в срока от 24 ч
  const code = str(body?.coupon, 20).toUpperCase();
  if (code && (code !== COUPON.code || !couponState(b, now).available)) return { ok: false, error: "coupon" };
  const [q] = await db.select().from(priceQuotes).where(eq(priceQuotes.bookingId, b.id));
  const snap = b.priceCheck as any;
  if (!q || !snap?.server) return { ok: false, error: "quote" };
  let lines = snap.server.lines as Line[], totalCents = b.totalCents ?? snap.server.totalCents;
  if (code) {
    const rent = lines.find((l) => l.code === "rent")!;
    const off = Math.round((rent.cents * COUPON.pct) / 100);
    lines = [...lines.filter((l) => l.code !== "discount"), { code: "discount", cents: -off }];
    totalCents = snap.server.totalCents - off;
  }
  const docs = list.flatMap((d, i) => Object.entries(d.photos).map(([k, id]) => ({ label: `Водач ${i + 1} (${d.name}) – ${PHOTO_LABEL[k]}`, id })));
  const drivers: Drivers = { ...info, names: list.map((d) => d.name) };
  const [u] = await db
    .update(bookings)
    .set({
      stage: "review", docsSubmittedAt: now, documents: docs, drivers, updatedAt: now,
      ...(code ? { couponUsedAt: now, totalCents, total: fmtCents(totalCents), priceCheck: { ...snap, server: { ...snap.server, lines, totalCents }, coupon: COUPON.code } } : {}),
    })
    .where(and(eq(bookings.id, b.id), eq(bookings.status, "pending"), eq(bookings.stage, "docs"), ...(code ? [isNull(bookings.couponUsedAt)] : [])))
    .returning();
  if (!u) return { ok: false, error: code ? "coupon" : "stage" };
  await db.insert(bookingEvents).values({ bookingId: b.id, actor: "customer", action: "booking.documents", details: { drivers: list.length, photos: ids.length, coupon: !!code } });
  // Попълнен редактируем договор (Word) – наемател е първият водач; вторият водач, услугите и заявителят – в приложението
  try {
    const main = list[0];
    const qi: QuoteInput = { carId: b.carId, startDate: b.startDate!, startTime: b.startTime, endDate: b.endDate!, endTime: b.endTime, seats: (q.input as any).seats ?? 0, del: info.addr.del, ret: info.addr.ret, abroad: (q.input as any).abroad ?? [], chains: !!b.chains, secondDriver: !!b.secondDriver };
    const base: ContractData = { ...main, carId: b.carId, del: info.addr.del ? { addr: info.addr.del, km: null } : null, ret: info.addr.ret ? { addr: info.addr.ret, km: null } : null };
    // Apply the redeemed discount to the main contract rent as well as its appendix.
    const contractLines = lines.map(l => l.code === "rent" ? { ...l, cents: l.cents + (lines.find(x => x.code === "discount")?.cents ?? 0) } : l);
    const data = contractWithPrice(base, qi, { ...q, lines: contractLines, totalCents });
    await saveContract(b.id, { ...data, appendix: appendix(u, drivers, list, lines, totalCents) }, "customer", "Документи от клиента");
  } catch (e) {
    console.error("Contract could not be generated", (e as Error)?.message);
  }
  await sendOwnerDocs(u).catch((e) => console.error("Owner documents email failed, it will be retried", (e as Error)?.message));
  await sendDocsReceived(u).catch((e) => console.error("Documents-received email failed, it will be retried", (e as Error)?.message));
  return { ok: true, booking: u };
}

// ===== Писма =====
export const docsInviteKey = (id: string) => `customer-docs-invite:${id}`;
export const docsReminderKey = (id: string) => `customer-docs-reminder:${id}`;
export const couponKey = (id: string) => `customer-coupon:${id}`;
export const docsReceivedKey = (id: string) => `customer-docs-received:${id}`;
export const ownerDocsKey = (id: string) => `owner-docs:${id}`;

const T: Record<string, Record<string, string>> = {
  bg: {
    hi: "Здравейте, {name}!", car: "Автомобил", pickup: "Получаване", dropoff: "Връщане", total: "Общо за услугите",
    q: "Въпроси? Обадете ни се на {phone} или отговорете на този имейл.", why: "Получавате това писмо, защото направихте заявка за наем на автомобил на rentacar-ptb.com.",
    invSubj: "Заявката е одобрена – изпратете документите", inv: "Автомобилът е наличен и заявката ви е одобрена.",
    invInfo: "Остава една стъпка: попълнете данните и приложете снимки на личната карта (паспорта) и шофьорската книжка на водача. След проверката ще получите окончателно потвърждение.",
    invBtn: "Подайте документите", remSubj: "Напомняне: изпратете документите за резервацията", rem: "Резервацията ви все още очаква документите на водача.",
    cpSubj: "10% отстъпка за наема, ако изпратите документите днес", cp: "Подарък за вас: 10% отстъпка от наема с код RENTY10.",
    cpInfo: "Въведете кода при подаването на документите. Кодът е само за тази резервация, използва се веднъж и важи до {until}.",
    recSubj: "Получихме документите – очакват проверка", rec: "Благодарим! Получихме документите ви.",
    recInfo: "Проверяваме ги и ще ви изпратим окончателно потвърждение по имейл. Резервацията е окончателна едва след него.",
    status: "Състояние на резервацията",
  },
  en: {
    hi: "Hello {name},", car: "Car", pickup: "Pick-up", dropoff: "Return", total: "Total for services",
    q: "Questions? Call us on {phone} or reply to this email.", why: "You are receiving this email because you requested a car rental on rentacar-ptb.com.",
    invSubj: "Your request is approved – please send the documents", inv: "The car is available and your request is approved.",
    invInfo: "One step left: fill in the details and attach photos of the driver's ID card (passport) and driving licence. After the check you will receive the final confirmation.",
    invBtn: "Submit the documents", remSubj: "Reminder: please send the documents for your booking", rem: "Your booking is still waiting for the driver's documents.",
    cpSubj: "10% off the rental if you send the documents today", cp: "A gift for you: 10% off the rental with the code RENTY10.",
    cpInfo: "Enter the code when you submit the documents. The code is only for this booking, can be used once and is valid until {until}.",
    recSubj: "We received the documents – check pending", rec: "Thank you! We have received your documents.",
    recInfo: "We are checking them and will send you the final confirmation by email. The booking is final only after that.",
    status: "Booking status",
  },
  de: {
    hi: "Hallo {name},", car: "Fahrzeug", pickup: "Abholung", dropoff: "Rückgabe", total: "Gesamt für Leistungen",
    q: "Fragen? Rufen Sie uns an unter {phone} oder antworten Sie auf diese E-Mail.", why: "Sie erhalten diese E-Mail, weil Sie auf rentacar-ptb.com einen Mietwagen angefragt haben.",
    invSubj: "Ihre Anfrage ist bestätigt – bitte senden Sie die Dokumente", inv: "Das Fahrzeug ist verfügbar und Ihre Anfrage ist bestätigt.",
    invInfo: "Ein Schritt fehlt noch: Füllen Sie die Angaben aus und fügen Sie Fotos des Personalausweises (Reisepasses) und des Führerscheins des Fahrers hinzu. Nach der Prüfung erhalten Sie die endgültige Bestätigung.",
    invBtn: "Dokumente einreichen", remSubj: "Erinnerung: Bitte senden Sie die Dokumente für Ihre Buchung", rem: "Ihre Buchung wartet noch auf die Dokumente des Fahrers.",
    cpSubj: "10 % Rabatt auf die Miete, wenn Sie die Dokumente heute senden", cp: "Ein Geschenk für Sie: 10 % Rabatt auf die Miete mit dem Code RENTY10.",
    cpInfo: "Geben Sie den Code beim Einreichen der Dokumente ein. Der Code gilt nur für diese Buchung, einmalig und bis {until}.",
    recSubj: "Dokumente erhalten – Prüfung ausstehend", rec: "Vielen Dank! Wir haben Ihre Dokumente erhalten.",
    recInfo: "Wir prüfen sie und senden Ihnen die endgültige Bestätigung per E-Mail. Die Buchung ist erst danach verbindlich.",
    status: "Buchungsstatus",
  },
};
const sofiaTime = (d: Date, lang: string) => d.toLocaleString(lang === "de" ? "de-DE" : lang === "en" ? "en-GB" : "bg-BG", { timeZone: "Europe/Sofia", dateStyle: "short", timeStyle: "short" });
type Kind = "invite" | "reminder" | "coupon" | "received";
export function stageMail(kind: Kind, b: Booking) {
  const t = T[b.lang] || T.bg;
  const fill = (s: string) => s.replace("{name}", b.name).replace("{phone}", PHONE).replace("{until}", b.couponSentAt ? sofiaTime(new Date(b.couponSentAt.getTime() + COUPON.validMs), b.lang) : "");
  const ref = b.id.slice(0, 6).toUpperCase();
  const link = statusLink(b);
  const sum = `<table style="border-collapse:collapse;margin:14px 0">${mailRow(t.car, b.car)}${mailRow(t.pickup, b.pickup)}${mailRow(t.dropoff, b.dropoff)}${mailRow(t.total, b.total)}</table>`;
  const [subject, lead, info, button] =
    kind === "invite" ? [t.invSubj, t.inv, t.invInfo, t.invBtn] : kind === "reminder" ? [t.remSubj, t.rem, t.invInfo, t.invBtn]
      : kind === "coupon" ? [t.cpSubj, t.cp, t.cpInfo, t.invBtn] : [t.recSubj, t.rec, t.recInfo, t.status];
  const note = kind === "invite" && b.note ? `<p style="background:#f3f5f9;padding:12px;border-radius:10px">${esc(b.note)}</p>` : "";
  const html = wrapMail(`<p>${esc(fill(t.hi))}</p><p style="font-size:18px"><b>${esc(lead)}</b></p>${note}${sum}<p>${esc(fill(info))}</p><p>${btn(link, button, "#1a8f4c")}</p><p>${esc(fill(t.q))}</p>` + mailFooter(t.why));
  const unsubscribe = kind === "coupon" ? `<p><a href="${esc(`${siteOrigin()}/api/bookings/${b.id}/marketing?t=${b.viewToken}`)}">${b.lang === "en" ? "Stop promotional emails" : b.lang === "de" ? "Werbe-E-Mails abbestellen" : "Спри рекламните имейли"}</a></p>` : "";
  return { subject: `${subject} (№ ${ref})`, html: html + unsubscribe, preheader: lead };
}
export const sendStage = (kind: Kind, mailKind: string, key: string, b: Booking) => {
  const m = stageMail(kind, b);
  return sendLogged(mailKind, key, b.id, { to: b.email, toName: b.name, subject: m.subject, html: m.html, replyTo: OWNER_EMAIL, lang: b.lang, preheader: m.preheader });
};
export const sendDocsInvite = (b: Booking) => sendStage("invite", "customer-docs-invite", docsInviteKey(b.id), b);
export const sendDocsReceived = (b: Booking) => sendStage("received", "customer-docs-received", docsReceivedKey(b.id), b);

// Моментът на успешното изпращане на поканата – начало за напомнянето (15 мин) и за RENTY10 (2 ч)
export async function markInvited(id: string, now = new Date()) {
  const [u] = await db.update(bookings).set({ docsInvitedAt: now }).where(and(eq(bookings.id, id), isNull(bookings.docsInvitedAt))).returning();
  return u || null;
}

// Писмо до фирмата: документите са получени – второ (окончателно) одобрение с бутон; попълненият договор е прикачен.
// Без ЕГН, номера на документи и снимки в писмото – те са в договора и в админ панела след вход.
export async function sendOwnerDocs(b: Booking, origin = siteOrigin()) {
  const manage = `${origin}/api/bookings/${b.id}/manage?key=${b.adminToken}`;
  const d = driversInfo(b);
  const file = await contracts().getWithMetadata(b.id, { type: "arrayBuffer" }).catch(() => null);
  const attachment: Attachment[] = file ? [{ name: String(file.metadata?.name || "Dogovor-naem.docx"), content: Buffer.from(file.data).toString("base64") }] : [];
  const html = (att: boolean) =>
    wrapMail(
      `<p style="font-size:17px"><b>Получени документи — очакват проверка.</b> Проверете ги и потвърдете окончателно резервацията.</p>` +
        `<p>${btn(manage, "Окончателно потвърди", "#1a8f4c")}${btn(manage, "Откажи", "#c0392b")}${btn(manage, "Управление на резервацията", "#0f1b2d")}</p>` +
        `<p style="color:#5b6577;font-size:13px">Отварянето на линка не потвърждава нищо – решението е с бутон на страницата.</p>` +
        `<table style="border-collapse:collapse;margin:14px 0">${mailRow("Заявител", `${b.name}, ${b.phone}`)}${mailRow("Водачи", (d?.names || []).join(", ") || "—")}${mailRow("Автомобил", b.car)}${mailRow("Получаване", b.pickup)}${mailRow("Връщане", b.dropoff)}${mailRow("Общо", b.total)}</table>` +
        (file ? `<p>📄 <b>Договорът за наем е попълнен</b> (Word, може да се редактира).${att ? " Прикачен е към този имейл." : ""}</p>` : `<p>Договорът не можа да бъде попълнен автоматично.</p>`) +
        `<p>🪪 Снимки на документите: ${Array.isArray(b.documents) ? b.documents.length : 0} – отварят се само след вход в админ панела.</p><p>${btn(`${origin}/admin/bookings/${b.id}`, "Отвори в админ панела", "#0f1b2d")}</p>`,
    );
  const mail = { to: OWNER_EMAIL, toName: "Rent a Car PTB", subject: `Получени документи — очакват проверка: ${b.car} – ${b.name}`, replyTo: b.email };
  let r = await sendLogged("owner-docs", ownerDocsKey(b.id), b.id, { ...mail, html: html(!!attachment.length), attachment }, { retryUncertain: true });
  if (r.result === "failed" && attachment.length) r = await sendLogged("owner-docs", ownerDocsKey(b.id), b.id, { ...mail, html: html(false) }, { retryUncertain: true });
  return r;
}

// ===== Напомняния за документите (customer-emails, на всеки 5 мин) =====
export const beforePickup = (b: Pick<Booking, "startDate" | "startTime">, now = new Date()) =>
  !!b.startDate && !!b.startTime && `${b.startDate} ${b.startTime}` > now.toLocaleString("sv-SE", { timeZone: "Europe/Sofia" }).slice(0, 16);
export const DOCS_TIMING = { reminderMs: 15 * 60_000, couponMs: 2 * 3600_000 };
export async function docsReminders(now = new Date()) {
  let sent = 0;
  const open = and(eq(bookings.status, "pending"), eq(bookings.stage, "docs"), isNotNull(bookings.docsInvitedAt), isNull(bookings.docsSubmittedAt), isNull(bookings.handedOverAt));
  // 15 мин след успешно изпратената покана, ако документите още не са подадени
  for (const b of await db.select().from(bookings).where(and(open, isNull(bookings.docsReminderAt), lte(bookings.docsInvitedAt, new Date(now.getTime() - DOCS_TIMING.reminderMs)))).limit(50)) {
    if (!beforePickup(b, now)) continue;
    const [c] = await db.update(bookings).set({ docsReminderAt: now }).where(and(eq(bookings.id, b.id), isNull(bookings.docsReminderAt), eq(bookings.stage, "docs"))).returning();
    if (!c) continue;
    const r = await sendStage("reminder", "customer-docs-reminder", docsReminderKey(b.id), c).catch(() => ({ result: "failed" as const }));
    if (r.result === "sent") sent++;
  }
  // RENTY10: 2 ч след поканата, само при маркетингово съгласие и незавършени документи; валидност – 24 ч от изпращането
  for (const b of await db.select().from(bookings).where(and(open, eq(bookings.marketingConsent, true), isNull(bookings.couponSentAt), lte(bookings.docsInvitedAt, new Date(now.getTime() - DOCS_TIMING.couponMs)))).limit(50)) {
    if (!beforePickup(b, now)) continue;
    const r = await sendStage("coupon", "customer-coupon", couponKey(b.id), { ...b, couponSentAt: now }).catch(() => ({ result: "failed" as const }));
    if (r.result !== "sent" && r.result !== "duplicate") continue;
    await db.update(bookings).set({ couponSentAt: now }).where(and(eq(bookings.id, b.id), isNull(bookings.couponSentAt)));
    sent++;
  }
  return sent;
}
