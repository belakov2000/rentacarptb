import type { bookings } from "../db/schema.js";
import { esc, mailFooter, mailRow, PHONE, wrapMail } from "./index.js";

// Писмо до клиента след решението на фирмата (потвърдена / отказана резервация).
// Ползва се от функцията bookings и от повторните опити в email-retry.
type Booking = typeof bookings.$inferSelect;

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
    why: "Получавате това писмо, защото направихте заявка за наем на автомобил на rentacar-ptb.com.",
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
    why: "You are receiving this email because you requested a car rental on rentacar-ptb.com.",
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
    why: "Sie erhalten diese E-Mail, weil Sie auf rentacar-ptb.com einen Mietwagen angefragt haben.",
  },
};

export function customerMail(b: Booking) {
  const t = CUSTOMER[b.lang] || CUSTOMER.bg;
  const ok = b.status === "confirmed";
  const row = mailRow;
  const html = wrapMail(
    `<p>${esc(t.hi.replace("{name}", b.name))}</p>` +
      `<p style="font-size:18px"><b>${esc(ok ? t.ok : t.no)}</b></p>` +
      (b.note ? `<p>${esc(t.note)}<br>${esc(b.note).replace(/\n/g, "<br>")}</p>` : "") +
      `<table style="border-collapse:collapse;margin:14px 0">${row(t.car, b.car)}${row(t.pickup, b.pickup)}${row(t.dropoff, b.dropoff)}${ok ? row(t.total, b.total) + row(t.deposit, "100 €") + row(t.pay, t[b.payment] || "") : ""}</table>` +
      (ok && t[b.payment] ? `<p>${esc(b.payment === "cash" ? t.cashInfo : t.bankInfo)}</p>` : "") +
      `<p>${esc(t.q.replace("{phone}", PHONE))}</p>` +
      mailFooter(t.why),
  );
  const ref = b.id.slice(0, 6).toUpperCase();
  return { subject: `${ok ? t.okSubj : t.noSubj} (№ ${ref})`, html, preheader: `${ok ? t.ok : t.no} ${b.car}, ${b.pickup}` };
}
