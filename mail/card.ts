// Текстове и писма за плащане с карта онлайн (БОРИКА). Три езика като останалите писма (bg / en / de).
// Писмото след плащане е ПОТВЪРЖДЕНИЕ ЗА ПЛАЩАНЕ – не е фактура, касов бон или банков документ.
// Не съдържа нови условия за анулиране или възстановяване.
import type { bookings, cardPayments } from "../db/schema.js";
import { btn, esc, mailFooter, OWNER_EMAIL, PHONE, wrapMail } from "./index.js";

type Booking = typeof bookings.$inferSelect;
type Attempt = typeof cardPayments.$inferSelect;
export type Lang = "bg" | "en" | "de";
export const langOf = (l: string): Lang => (l === "en" || l === "de" ? l : "bg");

// Разбивка на сумата за плащане с карта (server/card-pay.ts → breakdown)
export type ExtraLine = { code: string; cents: number; qty?: number; unitCents?: number; km?: number; rate?: number; country?: string };
export type Breakdown = {
  days: number; unitCents: number; rentCents: number;
  renty10Cents: number; // вече приложена отстъпка RENTY10 (положително число; 0 – няма)
  cardPctCents: number; // 10% от наема
  cardDiscountCents: number; // реално приложената отстъпка за карта (не се комбинира с RENTY10)
  extras: ExtraLine[]; extrasCents: number;
  totalBeforeCents: number; // сумата по резервацията преди отстъпката за карта
  payCents: number; depositCents: number; currency: string;
};

const money = (c: number, cur = "EUR") => (c / 100).toFixed(2).replace(".", ",") + (cur === "EUR" ? " €" : " " + cur);
// Депозитът – като на сайта и в останалите писма („100 €“)
const whole = (c: number) => (c % 100 ? money(c) : `${c / 100} €`);

export const CT: Record<Lang, Record<string, string>> = {
  bg: {
    title: "Плащане с карта онлайн", hi: "Здравейте, {name}!", booking: "Резервация", car: "Автомобил", pickup: "Получаване", dropoff: "Връщане",
    rent: "Наем: {days} × {unit}", day: "ден", days: "дни", renty10: "Отстъпка RENTY10 (10% от наема)", card: "Отстъпка за плащане с карта (10% от наема)",
    cardNone: "не се добавя – вече е приложена RENTY10 (10%); отстъпките не се комбинират, прилага се по-голямата",
    seats: "Детско столче", chains: "Вериги за сняг", second_driver: "Втори (допълнителен) водач", delivery: "Доставка до адрес", return: "Връщане от адрес", abroad: "Пътуване в чужбина",
    noDisc: "без отстъпка", totalBefore: "Сума по резервацията", pay: "Сума за плащане с карта", paid: "Платена сума", currency: "Валута",
    deposit: "Гаранционният депозит от {dep} не е включен в онлайн плащането. Той е възвръщаем и се предоставя отделно при получаване на автомобила.",
    linkSubj: "Връзка за плащане с карта – 10% отстъпка от наема", linkIntro: "Резервацията ви е потвърдена. Можете да платите целия наем онлайн с карта с 10% отстъпка от наема (доставката и допълнителните услуги са без отстъпка).",
    linkBtn: "Плащане с карта", linkValid: "Връзката е само за тази резервация и важи до {until} (българско време), но не след часа за получаване на автомобила.",
    linkSafe: "Данните на картата се въвеждат само на защитената страница на БОРИКА – не ги изпращайте по имейл или телефон.",
    paidSubj: "Потвърждение за плащане с карта", paidIntro: "Получихме вашето плащане с карта. Благодарим!",
    tranDate: "Дата и час на трансакцията", tranRef: "Референция на трансакцията (RRN)", approval: "Код за одобрение", order: "Номер на поръчката (ORDER)",
    notInvoice: "Това писмо потвърждава получено плащане. То не е фактура, касов бон или банков документ.",
    contacts: "Контакти", q: "Въпроси? Обадете ни се на {phone} или пишете на {email}.",
    why: "Получавате това писмо във връзка с вашата резервация на rentacar-ptb.com.",
    // Страницата за плащане
    payBtn: "Плати {amount} с карта", cardholder: "Име на картодържателя (на латиница, както е на картата)", bill: "Адрес на картодържателя (до 50 знака)",
    goBank: "Пренасочваме ви към защитената страница на БОРИКА…", goBankBtn: "Продължи към плащането", noScript: "Ако не бъдете пренасочени автоматично, натиснете бутона.",
    unavail: "Плащането с карта в момента не е достъпно.", unavailInfo: "Не сте таксувани. Свържете се с нас на {phone} – резервацията ви остава потвърдена.",
    invalid: "Връзката за плащане е невалидна или изтекла.", invalidInfo: "Не сте таксувани. Свържете се с нас на {phone}, за да получите нова връзка.",
    isPaid: "Плащането вече е получено.", inProgress: "Има започнато плащане за тази резервация.",
    inProgressInfo: "Ако страницата на банката е още отворена, завършете плащането там. Ако сте я затворили, проверяваме резултата в банковата система. Нов опит е възможен едва след като банката потвърди, че предишното плащане не е завършено – така избягваме двойно плащане. При въпроси: {phone}.",
    check: "Провери отново", review: "Резултатът от предишно плащане не може да бъде потвърден автоматично.", reviewInfo: "Не плащайте отново. Свържете се с нас на {phone} – ще проверим плащането в системата на банката.",
    blocked: "Плащането с карта не е възможно за тази резервация.", blockedInfo: "Свържете се с нас на {phone}.",
    cancelH: "Плащането е прекъснато – нищо не е платено.", cancelInfo: "Ако страницата на банката е още отворена, можете да продължите плащането там. Банката потвърждава окончателния резултат 16 минути след началото на плащането – след {until} (българско време) ще можете да опитате отново от същата връзка. До тогава не започваме второ плащане, за да няма двойно таксуване.",
    okH: "Плащането е успешно.", okInfo: "Ще получите потвърждение по имейл.", declinedH: "Плащането е отказано.", declinedInfo: "Сумата не е платена. Можете да опитате отново от връзката в имейла или с друга карта.",
    pendingH: "Резултатът от плащането още не е потвърден.", pendingInfo: "Проверяваме го в банковата система. Не плащайте отново – при успешно плащане ще получите имейл. Ако не получите имейл до 30 минути, свържете се с нас на {phone}.",
    unknownH: "Не можем да потвърдим това плащане.", unknownInfo: "Ако сумата е удържана от картата ви, свържете се с нас на {phone} – ще проверим плащането в системата на банката.",
    bankInfo: "Съобщение от банката", inputErr: "Попълнете името на латиница (2–45 знака) и адрес (до 50 знака).", back: "Към страницата на резервацията",
    test: "ТЕСТОВА СРЕДА – използвайте само тестови карти на БОРИКА. Реални плащания не се извършват.",
  },
  en: {
    title: "Online card payment", hi: "Hello {name},", booking: "Booking", car: "Car", pickup: "Pick-up", dropoff: "Return",
    rent: "Rental: {days} × {unit}", day: "day", days: "days", renty10: "RENTY10 discount (10% of the rental)", card: "Card payment discount (10% of the rental)",
    cardNone: "not added – RENTY10 (10%) is already applied; discounts are not combined, the higher one applies",
    seats: "Child seat", chains: "Snow chains", second_driver: "Second (additional) driver", delivery: "Delivery to address", return: "Collection from address", abroad: "Travel abroad",
    noDisc: "no discount", totalBefore: "Booking amount", pay: "Amount to pay by card", paid: "Amount paid", currency: "Currency",
    deposit: "The security deposit of {dep} is not included in the online payment. It is refundable and is provided separately when you pick up the car.",
    linkSubj: "Card payment link – 10% off the rental", linkIntro: "Your booking is confirmed. You can pay the full rental online by card with 10% off the rental (delivery and additional services are not discounted).",
    linkBtn: "Pay by card", linkValid: "The link is only for this booking and is valid until {until} (Bulgarian time), but not after the pick-up time.",
    linkSafe: "Card details are entered only on the secure BORICA page – never send them by email or phone.",
    paidSubj: "Card payment confirmation", paidIntro: "We have received your card payment. Thank you!",
    tranDate: "Transaction date and time", tranRef: "Transaction reference (RRN)", approval: "Approval code", order: "Order number (ORDER)",
    notInvoice: "This email confirms a received payment. It is not an invoice, fiscal receipt or bank document.",
    contacts: "Contacts", q: "Questions? Call us on {phone} or write to {email}.",
    why: "You are receiving this email in connection with your booking on rentacar-ptb.com.",
    payBtn: "Pay {amount} by card", cardholder: "Cardholder name (Latin letters, as on the card)", bill: "Cardholder address (up to 50 characters)",
    goBank: "Redirecting you to the secure BORICA page…", goBankBtn: "Continue to payment", noScript: "If you are not redirected automatically, press the button.",
    unavail: "Card payment is currently not available.", unavailInfo: "You have not been charged. Please contact us on {phone} – your booking remains confirmed.",
    invalid: "The payment link is invalid or has expired.", invalidInfo: "You have not been charged. Please contact us on {phone} to receive a new link.",
    isPaid: "The payment has already been received.", inProgress: "A payment for this booking has already been started.",
    inProgressInfo: "If the bank page is still open, please complete the payment there. If you closed it, we are checking the result in the bank system. A new attempt is possible only after the bank confirms that the previous payment was not completed – this prevents a double payment. Questions: {phone}.",
    check: "Check again", review: "The result of a previous payment cannot be confirmed automatically.", reviewInfo: "Please do not pay again. Contact us on {phone} – we will check the payment in the bank system.",
    blocked: "Card payment is not possible for this booking.", blockedInfo: "Please contact us on {phone}.",
    cancelH: "The payment was interrupted – nothing has been paid.", cancelInfo: "If the bank page is still open, you can continue the payment there. The bank confirms the final result 16 minutes after the payment started – after {until} (Bulgarian time) you can try again from the same link. Until then we do not start a second payment, to avoid a double charge.",
    okH: "The payment was successful.", okInfo: "You will receive a confirmation by email.", declinedH: "The payment was declined.", declinedInfo: "The amount has not been paid. You can try again from the link in the email or with another card.",
    pendingH: "The payment result is not confirmed yet.", pendingInfo: "We are checking it in the bank system. Please do not pay again – you will receive an email if the payment succeeded. If you receive no email within 30 minutes, contact us on {phone}.",
    unknownH: "We cannot confirm this payment.", unknownInfo: "If the amount was taken from your card, please contact us on {phone} – we will check the payment in the bank system.",
    bankInfo: "Message from the bank", inputErr: "Enter the name in Latin letters (2–45 characters) and an address (up to 50 characters).", back: "Back to the booking page",
    test: "TEST ENVIRONMENT – use BORICA test cards only. No real payments are made.",
  },
  de: {
    title: "Online-Kartenzahlung", hi: "Hallo {name},", booking: "Buchung", car: "Fahrzeug", pickup: "Abholung", dropoff: "Rückgabe",
    rent: "Miete: {days} × {unit}", day: "Tag", days: "Tage", renty10: "Rabatt RENTY10 (10 % der Miete)", card: "Rabatt für Kartenzahlung (10 % der Miete)",
    cardNone: "wird nicht hinzugefügt – RENTY10 (10 %) ist bereits angewendet; Rabatte werden nicht kombiniert, es gilt der höhere",
    seats: "Kindersitz", chains: "Schneeketten", second_driver: "Zweiter (zusätzlicher) Fahrer", delivery: "Lieferung an Adresse", return: "Abholung von Adresse", abroad: "Auslandsfahrt",
    noDisc: "ohne Rabatt", totalBefore: "Buchungsbetrag", pay: "Betrag für die Kartenzahlung", paid: "Bezahlter Betrag", currency: "Währung",
    deposit: "Die Kaution von {dep} ist nicht in der Online-Zahlung enthalten. Sie ist erstattungsfähig und wird separat bei der Abholung des Fahrzeugs hinterlegt.",
    linkSubj: "Link zur Kartenzahlung – 10 % Rabatt auf die Miete", linkIntro: "Ihre Buchung ist bestätigt. Sie können die gesamte Miete online per Karte mit 10 % Rabatt auf die Miete bezahlen (Lieferung und Zusatzleistungen sind nicht rabattiert).",
    linkBtn: "Mit Karte bezahlen", linkValid: "Der Link gilt nur für diese Buchung und bis {until} (bulgarische Zeit), jedoch nicht nach der Abholzeit.",
    linkSafe: "Kartendaten werden nur auf der sicheren BORICA-Seite eingegeben – senden Sie sie niemals per E-Mail oder Telefon.",
    paidSubj: "Bestätigung der Kartenzahlung", paidIntro: "Wir haben Ihre Kartenzahlung erhalten. Vielen Dank!",
    tranDate: "Datum und Uhrzeit der Transaktion", tranRef: "Transaktionsreferenz (RRN)", approval: "Genehmigungscode", order: "Auftragsnummer (ORDER)",
    notInvoice: "Diese E-Mail bestätigt eine erhaltene Zahlung. Sie ist keine Rechnung, kein Kassenbon und kein Bankdokument.",
    contacts: "Kontakt", q: "Fragen? Rufen Sie uns an unter {phone} oder schreiben Sie an {email}.",
    why: "Sie erhalten diese E-Mail im Zusammenhang mit Ihrer Buchung auf rentacar-ptb.com.",
    payBtn: "{amount} mit Karte bezahlen", cardholder: "Name des Karteninhabers (lateinische Buchstaben, wie auf der Karte)", bill: "Adresse des Karteninhabers (bis 50 Zeichen)",
    goBank: "Sie werden zur sicheren BORICA-Seite weitergeleitet…", goBankBtn: "Weiter zur Zahlung", noScript: "Falls Sie nicht automatisch weitergeleitet werden, drücken Sie die Schaltfläche.",
    unavail: "Die Kartenzahlung ist derzeit nicht verfügbar.", unavailInfo: "Ihnen wurde nichts belastet. Bitte kontaktieren Sie uns unter {phone} – Ihre Buchung bleibt bestätigt.",
    invalid: "Der Zahlungslink ist ungültig oder abgelaufen.", invalidInfo: "Ihnen wurde nichts belastet. Kontaktieren Sie uns unter {phone}, um einen neuen Link zu erhalten.",
    isPaid: "Die Zahlung ist bereits eingegangen.", inProgress: "Für diese Buchung wurde bereits eine Zahlung begonnen.",
    inProgressInfo: "Ist die Bankseite noch geöffnet, schließen Sie die Zahlung dort ab. Haben Sie sie geschlossen, prüfen wir das Ergebnis im Banksystem. Ein neuer Versuch ist erst möglich, wenn die Bank bestätigt, dass die vorherige Zahlung nicht abgeschlossen wurde – so wird eine Doppelzahlung vermieden. Fragen: {phone}.",
    check: "Erneut prüfen", review: "Das Ergebnis einer früheren Zahlung kann nicht automatisch bestätigt werden.", reviewInfo: "Bitte nicht erneut bezahlen. Kontaktieren Sie uns unter {phone} – wir prüfen die Zahlung im Banksystem.",
    blocked: "Für diese Buchung ist keine Kartenzahlung möglich.", blockedInfo: "Bitte kontaktieren Sie uns unter {phone}.",
    cancelH: "Die Zahlung wurde abgebrochen – es wurde nichts bezahlt.", cancelInfo: "Ist die Bankseite noch geöffnet, können Sie die Zahlung dort fortsetzen. Die Bank bestätigt das endgültige Ergebnis 16 Minuten nach Beginn der Zahlung – ab {until} (bulgarische Zeit) können Sie es über denselben Link erneut versuchen. Bis dahin starten wir keine zweite Zahlung, um eine Doppelbelastung zu vermeiden.",
    okH: "Die Zahlung war erfolgreich.", okInfo: "Sie erhalten eine Bestätigung per E-Mail.", declinedH: "Die Zahlung wurde abgelehnt.", declinedInfo: "Der Betrag wurde nicht bezahlt. Sie können es über den Link in der E-Mail oder mit einer anderen Karte erneut versuchen.",
    pendingH: "Das Zahlungsergebnis ist noch nicht bestätigt.", pendingInfo: "Wir prüfen es im Banksystem. Bitte nicht erneut bezahlen – bei erfolgreicher Zahlung erhalten Sie eine E-Mail. Falls innerhalb von 30 Minuten keine E-Mail kommt, kontaktieren Sie uns unter {phone}.",
    unknownH: "Wir können diese Zahlung nicht bestätigen.", unknownInfo: "Falls der Betrag von Ihrer Karte abgebucht wurde, kontaktieren Sie uns unter {phone} – wir prüfen die Zahlung im Banksystem.",
    bankInfo: "Nachricht der Bank", inputErr: "Geben Sie den Namen in lateinischen Buchstaben (2–45 Zeichen) und eine Adresse (bis 50 Zeichen) ein.", back: "Zur Buchungsseite",
    test: "TESTUMGEBUNG – nur BORICA-Testkarten verwenden. Es werden keine echten Zahlungen ausgeführt.",
  },
};
export const ct = (lang: string, k: string, v: Record<string, string> = {}) =>
  Object.entries(v).reduce((s, [a, b]) => s.split(`{${a}}`).join(b), CT[langOf(lang)][k] ?? CT.bg[k] ?? k);

// Редовете на разбивката: [етикет, сума, бележка]
export function breakdownRows(bd: Breakdown, lang: string): [string, string, string][] {
  const t = (k: string, v?: Record<string, string>) => ct(lang, k, v);
  const cur = bd.currency;
  const rows: [string, string, string][] = [[t("rent", { days: `${bd.days} ${bd.days === 1 ? t("day") : t("days")}`, unit: money(bd.unitCents, cur) }), money(bd.rentCents, cur), ""]];
  if (bd.renty10Cents) rows.push([t("renty10"), "−" + money(bd.renty10Cents, cur), ""]);
  rows.push(bd.cardDiscountCents ? [t("card"), "−" + money(bd.cardDiscountCents, cur), ""] : [t("card"), money(0, cur), t("cardNone")]);
  for (const l of bd.extras) {
    const label = t(l.code) + (l.code === "delivery" || l.code === "return" ? ` (${String(l.km).replace(".", ",")} km)` : l.code === "seats" && bd.days ? ` × ${(l.qty || 0) / bd.days}` : l.country ? ` – ${l.country.toUpperCase()}` : "");
    rows.push([label, money(l.cents, cur), t("noDisc")]);
  }
  rows.push([t("pay"), money(bd.payCents, cur), ""]);
  return rows;
}
const table = (rows: [string, string, string][]) =>
  `<table style="border-collapse:collapse;margin:14px 0;width:100%">${rows
    .map(([k, v, n], i) => `<tr${i === rows.length - 1 ? ' style="font-size:17px"' : ""}><td style="padding:5px 14px 5px 0;color:#5b6577;border-bottom:1px solid #e6e9ef">${esc(k)}${n ? `<br><small>${esc(n)}</small>` : ""}</td><td style="padding:5px 0;text-align:right;white-space:nowrap;border-bottom:1px solid #e6e9ef"><b>${esc(v)}</b></td></tr>`)
    .join("")}</table>`;
const kvTable = (rows: [string, string][]) =>
  `<table style="border-collapse:collapse;margin:14px 0">${rows.filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#5b6577">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join("")}</table>`;
export const refOf = (id: string) => id.slice(0, 6).toUpperCase();
const sofia = (d: Date, lang: string) => d.toLocaleString(langOf(lang) === "bg" ? "bg-BG" : langOf(lang) === "de" ? "de-DE" : "en-GB", { timeZone: "Europe/Sofia", dateStyle: "short", timeStyle: "short" });
// TRAN_DATE от БОРИКА: YYYYMMDDHHMMSS (както е подаден от банковия сървър)
export const tranDateText = (s: string | null) => (s && /^\d{14}$/.test(s) ? `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}` : "");
const bookingRows = (b: Booking, lang: string): [string, string][] => [[ct(lang, "booking"), "№ " + refOf(b.id)], [ct(lang, "car"), b.car], [ct(lang, "pickup"), b.pickup], [ct(lang, "dropoff"), b.dropoff]];
const contacts = (lang: string) => `<p>${esc(ct(lang, "q", { phone: PHONE, email: OWNER_EMAIL }))}</p>`;

export function linkMail(b: Booking, url: string, bd: Breakdown, expiresAt: Date) {
  const l = b.lang;
  const html = wrapMail(
    `<p>${esc(ct(l, "hi", { name: b.name }))}</p><p style="font-size:17px"><b>${esc(ct(l, "linkIntro"))}</b></p>` +
      kvTable(bookingRows(b, l)) + table(breakdownRows(bd, l)) +
      `<p>${esc(ct(l, "deposit", { dep: whole(bd.depositCents) }))}</p>` +
      `<p>${btn(url, ct(l, "linkBtn"), "#1a8f4c")}</p><p style="color:#5b6577;font-size:13px">${esc(ct(l, "linkValid", { until: sofia(expiresAt, l) }))} ${esc(ct(l, "linkSafe"))}</p>` +
      contacts(l) + mailFooter(ct(l, "why")),
  );
  return { subject: `${ct(l, "linkSubj")} (№ ${refOf(b.id)})`, html, preheader: `${ct(l, "pay")}: ${money(bd.payCents, bd.currency)}` };
}

function paidBody(b: Booking, a: Attempt, l: string, paidAt: Date) {
  const bd = a.breakdown as Breakdown;
  return (
    kvTable(bookingRows(b, l)) + table(breakdownRows(bd, l)) +
    kvTable([
      [ct(l, "paid"), money(a.amountCents, a.currency)], [ct(l, "currency"), a.currency],
      [ct(l, "tranDate"), tranDateText(a.tranDate) || sofia(paidAt, l)], [ct(l, "tranRef"), a.rrn || ""], [ct(l, "approval"), a.approval || ""], [ct(l, "order"), a.orderNo],
    ]) +
    `<p>${esc(ct(l, "deposit", { dep: whole(bd.depositCents) }))}</p>`
  );
}
// Потвърждение до клиента – само след проверено успешно плащане
export function paidMail(b: Booking, a: Attempt, paidAt: Date) {
  const l = b.lang;
  const html = wrapMail(
    `<p>${esc(ct(l, "hi", { name: b.name }))}</p><p style="font-size:18px"><b>${esc(ct(l, "paidIntro"))}</b></p>` + paidBody(b, a, l, paidAt) +
      `<p style="background:#f3f5f9;padding:12px;border-radius:12px">${esc(ct(l, "notInvoice"))}</p>` + contacts(l) + mailFooter(ct(l, "why")),
  );
  return { subject: `${ct(l, "paidSubj")} (№ ${refOf(b.id)})`, html, preheader: `${ct(l, "paid")}: ${money(a.amountCents, a.currency)}` };
}

// Известие до собственика (на български)
export function ownerPaidMail(b: Booking, a: Attempt, paidAt: Date, origin: string) {
  const dup = a.duplicate;
  const html = wrapMail(
    `<p style="font-size:17px"><b>${dup ? "ВНИМАНИЕ: второ успешно плащане с карта за резервация, която вече е платена." : "Получено плащане с карта онлайн (БОРИКА) – проверен подпис на банката."}</b></p>` +
      (dup ? `<p>Клиентът е платил повторно. Проверете в Merchant Portal и при нужда направете отмяна или възстановяване на второто плащане чрез банката.</p>` : "") +
      kvTable([["Клиент", b.name], ["Имейл", b.email], ["Телефон", b.phone], ["Среда", a.mode === "live" ? "реална (продукционен терминал)" : "ТЕСТОВА (тестов терминал – не е реално плащане)"], ["Терминал", a.terminal], ["INT_REF", a.intRef || ""], ["Карта", a.cardBrand || ""]]) +
      paidBody(b, a, "bg", paidAt) + `<p>${btn(`${origin}/admin/bookings/${b.id}`, "Отвори в админ панела", "#0f1b2d")}</p>` +
      `<p style="color:#5b6577;font-size:13px">Плащането е записано в „Плащания“ на резервацията. Писмото до клиента е потвърждение за плащане – не е фактура или касов бон.</p>`,
  );
  return { subject: `${dup ? "[ДВОЙНО ПЛАЩАНЕ] " : ""}${a.mode === "live" ? "" : "[ТЕСТ] "}Платено с карта: ${money(a.amountCents, a.currency)} – ${b.car} – ${b.name} (№ ${refOf(b.id)})`, html };
}

// Известие до собственика: резултатът от плащането не може да бъде установен автоматично
export function ownerUnknownMail(b: Booking, a: Attempt, origin: string, why: "final_code" | "no_result_24h" = "no_result_24h") {
  const reason = why === "final_code"
    ? `проверката за статус след 16 минути върна ACTION ${esc(a.action ?? "-")}, RC ${esc(a.rc ?? "-")}${a.statusMsg ? ` (${esc(a.statusMsg)})` : ""} – код, за който документацията на БОРИКА не посочва, че плащането е неуспешно`
    : "не е получен проверен отговор от БОРИКА в рамките на 24 часа";
  const html = wrapMail(
    `<p style="font-size:17px"><b>Плащане с карта без потвърден резултат.</b></p><p>За поръчка ORDER ${esc(a.orderNo)} (терминал ${esc(a.terminal)}) ${reason}. Проверете трансакцията в Merchant Portal (Authentications → Order ID). Резервацията НЕ е отбелязана като платена, а клиентът не може да плати повторно, докато не проверите. Ако в Merchant Portal трансакцията не е успешна, освободете опита от админ панела; ако е успешна, запишете плащането ръчно в „Плащания“.</p>` +
      kvTable([["Клиент", b.name], ["Имейл", b.email], ["Телефон", b.phone], ["Сума", money(a.amountCents, a.currency)]]) + `<p>${btn(`${origin}/admin/bookings/${b.id}`, "Отвори в админ панела", "#0f1b2d")}</p>`,
  );
  return { subject: `Неизвестен резултат от плащане с карта – ${b.name} (№ ${refOf(b.id)})`, html };
}
