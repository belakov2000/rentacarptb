// Работно време за получаване и връщане – същото като „Работно време“ на сайта (index.html, константа HOURS).
// Датите и часовете в резервациите са местно време в Пловдив (Europe/Sofia). Денят от седмицата на календарна дата
// не зависи от часовата зона, затова лятното часово време не влияе на проверката.
// Граничните часове се приемат: делничен ден 08:00 и 20:00 са валидни, 07:59 и 20:01 – не.
// Ключ: 0 = неделя … 6 = събота.
export const HOURS: Record<number, readonly [string, string]> = {
  0: ["09:00", "19:00"],
  1: ["08:00", "20:00"],
  2: ["08:00", "20:00"],
  3: ["08:00", "20:00"],
  4: ["08:00", "20:00"],
  5: ["08:00", "20:00"],
  6: ["09:00", "19:00"],
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

export function withinHours(date: string, time: string) {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return false;
  const h = HOURS[weekday(date)];
  return !!h && time >= h[0] && time <= h[1];
}

// Днешната дата в Пловдив (гггг-мм-дд)
export const sofiaToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
