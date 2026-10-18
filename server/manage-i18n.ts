// Превод на страницата за управление на резервация (/api/bookings/:id/manage) на английски и немски.
// Страницата се генерира на български; за ?lang=en|de готовият HTML се превежда по речника по-долу:
//   – дълги изречения (12+ знака) се заменят навсякъде в страницата (вкл. placeholder и текста на confirm());
//   – кратки етикети – само когато съставляват целия текст на елемента (за да не се променят данните на клиента);
//   – няколко изречения с дати и адреси – с правила (RULES).
// Данните на клиента и резервацията (имена, адреси, суми) не се превеждат.
export const LANGS = ["bg", "en", "de"] as const;
export type Lang = (typeof LANGS)[number];

const D: Record<string, [string, string]> = {
  "Управлявай резервацията в админ панела": ["Manage the booking in the admin panel", "Buchung im Adminbereich verwalten"],
  "— отмяна, промяна на часовете и документи (след вход).": ["— cancellation, time changes and documents (sign-in required).", "— Stornierung, Uhrzeitänderungen und Dokumente (Anmeldung erforderlich)."],
  // Заглавия и етикети
  "Резервация": ["Booking", "Buchung"],
  "Резервация – ": ["Booking – ", "Buchung – "],
  "Потвърждение – ": ["Confirmation – ", "Bestätigung – "],
  "Потвърдете действието": ["Confirm the action", "Aktion bestätigen"],
  "Клиент": ["Customer", "Kunde"], "Телефон": ["Phone", "Telefon"], "Имейл": ["Email", "E-Mail"], "Автомобил": ["Car", "Fahrzeug"],
  "Получаване": ["Pick-up", "Abholung"], "Връщане": ["Return", "Rückgabe"], "Общо": ["Total", "Gesamt"], "Плащане": ["Payment", "Zahlung"],
  "Данни за фактура": ["Invoice details", "Rechnungsdaten"], "Причина": ["Reason", "Grund"], "Кога": ["When", "Wann"], "От": ["By", "Durch"],
  "Вътрешна бележка": ["Internal note", "Interne Notiz"], "Статус": ["Status", "Status"],
  // Статуси и причини
  "Очаква потвърждение": ["Awaiting confirmation", "Wartet auf Bestätigung"], "Потвърдена": ["Confirmed", "Bestätigt"], "Отказана": ["Rejected", "Abgelehnt"],
  "Отменена": ["Cancelled", "Storniert"], "Неявяване": ["No-show", "Nicht erschienen"],
  "Клиентът се отказа": ["Customer cancelled", "Kunde hat storniert"], "Отмяна от собственика": ["Cancelled by the owner", "Storno durch den Vermieter"],
  "Друга причина": ["Other reason", "Anderer Grund"], "Клиентът не се яви": ["Customer did not show up", "Kunde nicht erschienen"],
  "собственик (линк от имейла)": ["owner (email link)", "Vermieter (E-Mail-Link)"],
  // Плащане
  "По банков път – физическо лице (фактура)": ["Bank transfer – private person (invoice)", "Banküberweisung – Privatperson (Rechnung)"],
  "По банков път – фирма (фактура)": ["Bank transfer – company (invoice)", "Banküberweisung – Firma (Rechnung)"],
  "В брой на място с касов бон": ["Cash on site with fiscal receipt", "Bar vor Ort mit Kassenbon"],
  // Чакаща заявка
  "Съобщение до клиента (по избор)": ["Message to the customer (optional)", "Nachricht an den Kunden (optional)"],
  "Напр. час и място за среща или причина за отказ": ["E.g. meeting time and place or reason for rejection", "Z. B. Treffpunkt und Uhrzeit oder Grund der Ablehnung"],
  "✓ Потвърди резервацията": ["✓ Confirm booking", "✓ Buchung bestätigen"],
  "✕ Откажи резервацията": ["✕ Reject booking", "✕ Buchung ablehnen"],
  "Сигурни ли сте, че искате да откажете резервацията?": ["Are you sure you want to reject the booking?", "Möchten Sie die Buchung wirklich ablehnen?"],
  "📄 Изтегли попълнения договор за наем": ["📄 Download the filled-in rental contract", "📄 Ausgefüllten Mietvertrag herunterladen"],
  "Внимание: автомобилът вече е потвърден за ": ["Warning: the car is already confirmed for ", "Achtung: Das Fahrzeug ist bereits bestätigt für "],
  ". Тази заявка не може да бъде потвърдена за същите дати.": [". This request cannot be confirmed for the same dates.", ". Diese Anfrage kann für dieselben Termine nicht bestätigt werden."],
  // Отмяна, неявяване, предаване
  "Резервацията е отменена": ["The booking has been cancelled", "Die Buchung wurde storniert"],
  "Автомобилът е освободен. Записът остава в историята.": ["The car has been released. The record stays in the history.", "Das Fahrzeug ist freigegeben. Der Eintrag bleibt in der Historie."],
  "Автомобилът е предаден": ["The car has been handed over", "Das Fahrzeug wurde übergeben"],
  ". Наемът е започнал – отмяна и „Клиентът не се яви“ не са възможни. Приключването или прекратяването на започнал наем се урежда отделно.": [
    ". The rental has started – cancellation and “Customer did not show up” are not possible. Ending or terminating a started rental is handled separately.",
    ". Die Miete hat begonnen – Stornierung und „Kunde nicht erschienen“ sind nicht möglich. Das Beenden oder Abbrechen einer begonnenen Miete wird separat geregelt."],
  "Отмяна на резервацията": ["Cancel the booking", "Buchung stornieren"],
  "Възможна веднага, включително дни преди получаването, докато автомобилът не е предаден. Не се извършват плащания или възстановявания.": [
    "Possible immediately, including days before pick-up, as long as the car has not been handed over. No payments or refunds are made.",
    "Sofort möglich, auch Tage vor der Abholung, solange das Fahrzeug nicht übergeben wurde. Es werden keine Zahlungen oder Erstattungen durchgeführt."],
  "Вътрешна бележка (по избор, не се изпраща на клиента)": ["Internal note (optional, not sent to the customer)", "Interne Notiz (optional, wird nicht an den Kunden gesendet)"],
  "Изпрати имейл на клиента": ["Send an email to the customer", "E-Mail an den Kunden senden"],
  "Отмени резервацията": ["Cancel booking", "Buchung stornieren"],
  "Достъпно след часа за получаване: ": ["Available after the pick-up time: ", "Verfügbar nach der Abholzeit: "],
  " (време в България).": [" (Bulgarian time).", " (bulgarische Zeit)."],
  "Предаване на автомобила": ["Car handover", "Fahrzeugübergabe"],
  "Отбележете, когато клиентът получи автомобила. След това отмяна и неявяване няма да са възможни.": [
    "Mark this when the customer receives the car. After that, cancellation and no-show will no longer be possible.",
    "Markieren Sie dies, wenn der Kunde das Fahrzeug erhält. Danach sind Stornierung und Nichterscheinen nicht mehr möglich."],
  // Потвърждение на действието
  "Да отменим ли резервацията? Автомобилът ще бъде освободен за нови резервации.": [
    "Cancel the booking? The car will be released for new bookings.", "Buchung stornieren? Das Fahrzeug wird für neue Buchungen freigegeben."],
  "Да отбележим ли, че клиентът не се яви? Резервацията ще бъде закрита и автомобилът ще бъде освободен за нови резервации.": [
    "Mark that the customer did not show up? The booking will be closed and the car released for new bookings.",
    "Vermerken, dass der Kunde nicht erschienen ist? Die Buchung wird geschlossen und das Fahrzeug für neue Buchungen freigegeben."],
  "Да отбележим ли, че автомобилът е предаден на клиента? След това отмяна и „Клиентът не се яви“ няма да са възможни.": [
    "Mark the car as handed over to the customer? After that, cancellation and “Customer did not show up” will not be possible.",
    "Das Fahrzeug als an den Kunden übergeben markieren? Danach sind Stornierung und „Kunde nicht erschienen“ nicht mehr möglich."],
  "Да, отмени резервацията": ["Yes, cancel the booking", "Ja, Buchung stornieren"],
  "Да, клиентът не се яви": ["Yes, the customer did not show up", "Ja, Kunde nicht erschienen"],
  "Да, автомобилът е предаден": ["Yes, the car has been handed over", "Ja, Fahrzeug übergeben"],
  "Назад, без промяна": ["Back, no change", "Zurück, ohne Änderung"],
  "Ще бъде изпратен имейл до клиента": ["An email will be sent to the customer", "Eine E-Mail wird an den Kunden gesendet"],
  " с номера, автомобила, периода и новия статус. Вътрешната бележка не се изпраща.": [
    " with the booking number, car, period and new status. The internal note is not sent.",
    " mit Buchungsnummer, Fahrzeug, Zeitraum und neuem Status. Die interne Notiz wird nicht gesendet."],
  "Няма да бъде изпратен имейл до клиента.": ["No email will be sent to the customer.", "Es wird keine E-Mail an den Kunden gesendet."],
  // Резултати
  "Резервацията е отменена. Автомобилът е освободен за нови резервации.": ["The booking has been cancelled. The car is released for new bookings.", "Die Buchung wurde storniert. Das Fahrzeug ist für neue Buchungen freigegeben."],
  "Резервацията е закрита като неявяване. Автомобилът е освободен за нови резервации.": ["The booking has been closed as a no-show. The car is released for new bookings.", "Die Buchung wurde als Nichterscheinen geschlossen. Das Fahrzeug ist für neue Buchungen freigegeben."],
  "Отбелязано е, че автомобилът е предаден. Наемът е започнал.": ["The car has been marked as handed over. The rental has started.", "Das Fahrzeug wurde als übergeben markiert. Die Miete hat begonnen."],
  " Клиентът получи имейл.": [" The customer received an email.", " Der Kunde hat eine E-Mail erhalten."],
  " Имейлът до клиента не беше изпратен веднага – ще бъде опитан отново автоматично.": [" The email to the customer was not sent immediately – it will be retried automatically.", " Die E-Mail an den Kunden wurde nicht sofort gesendet – sie wird automatisch erneut versucht."],
  " Не е изпратен имейл до клиента.": [" No email was sent to the customer.", " Es wurde keine E-Mail an den Kunden gesendet."],
  "„Клиентът не се яви“ е достъпно едва след часа за получаване.": ["“Customer did not show up” is only available after the pick-up time.", "„Kunde nicht erschienen“ ist erst nach der Abholzeit verfügbar."],
  "Действието не е възможно при текущия статус на резервацията.": ["This action is not possible with the current booking status.", "Diese Aktion ist beim aktuellen Buchungsstatus nicht möglich."],
  "Изберете причина за отмяната.": ["Choose a reason for the cancellation.", "Wählen Sie einen Grund für die Stornierung."],
  "Формулярът е остарял – статусът междувременно е променен. Проверете и опитайте отново.": ["The form is out of date – the status has changed in the meantime. Please check and try again.", "Das Formular ist veraltet – der Status hat sich inzwischen geändert. Bitte prüfen und erneut versuchen."],
  "Действието вече е изпълнено или не е възможно при текущия статус.": ["The action has already been carried out or is not possible with the current status.", "Die Aktion wurde bereits ausgeführt oder ist beim aktuellen Status nicht möglich."],
  "Резервацията е потвърдена. Клиентът получи имейл.": ["The booking is confirmed. The customer received an email.", "Die Buchung ist bestätigt. Der Kunde hat eine E-Mail erhalten."],
  "Резервацията е отказана. Клиентът получи имейл.": ["The booking was rejected. The customer received an email.", "Die Buchung wurde abgelehnt. Der Kunde hat eine E-Mail erhalten."],
  "Заявката няма записани дати на получаване и връщане и не може да бъде потвърдена. Можете да я откажете и да се свържете с клиента за нова заявка.": [
    "The request has no saved pick-up and return dates and cannot be confirmed. You can reject it and contact the customer for a new request.",
    "Die Anfrage hat keine gespeicherten Abhol- und Rückgabedaten und kann nicht bestätigt werden. Sie können sie ablehnen und den Kunden um eine neue Anfrage bitten.",
  ],
  "Часът за получаване по тази заявка вече е минал и тя не може да бъде потвърдена. Можете да я откажете и да се свържете с клиента за нова заявка.": [
    "The pick-up time of this request has already passed and it cannot be confirmed. You can reject it and contact the customer for a new request.",
    "Die Abholzeit dieser Anfrage ist bereits vorbei, sie kann nicht bestätigt werden. Sie können sie ablehnen und den Kunden um eine neue Anfrage bitten.",
  ],
  "Автомобилът е отбелязан като неактивен и заявката не може да бъде потвърдена.": ["The car is marked as inactive and the request cannot be confirmed.", "Das Fahrzeug ist als inaktiv markiert, die Anfrage kann nicht bestätigt werden."],
  "Тази резервация вече е обработена.": ["This booking has already been processed.", "Diese Buchung wurde bereits bearbeitet."],
  "Резервацията не е потвърдена – датите вече са заети.": ["The booking was not confirmed – the dates are already taken.", "Die Buchung wurde nicht bestätigt – die Termine sind bereits belegt."],
  "Решението е записано и клиентът го вижда на сайта, но имейлът до ": ["The decision is saved and the customer sees it on the site, but the email to ", "Die Entscheidung ist gespeichert und der Kunde sieht sie auf der Website, aber die E-Mail an "],
  " не беше изпратен. Ще опитаме отново автоматично; при нужда се свържете с клиента.": [" was not sent. We will retry automatically; contact the customer if needed.", " wurde nicht gesendet. Wir versuchen es automatisch erneut; kontaktieren Sie bei Bedarf den Kunden."],
  "Решението е записано и клиентът го вижда на сайта. Връзката с пощенската услуга прекъсна и не е сигурно дали имейлът до ": ["The decision is saved and the customer sees it on the site. The connection to the mail service was interrupted and it is unclear whether the email to ", "Die Entscheidung ist gespeichert und der Kunde sieht sie auf der Website. Die Verbindung zum Maildienst wurde unterbrochen; es ist unklar, ob die E-Mail an "],
  " е изпратен – няма да бъде изпратен повторно автоматично; при нужда се свържете с клиента.": [" was sent – it will not be resent automatically; contact the customer if needed.", " gesendet wurde – sie wird nicht automatisch erneut gesendet; kontaktieren Sie bei Bedarf den Kunden."],
  // Договор и километри
  "Данните на договора не са намерени.": ["The contract data was not found.", "Die Vertragsdaten wurden nicht gefunden."],
  "Договорът не можа да бъде обновен. Опитайте отново.": ["The contract could not be updated. Please try again.", "Der Vertrag konnte nicht aktualisiert werden. Bitte erneut versuchen."],
  "Километрите са записани – изтеглете договора отново.": ["The kilometres are saved – download the contract again.", "Die Kilometer sind gespeichert – laden Sie den Vertrag erneut herunter."],
  "Километри в договора": ["Kilometres in the contract", "Kilometer im Vertrag"],
  " (по пътен маршрут от бул. Дунав 10; 1,00 EUR/км в Пловдив, околните села, летище Пловдив и Асеновград, 0,70 EUR/км извън тях). Ако разстоянието в Google Maps или зоната са различни, поправете ги тук – договорът се попълва наново.": [
    " (by road from bul. Dunav 10; 1.00 EUR/km in Plovdiv, the nearby villages, Plovdiv Airport and Asenovgrad, 0.70 EUR/km elsewhere). If the distance in Google Maps or the zone differ, correct them here – the contract is filled in again.",
    " (Straßenroute ab bul. Dunav 10; 1,00 EUR/km in Plowdiw, den umliegenden Dörfern, am Flughafen Plowdiw und in Asenowgrad, 0,70 EUR/km außerhalb). Weichen Entfernung in Google Maps oder Zone ab, korrigieren Sie sie hier – der Vertrag wird neu ausgefüllt."],
  "Запази километрите и обнови договора": ["Save kilometres and update the contract", "Kilometer speichern und Vertrag aktualisieren"],
  "1,00 EUR/км – Пловдив и района": ["1.00 EUR/km – Plovdiv and area", "1,00 EUR/km – Plowdiw und Umgebung"],
  "0,70 EUR/км – извън Пловдив и района": ["0.70 EUR/km – outside Plovdiv and area", "0,70 EUR/km – außerhalb von Plowdiw und Umgebung"],
  "Цена на км": ["Price per km", "Preis pro km"],
  // Изтекъл линк и липсващи записи
  "Линкът е изтекъл": ["The link has expired", "Der Link ist abgelaufen"],
  "Линкът за управление от имейла важи до 30 дни след края на наема. Управлявайте резервацията след вход в админ панела.": [
    "The management link in the email is valid until 30 days after the end of the rental. Manage the booking after signing in to the admin panel.",
    "Der Verwaltungslink aus der E-Mail gilt bis 30 Tage nach Mietende. Verwalten Sie die Buchung nach der Anmeldung im Admin-Bereich."],
  "Към админ панела": ["To the admin panel", "Zum Admin-Bereich"],
  "Резервацията не е намерена": ["Booking not found", "Buchung nicht gefunden"],
  "Не е намерена": ["Not found", "Nicht gefunden"],
};

// Изречения с дати, имена и адреси между фиксираните части
const RULES: [RegExp, string, string][] = [
  [/(\d{1,2}:\d{2}(?::\d{2})?) ч\./g, "$1", "$1"],
  [/Внимание: автомобилът е блокиран за периода ([\d-]+) – ([\d-]+)/g, "Warning: the car is blocked for the period $1 – $2", "Achtung: Das Fahrzeug ist im Zeitraum $1 – $2 gesperrt"],
  [/Решението е взето на ([^<]*?)\. Клиентът вижда статуса на сайта\./g, "The decision was made on $1. The customer sees the status on the site.", "Die Entscheidung wurde am $1 getroffen. Der Kunde sieht den Status auf der Website."],
  [/Решението е взето\. Клиентът вижда статуса на сайта\./g, "The decision has been made. The customer sees the status on the site.", "Die Entscheidung wurde getroffen. Der Kunde sieht den Status auf der Website."],
  [/Решението е взето на ([^<]*?)\. Клиентът е уведомен по имейл и на сайта\./g, "The decision was made on $1. The customer has been notified by email and on the site.", "Die Entscheidung wurde am $1 getroffen. Der Kunde wurde per E-Mail und auf der Website benachrichtigt."],
  [/Решението е взето\. Клиентът е уведомен по имейл и на сайта\./g, "The decision has been made. The customer has been notified by email and on the site.", "Die Entscheidung wurde getroffen. Der Kunde wurde per E-Mail und auf der Website benachrichtigt."],
  [/Предаден на ([^<(]+) \(/g, "Handed over on $1 (", "Übergeben am $1 ("],
  [/Доставка до: /g, "Delivery to: ", "Lieferung an: "],
  [/Връщане от: /g, "Collection from: ", "Abholung von: "],
  [/(\d{1,2}\.\d{1,2}\.\d{4}) г\.,/g, "$1,", "$1,"],
];

const LONG = Object.keys(D).filter((k) => k.length >= 12).sort((a, b) => b.length - a.length);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const langOf = (v: string | null): Lang => (LANGS as readonly string[]).includes(v || "") ? (v as Lang) : "bg";

export function localize(html: string, lang: Lang) {
  if (lang === "bg") return html;
  const i = lang === "en" ? 0 : 1;
  let out = html.replace(/<html lang="bg">/, `<html lang="${lang}">`);
  // Дълги изречения – и в атрибути (placeholder, confirm()); апострофите не се ползват в преводите
  for (const k of LONG) {
    const t = D[k][i];
    out = out.split(k).join(t);
    const ek = esc(k);
    if (ek !== k) out = out.split(ek).join(esc(t));
  }
  for (const [re, en, de] of RULES) out = out.replace(re, i === 0 ? en : de);
  // Кратки етикети: само цял текст на елемент или на атрибут
  out = out.replace(/>([^<>]+)</g, (m, t: string) => {
    const k = t.trim(), hit = D[k] || D[esc(k)];
    return hit ? m.replace(k, hit[i]) : m;
  });
  out = out.replace(/(placeholder|aria-label)="([^"]*)"/g, (m, a, v) => (D[v] ? `${a}="${esc(D[v][i])}"` : m));
  return out;
}

// Превключвател на езика: същият защитен адрес с друг lang (ключът остава в адреса, както в линка от имейла)
export function langSwitch(url: URL, lang: Lang) {
  return `<p class="langs">${LANGS.map((l) => {
    const u = new URL(url);
    if (l === "bg") u.searchParams.delete("lang");
    else u.searchParams.set("lang", l);
    return l === lang ? `<b aria-current="true">${l.toUpperCase()}</b>` : `<a href="${esc(u.pathname + u.search)}" hreflang="${l}">${l.toUpperCase()}</a>`;
  }).join(" · ")}</p>`;
}
