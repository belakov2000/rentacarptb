// Сървърна оферта: един източник за данните. Браузърът (index.html → qInput, contractData) и сървърът (server/quote.ts →
// parseQuoteBody, bookingInput) трябва да обвързват офертата с едни и същи данни, иначе всяка заявка би била „променена“.
// Функциите се вземат от самия index.html (без ръчно копие). Без база и без външни заявки.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { check, finish } from "./harness.ts";
import { bookingInput, checkInput, contractWithPrice, inputHash, parseQuoteBody } from "../../server/quote.ts";
import { withServerPrice } from "../../server/request-text.ts";
import { price, priceLines } from "../../server/pricing.ts";
import { parseContract } from "../../contract/index.ts";

const html = readFileSync("index.html", "utf8");
const grab = (re: RegExp) => {
  const m = re.exec(html);
  if (!m) throw new Error("липсва в index.html: " + re);
  return m[0];
};
const code = [
  grab(/const BASE="[^"]*",KM_RATE=[\d.]+,SEAT=\d+,DEPOSIT=\d+,PHONE="[^"]*";/),
  grab(/const ABROAD=\[[^\n]*\];/),
  grab(/const abrSel=R=>[^\n]*;/),
  "const BOOKED={passat:[],golf:[],punto:[],ka:[],ibiza:[]};let BUF=60;",
  grab(/const T25=\[[^\]]*\],T20=\[[^\]]*\];/),
  grab(/const CARS=\[[\s\S]*?\}\];/),
  grab(/const fmt=n=>[^\n]*\n/),
  grab(/const rate=\(c,d\)=>[^\n]*;/),
  grab(/function span\(a,t1,b,t2\)\{[^\n]*\}/),
  grab(/const bf=\(d,t\)=>[^\n]*;/),
  grab(/const mn=\(d,t\)=>[^\n]*;/),
  grab(/const iv=\(\[s,e,st,et\]\)=>[^\n]*;/),
  grab(/const clash=\(c,A,Z\)=>[^\n]*;/),
  "const KMS={1:null,2:null,st:{1:\"\",2:\"\"},r:{1:KM_RATE,2:KM_RATE}};",
  grab(/const kmRate=n=>[^\n]*;/),
  grab(/const seatN=R=>[^\n]*;/),
  grab(/function quote\(c,R\)\{[\s\S]*?return\{d,r,tot,rows,pend,base:r\*d\}\}/),
  grab(/const Q=\{[^\n]*\};/),
  grab(/function pinRef\(R,n\)\{[^\n]*\}/),
  grab(/const qInput=R=>[^\n]*;/),
  grab(/const qKey=R=>[^\n]*;/),
  "let S={};",
  grab(/const qOk=\(\)=>[^\n]*;/),
  grab(/const contractData=\(R,q\)=>\{[\s\S]*?abroad:abrSel\(R\)\.map\(\(\[,name,fee\]\)=>\(\{name,fee\}\)\)\}\};/),
  "globalThis.T={CARS,quote,qInput,qKey,contractData,pinRef,Q,KMS,setS:v=>{S=v}};",
].join("\n");
const ctx: any = {};
vm.createContext(ctx);
vm.runInContext(code, ctx);
const B = ctx.T;

// 1. Браузърът → /api/quote и браузърът → /api/bookings (договорът) дават един и същ отпечатък
{
  const base = { car: "passat", d1: "2027-03-01", t1: "10:00", d2: "2027-03-04", t2: "11:00", cit: "BG" };
  const states: Record<string, unknown>[] = [
    {}, { seat: true, seatN: 1 }, { seat: true, seatN: 2 }, { seat: false, seatN: 2 },
    { m1: "addr", a1: "ул. Тестова 1" }, { m2: "addr", a2: "  с. Далеч   5 " }, { m1: "addr", a1: "ул. Тестова 1", m2: "addr", a2: "ул. Тестова 1" },
    { abr: true, ctry: ["gr", "de"] }, { abr: false, ctry: ["gr"] }, { m1: "store", a1: "ул. Скрита 1" },
    // Потвърден пин на картата; след промяна на адреса пинът не се изпраща
    { m1: "addr", a1: "ул. Улична 4, Пловдив", pin1: { lat: 42.1521, lon: 24.7533, a: "ул. Улична 4, Пловдив" } },
    { m1: "addr", a1: "ул. Тестова 1", m2: "addr", a2: "с. Далеч", pin2: { lat: 42.7, lon: 23.32, a: "с. Далеч" } },
    { m1: "addr", a1: "ул. Улична 5, Пловдив", pin1: { lat: 42.1521, lon: 24.7533, a: "ул. Улична 4, Пловдив" } },
    { m1: "store", a1: "ул. Улична 4", pin1: { lat: 42.1521, lon: 24.7533, a: "ул. Улична 4" } },
  ];
  const bad: string[] = [];
  for (const st of states) {
    for (const withQuote of [false, true]) {
      const R = { ...base, ...st } as any;
      B.setS(R);
      const c = B.CARS.find((x: any) => x.id === R.car);
      // С показана сървърна оферта договорът от браузъра взема сумите от нея (сървърът ги попълва отново)
      if (withQuote) { B.Q.st = "ok"; B.Q.key = B.qKey(R); B.Q.d = { days: 3, lines: [{ code: "rent", cents: 7500 }, { code: "seats", cents: 900 }] }; } else { B.Q.st = ""; B.Q.d = null; }
      const cl = parseQuoteBody(JSON.parse(JSON.stringify(B.qInput(R))));
      const sv = bookingInput({ carId: R.car, startDate: R.d1, startTime: R.t1, endDate: R.d2, endTime: R.t2 }, JSON.parse(JSON.stringify({ contract: B.contractData(R, B.quote(c, R)), pins: { del: B.pinRef(R, 1), ret: B.pinRef(R, 2) } })));
      if ("error" in cl || "error" in sv || inputHash(cl.input) !== inputHash(sv.input)) bad.push(JSON.stringify(st) + (withQuote ? " (с оферта)" : ""));
    }
  }
  check("1. браузърът изпраща към /api/quote същите данни, по които сървърът проверява заявката (столчета, адреси, държави)", bad.length === 0, bad.join("; ") || `${states.length * 2} състояния`);
}

// 2. Отпечатъкът: всяка промяна е различна оферта; интервали и главни букви в адреса – не
{
  const i = { carId: "golf", startDate: "2027-03-01", startTime: "10:00", endDate: "2027-03-03", endTime: "10:00", seats: 0, del: "ул. Тестова 1", ret: null, abroad: ["gr", "de"] };
  const h = inputHash(i);
  const changes = [{ carId: "passat" }, { startDate: "2027-03-02" }, { startTime: "10:01" }, { endDate: "2027-03-04" }, { endTime: "11:00" }, { seats: 1 }, { del: "ул. Тестова 2" }, { del: null }, { ret: "ул. Тестова 1" }, { abroad: ["gr"] }, { delPin: { lat: 42.1521, lon: 24.7533 } }];
  check("2. отпечатък: промяна на автомобил, дата, час, столче, адрес, пин или държава → друга оферта; интервали/букви – същата",
    inputHash({ ...i, del: "  УЛ. ТЕСТОВА   1 ", abroad: ["de", "gr"] }) === h &&
    inputHash({ ...i, delPin: { lat: 42.1521, lon: 24.7533 } } as any) === inputHash({ ...i, delPin: { lat: 42.15210000001, lon: 24.7533 } } as any) && changes.every((ch) => inputHash({ ...i, ...ch } as any) !== h), "");
}

// 3. Проверка на входните данни
{
  const i = { carId: "golf", startDate: "2027-03-01", startTime: "10:00", endDate: "2027-03-03", endTime: "10:00", seats: 0, del: null, ret: null, abroad: [] as string[] };
  const r = [checkInput(i, "2027-01-01"), checkInput(i, "2027-03-02"), checkInput({ ...i, startTime: "07:59" }, "2027-01-01"), checkInput({ ...i, endDate: "2027-02-28" }, "2027-01-01"), checkInput({ ...i, del: "ул." }, "2027-01-01"), checkInput({ ...i, seats: 1.5 }, "2027-01-01")];
  check("3. checkInput: ok / past / hours / order / address / seats", r.join() === ",past,hours,order,address,seats", r.join());
  check("3a. вериги и втори водач → service (оферта и резервация)", JSON.stringify(parseQuoteBody({ ...i, chains: true })) === '{"error":"service"}' && JSON.stringify(bookingInput(i, { contract: { secondDriver: true } })) === '{"error":"service"}', "");
}

// 4. Договорът и писмото до фирмата – от сървърната разбивка
{
  const p = price({ carId: "ka", startDate: "2027-03-01", startTime: "10:00", endDate: "2027-03-03", endTime: "10:00", seats: 1, del: { km: 12.4, rate: 1 }, ret: null, abroad: ["gr"] });
  if (!p.ok) throw new Error("price");
  const q: any = { lines: p.lines, days: p.days, totalCents: p.totalCents, depositCents: p.depositCents, legs: { del: { km: 12.4, rate: 1, source: "osm" } } };
  const d = parseContract({ d1: "x", rent: 1, days: 9, seat: 0, seatN: 0, del: { addr: "ул. Тестова 1", km: 0.1, rate: 0.7 }, ret: { addr: "ул. Друга 1", km: 1, rate: 1 }, abroad: [{ name: "Гърция", fee: 1 }] }, "ТЕСТ", "ka")!;
  const c = contractWithPrice(d, { carId: "ka", startDate: "2027-03-01", startTime: "10:00", endDate: "2027-03-03", endTime: "10:00", seats: 1, del: "ул. Тестова 1", ret: null, abroad: ["gr"] }, q);
  check("4. договор: дати, дни, наем, столче, км/тарифа и такси за чужбина от сървъра (данните от браузъра са заменени)",
    JSON.stringify([c.d1, c.days, c.rent, c.seat, c.seatN, c.seatDay, c.del, c.ret, c.abroad]) === JSON.stringify(["2027-03-01", 2, 40, 6, 1, 3, { addr: "ул. Тестова 1", km: 12.4, rate: 1 }, null, [{ name: "Гърция", fee: 100 }]]), JSON.stringify(c.abroad));
  const msg = withServerPrice("Заявка за наем: Ford Ka\nДетско столче: да, 1 бр.\nОбщо за услугите: 1 €\nБрой дни: 2, цена на ден: 0,50 €\n\nПЛАЩАНЕ: В брой\n\nКЛИЕНТ\nИмена: ТЕСТ", priceLines(p));
  check("4a. писмо до фирмата: блок „ЦЕНА“ след автомобила; сумите от браузъра са махнати; останалото е запазено",
    msg.startsWith("Заявка за наем: Ford Ka\n\nЦЕНА (изчислена от сървъра)\nНаем: 2 дни") && !msg.includes("Общо за услугите: 1 €") && !msg.includes("0,50 €") && msg.includes("ПЛАЩАНЕ: В брой") && msg.includes("Имена: ТЕСТ"), "");
}
await finish();
