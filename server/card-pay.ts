// Плащане с карта онлайн – 10% отстъпка от наема (виртуален ПОС на БОРИКА; протоколът е в server/borica.ts).
//
// Процес: клиентът избира „Плащане с карта онлайн“ в заявката → собственикът потвърждава окончателно (decide() в
// server/booking-actions.ts) → клиентът получава имейл със защитена връзка /pay/:id?k=… за конкретната резервация, с ограничен срок →
// страницата показва разбивката и изпраща подписана заявка TRTYPE=1 към БОРИКА → резултатът идва на BACKREF
// (/api/payments/borica/backref) или се взима с „Проверка за статус“ TRTYPE=90 (на страницата, от админ панела и на всеки 5 мин.).
// Плащане се записва САМО след проверен подпис на БОРИКА и съвпадение на терминал, поръчка, NONCE, сума и валута с опита.
// Връщането на клиента на сайта само по себе си не е доказателство.
//
// Сума: целият наем по сървърната цена на резервацията (bookings.price_check.server) − 10% от наема. Доставката, връщането
// от адрес и допълнителните услуги не получават отстъпка. RENTY10 (също 10% от наема) не се комбинира: прилага се по-голямата
// отстъпка, т.е. при използван RENTY10 отстъпка за карта не се добавя. Гаранционният депозит (100 €) не влиза в плащането.
//
// Конфигурация (само environment variables на сървъра, отделни за тестова и реална среда):
//   Deploy Preview / branch deploy / netlify dev → САМО BORICA_TEST_* и тестовият адрес на БОРИКА; BORICA_LIVE_* не се четат.
//   Production → САМО BORICA_LIVE_* и реалният адрес, и то само при BORICA_LIVE_ENABLED=1.
//   При липсваща или невалидна настройка плащането е недостъпно (ясна страница за клиента) – нищо не се отбелязва като платено.
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookingEvents, bookings, cardPaymentLinks, cardPayments, payments } from "../db/schema.js";
import { linkMail, ownerPaidMail, ownerUnknownMail, paidMail, type Breakdown } from "../mail/card.js";
import { OWNER_EMAIL } from "../mail/index.js";
import {
  amountOf, centsOf, FINAL_AFTER_MS, fieldsOf, GATEWAY, loadPrivateKey, loadPublicKey, outcomeOf, paymentRequest, pemOf, randomOrder,
  STATUS_WINDOW_MS, statusRequest, verifyResponse, type Fields, type Mode, type Terminal,
} from "./borica.js";
import { pickupPassed } from "./booking-actions.js";
import { queueEmail, sendLogged } from "./email.js";
import { fmtCents, type Line } from "./pricing.js";
import { siteOrigin } from "./stage.js";
import { deployContext, envKind, store } from "./stores.js";

type Booking = typeof bookings.$inferSelect;
type Attempt = typeof cardPayments.$inferSelect;
type Link = typeof cardPaymentLinks.$inferSelect;

export const CARD = { pct: 10, linkTtlMs: 48 * 3600_000 };
export const MERCH_NAME = "Rent a Car PTB";
export const MERCH_URL = "https://rentacar-ptb.com";
// Валутата на цените на сайта. Терминалът работи в една валута (т. 2.1) – ако настроената валута е друга, плащането е недостъпно
// (сумите не се преобразуват).
export const PRICE_CURRENCY = "EUR";
const OPEN = ["redirected"];

// ===== Конфигурация =====
// BORICA_FORCE_TEST=1 – отделен публичен тестов сайт (контекст production на друг Netlify сайт): само тестовият терминал.
// Променливата може единствено да избере тестовата среда – никога реалната.
export const payMode = (ctx = deployContext()): Mode | null =>
  process.env.BORICA_FORCE_TEST === "1" ? "test" : ctx === "production" ? "live" : envKind(ctx) === "preview" ? "test" : null;
export type Unavailable = "context" | "disabled" | "missing" | "currency" | "key";
// Имената на променливите (без стойностите) – за админ панела и за описанието на настройката
export const envNames = (mode: Mode) => {
  const p = mode === "live" ? "BORICA_LIVE_" : "BORICA_TEST_";
  return { terminal: p + "TERMINAL", merchant: p + "MERCHANT", currency: p + "CURRENCY", key: p + "PRIVATE_KEY", pass: p + "PRIVATE_KEY_PASSPHRASE", borica: p + "BORICA_PUBLIC_KEY", ...(mode === "live" ? { enabled: "BORICA_LIVE_ENABLED" } : {}) };
};
let cache: { sig: string; r: ReturnType<typeof load> } | null = null;
function load(mode: Mode): { ok: true; t: Terminal } | { ok: false; reason: Unavailable; mode: Mode | null } {
  const n = envNames(mode), env = process.env;
  if (mode === "live" && env.BORICA_LIVE_ENABLED !== "1") return { ok: false, reason: "disabled", mode };
  const terminal = String(env[n.terminal] || "").trim(), merchant = String(env[n.merchant] || "").trim(), currency = String(env[n.currency] || "").trim().toUpperCase();
  const keyPem = pemOf(env[n.key]), boricaPem = pemOf(env[n.borica]);
  if (!/^[A-Z0-9]{8}$/.test(terminal) || !/^\d{10}$/.test(merchant) || !/^[A-Z]{3}$/.test(currency) || !keyPem || !boricaPem) return { ok: false, reason: "missing", mode };
  if (currency !== PRICE_CURRENCY) return { ok: false, reason: "currency", mode };
  const key = loadPrivateKey(keyPem, env[n.pass] || undefined), borica = loadPublicKey(boricaPem);
  if (!key || !borica) return { ok: false, reason: "key", mode };
  return { ok: true, t: { mode, terminal, merchant, currency, key, borica, gateway: GATEWAY[mode] } };
}
export function terminalConfig(ctx = deployContext()) {
  const mode = payMode(ctx);
  if (!mode) return { ok: false as const, reason: "context" as Unavailable, mode: null };
  const n = envNames(mode);
  // Ключ на кеша – хеш на стойностите (стойностите не се пазят отделно и не се извеждат)
  const sig = createHash("sha256").update([mode, ...Object.values(n).map((k) => process.env[k] || "")].join("\0")).digest("hex");
  if (!cache || cache.sig !== sig) cache = { sig, r: load(mode) };
  return cache.r;
}
export const cardAvailable = () => terminalConfig().ok;

// ===== Сума =====
// Изчислява се само от записаната сървърна цена на резервацията. Ако сумата не може да бъде определена еднозначно
// (стари резервации, ръчна промяна, удължаване, неразчетена сума) – null: плащането с карта не се предлага автоматично.
export function breakdown(b: Booking): Breakdown | null {
  const snap = (b.priceCheck as any)?.server;
  if (b.priceCheckStatus !== "server" || b.totalReview || b.totalCents == null || !snap || !Array.isArray(snap.lines)) return null;
  const lines = snap.lines as Line[];
  if (lines.some((l) => !Number.isInteger(l.cents)) || lines.reduce((s, l) => s + l.cents, 0) !== b.totalCents) return null;
  if (lines.some((l) => (l.code as string) === "card_discount")) return null; // вече е платено с карта
  const rents = lines.filter((l) => l.code === "rent");
  if (rents.length !== 1 || rents[0].cents <= 0) return null;
  const rent = rents[0];
  const renty10 = -lines.filter((l) => l.code === "discount").reduce((s, l) => s + l.cents, 0);
  const cardPct = Math.round((rent.cents * CARD.pct) / 100);
  const cardDiscount = Math.max(0, cardPct - renty10);
  const extras = lines.filter((l) => l.code !== "rent" && l.code !== "discount");
  const pay = b.totalCents - cardDiscount;
  if (pay <= 0) return null;
  return {
    days: snap.days ?? rent.qty ?? 1, unitCents: rent.unitCents ?? rent.cents, rentCents: rent.cents, renty10Cents: renty10, cardPctCents: cardPct, cardDiscountCents: cardDiscount,
    extras: extras.map(({ code, cents, qty, unitCents, km, rate, country }) => ({ code, cents, qty, unitCents, km, rate, country })), extrasCents: extras.reduce((s, l) => s + l.cents, 0),
    totalBeforeCents: b.totalCents, payCents: pay, depositCents: snap.depositCents ?? 10000, currency: PRICE_CURRENCY,
  };
}

// Защо резервацията не може да бъде платена с карта ("" – може)
export type Block = "method" | "state" | "handed_over" | "paid" | "pickup" | "price";
export function blockOf(b: Booking, now = new Date()): Block | "" {
  if (b.payment !== "card") return "method";
  if (b.cardPaidAt) return "paid";
  if (b.status !== "confirmed" || (b.stage && b.stage !== "done")) return "state";
  if (b.handedOverAt) return "handed_over";
  if (pickupPassed(b, now)) return "pickup";
  if (!breakdown(b)) return "price";
  return "";
}

// ===== Защитена връзка за плащане =====
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const rnd = (n = 16) => randomBytes(n).toString("hex");
export const TOKEN_RE = /^[a-f0-9]{64}$/;
export const payUrl = (bookingId: string, token: string, origin = siteOrigin()) => `${origin}/pay/${bookingId}?k=${token}`;
const outbox = () => store("mail-outbox");
const linkOutboxKey = (linkId: string) => `card-link/${linkId}`;
export const linkKey = (linkId: string) => `customer-card-link:${linkId}`;

// Нова връзка (предишните се отменят). Връзката сама по себе си не таксува нищо.
export async function issueLink(b: Booking, actor: string, now = new Date()) {
  const token = rnd(32);
  const link = await db.transaction(async (tx) => {
    await tx.update(cardPaymentLinks).set({ revokedAt: now }).where(and(eq(cardPaymentLinks.bookingId, b.id), isNull(cardPaymentLinks.revokedAt)));
    const [l] = await tx.insert(cardPaymentLinks).values({ id: rnd(), bookingId: b.id, tokenHash: sha(token), createdBy: actor, createdAt: now, expiresAt: new Date(now.getTime() + CARD.linkTtlMs) }).returning();
    await tx.insert(bookingEvents).values({ bookingId: b.id, actor, action: "card.link_issued", details: { expiresAt: l.expiresAt.toISOString() } });
    await queueEmail(tx, "customer-card-link", linkKey(l.id), b.id, b.email);
    return l;
  });
  // Тайната връзка се пази в частното хранилище само до успешното изпращане на писмото (както писмото до фирмата)
  await outbox().setJSON(linkOutboxKey(link.id), { token });
  return { link, token, url: payUrl(b.id, token) };
}

export async function sendLink(b: Booking, link: Link) {
  const o = (await outbox().get(linkOutboxKey(link.id), { type: "json" }).catch(() => null)) as { token: string } | null;
  const bd = breakdown(b);
  if (!o || !bd || link.revokedAt || blockOf(b)) return null;
  const m = linkMail(b, payUrl(b.id, o.token), bd, link.expiresAt);
  const r = await sendLogged("customer-card-link", linkKey(link.id), b.id, { to: b.email, toName: b.name, subject: m.subject, html: m.html, replyTo: OWNER_EMAIL, lang: b.lang, preheader: m.preheader });
  if (r.result === "sent" || r.result === "duplicate") {
    await db.update(cardPaymentLinks).set({ sentAt: new Date() }).where(and(eq(cardPaymentLinks.id, link.id), isNull(cardPaymentLinks.sentAt)));
    await outbox().delete(linkOutboxKey(link.id)).catch(() => null);
  }
  return r;
}

// След окончателното потвърждение на резервация с плащане с карта (от server/booking-actions.ts → decide)
export async function afterConfirm(b: Booking, actor: string) {
  if (b.payment !== "card" || blockOf(b)) return null;
  const { link } = await issueLink(b, actor);
  return sendLink(b, link);
}

export type LinkCheck = { ok: true; link: Link; booking: Booking } | { ok: false; reason: "invalid" | "expired" | "revoked" };
export async function checkLink(bookingId: string, token: string, now = new Date()): Promise<LinkCheck> {
  if (!/^[a-f0-9]{32}$/.test(bookingId) || !TOKEN_RE.test(token)) return { ok: false, reason: "invalid" };
  const [l] = await db.select().from(cardPaymentLinks).where(and(eq(cardPaymentLinks.tokenHash, sha(token)), eq(cardPaymentLinks.bookingId, bookingId)));
  if (!l) return { ok: false, reason: "invalid" };
  if (l.revokedAt) return { ok: false, reason: "revoked" };
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!b) return { ok: false, reason: "invalid" };
  // След плащане връзката продължава да показва потвърждението (без нов опит)
  if (l.expiresAt.getTime() < now.getTime() && !b.cardPaidAt) return { ok: false, reason: "expired" };
  return { ok: true, link: l, booking: b };
}

// ===== Опит за плащане =====
const LATIN_NAME = /^[A-Za-z][A-Za-z .'-]{1,44}$/;
export function cardholderOf(name: unknown, addr: unknown) {
  const n = String(name ?? "").trim().replace(/\s+/g, " ").toUpperCase(), a = String(addr ?? "").trim().replace(/\s+/g, " ");
  return LATIN_NAME.test(n) && a.length >= 3 && a.length <= 50 && !/[<>;]/.test(a) ? { name: n, addr: a } : null;
}
export type StartResult =
  | { ok: true; action: string; fields: Fields; attempt: Attempt }
  | { ok: false; error: Block | Unavailable | "in_progress" | "review" | "input" };

export async function startPayment(b0: Booking, linkId: string, holder: { name: string; addr: string } | null, now = new Date()): Promise<StartResult> {
  const cfg = terminalConfig();
  if (!cfg.ok) return { ok: false, error: cfg.reason };
  if (!holder) return { ok: false, error: "input" };
  const t = cfg.t;
  await refreshOpen(b0.id, now); // окончателните резултати от предишни опити (не започваме второ плащане, ако първото е успешно)
  const r = await db.transaction(async (tx): Promise<StartResult> => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, b0.id)).for("update");
    const block = blockOf(b, now);
    if (block) return { ok: false, error: block };
    const prev = await tx.select().from(cardPayments).where(and(eq(cardPayments.bookingId, b.id), inArray(cardPayments.status, [...OPEN, "unknown"])));
    if (prev.some((p) => p.status === "unknown")) return { ok: false, error: "review" };
    const open = prev.filter((p) => p.mode === t.mode).sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0];
    // Започнат опит без окончателен резултат: нов опит едва след GUARDTIME + 1 мин. (т. 9.5.1) – без риск от двойно плащане
    if (open) return { ok: false, error: "in_progress" };
    const bd = breakdown(b)!;
    for (let i = 0; i < 8; i++) {
      const order = randomOrder();
      const id = rnd();
      const req = paymentRequest(t, {
        amountCents: bd.payCents, order, desc: `Rent a Car PTB - booking ${b.id.slice(0, 6).toUpperCase()}`, merchName: MERCH_NAME, merchUrl: MERCH_URL,
        lang: b.lang === "bg" ? "BG" : "EN", adOrderId: `${order}PTB${b.id.slice(0, 6).toUpperCase()}`, cardholder: { name: holder.name, email: b.email, billAddrLine1: holder.addr }, now,
      });
      const [a] = await tx
        .insert(cardPayments)
        .values({ id, bookingId: b.id, linkId, mode: t.mode, terminal: t.terminal, orderNo: order, nonce: req.fields.NONCE, amountCents: bd.payCents, currency: t.currency, breakdown: bd, status: "redirected", createdAt: now })
        .onConflictDoNothing()
        .returning();
      if (!a) continue; // ORDER вече е използван на терминала – нов номер
      await tx.insert(bookingEvents).values({ bookingId: b.id, actor: "customer", action: "card.payment_started", details: { mode: t.mode, order, amountCents: bd.payCents } });
      return { ok: true, action: t.gateway, fields: req.fields, attempt: a };
    }
    throw new Error("Could not allocate ORDER");
  });
  return r;
}

// ===== Отговор от БОРИКА =====
export type Verdict =
  | { ok: false; reason: "config" | "signature" | "terminal" | "type" | "order" | "nonce" }
  | { ok: true; attempt: Attempt };
// Подпис, терминал, тип, поръчка и NONCE. При проверка за статус документът показва NONCE на заявката за статус (пример 6.2,
// табл. 16) или на оригиналната трансакция (табл. 15) – приемат се само тези две стойности.
export async function matchResponse(t: Terminal, f: Fields, kind: "backref" | "status", statusNonce = ""): Promise<Verdict> {
  if (!verifyResponse(f, t.borica)) return { ok: false, reason: "signature" };
  if (f.TERMINAL !== t.terminal) return { ok: false, reason: "terminal" };
  if (kind === "backref" ? f.TRTYPE !== "1" : f.TRTYPE !== "90" || (f.TRAN_TRTYPE && f.TRAN_TRTYPE !== "1")) return { ok: false, reason: "type" };
  if (!/^\d{6}$/.test(f.ORDER || "")) return { ok: false, reason: "order" };
  const [a] = await db.select().from(cardPayments).where(and(eq(cardPayments.terminal, t.terminal), eq(cardPayments.orderNo, f.ORDER), eq(cardPayments.mode, t.mode)));
  if (!a) return { ok: false, reason: "order" };
  const okNonce = kind === "backref" ? f.NONCE === a.nonce : f.NONCE === a.nonce || (!!statusNonce && f.NONCE === statusNonce);
  if (!okNonce) return { ok: false, reason: "nonce" };
  return { ok: true, attempt: a };
}

export const paidKey = (bookingId: string) => `customer-card-paid:${bookingId}`;
export const ownerPaidKey = (attemptId: string) => `owner-card-paid:${attemptId}`;
export const ownerUnknownKey = (attemptId: string) => `owner-card-unknown:${attemptId}`;

export type Applied = { state: "paid" | "declined" | "pending" | "failed" | "unknown" | "mismatch"; attempt: Attempt; already?: boolean; duplicate?: boolean; notifyUnknown?: boolean };
// Записва проверен отговор (BACKREF или проверка за статус). Идемпотентно: повторен отговор за вече платен опит не променя нищо
// и не праща нови писма (заключване на реда + уникални ключове на плащането и на писмата).
export async function applyResult(attemptId: string, f: Fields, source: "backref" | "status", now = new Date()): Promise<Applied> {
  const outcome = outcomeOf(f);
  const res = await db.transaction(async (tx): Promise<Applied & { booking?: Booking }> => {
    const [a] = await tx.select().from(cardPayments).where(eq(cardPayments.id, attemptId)).for("update");
    if (a.status === "paid") return { state: "paid", attempt: a, already: true };
    const base = { action: f.ACTION ?? null, rc: f.RC ?? null, statusMsg: (f.STATUSMSG || "").slice(0, 255) || null, lastCheckAt: source === "status" ? now : a.lastCheckAt };
    if (outcome === "paid") {
      // Сумата и валутата трябва да съвпадат с изчислените на сървъра при създаването на опита
      if (centsOf(f.AMOUNT) !== a.amountCents || f.CURRENCY !== a.currency) {
        await tx.insert(bookingEvents).values({ bookingId: a.bookingId, actor: "system", action: "card.amount_mismatch", details: { order: a.orderNo, source, amount: f.AMOUNT ?? null, currency: f.CURRENCY ?? null } });
        return { state: "mismatch", attempt: a };
      }
      const [b] = await tx.select().from(bookings).where(eq(bookings.id, a.bookingId)).for("update");
      const duplicate = !!b.cardPaidAt && b.cardPaymentId !== a.id;
      const [u] = await tx
        .update(cardPayments)
        .set({ ...base, status: "paid", approval: f.APPROVAL || null, rrn: f.RRN || null, intRef: f.INT_REF || null, tranDate: f.TRAN_DATE || null, cardBrand: f.CARD_BRAND || null, resultSource: source, duplicate, resolvedAt: now })
        .where(eq(cardPayments.id, a.id))
        .returning();
      // Плащането влиза в „Плащания“ на резервацията (получено, с карта) – веднъж за опит
      await tx.insert(payments).values({
        id: rnd(), bookingId: b.id, amountCents: a.amountCents, currency: a.currency, method: "card", kind: "final", status: "received", paidAt: now, txnId: (f.RRN || f.INT_REF || "").slice(0, 40),
        note: `${a.mode === "live" ? "" : "ТЕСТ – "}Плащане с карта онлайн (БОРИКА), ORDER ${a.orderNo}, INT_REF ${f.INT_REF || "-"}, код ${f.APPROVAL || "-"}${duplicate ? " – ВТОРО ПЛАЩАНЕ ЗА ВЕЧЕ ПЛАТЕНА РЕЗЕРВАЦИЯ" : ""}`,
        idempotencyKey: `borica:${a.id}`, createdBy: "borica",
      }).onConflictDoNothing();
      let booking = b;
      if (!duplicate) {
        // Отстъпката за карта става част от договорената сума само при успешно плащане (иначе цената остава непроменена)
        const bd = a.breakdown as Breakdown, snap = (b.priceCheck as any) || {};
        const lines = bd.cardDiscountCents ? [...(snap.server?.lines || []), { code: "card_discount", cents: -bd.cardDiscountCents }] : snap.server?.lines || [];
        const total = b.totalCents == null ? null : b.totalCents - bd.cardDiscountCents;
        [booking] = await tx
          .update(bookings)
          .set({
            cardPaidAt: now, cardPaymentId: a.id, updatedAt: now,
            ...(bd.cardDiscountCents && total != null ? { totalCents: total, total: fmtCents(total), priceCheck: { ...snap, server: { ...snap.server, lines, totalCents: total }, card: { pct: CARD.pct, discountCents: bd.cardDiscountCents } } } : {}),
          })
          .where(eq(bookings.id, b.id))
          .returning();
        await queueEmail(tx, "customer-card-paid", paidKey(b.id), b.id, b.email);
      }
      await queueEmail(tx, "owner-card-paid", ownerPaidKey(a.id), b.id, OWNER_EMAIL);
      await tx.insert(bookingEvents).values({ bookingId: b.id, actor: "borica", action: "card.paid", details: { mode: a.mode, order: a.orderNo, amountCents: a.amountCents, source, duplicate } });
      return { state: "paid", attempt: u, duplicate, booking };
    }
    if (outcome === "declined") {
      const [u] = await tx.update(cardPayments).set({ ...base, status: "declined", resultSource: source, resolvedAt: now }).where(eq(cardPayments.id, a.id)).returning();
      if (a.status !== "declined") await tx.insert(bookingEvents).values({ bookingId: a.bookingId, actor: "borica", action: "card.declined", details: { order: a.orderNo, rc: f.RC ?? null, source } });
      return { state: "declined", attempt: u };
    }
    // Неуспех се приема САМО по изричното правило на стр. 18 (т. 4.2): проверка за статус с RC=-40, „чиято оригинална трансакция
    // е по-стара от GUARDTIME, можем да считаме че оригиналната трансакция не е успешна (timeout)“. Тогава е разрешен нов опит.
    const age = now.getTime() - a.createdAt.getTime();
    if (outcome === "timeout" && source === "status" && age > FINAL_AFTER_MS) {
      const [u] = await tx.update(cardPayments).set({ ...base, status: "failed", resultSource: source, resolvedAt: now }).where(eq(cardPayments.id, a.id)).returning();
      if (a.status !== "failed") await tx.insert(bookingEvents).values({ bookingId: a.bookingId, actor: "borica", action: "card.failed", details: { order: a.orderNo, rc: f.RC ?? null, source, rule: "status RC -40 older than GUARDTIME (P-OM-41 p.18)" } });
      return { state: "failed", attempt: u };
    }
    // Друг неуспешен резултат от проверката за статус след 16 мин. е окончателен за банката (стр. 56, т. 9.5.1), но документът
    // не казва, че означава неуспешно плащане. Затова: без нов опит и без отбелязване като платено – ръчна проверка в Merchant Portal.
    if (source === "status" && age > FINAL_AFTER_MS) {
      const [u] = await tx.update(cardPayments).set({ ...base, status: "unknown", resultSource: source, resolvedAt: now }).where(eq(cardPayments.id, a.id)).returning();
      if (a.status !== "unknown") await tx.insert(bookingEvents).values({ bookingId: a.bookingId, actor: "system", action: "card.unknown", details: { order: a.orderNo, action: f.ACTION ?? null, rc: f.RC ?? null, source } });
      return { state: "unknown", attempt: u, notifyUnknown: a.status !== "unknown" };
    }
    // В рамките на GUARDTIME отрицателните кодове могат да се променят (стр. 56) – опитът остава отворен
    const [u] = await tx.update(cardPayments).set(base).where(eq(cardPayments.id, a.id)).returning();
    return { state: "pending", attempt: u };
  });
  if (res.state === "paid" && !res.already) await sendPaidMails(res.attempt.bookingId, res.attempt).catch((e) => console.error("Card payment emails failed, they will be retried", (e as Error)?.message));
  if (res.notifyUnknown) await notifyUnknown(res.attempt, "final_code").catch(() => null);
  return { state: res.state, attempt: res.attempt, already: res.already, duplicate: res.duplicate };
}

async function sendPaidMails(bookingId: string, a: Attempt) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!b) return;
  const at = a.resolvedAt || new Date();
  if (!a.duplicate) {
    const m = paidMail(b, a, at);
    await sendLogged("customer-card-paid", paidKey(b.id), b.id, { to: b.email, toName: b.name, subject: m.subject, html: m.html, replyTo: OWNER_EMAIL, lang: b.lang, preheader: m.preheader });
  }
  const o = ownerPaidMail(b, a, at, siteOrigin());
  await sendLogged("owner-card-paid", ownerPaidKey(a.id), b.id, { to: OWNER_EMAIL, toName: "Rent a Car PTB", subject: o.subject, html: o.html, replyTo: b.email }, { retryUncertain: true });
}

async function notifyUnknown(a: Attempt, why: "final_code" | "no_result_24h") {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, a.bookingId));
  if (!b) return;
  const m = ownerUnknownMail(b, a, siteOrigin(), why);
  await sendLogged("owner-card-unknown", ownerUnknownKey(a.id), b.id, { to: OWNER_EMAIL, toName: "Rent a Car PTB", subject: m.subject, html: m.html }, { retryUncertain: true });
}

// Ръчно освобождаване на опит с неизвестен резултат – само от администратор, след проверка в Merchant Portal, че трансакцията
// не е успешна. Това е решение на човек, не извод от изтеклото време. Платено не може да бъде отбелязано оттук.
export async function releaseUnknown(attemptId: string, actor: string, note: string, now = new Date()) {
  const [u] = await db.update(cardPayments).set({ status: "failed", resultSource: "manual", statusMsg: ("Ръчно: " + note).slice(0, 255), resolvedAt: now })
    .where(and(eq(cardPayments.id, attemptId), eq(cardPayments.status, "unknown"))).returning();
  if (u) await db.insert(bookingEvents).values({ bookingId: u.bookingId, actor, action: "card.released", details: { order: u.orderNo } });
  return u || null;
}

// ===== Проверка за статус (TRTYPE=90) =====
export type CheckResult = Applied["state"] | "unknown" | "invalid" | "network" | "config" | "skip";
export async function checkStatus(a: Attempt, now = new Date()): Promise<CheckResult> {
  if (!OPEN.includes(a.status)) return "skip";
  const cfg = terminalConfig();
  if (!cfg.ok || cfg.t.mode !== a.mode || cfg.t.terminal !== a.terminal) return "config";
  // APGW пази данни само 24 ч.: след това резултатът не може да бъде установен автоматично
  if (now.getTime() - a.createdAt.getTime() > STATUS_WINDOW_MS) {
    const [u] = await db.update(cardPayments).set({ status: "unknown", resolvedAt: now }).where(and(eq(cardPayments.id, a.id), inArray(cardPayments.status, OPEN))).returning();
    if (u) {
      await db.insert(bookingEvents).values({ bookingId: a.bookingId, actor: "system", action: "card.unknown", details: { order: a.orderNo, reason: "no_result_24h" } });
      await notifyUnknown(u, "no_result_24h").catch(() => null);
    }
    return "unknown";
  }
  const req = statusRequest(cfg.t, a.orderNo);
  await db.update(cardPayments).set({ lastCheckAt: now, checks: sql`${cardPayments.checks} + 1` }).where(eq(cardPayments.id, a.id));
  let f: Fields;
  try {
    const r = await fetch(cfg.t.gateway, { method: "POST", signal: AbortSignal.timeout(20_000), headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(req.fields).toString() });
    if (!r.ok) return "network";
    const j = await r.json();
    f = fieldsOf(Object.entries(j && typeof j === "object" ? j : {}));
  } catch {
    return "network";
  }
  const m = await matchResponse(cfg.t, f, "status", req.fields.NONCE);
  if (!m.ok || m.attempt.id !== a.id) {
    await db.insert(bookingEvents).values({ bookingId: a.bookingId, actor: "system", action: "card.status_invalid", details: { order: a.orderNo, reason: m.ok ? "attempt" : m.reason } });
    return "invalid";
  }
  return (await applyResult(a.id, f, "status", now)).state;
}

// Отворените опити по една резервация (страницата за плащане и админ панелът) – не по-често от веднъж на 20 секунди за опит
export async function refreshOpen(bookingId: string, now = new Date()) {
  const open = await db.select().from(cardPayments).where(and(eq(cardPayments.bookingId, bookingId), inArray(cardPayments.status, OPEN)));
  for (const a of open) if (!a.lastCheckAt || now.getTime() - a.lastCheckAt.getTime() > 20_000) await checkStatus(a, now).catch(() => "network");
}

// Планираната проверка: опити без окончателен резултат, по-стари от 2 мин.
export async function dueChecks(now = new Date(), limit = 20) {
  return db
    .select()
    .from(cardPayments)
    .where(and(inArray(cardPayments.status, OPEN), lt(cardPayments.createdAt, new Date(now.getTime() - 2 * 60_000)), or(isNull(cardPayments.lastCheckAt), lt(cardPayments.lastCheckAt, new Date(now.getTime() - 4 * 60_000)))))
    .orderBy(cardPayments.createdAt)
    .limit(limit);
}

// ===== Изглед =====
export async function cardState(bookingId: string) {
  const attempts = await db.select().from(cardPayments).where(eq(cardPayments.bookingId, bookingId)).orderBy(desc(cardPayments.createdAt));
  const links = await db.select({ id: cardPaymentLinks.id, createdAt: cardPaymentLinks.createdAt, createdBy: cardPaymentLinks.createdBy, expiresAt: cardPaymentLinks.expiresAt, revokedAt: cardPaymentLinks.revokedAt, sentAt: cardPaymentLinks.sentAt })
    .from(cardPaymentLinks).where(eq(cardPaymentLinks.bookingId, bookingId)).orderBy(desc(cardPaymentLinks.createdAt));
  return { attempts: attempts.map(({ nonce: _n, ...a }) => a), links };
}

// Повторен опит за писмата (email-retry)
export async function retryCard(kind: string, bookingId: string, dedupeKey: string | null) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!b || !dedupeKey) return null;
  if (kind === "customer-card-link") {
    const [l] = await db.select().from(cardPaymentLinks).where(eq(cardPaymentLinks.id, dedupeKey.split(":")[1] || ""));
    return l && l.expiresAt > new Date() ? sendLink(b, l) : null;
  }
  if (kind === "customer-card-paid" || kind === "owner-card-paid") {
    const id = kind === "owner-card-paid" ? dedupeKey.split(":")[1] : b.cardPaymentId;
    const [a] = id ? await db.select().from(cardPayments).where(eq(cardPayments.id, id)) : [];
    if (!a || a.status !== "paid") return null;
    if (kind === "customer-card-paid") {
      const m = paidMail(b, a, a.resolvedAt || new Date());
      return sendLogged(kind, dedupeKey, b.id, { to: b.email, toName: b.name, subject: m.subject, html: m.html, replyTo: OWNER_EMAIL, lang: b.lang, preheader: m.preheader });
    }
    const o = ownerPaidMail(b, a, a.resolvedAt || new Date(), siteOrigin());
    return sendLogged(kind, dedupeKey, b.id, { to: OWNER_EMAIL, toName: "Rent a Car PTB", subject: o.subject, html: o.html, replyTo: b.email }, { retryUncertain: true });
  }
  return null;
}
export const CARD_RETRY_KINDS = ["customer-card-link", "customer-card-paid", "owner-card-paid"];
export { amountOf };
