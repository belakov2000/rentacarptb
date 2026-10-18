// Търсене на адреса и маршрут за доставка / връщане (server/geocode.ts, server/route.ts) през /api/quote и /api/route.
// Регресия: „гр. Пловдив, пл. Централен 1“ → 49,8 км × 0,70 € до с. Бяла река. Проверява се и кешът (route_cache, CDN).
// Синтетични данни; Nominatim / OSRM са симулирани с реалистични отговори (harness.ts, tests/fixtures/nominatim.ts).
// Без реални заявки и писма.
import { createHash } from "node:crypto";
import { bookingBody, check, contractData, finish, freshDb, http, O, routes, setContext, withQuote } from "./harness.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import quoteFn from "../../netlify/functions/quote.mts";
import routeFn from "../../netlify/functions/route.mts";
import { BASE, ROUTE_VERSION } from "../../server/route.ts";

setContext("deploy-preview");
const t = await freshDb("geocode_route");
t.use();
const CENTRAL = "гр. Пловдив, пл. Централен 1";
const q0 = { carId: "golf", startDate: "2028-06-05", startTime: "10:00", endDate: "2028-06-07", endTime: "10:00", seats: 0, delivery: null as string | null, return: null as string | null, abroad: [] as string[] };
let ip = 0; // отделен IP за всяка заявка – лимитите не са предмет на този тест
const quote = async (b: object) => {
  const r = await quoteFn(new Request(`${O}/api/quote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...q0, ...b }) }), { ip: `198.51.100.${++ip % 250}` } as any);
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const route = async (dest: string) => {
  const r = await routeFn(new Request(`${O}/api/route?destination=${encodeURIComponent(dest)}`), { ip: `198.51.100.${++ip % 250}` } as any);
  return { status: r.status, headers: r.headers, json: (await r.json().catch(() => ({}))) as any };
};
const nQuotes = async () => (await t.q("select count(*)::int n from price_quotes")).rows[0].n as number;
// Заявките към OSRM – за началната точка и реда дължина,ширина
const osrm: string[] = [];
const prev = http.handler!;
http.handler = async (url, init) => { if (url.includes("router.project-osrm.org")) osrm.push(url); return prev(url, init); };

// ===== 1. Регресия: пл. Централен в гр. Пловдив не е площадът в с. Бяла река =====
{
  const n0 = await nQuotes(), o0 = osrm.length;
  const q = await quote({ delivery: CENTRAL });
  check("1.1 /api/quote: „гр. Пловдив, пл. Централен 1“ → 502 route, reason ambiguous (уточнение), а не 49,8 км × 0,70 €", q.status === 502 && q.json.error === "route" && q.json.leg === "del" && q.json.reason === "ambiguous" && !("totalCents" in q.json), JSON.stringify(q.json));
  check("1.2 няма оферта, няма цена за доставка и няма маршрут до Бяла река", (await nQuotes()) === n0 && osrm.length === o0, `${osrm.length - o0}`);
  const r = await route(CENTRAL);
  check("1.3 /api/route: същият адрес → 422 ambiguous, без км и без CDN кеш", r.status === 422 && r.json.error === "ambiguous" && !("km" in r.json) && !r.headers.get("netlify-cdn-cache-control"), `${r.status} ${JSON.stringify(r.json)}`);
  const ret = await quote({ return: CENTRAL });
  check("1.4 същото за връщане от адрес (leg ret)", ret.status === 502 && ret.json.leg === "ret" && ret.json.reason === "ambiguous");
  // Резервация с този адрес без оферта не се записва
  const d1 = "2028-06-05", d2 = "2028-06-07";
  const b = await withQuote(bookingBody("GEO1", d1, "10:00", d2, "10:00", { carId: "golf", car: "golf", requestKey: "geo-test-1-key", contract: { ...contractData(d1, "10:00", d2, "10:00"), del: { addr: CENTRAL, km: 3.6, rate: 1 } } }));
  const br = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }), { params: {} } as any);
  const bj: any = await br.json().catch(() => ({}));
  const nb = (await t.q("select count(*)::int n from bookings")).rows[0].n;
  check("1.5 резервация с непотвърден адрес: няма оферта → отказ quote_required, нищо не е записано (км от браузъра не се приемат)", !b.quote && br.status === 409 && bj.error === "quote_required" && nb === 0, `${br.status} ${bj.error} ${nb}`);
}

// ===== 2. Коректен адрес, само улица, липсващ адрес; еднакъв резултат в /api/quote и /api/route =====
{
  const c0 = routes.calls;
  const q = await quote({ delivery: "гр. Пловдив, ул. Тестова 3" });
  const r = await route("гр. Пловдив, ул. Тестова 3");
  check("2.1 намерен номер: оферта 5 км × 1,00 €, точност house", q.status === 200 && q.json.legs.del.km === 5 && q.json.legs.del.rate === 1 && q.json.legs.del.precision === "house", JSON.stringify(q.json.legs));
  check("2.2 /api/route за същия адрес: същите км, тарифа и точност, едно търсене при доставчика (общ кеш)", r.status === 200 && r.json.km === 5 && r.json.rate === 1 && r.json.precision === "house" && routes.calls - c0 === 1, `${JSON.stringify(r.json)} заявки ${routes.calls - c0}`);
  // Недостатъчна точност → няма оферта и няма цена за доставка (адресът не се заменя с точка от улицата / центъра на селото)
  const n0 = await nQuotes(), o0 = osrm.length;
  const imp: [string, string][] = [
    ["ул. Улична 4, Пловдив", "въведен номер, на картата е само улицата"],
    ["ул. Тестова, Пловдив", "без номер"],
    ["с. Далеч", "само населеното място"],
  ];
  for (const [a, why] of imp) {
    const iq = await quote({ delivery: a }), ir = await route(a), rq = await quote({ return: a });
    check(`2.3 ${why} („${a}“): /api/quote 502 imprecise (доставка и връщане), /api/route 422 imprecise, без км и без CDN кеш`,
      iq.status === 502 && iq.json.reason === "imprecise" && iq.json.leg === "del" && !("totalCents" in iq.json) && rq.json.reason === "imprecise" && rq.json.leg === "ret" &&
      ir.status === 422 && ir.json.error === "imprecise" && !("km" in ir.json) && !ir.headers.get("netlify-cdn-cache-control"), `${iq.status} ${iq.json.reason} ${ir.status} ${ir.json.error}`);
  }
  check("2.3 при недостатъчна точност не е издадена оферта и не е изчислен маршрут", (await nQuotes()) === n0 && osrm.length === o0, `${(await nQuotes()) - n0} ${osrm.length - o0}`);
  const nq = await quote({ delivery: "ул. Няма 5" }), nr = await route("ул. Няма 5");
  check("2.4 липсващ адрес: /api/quote 502 not_found, /api/route 404", nq.status === 502 && nq.json.reason === "not_found" && nr.status === 404, `${nq.status} ${nq.json.reason} ${nr.status}`);
  const far = await quote({ delivery: "с. Далеч 5" });
  check("2.5 посочено село извън зоната с намерен номер: 150 км × 0,70 €, точност house", far.status === 200 && far.json.legs.del.km === 150 && far.json.legs.del.rate === 0.7 && far.json.legs.del.precision === "house", JSON.stringify(far.json.legs));
  // Резервация с адрес с недостатъчна точност: няма оферта → не се записва (км от браузъра не се приемат)
  const d1 = "2028-06-12", d2 = "2028-06-14";
  const b = await withQuote(bookingBody("GEO2", d1, "10:00", d2, "10:00", { carId: "golf", car: "golf", requestKey: "geo-test-2-key", contract: { ...contractData(d1, "10:00", d2, "10:00"), del: { addr: "ул. Улична 4, Пловдив", km: 4.1, rate: 1 } } }));
  const br = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }), { params: {} } as any);
  const bj: any = await br.json().catch(() => ({}));
  check("2.7 резервация с непотвърден номер: няма оферта → 409 quote_required, нищо не е записано", !b.quote && br.status === 409 && bj.error === "quote_required" && (await t.q("select count(*)::int n from bookings")).rows[0].n === 0, `${br.status} ${bj.error}`);
  const start = `${BASE.lon},${BASE.lat};`;
  check("2.6 OSRM тръгва от точката на офиса (pin в Google Maps) в реда дължина,ширина", osrm.length > 0 && osrm.every((u) => u.includes("/driving/24.7329252,42.1615692;")) && start === "24.7329252,42.1615692;", osrm[0]);
}

// ===== 3. Доставка и връщане: всеки адрес по веднъж, без двойно начисляване =====
{
  const both = await quote({ delivery: "ул. Тестова 3", return: "с. Далеч 5" });
  const ls = both.json.lines || [];
  const del = ls.filter((l: any) => l.code === "delivery"), ret = ls.filter((l: any) => l.code === "return");
  check("3.1 доставка 5 км × 1 € = 5 € и връщане 150 км × 0,70 € = 105 €; по един ред; сума = наем + доставка + връщане",
    both.status === 200 && del.length === 1 && ret.length === 1 && del[0].cents === 500 && ret[0].cents === 10500 && both.json.totalCents === 5000 + 500 + 10500, JSON.stringify(ls));
  const half = await quote({ delivery: "ул. Тестова 3", return: "ул. Улична 4" });
  check("3.4 доставка с потвърден номер и връщане с непотвърден: цялата оферта се отказва (leg ret, imprecise), без частична цена", half.status === 502 && half.json.leg === "ret" && half.json.reason === "imprecise" && !("totalCents" in half.json), JSON.stringify(half.json));
  const same = await quote({ delivery: "ул. Тестова 3", return: "ул. Тестова 3" });
  check("3.2 един и същ адрес за доставка и връщане: два отделни курса по 5 €, без удвояване на км в един ред", same.status === 200 && same.json.totalCents === 6000 && same.json.lines.filter((l: any) => l.km === 5).length === 2 && !same.json.lines.some((l: any) => l.km === 10));
  const onlyDel = await quote({ delivery: "ул. Тестова 3" });
  check("3.3 само доставка: няма ред за връщане", onlyDel.json.totalCents === 5500 && !onlyDel.json.lines.some((l: any) => l.code === "return"));
}

// ===== 4. Кеш: старите 49,8 км не се връщат =====
{
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  const norm = CENTRAL.toLowerCase();
  // Записите отпреди поправката: v1 (първата версия), v2 без началната точка в ключа и v2 с нея (междинните версии на PR #54)
  const v2 = (a: string) => "v2/" + h("2@42.1615692,24.7329252\n" + a.toLowerCase());
  for (const key of ["v1/" + h(norm), "v2/" + h(norm), v2(CENTRAL), v2("ул. Улична 4, Пловдив")])
    await t.q(`insert into route_cache (key, status, km, rate, local, source, claimed_at, expires_at) values ($1, 'ok', 49.8, 0.7, false, 'osm', now(), now() + interval '1 day') on conflict (key) do update set status = 'ok', km = 49.8, rate = 0.7, expires_at = now() + interval '1 day'`, [key]);
  await t.q("delete from route_cache where key like 'v4/%' and status = 'fail'"); // запомнените грешки от разделите по-горе – търси се отново
  const q = await quote({ delivery: CENTRAL }), r = await route(CENTRAL);
  check("4.1 стари записи с 49,8 км в route_cache (v1, v2) не се четат: /api/quote и /api/route пак искат уточнение", q.status === 502 && q.json.reason === "ambiguous" && r.status === 422, `${q.status} ${r.status}`);
  const sq = await quote({ delivery: "ул. Улична 4, Пловдив" });
  check("4.1б стар запис v2 с цена до точка от улицата не се чете: отказ imprecise", sq.status === 502 && sq.json.reason === "imprecise", `${sq.status} ${sq.json.reason}`);
  const keys = (await t.q("select key from route_cache where status <> 'ok' or km <> 49.8")).rows.map((x: any) => x.key);
  check("4.2 новите ключове са v4/хеш(версия + начална точка + адрес)", keys.length > 0 && keys.every((k: string) => /^v4\/[a-f0-9]{64}$/.test(k)) && ROUTE_VERSION === "4@42.1615692,24.7329252", ROUTE_VERSION);
  const ok = await route("гр. Пловдив, ул. Тестова 3");
  check("4.3 CDN кеш на /api/route: етикет route,route-v4 (за изчистване) и версия в отговора; обезсилва се с всеки нов deploy",
    ok.headers.get("netlify-cache-tag") === "route,route-v4" && /durable/.test(ok.headers.get("netlify-cdn-cache-control") || "") && ok.json.version === ROUTE_VERSION, `${ok.headers.get("netlify-cache-tag")} ${ok.json.version}`);
  const bad = await route("ул. Няма 9");
  check("4.4 грешките (404 / 422) не се кешират в CDN", !bad.headers.get("netlify-cdn-cache-control"));
}

// ===== 5. Проверени обекти: Летище София (Терминал 1 / 2 поотделно), Летище Пловдив =====
{
  const c0 = routes.calls, o0 = osrm.length;
  const t2 = await quote({ delivery: "Летище София Терминал 2" }), t1 = await quote({ delivery: "Sofia Airport, Terminal 1" });
  check("5.1 Терминал 2: 139,3 км × 0,70 € = 97,51 €, точност poi, името на терминала в отговора",
    t2.status === 200 && t2.json.legs.del.km === 139.3 && t2.json.legs.del.rate === 0.7 && t2.json.legs.del.precision === "poi" && t2.json.legs.del.poi === "Летище София, Терминал 2" && t2.json.lines.find((l: any) => l.code === "delivery").cents === 9751, JSON.stringify(t2.json.legs));
  check("5.2 Терминал 1 (латиница): друга точка и друго разстояние – 138,5 км; не е заменен с Терминал 2",
    t1.status === 200 && t1.json.legs.del.km === 138.5 && t1.json.legs.del.poi === "Летище София, Терминал 1", JSON.stringify(t1.json.legs));
  check("5.3 маршрутите са до автомобилните точки на терминалите (OSRM, дължина,ширина), без търсене на адрес при Nominatim",
    osrm.slice(o0).some((u) => u.includes(";23.414214,42.688069?")) && osrm.slice(o0).some((u) => u.includes(";23.402457,42.689058?")) && routes.calls === c0, osrm.slice(o0).join(" "));
  const r2 = await route("Летище София Терминал 2"), rf = await route("Flughafen Sofia, Terminal 2");
  check("5.4 /api/route за същия терминал: същите км, тарифа и обект като /api/quote", r2.status === 200 && r2.json.km === 139.3 && r2.json.rate === 0.7 && r2.json.precision === "poi" && r2.json.poi === "Летище София, Терминал 2", JSON.stringify(r2.json));
  check("5.5 друго изписване (немски) на същия терминал → същият резултат", rf.status === 200 && rf.json.km === 139.3 && rf.json.poi === "Летище София, Терминал 2", JSON.stringify(rf.json));
  const n0 = await nQuotes(), o1 = osrm.length;
  const und = await quote({ delivery: "Летище София" }), undR = await quote({ return: "Sofia Airport" }), both = await quote({ delivery: "Летище София Терминал 1 или 2" }), ur = await route("Летище София");
  check("5.6 неясен терминал (доставка и връщане): 502 terminal, /api/route 422 terminal; без оферта, без маршрут, без CDN кеш",
    und.status === 502 && und.json.reason === "terminal" && und.json.leg === "del" && undR.json.reason === "terminal" && undR.json.leg === "ret" && both.json.reason === "terminal" &&
    ur.status === 422 && ur.json.error === "terminal" && !ur.headers.get("netlify-cdn-cache-control") && (await nQuotes()) === n0 && osrm.length === o1, `${und.status} ${und.json.reason} ${undR.json.reason} ${both.json.reason} ${ur.status}`);
  const pdv = await quote({ delivery: "Летище Пловдив", return: "Летище София, Терминал 2" });
  const ls = pdv.json.lines || [];
  check("5.7 доставка до Летище Пловдив 19,2 км × 1,00 € (в зоната) и връщане от Терминал 2 139,3 км × 0,70 €; по един ред, без двойно начисляване",
    pdv.status === 200 && pdv.json.legs.del.poi === "Летище Пловдив" && pdv.json.legs.del.rate === 1 && ls.filter((l: any) => l.code === "delivery").length === 1 && ls.filter((l: any) => l.code === "return").length === 1 &&
    pdv.json.totalCents === 5000 + 1920 + 9751, JSON.stringify(ls));
  const rows = (await t.q("select * from route_cache where precision = 'poi'")).rows;
  check("5.8 кешът пази само км, тарифа и точност – без името на обекта и без адреса", rows.length > 0 && !/Летище|Терминал|Sofia|Airport/i.test(JSON.stringify(rows)));
  const again = await quote({ delivery: "Летище София Терминал 2" });
  check("5.9 от кеша: същото разстояние и името на терминала (определено отново от текста)", again.json.legs.del.km === 139.3 && again.json.legs.del.poi === "Летище София, Терминал 2", JSON.stringify(again.json.legs));
  // Строгите проверки за обикновени адреси остават
  const plain = await quote({ delivery: "ул. Летище 5, Пловдив" }), c2 = await quote({ delivery: CENTRAL });
  check("5.10 „ул. Летище 5“ е обикновен адрес (строга проверка); Бяла река пак е отказана", plain.status === 200 && plain.json.legs.del.precision === "house" && !plain.json.legs.del.poi && c2.json.reason === "ambiguous", `${plain.status} ${c2.json.reason}`);
}

await finish();
