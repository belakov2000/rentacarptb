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
const route2 = async (dest: string, pin: { lat: number; lon: number }) => {
  const r = await routeFn(new Request(`${O}/api/route?destination=${encodeURIComponent(dest)}&lat=${pin.lat}&lon=${pin.lon}`), { ip: `198.51.100.${++ip % 250}` } as any);
  return { status: r.status, cache: r.headers.get("cache-control"), cdn: r.headers.get("netlify-cdn-cache-control"), json: (await r.json().catch(() => ({}))) as any };
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
  // Само улица / населено място → не е точен адрес и не се отказва: 409 „pin“ с началната точка за картата; без оферта и маршрут
  const n0 = await nQuotes(), o0 = osrm.length;
  const imp: [string, string, number][] = [
    ["ул. Улична 4, Пловдив", "въведен номер, на картата е само улицата", 42.151],
    ["ул. Тестова, Пловдив", "без номер", 42.15],
    ["с. Далеч", "само населеното място", 42.7],
  ];
  for (const [a, why, lat] of imp) {
    const iq = await quote({ delivery: a }), ir = await route(a), rq = await quote({ return: a });
    check(`2.3 ${why} („${a}“): /api/quote 409 pin (доставка и връщане) с начална точка, /api/route 409 pin; без км и без CDN кеш`,
      iq.status === 409 && iq.json.reason === "pin" && iq.json.leg === "del" && iq.json.pin.lat === lat && !("totalCents" in iq.json) && rq.json.reason === "pin" && rq.json.leg === "ret" &&
      ir.status === 409 && ir.json.error === "pin" && ir.json.pin.lat === lat && !("km" in ir.json) && !ir.headers.get("netlify-cdn-cache-control"), `${iq.status} ${iq.json.reason} ${JSON.stringify(iq.json.pin)} ${ir.status}`);
  }
  check("2.3 без потвърден пин не е издадена оферта и не е изчислен маршрут", (await nQuotes()) === n0 && osrm.length === o0, `${(await nQuotes()) - n0} ${osrm.length - o0}`);
  // Потвърден пин: маршрутът е до пина, точност „pin“; /api/route със същия пин – същият резултат
  const pin = { lat: 42.1521, lon: 24.7533 };
  const pq = await quote({ delivery: "ул. Улична 4, Пловдив", deliveryPin: pin }), pr = await route2("ул. Улична 4, Пловдив", pin);
  check("2.3п потвърден пин: оферта до пина (OSRM до точните координати), точност pin; /api/route със същия пин – същите км и тарифа, без CDN кеш",
    pq.status === 200 && pq.json.legs.del.precision === "pin" && osrm.at(-1)!.includes(";24.7533,42.1521?") && pr.status === 200 && pr.json.km === pq.json.legs.del.km && pr.json.rate === 1 && pr.json.precision === "pin" && !pr.cdn,
    `${pq.status} ${JSON.stringify(pq.json.legs)} ${pr.status}`);
  const far1 = await quote({ delivery: "ул. Улична 4, Пловдив", deliveryPin: { lat: 42.2, lon: 24.75 } });
  const town1 = await quote({ delivery: "с. Далеч", deliveryPin: { lat: 42.705, lon: 23.33 } });
  const out = await quote({ delivery: "ул. Улична 4, Пловдив", deliveryPin: { lat: 48.1, lon: 11.5 } }), bad = await quote({ delivery: null, deliveryPin: pin });
  const amb = await quote({ delivery: "гр. Пловдив, пл. Централен 1", deliveryPin: { lat: 42.14, lon: 24.75 } });
  check("2.3в пинът се отказва: >3 км от улицата → pin_far; в друго населено място → pin_town; извън България / без адрес → 400 pin; друго населено място в адреса остава ambiguous",
    far1.status === 502 && far1.json.reason === "pin_far" && town1.json.reason === "pin_town" && out.status === 400 && out.json.error === "pin" && bad.json.error === "pin" && amb.json.reason === "ambiguous",
    `${far1.json.reason} ${town1.json.reason} ${out.json.error} ${bad.json.error} ${amb.json.reason}`);
  const nq = await quote({ delivery: "ул. Няма 5" }), nr = await route("ул. Няма 5");
  check("2.4 липсващ адрес: /api/quote 502 not_found, /api/route 404", nq.status === 502 && nq.json.reason === "not_found" && nr.status === 404, `${nq.status} ${nq.json.reason} ${nr.status}`);
  const far = await quote({ delivery: "с. Далеч 5" });
  check("2.5 посочено село извън зоната с намерен номер: 150 км × 0,70 €, точност house", far.status === 200 && far.json.legs.del.km === 150 && far.json.legs.del.rate === 0.7 && far.json.legs.del.precision === "house", JSON.stringify(far.json.legs));
  // Резервация с адрес с недостатъчна точност: няма оферта → не се записва (км от браузъра не се приемат)
  const d1 = "2028-06-12", d2 = "2028-06-14";
  const b = await withQuote(bookingBody("GEO2", d1, "10:00", d2, "10:00", { carId: "golf", car: "golf", requestKey: "geo-test-2-key", contract: { ...contractData(d1, "10:00", d2, "10:00"), del: { addr: "ул. Улична 4, Пловдив", km: 4.1, rate: 1 } } }));
  const br = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }), { params: {} } as any);
  const bj: any = await br.json().catch(() => ({}));
  check("2.7 резервация без потвърден пин (само улица): няма оферта → 409 quote_required, нищо не е записано", !b.quote && br.status === 409 && bj.error === "quote_required" && (await t.q("select count(*)::int n from bookings")).rows[0].n === 0, `${br.status} ${bj.error}`);
  // „Посочи мястото на картата“ (free): без намерена улица, без ограничението 3 км, при недостъпно търсене
  {
    const o1 = routes.urls.length;
    const nf = await quote({ delivery: "ул. Няма 5, Пловдив", deliveryPin: { lat: 42.1601, lon: 24.7601, free: true } });
    const down = await quote({ return: "ул. Мрежа 3, Пловдив", returnPin: { lat: 42.1602, lon: 24.7602, free: true } });
    check("2.9 свободен пин: адрес без резултат и адрес при недостъпно търсене → оферта до пина (точност pin), без търсене на адреса",
      nf.status === 200 && nf.json.legs.del.precision === "pin" && down.status === 200 && down.json.legs.ret.precision === "pin" && !routes.urls.slice(o1).some((u) => u.includes("/search")), `${nf.status} ${nf.json.reason || ""} ${down.status} ${down.json.reason || ""}`);
    const farFree = await quote({ delivery: "ул. Улична 4, Пловдив", deliveryPin: { lat: 42.2, lon: 24.75, free: true } });
    check("2.10 свободен пин на 5 км от намерената улица: приема се (ограничението 3 км е само за пин към намерена улица)", farFree.status === 200 && farFree.json.legs.del.precision === "pin", `${farFree.status} ${farFree.json.reason || ""}`);
    const noRoad = await quote({ delivery: "нива край селото", deliveryPin: { lat: 42.405, lon: 24.7, free: true } });
    const abroad = await quote({ delivery: "село до границата", deliveryPin: { lat: 42.9, lon: 22.5, free: true } });
    const fake = await quote({ delivery: "ул. Няма 5, Пловдив", deliveryPin: { lat: 42.1601, lon: 24.7601, free: true }, km: 0, totalCents: 1 } as any);
    check("2.11 свободен пин далеч от път → 502 no_route без цена; извън България → pin_abroad; км / сума от браузъра не се ползват",
      noRoad.status === 502 && noRoad.json.reason === "no_route" && !("totalCents" in noRoad.json) && abroad.json.reason === "pin_abroad" && fake.json.totalCents === nf.json.totalCents, `${noRoad.json.reason} ${abroad.json.reason} ${fake.json.totalCents}`);
    const moved = await quote({ delivery: "ул. Няма 5, Пловдив", deliveryPin: { lat: 42.1701, lon: 24.7701, free: true } });
    check("2.12 преместен пин след изчислена цена → нова оферта (друг ключ), старата не важи за новия пин", moved.status === 200 && moved.json.quote !== nf.json.quote);
  }
  // Резервация с потвърден пин: офертата е обвързана с пина; друг пин → quote_mismatch
  {
    const d1 = "2028-06-19", d2 = "2028-06-21", A = "ул. Улична 4, Пловдив";
    const mk = (k: string, pins: any) => bookingBody("GEOP" + k, d1, "10:00", d2, "10:00", { carId: "golf", car: "golf", requestKey: `geo-pin-${k}-key`, pins, contract: { ...contractData(d1, "10:00", d2, "10:00"), del: { addr: A, km: 1, rate: 1 } } });
    const b1 = await withQuote(mk("a", { del: pin, ret: null }));
    const wrong = { ...b1, requestKey: "geo-pin-b-key", pins: { del: { lat: 42.1522, lon: 24.7533 }, ret: null } };
    const post = async (b: any) => { const r = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }), { params: {} } as any); return { status: r.status, json: (await r.json().catch(() => ({}))) as any }; };
    const w = await post(wrong), ok = await post(b1);
    check("2.8 резервация с потвърден пин: друг пин → 409 quote_mismatch; същият пин → записана", !!b1.quote && w.status === 409 && w.json.error === "quote_mismatch" && ok.status === 201, `${w.status} ${w.json.error} ${ok.status} ${ok.json.error || ""}`);
  }
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
  const halfOk = await quote({ delivery: "ул. Тестова 3", return: "ул. Улична 4", returnPin: { lat: 42.1515, lon: 24.7515 } });
  check("3.4 доставка с намерен номер и връщане само до улица: без пин – няма частична оферта (409 pin, leg ret); с пин – два отделни реда",
    half.status === 409 && half.json.leg === "ret" && half.json.reason === "pin" && !("totalCents" in half.json) && halfOk.status === 200 && halfOk.json.lines.filter((l: any) => l.code === "return").length === 1 && halfOk.json.legs.ret.precision === "pin", JSON.stringify(half.json));
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
  await t.q("delete from route_cache where key like 'v6/%' and status = 'fail' and reason not like 'pin:%'"); // запомнените грешки от разделите по-горе – търси се отново
  const q = await quote({ delivery: CENTRAL }), r = await route(CENTRAL);
  check("4.1 стари записи с 49,8 км в route_cache (v1, v2) не се четат: /api/quote и /api/route пак искат уточнение", q.status === 502 && q.json.reason === "ambiguous" && r.status === 422, `${q.status} ${r.status}`);
  const sq = await quote({ delivery: "ул. Улична 4, Пловдив" });
  check("4.1б стар запис v2 с цена до точка от улицата не се чете: искане за потвърден пин", sq.status === 409 && sq.json.reason === "pin", `${sq.status} ${sq.json.reason}`);
  const keys = (await t.q("select key from route_cache where status <> 'ok' or km <> 49.8")).rows.map((x: any) => x.key);
  check("4.2 новите ключове са v6/хеш(версия + начална точка + адрес)", keys.length > 0 && keys.every((k: string) => /^v6\/[a-f0-9]{64}$/.test(k)) && ROUTE_VERSION === "6@42.1615692,24.7329252", ROUTE_VERSION);
  const ok = await route("гр. Пловдив, ул. Тестова 3");
  check("4.3 CDN кеш на /api/route: етикет route,route-v6 (за изчистване) и версия в отговора; обезсилва се с всеки нов deploy",
    ok.headers.get("netlify-cache-tag") === "route,route-v6" && /durable/.test(ok.headers.get("netlify-cdn-cache-control") || "") && ok.json.version === ROUTE_VERSION, `${ok.headers.get("netlify-cache-tag")} ${ok.json.version}`);
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
