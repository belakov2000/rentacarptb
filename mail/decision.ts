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

// ===== Имейл до клиента след отмяна на потвърдена резервация или неявяване =====
// Само номер, автомобил, период и новия статус – вътрешната бележка на собственика не се включва.
// Не обещава възстановяване на суми или депозит.
const CLOSED: Record<string, Record<string, string>> = {
  bg: {
    cancelSubj: "Резервацията ви е отменена – Rent a Car PTB",
    noShowSubj: "Резервацията ви е закрита поради неявяване – Rent a Car PTB",
    hi: "Здравейте, {name}!",
    cancel: "Вашата резервация е отменена и автомобилът вече не е запазен за вас.",
    noShow: "Резервацията е закрита, тъй като не се явихте в уговорения час за получаване на автомобила.",
    ref: "Номер на резервацията", car: "Автомобил", pickup: "Получаване", dropoff: "Връщане", status: "Статус",
    cancelled: "Отменена", no_show: "Закрита – неявяване",
    q: "Въпроси? Обадете ни се на {phone} или отговорете на този имейл.",
    why: "Получавате това писмо, защото направихте заявка за наем на автомобил на rentacar-ptb.com.",
  },
  en: {
    cancelSubj: "Your booking has been cancelled – Rent a Car PTB",
    noShowSubj: "Your booking has been closed (no-show) – Rent a Car PTB",
    hi: "Hello {name},",
    cancel: "Your booking has been cancelled and the car is no longer reserved for you.",
    noShow: "Your booking has been closed because you did not arrive at the agreed pick-up time.",
    ref: "Booking number", car: "Car", pickup: "Pick-up", dropoff: "Return", status: "Status",
    cancelled: "Cancelled", no_show: "Closed – no-show",
    q: "Questions? Call us on {phone} or reply to this email.",
    why: "You are receiving this email because you requested a car rental on rentacar-ptb.com.",
  },
  de: {
    cancelSubj: "Ihre Buchung wurde storniert – Rent a Car PTB",
    noShowSubj: "Ihre Buchung wurde wegen Nichterscheinens geschlossen – Rent a Car PTB",
    hi: "Hallo {name},",
    cancel: "Ihre Buchung wurde storniert, das Fahrzeug ist nicht mehr für Sie reserviert.",
    noShow: "Ihre Buchung wurde geschlossen, da Sie zur vereinbarten Abholzeit nicht erschienen sind.",
    ref: "Buchungsnummer", car: "Fahrzeug", pickup: "Abholung", dropoff: "Rückgabe", status: "Status",
    cancelled: "Storniert", no_show: "Geschlossen – nicht erschienen",
    q: "Fragen? Rufen Sie uns an unter {phone} oder antworten Sie auf diese E-Mail.",
    why: "Sie erhalten diese E-Mail, weil Sie auf rentacar-ptb.com einen Mietwagen angefragt haben.",
  },
};

export function closedMail(b: Booking) {
  const t = CLOSED[b.lang] || CLOSED.bg;
  const noShow = b.status === "no_show";
  const ref = b.id.slice(0, 6).toUpperCase();
  const html = wrapMail(
    `<p>${esc(t.hi.replace("{name}", b.name))}</p>` +
      `<p style="font-size:18px"><b>${esc(noShow ? t.noShow : t.cancel)}</b></p>` +
      `<table style="border-collapse:collapse;margin:14px 0">${mailRow(t.ref, ref)}${mailRow(t.car, b.car)}${mailRow(t.pickup, b.pickup)}${mailRow(t.dropoff, b.dropoff)}${mailRow(t.status, noShow ? t.no_show : t.cancelled)}</table>` +
      `<p>${esc(t.q.replace("{phone}", PHONE))}</p>` +
      mailFooter(t.why),
  );
  return { subject: `${noShow ? t.noShowSubj : t.cancelSubj} (№ ${ref})`, html, preheader: `${noShow ? t.noShow : t.cancel} ${b.car}, ${b.pickup}` };
}

// ===== Имейл до клиента при удължаване на наема (само ако администраторът изрично е избрал изпращане) =====
const EXTENDED: Record<string, Record<string, string>> = {
  bg: {
    subj: "Наемът ви е удължен – Rent a Car PTB", hi: "Здравейте, {name}!", lead: "Потвърждаваме удължаването на наема.",
    car: "Автомобил", pickup: "Получаване", oldEnd: "Предишно връщане", newEnd: "Ново връщане", added: "Допълнителна сума за удължаването", total: "Нова обща сума",
    info: "Ще ви предоставим новата версия на договора за подпис. Плащането на допълнителната сума се урежда отделно.",
    q: "Въпроси? Обадете ни се на {phone} или отговорете на този имейл.", why: "Получавате това писмо, защото имате резервация за наем на автомобил на rentacar-ptb.com.",
  },
  en: {
    subj: "Your rental has been extended – Rent a Car PTB", hi: "Hello {name},", lead: "We confirm the extension of your rental.",
    car: "Car", pickup: "Pick-up", oldEnd: "Previous return", newEnd: "New return", added: "Additional amount for the extension", total: "New total",
    info: "We will provide the new version of the contract for signing. Payment of the additional amount is arranged separately.",
    q: "Questions? Call us on {phone} or reply to this email.", why: "You are receiving this email because you have a car rental booking on rentacar-ptb.com.",
  },
  de: {
    subj: "Ihre Miete wurde verlängert – Rent a Car PTB", hi: "Hallo {name},", lead: "Wir bestätigen die Verlängerung Ihrer Miete.",
    car: "Fahrzeug", pickup: "Abholung", oldEnd: "Bisherige Rückgabe", newEnd: "Neue Rückgabe", added: "Zusätzlicher Betrag für die Verlängerung", total: "Neuer Gesamtbetrag",
    info: "Wir stellen Ihnen die neue Version des Vertrags zur Unterschrift zur Verfügung. Die Zahlung des zusätzlichen Betrags wird separat geregelt.",
    q: "Fragen? Rufen Sie uns an unter {phone} oder antworten Sie auf diese E-Mail.", why: "Sie erhalten diese E-Mail, weil Sie eine Mietwagenbuchung auf rentacar-ptb.com haben.",
  },
};
const dmy = (d: string) => d.split("-").reverse().join(".");
const eurTxt = (c: number) => (c / 100).toFixed(2).replace(".", ",") + " €";
export function extendedMail(b: Booking, e: { oldEndDate: string; oldEndTime: string; newEndDate: string; newEndTime: string; addedCents: number; newTotalCents: number | null }) {
  const t = EXTENDED[b.lang] || EXTENDED.bg;
  const ref = b.id.slice(0, 6).toUpperCase();
  const html = wrapMail(
    `<p>${esc(t.hi.replace("{name}", b.name))}</p><p style="font-size:18px"><b>${esc(t.lead)}</b></p>` +
      `<table style="border-collapse:collapse;margin:14px 0">${mailRow(t.car, b.car)}${mailRow(t.pickup, b.pickup)}${mailRow(t.oldEnd, `${dmy(e.oldEndDate)} ${e.oldEndTime}`)}${mailRow(t.newEnd, `${dmy(e.newEndDate)} ${e.newEndTime}`)}${mailRow(t.added, eurTxt(e.addedCents))}${e.newTotalCents != null ? mailRow(t.total, eurTxt(e.newTotalCents)) : ""}</table>` +
      `<p>${esc(t.info)}</p><p>${esc(t.q.replace("{phone}", PHONE))}</p>` + mailFooter(t.why),
  );
  return { subject: `${t.subj} (№ ${ref})`, html, preheader: `${t.lead} ${b.car}` };
}
