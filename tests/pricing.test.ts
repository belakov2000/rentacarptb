// node --experimental-strip-types --test tests/
// Сървърната цена (server/pricing.ts) трябва да е същата като цената, която браузърът показва (index.html → quote()).
// Функциите и константите се вземат от самия index.html и се изпълняват в изолиран контекст – без ръчно копие.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { ABROAD, CHAINS_DAY, DEPOSIT, fmtCents, price, priceLines, PRICING_VERSION, SEAT_DAY, SECOND_DRIVER_DAY, TIERS } from "../server/pricing.ts";


const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const grab = (re: RegExp) => {
  const m = re.exec(html);
  assert.ok(m, "липсва в index.html: " + re);
  return m[0];
};
// Само чистите функции за цената (без DOM)
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
  "globalThis.T={CARS,ABROAD,SEAT,DEPOSIT,KMS,quote,fmt};",
].join("\n");
const ctx: any = {};
vm.createContext(ctx);
vm.runInContext(code, ctx);
const B = ctx.T;

test("константите са същите като на сайта", () => {
  for (const c of B.CARS) assert.equal(JSON.stringify(TIERS[c.id]), JSON.stringify(c.tiers), c.id);
  assert.equal(JSON.stringify(Object.keys(TIERS).sort()), JSON.stringify(B.CARS.map((c: any) => c.id).sort()));
  assert.equal(SEAT_DAY, B.SEAT);
  assert.equal(DEPOSIT, B.DEPOSIT);
  assert.equal(JSON.stringify(ABROAD), JSON.stringify(B.ABROAD));
  assert.equal(CHAINS_DAY, 3.5);
  assert.equal(SECOND_DRIVER_DAY, 3);
  assert.ok(PRICING_VERSION);
});

// Браузърът: обща сума като текст (fmt) → евроцентове (същото правило като db/money.ts)
const browserCents = (tot: number) => {
  const m = /^(\d+)(?:,(\d{2}))? €$/.exec(B.fmt(tot))!;
  return Number(m[1]) * 100 + Number(m[2] || 0);
};
const PERIODS: [string, string, string, string][] = [
  ["2027-03-01", "10:00", "2027-03-01", "18:00"], // под 24 ч → 1 ден
  ["2027-03-01", "10:00", "2027-03-02", "10:00"], // точно 24 ч → 1 ден
  ["2027-03-01", "10:00", "2027-03-02", "10:01"], // започнат втори ден → 2
  ["2027-03-01", "09:00", "2027-03-16", "09:00"], // 15 дни – първо ниво
  ["2027-03-01", "09:00", "2027-03-16", "09:30"], // 16 дни – второ ниво
  ["2027-03-01", "09:00", "2027-03-31", "09:00"], // 30 дни
  ["2027-03-01", "09:00", "2027-03-31", "10:00"], // 31 дни – трето ниво
  ["2027-03-28", "08:00", "2027-04-02", "20:00"], // през лятното часово време (датите са местни)
];
const LEGS: [number | null, number, number | null, number][] = [[null, 1, null, 1], [12.4, 1, null, 1], [null, 1, 33.3, 0.7], [7.7, 0.7, 101.9, 0.7], [0, 1, 0.1, 1]];

test("сървърът изчислява същата сума като браузъра", () => {
  let n = 0;
  for (const car of B.CARS)
    for (const [d1, t1, d2, t2] of PERIODS)
      for (const seats of [0, 1, 2])
        for (const [k1, r1, k2, r2] of LEGS)
          for (const abr of [[], ["gr"], ["de", "it"]]) {
            B.KMS[1] = k1; B.KMS[2] = k2; B.KMS.r[1] = r1; B.KMS.r[2] = r2;
            const R = { d1, t1, d2, t2, seat: seats > 0, seatN: seats, m1: k1 == null ? "office" : "addr", m2: k2 == null ? "office" : "addr", abr: abr.length > 0, ctry: abr };
            const q = B.quote(car, R);
            const s = price({ carId: car.id, startDate: d1, startTime: t1, endDate: d2, endTime: t2, seats, del: k1 == null ? null : { km: k1, rate: r1 }, ret: k2 == null ? null : { km: k2, rate: r2 }, abroad: abr });
            assert.ok(s.ok && !q.err, JSON.stringify(R));
            if (!s.ok) continue;
            assert.equal(s.days, q.d, "дни " + JSON.stringify(R));
            assert.equal(s.rentCents, Math.round(q.base * 100), "наем " + JSON.stringify(R));
            assert.equal(s.totalCents, browserCents(q.tot), `${car.id} ${JSON.stringify(R)}`);
            n++;
          }
  assert.ok(n > 1000, "брой сравнения " + n);
});

test("вериги и втори водач: вътрешни правила по брой дни (още не се предлагат на клиентите)", () => {
  const p = price({ carId: "golf", startDate: "2027-01-10", startTime: "10:00", endDate: "2027-01-14", endTime: "10:00", seats: 0, del: null, ret: null, abroad: [], chains: true, secondDriver: true });
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.days, 4);
  assert.equal(p.lines.find((l) => l.code === "chains")!.cents, 1400); // 4 × 3,50 €
  assert.equal(p.lines.find((l) => l.code === "second_driver")!.cents, 1200); // 4 × 3 €
  assert.equal(p.totalCents, 4 * 2500 + 1400 + 1200);
  assert.equal(p.depositCents, 10000);
  assert.ok(!p.lines.some((l) => (l.code as string) === "deposit"), "депозитът не е в сумата");
});

test("невалидни входни данни не дават цена", () => {
  const base = { carId: "golf", startDate: "2027-01-10", startTime: "10:00", endDate: "2027-01-12", endTime: "10:00", seats: 0, del: null, ret: null, abroad: [] as string[] };
  assert.deepEqual(price({ ...base, carId: "tesla" }), { ok: false, error: "car" });
  assert.deepEqual(price({ ...base, endDate: "2027-01-09" }), { ok: false, error: "order" });
  assert.deepEqual(price({ ...base, seats: 3 }), { ok: false, error: "seats" });
  assert.deepEqual(price({ ...base, del: { km: 5, rate: 0.5 } }), { ok: false, error: "km" });
  assert.deepEqual(price({ ...base, abroad: ["xx"] }), { ok: false, error: "country" });
  assert.deepEqual(price({ ...base, startTime: "" }), { ok: false, error: "dates" });
});

test("текстът на цената за известието до фирмата и форматът на сумите", () => {
  const p = price({ carId: "ka", startDate: "2027-03-01", startTime: "10:00", endDate: "2027-03-03", endTime: "10:00", seats: 1, del: { km: 12.4, rate: 1 }, ret: null, abroad: ["gr"] });
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual(priceLines(p), ["Наем: 2 дни × 20 € = 40 €", "Детско столче: 1 бр. × 2 дни × 3 € = 6 €", "Доставка до адрес: 12,4 км × 1,00 €/км = 12,40 €", "Пътуване в чужбина – Гърция: 100 €", "Общо за услугите: 158,40 €", "Гаранционен депозит (не е част от сумата): 100 €"]);
  assert.equal(fmtCents(5000), "50 €");
  assert.equal(fmtCents(15840), "158,40 €");
  assert.equal(fmtCents(5), "0,05 €");
});
