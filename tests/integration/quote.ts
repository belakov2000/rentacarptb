// Етап 2: сървърът определя цената на новите резервации (server/quote.ts, /api/quote, /api/bookings).
// Синтетични данни; маршрутите (OpenStreetMap / OSRM), Brevo и Identity са симулирани (harness.ts). Без реални имейли и външни заявки.
import { eq, sql } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { adminJar, bookingBody, check, contractData, finish, freshDb, mail, O, quoteFor, routes, schema, setContext, withQuote } from "./harness.ts";
import { stores } from "./stubs/blobs.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import quoteFn from "../../netlify/functions/quote.mts";
import routeFn from "../../netlify/functions/route.mts";
import adminBookingsFn from "../../netlify/functions/admin-bookings.mts";
import { createQuote, QUOTE_TTL_MS } from "../../server/quote.ts";
import { price } from "../../server/pricing.ts";

setContext("deploy-preview");
const t = await freshDb("quote");
t.use();
const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
const count = async (q: string, p: unknown[] = []) => (await t.q(q, p)).rows[0].n as number;
const nBookings = () => count("select count(*)::int n from bookings");
const nQuotes = () => count("select count(*)::int n from price_quotes");
const post = async (body: unknown) => {
  const r = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: {} } as any);
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const quote = async (body: unknown) => {
  const r = await quoteFn(new Request(`${O}/api/quote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const cdocs = () => stores.get("deploypreview-contracts")!;
const docXml = (id: string) => strFromU8(unzipSync(new Uint8Array(cdocs().get(id)!.data))["word/document.xml"]);
const cdata = (id: string) => JSON.parse(Buffer.from(cdocs().get(id + ".json")!.data).toString());
let k = 0;
const body = (o: { car?: string; d1?: string; t1?: string; d2?: string; t2?: string; contract?: Record<string, unknown> | null; extra?: Record<string, unknown> } = {}) => {
  k++;
  const d1 = o.d1 || "2028-06-05", t1 = o.t1 || "10:00", d2 = o.d2 || "2028-06-07", t2 = o.t2 || "10:00";
  const c = o.contract === null ? {} : { contract: { ...contractData(d1, t1, d2, t2), del: null, ...(o.contract || {}) } };
  return bookingBody(`Q${k}`, d1, t1, d2, t2, { carId: o.car || "golf", car: o.car || "golf", requestKey: `quote-test-${k}-key`, ...c, ...(o.extra || {}) });
};
const q0 = { carId: "golf", startDate: "2028-06-05", startTime: "10:00", endDate: "2028-06-07", endTime: "10:00", seats: 0, delivery: null, return: null, abroad: [] };

// ===== 1. Цени за всички автомобили и ценови граници (същите като сайта; браузърът – tests/pricing.test.ts) =====
{
  const exp: Record<string, number[]> = { punto: [20, 18, 15], ka: [20, 18, 15], ibiza: [25, 23, 20], golf: [25, 23, 20], passat: [25, 23, 20] };
  const P: [string, string, string, string, number][] = [
    ["2028-06-05", "10:00", "2028-06-05", "18:00", 1], ["2028-06-05", "10:00", "2028-06-06", "10:00", 1], ["2028-06-05", "10:00", "2028-06-06", "10:01", 2],
    ["2028-06-01", "09:00", "2028-06-16", "09:00", 15], ["2028-06-01", "09:00", "2028-06-16", "09:30", 16], ["2028-06-01", "09:00", "2028-07-01", "09:00", 30], ["2028-06-01", "09:00", "2028-07-01", "10:00", 31],
  ];
  let bad: string[] = [], n = 0;
  for (const car of Object.keys(exp))
    for (const [d1, t1, d2, t2, days] of P) {
      const r = await quote({ ...q0, carId: car, startDate: d1, startTime: t1, endDate: d2, endTime: t2 });
      const daily = exp[car][days > 30 ? 2 : days > 15 ? 1 : 0];
      n++;
      if (r.status !== 200 || r.json.days !== days || r.json.totalCents !== daily * 100 * days || r.json.depositCents !== 10000) bad.push(`${car} ${d1} ${t1}→${d2} ${t2}: ${r.status} ${r.json.days} ${r.json.totalCents}`);
    }
  check("1.1 всички автомобили и ценови граници (1/15/16/30/31 дни, започнат 24-часов период) – текущите цени без допълнително −20%", bad.length === 0, `${n} оферти ${bad.join("; ")}`);
  const s = await quote({ ...q0, seats: 2, abroad: ["gr", "de"] });
  check("1.2 столчета (2 × 2 дни × 3 €) и чужбина (100 € + 180 €); депозитът е отделно", s.json.totalCents === 5000 + 1200 + 28000 && s.json.lines.some((l: any) => l.code === "seats" && l.cents === 1200) && !s.json.lines.some((l: any) => l.code === "deposit") && s.json.depositCents === 10000, `${s.json.total}`);
  const d = await quote({ ...q0, delivery: "ул. Тестова 1", return: "с. Далеч 5" });
  check("1.3 доставка и връщане: км и тарифа от сървъра (5 км × 1,00 € + 150 км × 0,70 €), закръгляне до евроцент", d.status === 200 && d.json.totalCents === 5000 + 500 + 10500 && d.json.legs.del.km === 5 && d.json.legs.del.rate === 1 && d.json.legs.ret.rate === 0.7, `${d.json.total}`);
  const p = price({ carId: "passat", startDate: "2028-06-05", startTime: "10:00", endDate: "2028-06-06", endTime: "10:00", seats: 0, del: { km: 12.35, rate: 0.7 }, ret: { km: 0.05, rate: 1 }, abroad: [] });
  check("1.4 закръгляне на всяка такса за км до цял евроцент (12,35 км × 0,70 € = 8,65 €; 0,05 км × 1 € = 0,05 €)", p.ok && p.lines[1].cents === 865 && p.lines[2].cents === 5 && p.totalCents === 2500 + 865 + 5, p.ok ? String(p.totalCents) : "");
}

// ===== 2. Часове, дати и смяна на часовото време (Europe/Sofia) =====
{
  // Броят дни е по местния час (както на сайта и в договора): 30.10.2027 10:00 → 31.10.2027 10:00 е 1 ден, въпреки 25 реални часа
  const back = await quote({ ...q0, startDate: "2027-10-30", startTime: "10:00", endDate: "2027-10-31", endTime: "10:00" });
  const fwd = await quote({ ...q0, startDate: "2027-03-27", startTime: "10:00", endDate: "2027-03-28", endTime: "10:00" });
  const fwd2 = await quote({ ...q0, startDate: "2027-03-27", startTime: "10:00", endDate: "2027-03-28", endTime: "10:01" });
  check("2.1 смяна на часовото време: по местния час 24 ч = 1 ден (есен 25 реални ч, пролет 23 реални ч); +1 мин = 2 дни", back.json.days === 1 && fwd.json.days === 1 && fwd2.json.days === 2, `${back.json.days}/${fwd.json.days}/${fwd2.json.days}`);
  const edge = await quote({ ...q0, startDate: "2028-06-05", startTime: "08:00", endDate: "2028-06-07", endTime: "20:00" }); // понеделник → сряда
  const sun = await quote({ ...q0, startDate: "2028-06-04", startTime: "19:01", endDate: "2028-06-07", endTime: "10:00" }); // неделя 19:01
  const past = await quote({ ...q0, startDate: "2020-01-06", endDate: "2020-01-08" });
  const order = await quote({ ...q0, endDate: "2028-06-04" });
  check("2.2 работно време: 08:00 и 20:00 в делник се приемат; неделя 19:01 → hours; минала дата → past; връщане преди получаване → order",
    edge.status === 200 && sun.status === 400 && sun.json.error === "hours" && past.json.error === "past" && order.json.error === "order", `${edge.status} ${sun.json.error} ${past.json.error} ${order.json.error}`);
}

// ===== 3. Подправени суми, тарифи, километри и услуги =====
{
  const b = body({ contract: { del: { addr: "ул. Тестова 1", km: 0.1, rate: 0.7 }, days: 1, rent: 1 }, extra: { total: "1 €" } });
  const q = await withQuote(b);
  const r = await post(q);
  const s = await row(r.json.id);
  const cd = cdata(r.json.id);
  check("3.1 сума „1 €“, наем 1 € и 0,1 км × 0,70 € от браузъра се игнорират: записва се сървърната сума 55 € и км/тарифа от сървъра",
    r.status === 201 && s.total === "55 €" && s.totalCents === 5500 && s.totalReview === "" && s.priceCheckStatus === "server" && cd.rent === 50 && cd.days === 2 && cd.del.km === 5 && cd.del.rate === 1, `${s.total} rent ${cd.rent} km ${cd.del.km}×${cd.del.rate}`);
  check("3.2 снимката на цената в резервацията е без адреса и личните данни", !/Тестова|ТЕСТ|example/.test(JSON.stringify(s.priceCheck)) && (s.priceCheck as any).server.totalCents === 5500, "");
  const kmSpoof = await quote({ ...q0, delivery: "ул. Тестова 2", km: 0.1, rate: 0.7, totalCents: 1 });
  check("3.3 /api/quote не приема км, тарифа или сума от браузъра (полетата се игнорират)", kmSpoof.json.legs.del.km === 5 && kmSpoof.json.legs.del.rate === 1 && kmSpoof.json.totalCents === 5500, kmSpoof.json.total);
  const b2 = await withQuote(body());
  const n0 = await nBookings(), m0 = mail.sent.length;
  const low = await post({ ...b2, quoteTotalCents: 100 });
  check("3.4 подадена друга „видяна“ сума (quoteTotalCents) → 409 price_changed с текущата сума; нищо не е записано и изпратено", low.status === 409 && low.json.error === "price_changed" && low.json.currentCents === 5000 && (await nBookings()) === n0 && mail.sent.length === m0, low.json.error);
  const seat = await post({ ...b2, contract: { ...b2.contract, seat: 6, seatN: 1, seatDay: 3 } });
  const abr = await post({ ...b2, contract: { ...b2.contract, abroad: [{ name: "Гърция", fee: 0 }] } });
  const unk = await post({ ...b2, contract: { ...b2.contract, abroad: [{ name: "Марс", fee: 0 }] } });
  check("3.5 добавено столче или държава след офертата → quote_mismatch; непозната държава → 400", seat.json.error === "quote_mismatch" && abr.json.error === "quote_mismatch" && unk.status === 400 && unk.json.error === "invalid_services", `${seat.json.error} ${abr.json.error} ${unk.json.error}`);
  const ch1 = await post({ ...b2, chains: true });
  const ch2 = await post({ ...b2, contract: { ...b2.contract, secondDriver: true } });
  const ch3 = await quote({ ...q0, chains: true });
  const ch4 = await quote({ ...q0, services: { secondDriver: true } });
  check("3.6 вериги и втори водач не могат да бъдат активирани през API (резервация 400, оферта 400 service)", ch1.status === 400 && ch2.status === 400 && ch3.json.error === "service" && ch4.json.error === "service", `${ch1.status} ${ch2.status} ${ch3.json.error} ${ch4.json.error}`);
  const seats3 = await quote({ ...q0, seats: 3 }), car = await quote({ ...q0, carId: "tesla" }), cc = await quote({ ...q0, abroad: ["xx"] }), dup = await quote({ ...q0, abroad: ["gr", "gr"] });
  check("3.7 невалидни услуги в офертата: 3 столчета, непознат автомобил, непозната или повторена държава → 400", seats3.json.error === "seats" && car.json.error === "car" && cc.json.error === "country" && dup.json.error === "country", "");
  const ok = await post(b2);
  check("3.8 същата оферта с правилните данни → 201 (сумата 50 € е сървърната)", ok.status === 201 && (await row(ok.json.id)).totalCents === 5000, "");
}

// ===== 4. Липсваща, изтекла, чужда и използвана оферта; стара версия на страницата =====
{
  const n0 = await nBookings(), m0 = mail.sent.length;
  const old = await post(body({ extra: { total: "50 €" } }));
  check("4.1 стара страница (без оферта) → 409 quote_required с текст за презареждане; няма резервация и писма", old.status === 409 && old.json.error === "quote_required" && /Презаредете/.test(old.json.detail) && (await nBookings()) === n0 && mail.sent.length === m0, old.json.detail);
  const fake = await post({ ...body(), quote: "f".repeat(64), quoteTotalCents: 5000 });
  const junk = await post({ ...body(), quote: "<script>", quoteTotalCents: 5000 });
  check("4.2 непознат или невалиден ключ → quote_required", fake.json.error === "quote_required" && junk.json.error === "quote_required", "");
  const e = await withQuote(body());
  await t.q("update price_quotes set expires_at = now() - interval '1 second' where booking_id is null");
  const exp = await post(e);
  check("4.3 изтекла оферта → 409 quote_expired (срокът се проверява на сървъра)", exp.status === 409 && exp.json.error === "quote_expired" && QUOTE_TTL_MS === 30 * 60_000, exp.json.error);
  const other = await withQuote(body({ car: "passat", d1: "2028-08-01", d2: "2028-08-03" }));
  const mine = body();
  const foreign = await post({ ...mine, quote: other.quote, quoteTotalCents: other.quoteTotalCents });
  check("4.4 чужда оферта (друг автомобил и дати) → quote_mismatch", foreign.status === 409 && foreign.json.error === "quote_mismatch", foreign.json.error);
  const a = await withQuote(body({ d1: "2028-09-01", d2: "2028-09-02" }));
  const r1 = await post(a);
  const reuse = await post({ ...body({ d1: "2028-09-01", d2: "2028-09-02" }), quote: a.quote, quoteTotalCents: a.quoteTotalCents });
  check("4.5 използвана оферта за друга заявка (друг клиент и ключ) → quote_used; първата резервация остава единствена", r1.status === 201 && reuse.status === 409 && reuse.json.error === "quote_used", reuse.json.error);
  const again = await post(a);
  check("4.6 повторно изпращане на същата заявка (същият ключ) след използване на офертата → същата резервация (duplicate)", again.status === 200 && again.json.duplicate === true && again.json.id === r1.json.id, "");
}

// ===== 5. Промяна на данните след офертата =====
{
  const b = await withQuote(body({ contract: { del: { addr: "ул. Тестова 7", km: null, rate: null } } }));
  const date = await post({ ...b, endDate: "2028-06-08", dropoff: "x", contract: { ...b.contract, d2: "2028-06-08" } });
  const time = await post({ ...b, endTime: "11:00" });
  const addr = await post({ ...b, contract: { ...b.contract, del: { addr: "ул. Друга 7", km: 5, rate: 1 } } });
  const car = await post({ ...b, carId: "passat" });
  check("5.1 промяна на дата, час, адрес или автомобил след офертата → quote_mismatch (нужна е нова оферта)", [date, time, addr, car].every((x) => x.status === 409 && x.json.error === "quote_mismatch"), [date, time, addr, car].map((x) => x.json.error).join());
  const ws = await post({ ...b, contract: { ...b.contract, del: { addr: "  УЛ.  Тестова   7 ", km: 1, rate: 1 } } });
  check("5.2 само интервали и главни/малки букви в адреса не са промяна → 201", ws.status === 201 && (await row(ws.json.id)).totalCents === 5500, String(ws.status));
}

// ===== 6. Липсващ маршрут и възстановяване след грешка =====
{
  const n0 = await nQuotes();
  const nf = await quote({ ...q0, delivery: "ул. Няма 1" });
  const net = await quote({ ...q0, return: "ул. Мрежа 1" });
  check("6.1 адресът не е намерен / мрежова грешка → 502 route с вида и посоката; няма оферта (няма нулева доставка)", nf.status === 502 && nf.json.error === "route" && nf.json.leg === "del" && nf.json.reason === "not_found" && net.status === 502 && net.json.leg === "ret" && net.json.reason === "error" && (await nQuotes()) === n0, `${nf.json.reason}/${net.json.reason}`);
  const slow = await createQuote({ carId: "golf", startDate: "2028-06-05", startTime: "10:00", endDate: "2028-06-07", endTime: "10:00", seats: 0, del: "ул. Бавна 1", ret: null, abroad: [] }, { route: () => new Promise(() => {}), timeoutMs: 50 });
  check("6.2 маршрут без отговор → timeout, без оферта", !slow.ok && slow.error === "route" && (slow as any).reason === "timeout" && (await nQuotes()) === n0, "");
  const bad = body({ contract: { del: { addr: "ул. Няма 1", km: 0, rate: 1 } } });
  const n1 = await nBookings();
  const noQ = await post(await withQuote(bad));
  check("6.3 заявка без изчислен маршрут не се записва (409 quote_required) – нито с 0 км, нито с км от браузъра", noQ.status === 409 && (await nBookings()) === n1, noQ.json.error);
  const fixed = await withQuote({ ...bad, contract: { ...bad.contract, del: { addr: "ул. Намерена 1", km: 0, rate: 1 } } });
  const ok = await post(fixed);
  check("6.4 след поправка на адреса: нова оферта и записана резервация със сървърната доставка", ok.status === 201 && (await row(ok.json.id)).totalCents === 5500, String(ok.status));
}

// ===== 7. Кеш на маршрутите (без повторни платени заявки) =====
{
  const c0 = routes.calls;
  await quote({ ...q0, delivery: "ул. Кеш 1" });
  const c1 = routes.calls;
  await quote({ ...q0, delivery: "ул.  кеш 1 " });
  await quote({ ...q0, delivery: "ул. Кеш 1", startDate: "2028-06-06", endDate: "2028-06-09" });
  const rr = await routeFn(new Request(`${O}/api/route?destination=${encodeURIComponent("ул. Кеш 1")}`));
  const rj = await rr.json();
  check("7.1 същият адрес (и с други интервали/букви) се търси при доставчика веднъж за офертите и /api/route (в срока на кеша)", c1 > c0 && routes.calls === c1 && rr.status === 200 && rj.km === 5 && rj.rate === 1, `заявки: ${c1 - c0} → ${routes.calls - c0}`);
  const rows = (await t.q("select * from route_cache")).rows;
  check("7.2 кешът е в базата (route_cache): ключът е хеш, без адреса и намереното място", rows.length > 0 && rows.every((r: any) => /^v5\/[a-f0-9]{64}$/.test(r.key)) && !/Кеш|Синтетично|Тестова/.test(JSON.stringify(rows)), rows[0]?.key);
}

// ===== 8. Едновременни и повторни изпращания =====
{
  const b = await withQuote(body({ d1: "2028-11-01", d2: "2028-11-03" }));
  const n0 = await nBookings();
  const same = await Promise.all(Array.from({ length: 6 }, () => post(b)));
  check("8.1 6 едновременни изпращания (същата заявка и оферта) → 1 резервация, останалите – същата", same.filter((r) => r.status === 201).length === 1 && new Set(same.map((r) => r.json.id)).size === 1 && (await nBookings()) === n0 + 1, same.map((r) => r.status).join());
  const c = await withQuote(body({ d1: "2028-11-10", d2: "2028-11-12" }));
  const diff = await Promise.all(Array.from({ length: 5 }, (_, i) => post({ ...c, email: `race-${i}@example.com`, requestKey: `race-key-${i}-xxxx` })));
  check("8.2 5 едновременни заявки от различни клиенти с една оферта → 1 резервация, останалите 409 quote_used", diff.filter((r) => r.status === 201).length === 1 && diff.filter((r) => r.status === 409 && r.json.error === "quote_used").length === 4, diff.map((r) => r.status + (r.json.error || "")).join());
  const used = await count("select count(*)::int n from price_quotes where booking_id is not null and booking_id not in (select id from bookings)");
  check("8.3 няма оферта, вързана към несъществуваща резервация", used === 0, String(used));
}

// ===== 9. Договор и писма с една и съща сървърна цена; админ панел и договорена сума =====
{
  mail.sent.length = 0;
  const b = await withQuote(body({ car: "passat", d1: "2028-12-04", d2: "2028-12-06", contract: { seat: 3, seatN: 1, seatDay: 3, del: { addr: "ул. Писмо 1", km: 99, rate: 0.7 }, abroad: [{ name: "Гърция", fee: 1 }] },
    extra: { total: "1 €", message: "Заявка за наем: Volkswagen Passat\nОбщо за услугите: 1 €\nБрой дни: 2, цена на ден: 0,50 €, наем на автомобила: 1 €\nДетско столче: да, 1 бр.\nПътуване в чужбина: Гърция (1 €)\n\nПЛАЩАНЕ: В брой на място с касов бон\n\nКЛИЕНТ\nИмена: ТЕСТ\n\nДОКУМЕНТ ЗА САМОЛИЧНОСТ\nЕГН: 8001010000" } }));
  const r = await post(b);
  const s = await row(r.json.id);
  // 2 × 25 + столче 2 × 3 + доставка 5 км × 1 + Гърция 100 = 161 €
  const owner = mail.sent.find((m) => /Нова заявка/.test(m.subject))!, cust = mail.sent.find((m) => m.to === b.email)!;
  const x = docXml(r.json.id);
  check("9.1 резервацията: 161 € (наем, столче, доставка, чужбина – от сървъра)", r.status === 201 && s.totalCents === 16100 && s.total === "161 €", s.total);
  check("9.2 писмо до фирмата: сървърната разбивка и сума; редовете със сумите от браузъра са махнати; без ЕГН",
    owner.html.includes("ЦЕНА (изчислена от сървъра)") && owner.html.includes("Общо за услугите: 161 €") && owner.html.includes("Доставка до адрес: 5 км × 1,00 €/км = 5 €") && owner.html.includes("Гърция: 100 €") && !owner.html.includes("Общо за услугите: 1 €") && !owner.html.includes("0,50 €") && !owner.html.includes("8001010000") && owner.html.includes("Гаранционен депозит (не е част от сумата): 100 €"), "");
  check("9.3 писмо до клиента: същата сума", cust.html.includes("161 €"), "");
  check("9.4 договорът: наем 50,00 EUR, столче 3,00 EUR/ден общо 6,00 EUR, 5 км × 1,00 EUR (5,00 EUR), чужбина 100,00 EUR",
    x.includes("50,00 EUR") && x.includes("общо 6,00 EUR") && x.includes("5 км по пътен маршрут × 1,00 EUR/км") && x.includes("5,00 EUR") && x.includes("100,00 EUR") && !x.includes("99 км"), "");
  const jar = adminJar();
  setContext("deploy-preview", { cookies: jar, ip: "203.0.113.20" });
  const d = await adminBookingsFn(new Request(`${O}/api/admin/bookings/${r.json.id}`, { headers: { Origin: O } }), { ip: "203.0.113.20", params: { id: r.json.id } } as any);
  const dj: any = await d.json();
  setContext("deploy-preview");
  check("9.5 админ панел: статус „server“, разбивка и договорена сума = сървърната; депозитът е отделно", d.status === 200 && dj.booking.priceCheckStatus === "server" && dj.finance.agreedCents === 16100 && dj.booking.priceCheck.server.depositCents === 10000, `${d.status} ${dj.finance?.agreedCents}`);
  const page = await (await bookingsFn(new Request(`${O}/api/bookings/${s.id}/manage?key=${s.adminToken}`, { method: "POST", body: new URLSearchParams({ action: "confirm" }) }), { params: { id: s.id } } as any)).text();
  const dec = mail.sent.filter((m) => m.to === b.email).at(-1)!;
  check("9.6 потвърждение: писмото до клиента е със същата сума и депозит 100 € отделно", /потвърдена/.test(page) && dec !== cust && dec.html.includes("161 €") && dec.html.includes("100 €"), "");
}

// ===== 10. Стари резервации и удължаване =====
{
  await t.q(`insert into bookings (id, view_token, admin_token, name, email, phone, car, car_id, start_date, end_date, start_time, end_time, pickup, dropoff, total, total_cents, status)
    values ('${"1".repeat(32)}', 'v', 'a', 'ТЕСТ Стара', 'old@example.com', '+359', 'Golf', 'golf', '2028-12-20', '2028-12-22', '10:00', '10:00', 'x', 'y', '1 €', 100, 'confirmed')`);
  await post(await withQuote(body({ d1: "2028-12-10", d2: "2028-12-11" })));
  const old = await row("1".repeat(32));
  check("10.1 стара резервация не се преизчислява (сума, статус на проверката)", old.total === "1 €" && old.totalCents === 100 && old.priceCheckStatus === null, "");
  const n = await count("select count(*)::int n from bookings where price_check_status = 'server' and total_cents is null");
  check("10.2 всяка нова резервация има сървърна сума", n === 0, "");
  const b = await withQuote(body({ car: "ka", d1: "2029-01-08", d2: "2029-01-10" }));
  const r = await post(b);
  const s = await row(r.json.id);
  await bookingsFn(new Request(`${O}/api/bookings/${s.id}/manage?key=${s.adminToken}`, { method: "POST", body: new URLSearchParams({ action: "confirm" }) }), { params: { id: s.id } } as any);
  const jar = adminJar();
  setContext("deploy-preview", { cookies: jar, ip: "203.0.113.21" });
  const call = async (fields: Record<string, unknown>) => {
    const res = await adminBookingsFn(new Request(`${O}/api/admin/bookings/${s.id}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: O }, body: JSON.stringify(fields) }), { ip: "203.0.113.21", params: { id: s.id } } as any);
    return { status: res.status, json: (await res.json()) as any };
  };
  const eq1 = await call({ action: "extend_quote", newEndDate: "2029-01-12", newEndTime: "10:00" });
  const ex = await call({ action: "extend", newEndDate: "2029-01-12", newEndTime: "10:00", confirmCents: eq1.json.quote?.addedCents, idempotencyKey: "ext-quote-test-1" });
  setContext("deploy-preview");
  const after = await row(s.id);
  check("10.3 удължаване на сървърно оценена резервация: 2 дни × 20 € по договорената дневна цена, нова сума 80 € (правилата не са променени)",
    s.totalCents === 4000 && eq1.json.quote?.auto === true && eq1.json.quote.dailyCents === 2000 && ex.status === 200 && after.totalCents === 8000 && after.endDate === "2029-01-12", `${s.totalCents} → ${after.totalCents} ${eq1.json.quote?.reason || ""}`);
}

// ===== 11. Промяна на цената между офертата и подаването =====
{
  const b = await withQuote(body({ d1: "2029-02-05", d2: "2029-02-07" }));
  // Офертата е издадена по „стари“ правила (симулирано в базата): друга сума и версия
  await t.q("update price_quotes set total_cents = 4000, version = 'old' where id = encode(sha256($1::bytea), 'hex')", [b.quote]);
  const n0 = await nBookings();
  const r = await post({ ...b, quoteTotalCents: 4000 });
  check("11.1 цената по текущите правила е друга → 409 price_changed с новата сума; не се записва тихо по-висока цена", r.status === 409 && r.json.error === "price_changed" && r.json.currentCents === 5000 && r.json.currentTotal === "50 €" && (await nBookings()) === n0, `${r.json.error} ${r.json.currentTotal}`);
  const nq = await quoteFor(b);
  const ok = await post({ ...b, quote: nq.json.quote, quoteTotalCents: nq.json.totalCents });
  check("11.2 след нова оферта и потвърждение на новата сума → 201", ok.status === 201 && (await row(ok.json.id)).totalCents === 5000, "");
}

// ===== 12. Офертата не блокира наличност; заетостта се проверява при подаването =====
{
  const a = await withQuote(body({ car: "ibiza", d1: "2029-03-05", d2: "2029-03-07" }));
  const b = await withQuote(body({ car: "ibiza", d1: "2029-03-06", d2: "2029-03-08" }));
  const ra = await post(a);
  const sa = await row(ra.json.id);
  await bookingsFn(new Request(`${O}/api/bookings/${sa.id}/manage?key=${sa.adminToken}`, { method: "POST", body: new URLSearchParams({ action: "confirm" }) }), { params: { id: sa.id } } as any);
  const rb = await post(b);
  check("12.1 две оферти за застъпващи се периоди се издават; след потвърждаване на първата втората заявка → 409 busy", ra.status === 201 && rb.status === 409 && rb.json.error === "busy", `${ra.status}/${rb.status}`);
  await t.q("update cars set status = 'inactive' where id = 'punto'");
  const inact = await quote({ ...q0, carId: "punto" });
  await t.q("update cars set status = 'active' where id = 'punto'");
  check("12.2 неактивен автомобил → оферта 409 car_inactive", inact.status === 409 && inact.json.error === "car_inactive", "");
}

const sent = mail.sent.filter((m) => !/@example\.com$/.test(m.to) && m.to !== "rentaptb_stroi@abv.bg");
check("Имейлите са само към синтетични адреси (Brevo е симулиран)", sent.length === 0, sent.map((m) => m.to).join());
await finish();
