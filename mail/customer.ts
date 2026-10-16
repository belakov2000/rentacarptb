import type { bookings } from "../db/schema.js";
import { btn, esc, mailFooter, mailRow, PHONE, wrapMail } from "./index.js";

// Автоматични писма до клиента: получена заявка, напомняния преди получаване и връщане, инструкции за предаването и молба за отзив.
type Booking = typeof bookings.$inferSelect;
export type CustomerMailKind = "received" | "pickup24" | "handover" | "return24" | "returnSoon" | "review";

const OFFICE_MAP = "https://maps.app.goo.gl/3Z6hxjwnggn99cNu7";
// Профилът в Google Maps, където клиентът може да остави отзив (може да се смени с REVIEW_URL)
const REVIEW_URL = process.env.REVIEW_URL || OFFICE_MAP;

const T: Record<string, Record<string, string>> = {
  bg: {
    hi: "Здравейте, {name}!",
    car: "Автомобил", pickup: "Получаване", dropoff: "Връщане", total: "Общо за услугите", date: "Дата", time: "Час", place: "Място",
    office: "В нашия офис – гр. Пловдив, бул. „Дунав“ №10", deliverTo: "Доставка до ", collectFrom: "Вземане от ",
    map: "Виж на картата",
    q: "Въпроси? Обадете ни се на {phone} или отговорете на този имейл.",
    why: "Получавате това писмо, защото направихте заявка за наем на автомобил на rentacar-ptb.com.",
    // Получена заявка
    recSubj: "Получихме вашата заявка – Rent a Car PTB",
    rec: "Благодарим ви! Получихме заявката ви за наем.",
    recInfo: "Проверяваме наличността и ще ви изпратим потвърждение по имейл възможно най-скоро – обикновено до няколко часа в работно време (08:00 – 20:00).",
    recNote: "Резервацията е окончателна едва след нашето потвърждение.",
    // 24 ч. преди получаване
    p24Subj: "Утре получавате автомобила – Rent a Car PTB",
    p24: "Напомняме ви, че утре ви очакваме за получаване на автомобила.",
    bring: "Моля, носете със себе си:",
    bring1: "Лична карта или паспорт", bring2: "Валидна шофьорска книжка", bring3: "Гаранционен депозит 100 € (връща се при връщане на автомобила)",
    bringCash: "Сумата за наема в брой (ще ви издадем касов бон)",
    // Инструкции за предаването
    hoSubj: "Инструкции за предаването на автомобила – Rent a Car PTB",
    ho: "Ето всичко, което ви трябва за предаването на автомобила днес.",
    hoOffice: "Елате в нашия офис на посочения час. При пристигане ни се обадете на {phone}, ако не ни видите веднага.",
    hoDelivery: "Наш служител ще докара автомобила на посочения адрес в уговорения час и ще ви се обади по телефона малко преди пристигане.",
    hoSteps: "Как протича предаването (около 15 минути):",
    hoStep1: "Проверка на документите и подписване на договора за наем",
    hoStep2: "Заедно оглеждаме автомобила и отбелязваме състоянието и горивото",
    hoStep3: "Плащане на депозита и получаване на ключовете",
    hoLate: "Ако закъснявате или искате да промените часа, моля, обадете ни се на {phone}.",
    // Връщане
    r24Subj: "Утре е връщането на автомобила – Rent a Car PTB",
    r24: "Напомняме ви, че наемът приключва утре.",
    p24nSubj: "Наближава получаването на автомобила – Rent a Car PTB",
    p24n: "Напомняме ви, че наближава получаването на автомобила.",
    r24nSubj: "Наближава връщането на автомобила – Rent a Car PTB",
    r24n: "Напомняме ви, че наемът наближава своя край.",
    rsSubj: "Наближава часът за връщане на автомобила – Rent a Car PTB",
    rs: "Наближава часът за връщане на автомобила.",
    retTips: "Преди връщане:",
    ret1: "Заредете горивото до нивото, с което е получен автомобилът",
    retClean: "Върнете автомобила чист – отвътре и отвън",
    ret2: "Проверете дали не сте забравили лични вещи",
    ret3: "Депозитът се връща след оглед на автомобила",
    retLonger: "Искате да удължите наема? Обадете ни се на {phone} преди часа за връщане.",
    // Отзив
    revSubj: "Благодарим ви, че пътувахте с нас! – Rent a Car PTB",
    rev: "Благодарим ви, че избрахте Rent a Car PTB! Надяваме се пътуването да е било приятно.",
    revAsk: "Ще се радваме, ако отделите минута да оцените услугата ни – вашето мнение помага на нас и на други клиенти.",
    revBtn: "★ Оценете ни в Google",
    revBad: "Ако нещо не е било наред, отговорете на този имейл – ще го прочетем лично.",
  },
  en: {
    hi: "Hello {name},",
    car: "Car", pickup: "Pick-up", dropoff: "Return", total: "Total for services", date: "Date", time: "Time", place: "Place",
    office: "At our office – Plovdiv, 10 Dunav Blvd.", deliverTo: "Delivery to ", collectFrom: "Collection from ",
    map: "View on map",
    q: "Questions? Call us on {phone} or reply to this email.",
    why: "You are receiving this email because you requested a car rental on rentacar-ptb.com.",
    recSubj: "We received your request – Rent a Car PTB",
    rec: "Thank you! We have received your rental request.",
    recInfo: "We are checking availability and will send you a confirmation by email as soon as possible – usually within a few hours during business hours (08:00 – 20:00).",
    recNote: "The booking is final only after our confirmation.",
    p24Subj: "You pick up your car tomorrow – Rent a Car PTB",
    p24: "A friendly reminder that we are expecting you tomorrow to pick up your car.",
    bring: "Please bring with you:",
    bring1: "ID card or passport", bring2: "Valid driving licence", bring3: "Security deposit of 100 € (refunded when you return the car)",
    bringCash: "The rental amount in cash (you will receive a fiscal receipt)",
    hoSubj: "Car handover instructions – Rent a Car PTB",
    ho: "Here is everything you need for today's car handover.",
    hoOffice: "Come to our office at the time shown. Call us on {phone} on arrival if you don't see us right away.",
    hoDelivery: "Our staff member will bring the car to the address shown at the agreed time and will call you shortly before arriving.",
    hoSteps: "How the handover works (about 15 minutes):",
    hoStep1: "Checking documents and signing the rental contract",
    hoStep2: "Inspecting the car together and noting its condition and fuel level",
    hoStep3: "Paying the deposit and receiving the keys",
    hoLate: "If you are running late or want to change the time, please call us on {phone}.",
    r24Subj: "Your car return is tomorrow – Rent a Car PTB",
    r24: "A friendly reminder that your rental ends tomorrow.",
    p24nSubj: "Your car pick-up is coming up – Rent a Car PTB",
    p24n: "A friendly reminder that your car pick-up is coming up.",
    r24nSubj: "Your car return is coming up – Rent a Car PTB",
    r24n: "A friendly reminder that your rental is coming to an end.",
    rsSubj: "Your car return time is coming up – Rent a Car PTB",
    rs: "Your car return time is coming up soon.",
    retTips: "Before returning:",
    ret1: "Refuel to the level the car had at pick-up",
    retClean: "Return the car clean – inside and out",
    ret2: "Make sure you haven't left any personal belongings",
    ret3: "The deposit is refunded after the car is inspected",
    retLonger: "Want to extend your rental? Call us on {phone} before the return time.",
    revSubj: "Thank you for travelling with us! – Rent a Car PTB",
    rev: "Thank you for choosing Rent a Car PTB! We hope you had a pleasant trip.",
    revAsk: "We would be grateful if you could take a minute to rate our service – your feedback helps us and other customers.",
    revBtn: "★ Rate us on Google",
    revBad: "If anything wasn't right, just reply to this email – we will read it personally.",
  },
  de: {
    hi: "Hallo {name},",
    car: "Fahrzeug", pickup: "Abholung", dropoff: "Rückgabe", total: "Gesamt für Leistungen", date: "Datum", time: "Uhrzeit", place: "Ort",
    office: "In unserem Büro – Plowdiw, Bul. Dunav 10", deliverTo: "Zustellung an ", collectFrom: "Abholung von ",
    map: "Auf der Karte ansehen",
    q: "Fragen? Rufen Sie uns an unter {phone} oder antworten Sie auf diese E-Mail.",
    why: "Sie erhalten diese E-Mail, weil Sie auf rentacar-ptb.com einen Mietwagen angefragt haben.",
    recSubj: "Wir haben Ihre Anfrage erhalten – Rent a Car PTB",
    rec: "Vielen Dank! Wir haben Ihre Mietanfrage erhalten.",
    recInfo: "Wir prüfen die Verfügbarkeit und senden Ihnen so bald wie möglich eine Bestätigung per E-Mail – meist innerhalb weniger Stunden während der Geschäftszeiten (08:00 – 20:00).",
    recNote: "Die Buchung ist erst nach unserer Bestätigung verbindlich.",
    p24Subj: "Morgen holen Sie Ihr Fahrzeug ab – Rent a Car PTB",
    p24: "Wir erinnern Sie daran, dass wir Sie morgen zur Abholung Ihres Fahrzeugs erwarten.",
    bring: "Bitte bringen Sie mit:",
    bring1: "Personalausweis oder Reisepass", bring2: "Gültigen Führerschein", bring3: "Kaution von 100 € (wird bei Rückgabe erstattet)",
    bringCash: "Den Mietbetrag in bar (Sie erhalten einen Kassenbon)",
    hoSubj: "Hinweise zur Fahrzeugübergabe – Rent a Car PTB",
    ho: "Hier finden Sie alles, was Sie für die heutige Fahrzeugübergabe brauchen.",
    hoOffice: "Kommen Sie zur angegebenen Uhrzeit in unser Büro. Rufen Sie uns bei Ankunft unter {phone} an, falls Sie uns nicht gleich sehen.",
    hoDelivery: "Unser Mitarbeiter bringt das Fahrzeug zur vereinbarten Zeit an die angegebene Adresse und ruft Sie kurz vor der Ankunft an.",
    hoSteps: "So läuft die Übergabe ab (ca. 15 Minuten):",
    hoStep1: "Prüfung der Dokumente und Unterzeichnung des Mietvertrags",
    hoStep2: "Gemeinsame Besichtigung des Fahrzeugs, Zustand und Tankfüllung werden notiert",
    hoStep3: "Zahlung der Kaution und Übergabe der Schlüssel",
    hoLate: "Wenn Sie sich verspäten oder die Uhrzeit ändern möchten, rufen Sie uns bitte unter {phone} an.",
    r24Subj: "Morgen ist die Fahrzeugrückgabe – Rent a Car PTB",
    r24: "Wir erinnern Sie daran, dass Ihre Miete morgen endet.",
    p24nSubj: "Die Abholung Ihres Fahrzeugs rückt näher – Rent a Car PTB",
    p24n: "Wir erinnern Sie daran, dass die Abholung Ihres Fahrzeugs näher rückt.",
    r24nSubj: "Die Fahrzeugrückgabe rückt näher – Rent a Car PTB",
    r24n: "Wir erinnern Sie daran, dass Ihre Miete bald endet.",
    rsSubj: "Die Rückgabezeit rückt näher – Rent a Car PTB",
    rs: "Die Uhrzeit für die Rückgabe des Fahrzeugs rückt näher.",
    retTips: "Vor der Rückgabe:",
    ret1: "Tanken Sie bis zum Füllstand bei der Abholung",
    retClean: "Geben Sie das Fahrzeug sauber zurück – innen und außen",
    ret2: "Prüfen Sie, ob Sie keine persönlichen Gegenstände vergessen haben",
    ret3: "Die Kaution wird nach der Besichtigung des Fahrzeugs erstattet",
    retLonger: "Möchten Sie die Miete verlängern? Rufen Sie uns vor der Rückgabezeit unter {phone} an.",
    revSubj: "Danke, dass Sie mit uns gefahren sind! – Rent a Car PTB",
    rev: "Vielen Dank, dass Sie sich für Rent a Car PTB entschieden haben! Wir hoffen, Sie hatten eine angenehme Fahrt.",
    revAsk: "Wir würden uns freuen, wenn Sie sich eine Minute Zeit nehmen, um unseren Service zu bewerten – Ihre Meinung hilft uns und anderen Kunden.",
    revBtn: "★ Bewerten Sie uns bei Google",
    revBad: "Falls etwas nicht in Ordnung war, antworten Sie einfach auf diese E-Mail – wir lesen sie persönlich.",
  },
};

// В текста на заявката получаването е „дд.мм.гггг ЧЧ:ММ, място“ – тук остава само мястото
const placeOf = (s: string) => s.replace(/^\d{2}\.\d{2}\.\d{4}( \d{2}:\d{2})?,\s*/, "");
const isOffice = (place: string) => /Дунав\s*10/.test(place);
const bgDate = (d: string | null) => (d ? d.split("-").reverse().join(".") : "");

function where(t: Record<string, string>, raw: string) {
  const place = placeOf(raw);
  if (!place || isOffice(place)) return { text: t.office, map: OFFICE_MAP, office: true };
  const addr = place.replace(/^(доставка до|вземане от)\s+/i, "");
  const label = /^вземане от/i.test(place) ? t.collectFrom : t.deliverTo;
  return { text: label + addr, map: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`, office: false };
}

const list = (items: string[]) => `<ul style="padding-left:20px;margin:6px 0 14px">${items.map((i) => `<li style="margin:3px 0">${esc(i)}</li>`).join("")}</ul>`;

// tomorrow = false: първото напомняне не е в деня преди получаването / връщането (настроен е друг брой часове) –
// тогава текстът не казва „утре“.
export function lifecycleMail(kind: CustomerMailKind, b: Booking, o: { tomorrow?: boolean } = {}) {
  const tomorrow = o.tomorrow !== false;
  const t = T[b.lang] || T.bg;
  const fill = (s: string) => s.replace("{name}", b.name).replace("{phone}", PHONE);
  const ref = b.id.slice(0, 6).toUpperCase();
  const pick = where(t, b.pickup);
  const ret = where(t, b.dropoff);
  const mapLink = (w: { map: string }) => `<p><a href="${esc(w.map)}" style="color:#0f1b2d;font-weight:700">📍 ${esc(t.map)}</a></p>`;
  const when = (d: string | null, time: string, w: { text: string }) =>
    `<table style="border-collapse:collapse;margin:14px 0">${mailRow(t.car, b.car)}${mailRow(t.date, bgDate(d))}${mailRow(t.time, time)}${mailRow(t.place, w.text)}</table>`;

  let subject = "", lead = "", body = "";
  switch (kind) {
    case "received":
      subject = t.recSubj;
      lead = t.rec;
      body =
        `<table style="border-collapse:collapse;margin:14px 0">${mailRow(t.car, b.car)}${mailRow(t.pickup, b.pickup)}${mailRow(t.dropoff, b.dropoff)}${mailRow(t.total, b.total)}</table>` +
        `<p>${esc(t.recInfo)}</p><p style="color:#5b6577">${esc(t.recNote)}</p>`;
      break;
    case "pickup24":
      subject = tomorrow ? t.p24Subj : t.p24nSubj;
      lead = tomorrow ? t.p24 : t.p24n;
      body =
        when(b.startDate, b.startTime, pick) + mapLink(pick) +
        `<p><b>${esc(t.bring)}</b></p>` + list([t.bring1, t.bring2, t.bring3, ...(b.payment === "cash" ? [t.bringCash] : [])]);
      break;
    case "handover":
      subject = t.hoSubj;
      lead = t.ho;
      body =
        when(b.startDate, b.startTime, pick) + mapLink(pick) +
        `<p>${esc(fill(pick.office ? t.hoOffice : t.hoDelivery))}</p>` +
        `<p><b>${esc(t.hoSteps)}</b></p>` + list([t.hoStep1, t.hoStep2, t.hoStep3]) +
        `<p>${esc(fill(t.hoLate))}</p>`;
      break;
    case "return24":
    case "returnSoon":
      subject = kind === "return24" ? (tomorrow ? t.r24Subj : t.r24nSubj) : t.rsSubj;
      lead = kind === "return24" ? (tomorrow ? t.r24 : t.r24n) : t.rs;
      body =
        when(b.endDate, b.endTime, ret) + mapLink(ret) +
        `<p><b>${esc(t.retTips)}</b></p>` + list([t.ret1, t.retClean, t.ret2, t.ret3]) +
        `<p>${esc(fill(t.retLonger))}</p>`;
      break;
    case "review":
      subject = t.revSubj;
      lead = t.rev;
      body = `<p>${esc(t.revAsk)}</p><p>${btn(REVIEW_URL, t.revBtn, "#f5b301", "#0f1b2d")}</p><p style="color:#5b6577">${esc(t.revBad)}</p>`;
      break;
  }
  const html = wrapMail(
    `<p>${esc(fill(t.hi))}</p><p style="font-size:18px"><b>${esc(lead)}</b></p>${body}` +
      (kind === "review" ? "" : `<p>${esc(fill(t.q))}</p>`) +
      mailFooter(t.why),
  );
  return { subject: `${subject} (№ ${ref})`, html, preheader: `${lead} ${b.car}` };
}
