// Търсене на адреса и маршрут за доставка / връщане (server/geocode.ts, server/route.ts) през /api/quote и /api/route.
// Регресия: „гр. Пловдив, пл. Централен 1“ → 49,8 км × 0,70 € до с. Бяла река. Проверява се и кешът (route_cache, CDN).
// Синтетични данни; Nominatim / OSRM са симулирани с реалистични отговори (harness.ts, tests/fixtures/nominatim.ts).
// Без реални заявки и писма.
import { createHash } from "node:crypto";
import { bookingBody, check, contractData, finish, freshDb, google, http, O, routes, setContext, withQuote } from "./harness.ts";
import placesFn from "../../netlify/functions/places.mts";
import { LIMITS } from "../../server/limits.ts";
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
const route2 = async (dest: string, place: string) => {
  const r = await routeFn(new Request(`${O}/api/route?destination=${encodeURIComponent(dest)}&place=${place}&session=${"a".repeat(32)}`), { ip: `198.51.100.${++ip % 250}` } as any);
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

// ===== 6. Адрес, избран от предложенията на Google (симулиран Google; тестов ключ само в този раздел) =====
{
  const SES = "a".repeat(32);
  const places = async (input: string, o: { session?: string; lang?: string; client?: string } = {}) => {
    const r = await placesFn(new Request(`${O}/api/places?input=${encodeURIComponent(input)}&session=${o.session ?? SES}&lang=${o.lang ?? "bg"}`, { headers: o.client ? { "X-Client-Id": o.client } : {} }), { ip: `198.51.100.${++ip % 250}` } as any);
    return { status: r.status, cache: r.headers.get("cache-control"), json: (await r.json().catch(() => ({}))) as any };
  };
  const label = (id: string, s: any) => `${s.main}, ${s.secondary}`;
  // Без ключ: предложения няма (503), избран адрес не може да бъде проверен
  const off = await places("бул. Витоша 1");
  const offQ = await quote({ delivery: "бул. „Витоша“ 1, София, България", deliveryPlace: { id: "gp_sofia_vitosha_1", session: SES } });
  check("6.1 без ключ за Google: /api/places 503 unavailable; оферта с избран адрес → 502 unavailable (без заявки към Google)", off.status === 503 && off.json.error === "unavailable" && offQ.status === 502 && offQ.json.reason === "unavailable" && google.autocomplete + google.details + google.routes === 0, `${off.status} ${offQ.json.reason}`);

  process.env.GOOGLE_MAPS_API_KEY = "test-only-not-a-real-key";
  const sug = await places("бул. Витоша 1", { lang: "en" });
  const body = google.bodies.at(-1);
  check("6.2 /api/places: до 5 предложения (основен и допълнителен текст, Place ID), за цяла България, на езика на страницата, със сесия, без кеш",
    sug.status === 200 && sug.json.suggestions.length === 2 && sug.json.suggestions[0].id === "gp_sofia_vitosha_1" && sug.json.suggestions[0].main === "бул. „Витоша“ 1" && sug.json.suggestions[0].secondary === "София, България" &&
    JSON.stringify(body.includedRegionCodes) === '["bg"]' && body.languageCode === "en" && body.sessionToken === SES && !body.locationRestriction && !body.locationBias && sug.cache === "no-store", JSON.stringify(sug.json).slice(0, 200));
  const bad = await Promise.all([places("ab"), places("бул. Витоша", { session: "x" }), places("<script>alert</script>"), places("https://example.com")]);
  check("6.3 невалиден текст или ключ на сесията → 400 без заявка към Google", bad.every((r) => r.status === 400) && google.autocomplete === 1, bad.map((r) => r.status).join());
  google.fail = "places";
  const pe = await places("ул. Гладстон 10");
  google.fail = "";
  check("6.4 грешка на Google при предложенията → 502 provider (браузърът продължава без предложения)", pe.status === 502 && pe.json.error === "provider");
  const lim0 = { ...LIMITS };
  LIMITS.placesPerClient = 2;
  const cl = "c".repeat(32);
  const lr = [await places("ул. Гладстон 1", { client: cl }), await places("ул. Гладстон 2", { client: cl }), await places("ул. Гладстон 3", { client: cl })];
  Object.assign(LIMITS, lim0);
  check("6.5 ограничение на предложенията по раздел на браузъра → 429 с Retry-After", lr[0].status === 200 && lr[1].status === 200 && lr[2].status === 429, lr.map((r) => r.status).join());

  // Избран адрес в Пловдив, чийто номер липсва в OpenStreetMap (както ул. Гладстон 10): приема се по проверката на Google
  const glad = (await places("ул. Гладстон 10")).json.suggestions[0];
  const gl = label(glad.id, glad);
  const osm0 = routes.calls, d0 = google.details;
  const q = await quote({ delivery: gl, deliveryPlace: { id: glad.id, session: SES } });
  check("6.6 Пловдив, ул. Гладстон 10 (избран от Google): 3,3 км × 1,00 €, точност google; без отказ заради OpenStreetMap и без търсене там",
    q.status === 200 && q.json.legs.del.km === 3.3 && q.json.legs.del.rate === 1 && q.json.legs.del.precision === "google" && routes.calls === osm0, JSON.stringify(q.json.legs));
  const det = google.detailUrls.at(-1)!;
  const rb = google.bodies.at(-1);
  check("6.7 Place Details със същата сесия (затваря сесията), маршрут с Google Routes от точката на офиса до избрания Place ID",
    google.details === d0 + 1 && det.includes("/places/gp_pdv_gladston_10") && det.includes("sessionToken=" + SES) && rb.destination.placeId === "gp_pdv_gladston_10" && rb.origin.location.latLng.latitude === 42.1615692 && rb.origin.location.latLng.longitude === 24.7329252, det);
  const free = await quote({ delivery: gl });
  check("6.8 същият текст без избор от предложенията: строгата проверка остава (OpenStreetMap; тук номерът е намерен – друг ключ в кеша)", free.status === 200 && free.json.legs.del.precision === "house", JSON.stringify(free.json.legs || free.json));
  const r1 = await route2(gl, glad.id);
  check("6.9 /api/route със същото място: същите км, тарифа и точност; без CDN кеш", r1.status === 200 && r1.json.km === 3.3 && r1.json.rate === 1 && r1.json.precision === "google" && r1.cache === "no-store" && !r1.cdn, JSON.stringify(r1.json));
  // София: адрес с номер (0,70 €/км), само улица → уточнение
  const vit = sug.json.suggestions;
  const sq = await quote({ delivery: label("", vit[0]), deliveryPlace: { id: vit[0].id, session: SES } });
  const sr = await quote({ delivery: label("", vit[1]), deliveryPlace: { id: vit[1].id, session: SES } });
  check("6.10 София, бул. Витоша 1: 146,2 км × 0,70 € = 102,34 €; само „бул. Витоша“ (улица) → 502 imprecise, без оферта",
    sq.status === 200 && sq.json.legs.del.km === 146.2 && sq.json.legs.del.rate === 0.7 && sq.json.lines.find((l: any) => l.code === "delivery").cents === 10234 && sr.status === 502 && sr.json.reason === "imprecise", `${JSON.stringify(sq.json.legs)} ${sr.json.reason}`);
  // Друго населено място: Асеновград – населено място → уточнение; адрес → цена
  const as = (await places("Асеновград")).json.suggestions;
  const ac = await quote({ return: label("", as[0]), returnPlace: { id: as[0].id, session: SES } }), aa = await quote({ return: label("", as[1]), returnPlace: { id: as[1].id, session: SES } });
  check("6.11 Асеновград: само населеното място (връщане) → imprecise; ул. Цар Иван Асен II 1 → 21,4 км × 1,00 € (в зоната)", ac.json.reason === "imprecise" && ac.json.leg === "ret" && aa.status === 200 && aa.json.legs.ret.km === 21.4 && aa.json.legs.ret.rate === 1, `${ac.json.reason} ${JSON.stringify(aa.json.legs)}`);
  // Летищата през Google: терминалите остават отделни
  const ap = (await places("Летище София")).json.suggestions;
  const a0 = await quote({ delivery: label("", ap[0]), deliveryPlace: { id: ap[0].id, session: SES } });
  const a2 = await quote({ delivery: label("", ap[1]), deliveryPlace: { id: ap[1].id, session: SES } });
  const pd = (await places("Летище Пловдив")).json.suggestions[0];
  const ap3 = await quote({ delivery: label("", pd), deliveryPlace: { id: pd.id, session: SES } });
  const lastRoute = google.bodies.at(-1);
  check("6.12 Google „Летище София“ (цялото летище) → избор на терминал; „Терминал 2“ → 139,3 км до точката пред Т2; Летище Пловдив → 19,2 км до точката пред терминала",
    a0.status === 502 && a0.json.reason === "terminal" && a2.status === 200 && a2.json.legs.del.km === 139.3 && a2.json.legs.del.poi === "Летище София, Терминал 2" &&
    ap3.json.legs.del.km === 19.2 && ap3.json.legs.del.poi === "Летище Пловдив" && lastRoute.destination.location.latLng.longitude === 24.844729, `${a0.json.reason} ${JSON.stringify(a2.json.legs)} ${JSON.stringify(ap3.json.legs)}`);
  // Подправен избор: място извън България; несъществуващ / невалиден Place ID
  const gr = await quote({ delivery: "Солун, Гърция", deliveryPlace: { id: "gp_gr_thessaloniki", session: SES } });
  const nf = await quote({ delivery: "ул. Измислена 1", deliveryPlace: { id: "gp_does_not_exist", session: SES } });
  const inv = await quote({ delivery: "ул. Гладстон 10", deliveryPlace: { id: "../../x", session: SES } });
  const nod = await quote({ delivery: null, deliveryPlace: { id: "gp_pdv_gladston_10", session: SES } });
  check("6.13 избрано място извън България → abroad; несъществуващ Place ID → not_found; невалиден ID / избор без адрес → 400 place",
    gr.json.reason === "abroad" && nf.json.reason === "not_found" && inv.status === 400 && inv.json.error === "place" && nod.status === 400 && nod.json.error === "place", `${gr.json.reason} ${nf.json.reason} ${inv.json.error} ${nod.json.error}`);
  // Грешка на Google: Place Details → няма оферта; Routes → OSRM до същата проверена точка
  google.fail = "details";
  const de = await quote({ delivery: "бул. „Витоша“ 1, София (нов)", deliveryPlace: { id: "gp_sofia_vitosha_1x", session: SES } });
  google.fail = "routes";
  const as2 = (await places("Асеновград")).json.suggestions[1];
  await t.q("delete from route_cache");
  const rf = await quote({ return: label("", as2), returnPlace: { id: as2.id, session: SES } });
  google.fail = "";
  check("6.14 грешка на Google Place Details → 502 error, без оферта; грешка на Google Routes → OSRM до проверената точка (source osm)",
    de.status === 502 && de.json.reason === "error" && rf.status === 200 && rf.json.legs.ret.km === 5 && osrm.at(-1)!.includes(";24.877,42.011?"), `${de.json.reason} ${JSON.stringify(rf.json.legs)}`);
  // Офертата е обвързана с избраното място: резервация със същия текст, но друг / без Place ID се отказва
  const d1 = "2028-07-03", d2 = "2028-07-05";
  const qb = { ...q0, startDate: d1, endDate: d2 };
  const ok = await quote({ ...qb, delivery: gl, deliveryPlace: { id: glad.id, session: SES } });
  const bb = (places: any) => bookingBody("GEO3" + Math.random(), d1, "10:00", d2, "10:00", { carId: "golf", car: "golf", requestKey: "geo-test-3-" + Math.random().toString(36).slice(2) + "-key", quote: ok.json.quote, quoteTotalCents: ok.json.totalCents, places,
    contract: { ...contractData(d1, "10:00", d2, "10:00"), del: { addr: gl, km: 3.3, rate: 1 } } });
  const post = async (b: any) => { const r = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }), { params: {} } as any); return { status: r.status, json: (await r.json().catch(() => ({}))) as any }; };
  const other = await post(bb({ del: "gp_sofia_vitosha_1", ret: null })), none = await post(bb({}));
  const good = await post(bb({ del: glad.id, ret: null }));
  check("6.15 резервация: друг Place ID или без него → 409 quote_mismatch; същият избран адрес → записана с доставка 3,30 €",
    other.status === 409 && other.json.error === "quote_mismatch" && none.status === 409 && none.json.error === "quote_mismatch" && good.status === 201, `${other.status} ${other.json.error} ${none.json.error} ${good.status} ${good.json.error || ""}`);
  const rows = (await t.q("select * from route_cache")).rows;
  check("6.16 кешът: ключ v4/хеш (Place ID), без адреса, Place ID, координати и сесия", rows.length > 0 && !/gp_|Гладстон|Витоша|42\.1431|24\.7494|aaaa/.test(JSON.stringify(rows)), JSON.stringify(rows[0]).slice(0, 120));
  delete process.env.GOOGLE_MAPS_API_KEY;
}

await finish();
