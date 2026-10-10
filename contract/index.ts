import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { TEMPLATE_BASE64 } from "./template.js";

// Попълва договора за наем (contract/dogovor-shablon.docx) с данните от резервацията.
// В шаблона празните места са маркери {{ключ}}; липсващите стойности остават като линия за ръчно попълване.

// Данни за автомобилите в договора (ключовете съвпадат с тези на сайта)
const CARS: Record<string, { model: string; reg: string; vin: string; fuel: string; color: string }> = {
  punto: { model: "FIAT PUNTO", reg: "PB7470TE", vin: "ZFA19900000454689", fuel: "Бензин (Petrol)", color: "Бял (White)" },
  ka: { model: "Ford KA", reg: "PB3083XE", vin: "WFOUXXLTRU9E54381", fuel: "Бензин (Petrol)", color: "Син (Blue)" },
  ibiza: { model: "Seat Ibiza", reg: "РВ3305УА", vin: "VSSZZZ6JZBR029838", fuel: "Дизел (Diesel)", color: "Черен (Black)" },
  golf: { model: "Volkswagen Golf 5", reg: "РВ1244УА", vin: "WVWZZZ1KZ9M313532", fuel: "Дизел (Diesel)", color: "Бял (White)" },
  passat: { model: "Volkswagen Passat", reg: "РВ8991XE", vin: "WVWZZZ3CZ7E193036", fuel: "Дизел (Diesel)", color: "Черен (Black)" },
};
const LANDLORD = "Теодор Петков Белаков";
const OFFICE = "гр. Пловдив, бул. „Дунав“ №10";
const KM_RATE = 0.7;
const BLANK = "____________________";

// ===== Суми и числа с думи =====
const UNITS: Record<string, string[]> = {
  m: ["нула", "един", "два", "три", "четири", "пет", "шест", "седем", "осем", "девет"],
  n: ["нула", "едно", "две", "три", "четири", "пет", "шест", "седем", "осем", "девет"],
  f: ["нула", "една", "две", "три", "четири", "пет", "шест", "седем", "осем", "девет"],
};
const TEENS = ["десет", "единадесет", "дванадесет", "тринадесет", "четиринадесет", "петнадесет", "шестнадесет", "седемнадесет", "осемнадесет", "деветнадесет"];
const TENS = ["", "", "двадесет", "тридесет", "четиридесет", "петдесет", "шестдесет", "седемдесет", "осемдесет", "деветдесет"];
const HUNDREDS = ["", "сто", "двеста", "триста", "четиристотин", "петстотин", "шестстотин", "седемстотин", "осемстотин", "деветстотин"];

// „и“ стои пред последната част: сто двадесет и пет, хиляда и сто
const joinI = (l: string[]) => (l.length > 1 ? l.slice(0, -1).join(" ") + " и " + l[l.length - 1] : l[0] || "");
function under1000(n: number, g: string) {
  const out: string[] = [];
  const h = Math.floor(n / 100), r = n % 100;
  if (h) out.push(HUNDREDS[h]);
  if (r >= 10 && r < 20) out.push(TEENS[r - 10]);
  else {
    if (r >= 20) out.push(TENS[Math.floor(r / 10)]);
    if (r % 10) out.push(UNITS[g][r % 10]);
  }
  return out;
}
export function words(n: number, g: "m" | "n" | "f" = "m") {
  n = Math.floor(n);
  if (!n) return "нула";
  if (n >= 1e6) return String(n);
  const th = Math.floor(n / 1000), out: string[] = [];
  if (th === 1) out.push("хиляда");
  else if (th > 1) out.push(joinI(under1000(th, "f")) + " хиляди");
  return joinI([...out, ...under1000(n % 1000, g)]);
}
export function money(x: number) {
  const c = Math.round(x * 100), e = Math.floor(c / 100), ct = c % 100;
  const w = `${words(e, "n")} евро${ct ? ` и ${words(ct)} ${ct === 1 ? "евроцент" : "евроцента"}` : ""}`;
  return `${e},${String(ct).padStart(2, "0")} EUR (${w})`;
}
const bgDate = (d: string) => (d ? d.split("-").reverse().join(".") : "");
function timeText(t: string) {
  const [h, m] = t.split(":").map(Number);
  return `${t} часа (${words(h)} ${h === 1 ? "час" : "часа"}${m ? ` и ${words(m, "f")} ${m === 1 ? "минута" : "минути"}` : ""})`;
}
const kmText = (k: number) => String(k).replace(".", ",");

// ===== Входни данни от формата =====
type Leg = { addr: string; km: number | null } | null;
export type ContractData = {
  name: string; carId: string; citizen: string;
  idt: string; idn: string; egn: string; idd: string; idp: string; city: string; addr: string;
  dln: string; dld: string; dlp: string;
  d1: string; t1: string; d2: string; t2: string;
  days: number | null; rent: number | null; seat: number | null; seatN: number; seatDay: number | null;
  del: Leg; ret: Leg; abroad: { name: string; fee: number }[];
};

const s = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e6 ? v : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const leg = (v: any): Leg => (v && typeof v === "object" && s(v.addr) ? { addr: s(v.addr), km: num(v.km) } : null);

export function parseContract(c: any, name: string, carId: string): ContractData | null {
  if (!c || typeof c !== "object") return null;
  const date = (v: unknown) => (DATE_RE.test(s(v, 10)) ? s(v, 10) : "");
  const time = (v: unknown) => (TIME_RE.test(s(v, 5)) ? s(v, 5) : "");
  return {
    name, carId,
    citizen: s(c.citizen, 80), idt: c.idt === "pass" ? "pass" : "id",
    idn: s(c.idn, 40), egn: s(c.egn, 20), idd: date(c.idd), idp: s(c.idp, 120), city: s(c.city, 80), addr: s(c.addr),
    dln: s(c.dln, 40), dld: date(c.dld), dlp: s(c.dlp, 120),
    d1: date(c.d1), t1: time(c.t1), d2: date(c.d2), t2: time(c.t2),
    days: num(c.days), rent: num(c.rent), seat: num(c.seat),
    // Брой столчета и цена на ден за всички (по-старите заявки пращат само общата сума)
    seatN: Math.min(5, Math.floor(num(c.seatN) ?? (num(c.seat) ? 1 : 0))), seatDay: num(c.seatDay),
    del: leg(c.del), ret: leg(c.ret),
    abroad: Array.isArray(c.abroad)
      ? c.abroad.slice(0, 20).map((a: any) => ({ name: s(a?.name, 60), fee: num(a?.fee) ?? 0 })).filter((a: { name: string }) => a.name)
      : [],
  };
}

function values(d: ContractData): Record<string, string> {
  const car = CARS[d.carId];
  const check = (on: boolean) => (on ? ["☐", "☒"] : ["☒", "☐"]);
  const hours = d.d1 && d.t1 && d.d2 && d.t2
    ? Math.max(1, Math.ceil((Date.parse(`${d.d2}T${d.t2}Z`) - Date.parse(`${d.d1}T${d.t1}Z`)) / 36e5 - 1e-9))
    : null;
  const legVals = (l: Leg) => {
    if (!l) return { addr: "—", fee: money(0), km: "", place: OFFICE };
    const fee = l.km != null ? l.km * KM_RATE : null;
    return {
      addr: l.addr,
      fee: fee != null ? money(fee) : `${BLANK} EUR`,
      km: l.km != null ? ` (${kmText(l.km)} км по пътен маршрут × 0,70 EUR/км)` : "",
      place: l.addr,
    };
  };
  const del = legVals(d.del), ret = legVals(d.ret);
  const [delNo, delYes] = check(!!d.del), [retNo, retYes] = check(!!d.ret), [abrNo, abrYes] = check(d.abroad.length > 0);
  const seatN = d.seat || d.seatDay ? Math.max(1, d.seatN) : 0;
  const seatDay = seatN ? d.seatDay ?? (d.seat && d.days ? d.seat / d.days : null) : 0;
  const [seatNo, seatYes] = check(seatN > 0);
  return {
    date: bgDate(d.d1), name: d.name, egn: d.egn, citizen: d.citizen,
    address: [d.city, d.addr].filter(Boolean).join(", "),
    idLabel: d.idt === "pass" ? "Паспорт" : "ЛК", idIssued: d.idt === "pass" ? "издаден" : "издадена",
    idn: d.idn, idd: bgDate(d.idd), idp: d.idp,
    dln: d.dln, dld: bgDate(d.dld), dlp: d.dlp,
    carModel: car?.model || "", carReg: car?.reg || "", carVin: car?.vin || "", carFuel: car?.fuel || "", carColor: car?.color || "",
    period: hours && d.days ? `${hours} ${hours === 1 ? "час" : "часа"} / ${d.days} ${d.days === 1 ? "ден" : "дни"} (${words(d.days)} ${d.days === 1 ? "ден" : "дни"})` : "",
    startDate: bgDate(d.d1), startTime: d.t1 ? timeText(d.t1) : "",
    endDate: bgDate(d.d2), endTime: d.t2 ? timeText(d.t2) : "",
    rent: d.rent != null ? money(d.rent) : "",
    delAddr: del.addr, delFee: del.fee, delKm: del.km, delNo, delYes,
    retAddr: ret.addr, retFee: ret.fee, retKm: ret.km, retNo, retYes,
    abrList: d.abroad.length ? d.abroad.map((a) => a.name).join(", ") : "—",
    abrFee: money(d.abroad.reduce((t, a) => t + a.fee, 0)),
    abrNo, abrYes,
    seatN: seatN ? `${seatN} (${words(seatN)}) ${seatN === 1 ? "брой" : "броя"}` : "—",
    seatFee: seatDay != null ? money(seatDay) : `${BLANK} EUR`,
    seatTotal: seatN && d.seat && d.days ? ` – общо ${money(d.seat)} за ${d.days} ${d.days === 1 ? "ден" : "дни"}` : "",
    seatNo, seatYes,
    pickupPlace: del.place, returnPlace: ret.place,
    d1: bgDate(d.d1), t1: d.t1,
    returnDate: "", returnTime: "", returnAddress: "",
    landlord: LANDLORD,
  };
}

const xmlEsc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Допълнения, които могат да останат празни (без линия)
const OPTIONAL = new Set(["delKm", "retKm", "seatTotal"]);
let template: Record<string, Uint8Array> | null = null;

// Връща попълнения договор като .docx
export function buildContract(d: ContractData): Uint8Array {
  template ||= unzipSync(Buffer.from(TEMPLATE_BASE64, "base64"));
  const v = values(d);
  const xml = strFromU8(template["word/document.xml"]).replace(/\{\{(\w+)\}\}/g, (_, k) => xmlEsc(v[k] || (OPTIONAL.has(k) ? "" : BLANK)));
  return zipSync({ ...template, "word/document.xml": strToU8(xml) }, { level: 6 });
}

export function contractFileName(d: ContractData) {
  return `Dogovor-naem-${d.carId || "kola"}-${d.d1 || "data"}.docx`;
}
