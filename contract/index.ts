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
// Цена на км за доставка / връщане от адрес: 1,00 EUR в Пловдив и района (вкл. летище Пловдив и Асеновград), 0,70 EUR извън него
const KM_RATE = 0.7, KM_RATES = [1, 0.7];
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
type Leg = { addr: string; km: number | null; rate?: number } | null;
export type ContractData = {
  name: string; carId: string; citizen: string;
  idt: string; idn: string; egn: string; idd: string; idp: string;
  // Адрес по документа. region / municipality / placeType липсват (undefined) в договорите отпреди тези полета –
  // за тях адресът остава „град, адрес“ без представки, както е бил (видът на населеното място не се измисля).
  region?: string; municipality?: string; placeType?: "city" | "village" | ""; city: string; addr: string;
  dln: string; dld: string; dlp: string;
  d1: string; t1: string; d2: string; t2: string;
  days: number | null; rent: number | null; seat: number | null; seatN: number; seatDay: number | null;
  del: Leg; ret: Leg; abroad: { name: string; fee: number }[];
  // Приложение към договора (двуетапна заявка): допълнителни услуги (вериги, втори водач), данните на втория водач, отстъпка.
  // Шаблонът няма полета за тях – редовете се добавят като отделни абзаци в края на документа.
  appendix?: string[];
  appendixSecondDriver?: boolean;
  appendixSecondDriverName?: string;
};

const s = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e6 ? v : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// По-старите заявки нямат rate – за тях остава 0,70 EUR/км
export const kmRate = (v: unknown) => (KM_RATES.includes(v as number) ? (v as number) : KM_RATE);
const leg = (v: any): Leg => (v && typeof v === "object" && s(v.addr) ? { addr: s(v.addr), km: num(v.km), rate: kmRate(v.rate) } : null);

// ===== Адрес по документа =====
// Представките се добавят само тук (docAddress); ако клиентът ги е написал в полето, се махат – без „гр. гр.“ или „с. с.“.
// Полетата приемат латиница и чужди наименования; област и община са задължителни само за българска лична карта.
const PRE = { region: /^(обл\.|област\s)\s*/i, municipality: /^(общ\.|община\s)\s*/i, city: /^(гр\.|град\s|с\.|село\s)\s*/i };
const unpre = (v: string, re: RegExp) => v.replace(re, "").trim();
const BG = /^(bg|bgr|българия|република българия|bulgaria|republic of bulgaria|bulgarien|bulgarie)$/i;
export const adminAreasRequired = (citizen: string, idt: string) => idt !== "pass" && BG.test(citizen.trim().replace(/\.$/, ""));
export function docAddress(d: Pick<ContractData, "region" | "municipality" | "placeType" | "city" | "addr">) {
  const t = d.placeType === "city" ? "гр. " : d.placeType === "village" ? "с. " : "";
  return [d.region && "обл. " + d.region, d.municipality && "общ. " + d.municipality, d.city && t + d.city, d.addr].filter(Boolean).join(", ");
}
// Проверка на адреса от формата (и на сървъра – заявката може да бъде променена ръчно). Само за заявки от новата форма
// (с поле placeType); по-старите страници не го пращат и се приемат както досега. Връща "" или код на грешката.
export function addressError(c: any) {
  if (!c || typeof c !== "object" || !("placeType" in c)) return "";
  const d = parseContract(c, "", "");
  if (!d || (d.placeType !== "city" && d.placeType !== "village")) return "place_type";
  if (!d.city || !d.addr) return "address";
  if (adminAreasRequired(d.citizen, d.idt) && (!d.region || !d.municipality)) return "admin_areas";
  return "";
}

export function parseContract(c: any, name: string, carId: string): ContractData | null {
  if (!c || typeof c !== "object") return null;
  const date = (v: unknown) => (DATE_RE.test(s(v, 10)) ? s(v, 10) : "");
  const time = (v: unknown) => (TIME_RE.test(s(v, 5)) ? s(v, 5) : "");
  return {
    name, carId,
    citizen: s(c.citizen, 80), idt: c.idt === "pass" ? "pass" : "id",
    idn: s(c.idn, 40), egn: s(c.egn, 20), idd: date(c.idd), idp: s(c.idp, 120),
    // Без placeType (по-стари заявки) името на града се пази непроменено
    ...("placeType" in c
      ? {
          region: unpre(s(c.region, 80), PRE.region), municipality: unpre(s(c.municipality, 80), PRE.municipality),
          placeType: c.placeType === "city" || c.placeType === "village" ? c.placeType : "", city: unpre(s(c.city, 80), PRE.city),
        }
      : { city: s(c.city, 80) }),
    addr: s(c.addr),
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
    const rate = kmRate(l.rate);
    const fee = l.km != null ? l.km * rate : null;
    return {
      addr: l.addr,
      fee: fee != null ? money(fee) : `${BLANK} EUR`,
      km: l.km != null ? ` (${kmText(l.km)} км по пътен маршрут × ${rate.toFixed(2).replace(".", ",")} EUR/км)` : "",
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
    address: docAddress(d),
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

// Абзаци на приложението (първият ред – удебелен заглавен)
function appendixXml(d: ContractData) {
  const { appendix: lines, appendixSecondDriver: secondDriver } = d;
  if (!lines?.length) return "";
  const p = (text: string, opts: { bold?: boolean; page?: boolean; keep?: boolean; before?: number } = {}) =>
    `<w:p><w:pPr>${opts.page ? "<w:pageBreakBefore/>" : ""}${opts.keep ? "<w:keepNext/>" : ""}<w:keepLines/><w:spacing w:before="${opts.before || 0}" w:after="60" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/>${opts.bold ? "<w:b/>" : ""}</w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
  // Keep the final terms with the signatures. The signature block stays together
  // if a longer appendix requires another page; it is never left half on each.
  const text = lines.map((t, i) => p(t, { bold: i === 0, page: i === 0, keep: i === 0 || i === lines.length - 1 })).join("");
  const hasSecond = secondDriver ?? lines.some(t => t.startsWith("Втори (допълнителен) водач:"));
  // Older saved contracts keep the second driver's name in the appendix text.
  const secondName = d.appendixSecondDriverName || lines.find(t => t.startsWith("Втори (допълнителен) водач:"))?.slice("Втори (допълнителен) водач:".length).split(/[,;]/)[0].trim() || BLANK;
  const roles = [["Наемодател", LANDLORD], ["Наемател", d.name || BLANK], ...(hasSecond ? [["Втори водач", secondName]] : [])];
  return text + p("Подписи по приложението", { bold: true, keep: true, before: 180 }) +
    roles.map(([role, name], i) => p(`${role} – име: ${name}`, { keep: true, before: 180 }) + p("Подпис: ______________________________", { keep: i < roles.length - 1 })).join("");
}
const xmlEsc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Допълнения, които могат да останат празни (без линия)
const OPTIONAL = new Set(["delKm", "retKm", "seatTotal"]);
let template: Record<string, Uint8Array> | null = null;

// Връща попълнения договор като .docx
export function buildContract(d: ContractData): Uint8Array {
  template ||= unzipSync(Buffer.from(TEMPLATE_BASE64, "base64"));
  const v = values(d);
  // Имената на наемателя над подписите („Име: …“) остават празни – наемателят ги пише ръчно при подписване
  const xml = strFromU8(template["word/document.xml"])
    .replace(/Име: \{\{name\}\}/g, "Име: {{signName}}")
    // „Място“ в двете декларации е мястото, откъдето клиентът взема автомобила (офисът или адресът за доставка)
    .replace(/Място: Пловдив[.,] бул\. Дунав 10/g, "Място: {{pickupPlace}}")
    .replace(/\{\{(\w+)\}\}/g, (_, k) => xmlEsc(v[k] || (OPTIONAL.has(k) ? "" : BLANK)))
    .replace(/(<w:sectPr[\s>])/, (m) => appendixXml(d) + m);
  return zipSync({ ...template, "word/document.xml": strToU8(xml) }, { level: 6 });
}

export function contractFileName(d: ContractData) {
  return `Dogovor-naem-${d.carId || "kola"}-${d.d1 || "data"}.docx`;
}
