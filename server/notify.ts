import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookingExtensions, bookings } from "../db/schema.js";
import { lifecycleMail } from "../mail/customer.js";
import { closedMail, customerMail, extendedMail } from "../mail/decision.js";
import { btn, esc, OWNER_EMAIL, wrapMail, type Attachment } from "../mail/index.js";
import { contracts } from "./contracts.js";
import { sendLogged } from "./email.js";
import { store } from "./stores.js";

// Писмата около една резервация. Ползват се веднага при заявката / решението и от повторните опити (email-retry).
type Booking = typeof bookings.$inferSelect;

// Готовото писмо до фирмата се пази в частното хранилище mail-outbox, докато не бъде изпратено успешно
// (съдържа тайната връзка за управление – затова не е в базата и не е в лога), след това се изтрива.
type Outbox = { subject: string; html: string; htmlNoAttachment: string; replyTo: string };
const outbox = () => store("mail-outbox");
const outboxKey = (id: string) => `owner-new/${id}`;
export const saveOwnerOutbox = (id: string, o: Outbox) => outbox().setJSON(outboxKey(id), o);

export const ownerNewKey = (id: string) => `owner-new:${id}`;
export const receivedKey = (id: string) => `customer-received:${id}`;
export const decisionKey = (id: string) => `customer-decision:${id}`;
// Отмяна / неявяване: една резервация може да бъде закрита само веднъж, затова ключът е по резервация
export const closedKey = (id: string) => `customer-closed:${id}`;

export async function sendOwnerNew(id: string) {
  const o = ((await outbox().get(outboxKey(id), { type: "json" }).catch(() => null)) as Outbox | null) || (await minimalOwnerMail(id));
  if (!o) return null;
  const file = await contracts().getWithMetadata(id, { type: "arrayBuffer" }).catch(() => null);
  const attachment: Attachment[] = file ? [{ name: String(file.metadata?.name || "Dogovor-naem.docx"), content: Buffer.from(file.data).toString("base64") }] : [];
  const mail = { to: OWNER_EMAIL, toName: "Rent a Car PTB", subject: o.subject, replyTo: o.replyTo };
  // Известието до фирмата се повтаря и след несигурен резултат – пропусната заявка е по-лошо от второ писмо
  let r = await sendLogged("owner-new", ownerNewKey(id), id, { ...mail, html: attachment.length ? o.html : o.htmlNoAttachment, attachment }, { retryUncertain: true });
  // Ако пощата откаже прикачения файл, писмото се изпраща без него – договорът остава достъпен от линка
  if (r.result === "failed" && attachment.length) r = await sendLogged("owner-new", ownerNewKey(id), id, { ...mail, html: o.htmlNoAttachment }, { retryUncertain: true });
  if (r.result === "sent" || r.result === "duplicate") await outbox().delete(outboxKey(id)).catch(() => null);
  return r;
}

// Ако готовото писмо липсва (напр. изтрито), фирмата пак получава кратко писмо с бутоните – без текста от формата
async function minimalOwnerMail(id: string): Promise<Outbox | null> {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id));
  const origin = process.env.URL;
  if (!b || !origin) return null;
  const manage = `${origin}/api/bookings/${b.id}/manage?key=${b.adminToken}`;
  const html = wrapMail(
    `<p style="font-size:17px"><b>Нова заявка за наем от сайта.</b> Потвърдете или откажете – клиентът ще получи имейл и ще види решението на сайта.</p>` +
      `<p>${btn(manage, "Потвърди резервацията", "#1a8f4c")}${btn(manage, "Откажи", "#c0392b")}${btn(manage, "Управление на резервацията", "#0f1b2d")}</p>` +
      `<p>${esc(b.car)} · ${esc(b.pickup)} → ${esc(b.dropoff)} · ${esc(b.total)}</p>`,
  );
  return { subject: `Нова заявка за наем: ${b.car} – ${b.name}`, html, htmlNoAttachment: html, replyTo: b.email };
}

export function sendCustomerReceived(b: Booking) {
  const m = lifecycleMail("received", b);
  return sendLogged("customer-received", receivedKey(b.id), b.id, { to: b.email, toName: b.name, subject: m.subject, html: m.html, replyTo: OWNER_EMAIL, lang: b.lang, preheader: m.preheader });
}

export function sendDecision(b: Booking) {
  const m = customerMail(b);
  return sendLogged("customer-decision", decisionKey(b.id), b.id, { to: b.email, toName: b.name, subject: m.subject, html: m.html, replyTo: OWNER_EMAIL, lang: b.lang, preheader: m.preheader });
}

export function sendClosed(b: Booking) {
  const m = closedMail(b);
  return sendLogged("customer-closed", closedKey(b.id), b.id, { to: b.email, toName: b.name, subject: m.subject, html: m.html, replyTo: OWNER_EMAIL, lang: b.lang, preheader: m.preheader });
}

// Удължаване: ключът е по запис за удължаване – всяко удължаване има най-много едно писмо
export const extendedKey = (id: string, extId: number) => `customer-extended:${id}:${extId}`;
type Extension = typeof bookingExtensions.$inferSelect;
export function sendExtended(b: Booking, e: Extension) {
  const m = extendedMail(b, e);
  return sendLogged("customer-extended", extendedKey(b.id, e.id), b.id, { to: b.email, toName: b.name, subject: m.subject, html: m.html, replyTo: OWNER_EMAIL, lang: b.lang, preheader: m.preheader });
}

// Повторен опит по запис от email_log
export async function retry(kind: string, bookingId: string | null, dedupeKey: string | null = null) {
  if (!bookingId) return null;
  if (kind === "owner-new") return sendOwnerNew(bookingId);
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!b) return null;
  if (kind === "customer-received") return sendCustomerReceived(b);
  // След отмяна неизпратеното писмо за потвърждението вече не е вярно – не се изпраща
  if (kind === "customer-decision" && (b.status === "confirmed" || b.status === "rejected")) return sendDecision(b);
  if (kind === "customer-closed" && (b.status === "cancelled" || b.status === "no_show")) return sendClosed(b);
  // Удължаване: само ако е последното удължаване и наемът все още е активен – иначе писмото вече не е вярно
  if (kind === "customer-extended" && dedupeKey && b.status === "confirmed" && !b.returnedAt) {
    const extId = Number(dedupeKey.split(":")[2]);
    const [last] = await db.select().from(bookingExtensions).where(eq(bookingExtensions.bookingId, b.id)).orderBy(desc(bookingExtensions.id)).limit(1);
    if (last && last.id === extId && last.notify) return sendExtended(b, last);
  }
  return null;
}
export const RETRY_KINDS = ["owner-new", "customer-received", "customer-decision", "customer-closed", "customer-extended"];
// Писма, които се повтарят и след несигурен резултат (възможно второ копие): само известието до фирмата
export const UNCERTAIN_RETRY_KINDS = ["owner-new"];
