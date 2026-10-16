// Заетост на автомобил по дата и час (местно време).
// След всяко връщане автомобилът е зает още BUFFER_MIN минути (почистване и проверка), а преди всяко получаване – също толкова.
// Пример: върнат в 12:00 → може да бъде взет отново от 13:00.
export const BUFFER_MIN = 60;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Час от текста „дд.мм.гггг чч:мм, …“ (полета pickup / dropoff) – за по-стари резервации без start_time / end_time
export function timeFromText(s: string) {
  const m = /\d{2}\.\d{2}\.\d{4}\s+(\d{2}:\d{2})/.exec(s || "");
  return m && TIME_RE.test(m[1]) ? m[1] : "";
}

// Минути от условна начална точка – само за сравнение на моменти помежду им
export const minutes = (date: string, time: string) => Date.parse(`${date}T${time}:00Z`) / 60000;

// Получаване в началото на деня и връщане в края му, ако часът не е известен
export const startTimeOf = (t: string, text = "") => (TIME_RE.test(t) ? t : timeFromText(text) || "00:00");
export const endTimeOf = (t: string, text = "") => (TIME_RE.test(t) ? t : timeFromText(text) || "23:59");

// Застъпват ли се два периода, като между тях трябва да има поне BUFFER_MIN минути
export const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  aStart < bEnd + BUFFER_MIN && bStart < aEnd + BUFFER_MIN;

export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Местна дата и час, преместени с n минути (за показване на буфера): ["2026-10-16","23:30"] + 60 → ["2026-10-17","00:30"]
export function shiftLocal([d, t]: [string, string], n: number): [string, string] {
  const iso = new Date(Date.parse(`${d}T${t}:00Z`) + n * 60_000).toISOString();
  return [iso.slice(0, 10), iso.slice(11, 16)];
}
