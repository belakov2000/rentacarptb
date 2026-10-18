// Защита на публичните заявки за цена и разстояние (server/limits.ts, server/route.ts) и таблицата price_quotes.
// Синтетични данни; доставчикът на маршрути (OpenStreetMap / OSRM / Google) е симулиран (harness.ts). Без реални заявки и писма.
import { eq } from "drizzle-orm";
import { bookingBody, check, contractData, finish, freshDb, http, mail, O, quoteFor, routes, schema, setContext, withQuote } from "./harness.ts";
import { stores } from "./stubs/blobs.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import quoteFn from "../../netlify/functions/quote.mts";
import routeFn from "../../netlify/functions/route.mts";
import adminBookingsFn from "../../netlify/functions/admin-bookings.mts";
import { LIMITS } from "../../server/limits.ts";
import { ROUTE_CACHE } from "../../server/route.ts";
import { quoteCleanup } from "../../server/quote.ts";
import { TABLES, backupDatabase } from "../../server/backup.ts";
import { adminJar } from "./harness.ts";
import { ipHash } from "../../server/auth.ts";

setContext("deploy-preview");
const t = await freshDb("limits");
t.use();
const DEFAULT = { ...LIMITS };
const reset = async () => { Object.assign(LIMITS, DEFAULT); await t.q("delete from api_limits"); };
const q0 = { carId: "golf", startDate: "2028-06-05", startTime: "10:00", endDate: "2028-06-07", endTime: "10:00", seats: 0, delivery: null as string | null, return: null as string | null, abroad: [] as string[] };
const hex = (n: number) => n.toString(16).padStart(32, "0");
const quote = async (body: unknown, o: { ip?: string; client?: string | null; raw?: string } = {}) => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (o.client) headers["X-Client-Id"] = o.client;
  const r = await quoteFn(new Request(`${O}/api/quote`, { method: "POST", headers, body: o.raw ?? JSON.stringify(body) }), { ip: o.ip ?? "203.0.113.1" } as any);
  return { status: r.status, retry: r.headers.get("retry-after"), json: (await r.json().catch(() => ({}))) as any };
};
const route = async (dest: string, ip = "203.0.113.1") => {
  const r = await routeFn(new Request(`${O}/api/route?destination=${encodeURIComponent(dest)}`), { ip } as any);
  return { status: r.status, retry: r.headers.get("retry-after"), json: (await r.json().catch(() => ({}))) as any };
};
const post = async (body: unknown) => {
  const r = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: {} } as any);
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
// Логовете на сървъра по време на теста – за проверката, че в тях няма адреси
const logs: string[] = [];
for (const k of ["log", "error", "warn"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => { logs.push(a.map((x) => (x instanceof Error ? x.name + " " + x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...a); };
}

// ===== 1. Проверка преди външна заявка; размер на данните =====
{
  const c0 = routes.calls;
  const bad = ["ул", "12345 678", "http://evil.example/ул", "<script>ул. Тест</script>", "ул. Тест\u0000 1", "ул. " + "Дълга ".repeat(60)];
  const rq = await Promise.all(bad.map((a) => quote({ ...q0, delivery: a })));
  const rr = await Promise.all(bad.map((a) => route(a)));
  check("1.1 невалиден адрес (кратък, без букви, адрес на сайт, HTML, управляващ знак, над 300 знака) → 400 преди доставчика",
    rq.every((r) => r.status === 400 && r.json.error === "address") && rr.every((r) => r.status === 400) && routes.calls === c0, rq.map((r) => r.json.error).join());
  const big = await quote(null, { raw: JSON.stringify({ ...q0, pad: "x".repeat(5000) }) });
  const many = await quote({ ...q0, abroad: Array.from({ length: 12 }, (_, i) => "c" + i) });
  check("1.2 тяло над 4 KB → 413; повече държави от списъка → 400; без заявки към доставчика", big.status === 413 && many.status === 400 && routes.calls === c0, `${big.status}/${many.status}`);
  check("1.3 невалидните заявки не харчат лимитите", (await t.q("select count(*)::int n from api_limits")).rows[0].n === 0, "");
}

// ===== 2. Ограничения по раздел на браузъра, по IP и общо =====
{
  await reset();
  LIMITS.quotePerClient = 5; LIMITS.quotePerIp = 12;
  const A = hex(1), Bc = hex(2);
  const a = []; for (let i = 0; i < 6; i++) a.push(await quote(q0, { client: A }));
  const other = await quote(q0, { client: Bc });
  check("2.1 раздел: 5 оферти за 10 мин. → 6-та 429 (scope quote:client, Retry-After); друг клиент зад същия IP не е блокиран",
    a.slice(0, 5).every((r) => r.status === 200) && a[5].status === 429 && a[5].json.error === "rate_limited" && a[5].json.scope === "quote:client" && Number(a[5].retry) > 0 && other.status === 200, `${a.map((r) => r.status).join()} / ${other.status} retry ${a[5].retry}`);
  // На IP вече има 7; още 5 различни раздела → 12; 13-ата е отказана по IP
  const rest = []; for (let i = 3; i < 9; i++) rest.push(await quote(q0, { client: hex(i) }));
  const otherIp = await quote(q0, { client: hex(99), ip: "198.51.100.7" });
  check("2.2 IP: 12 оферти за 10 мин. от много раздели → следващата 429 (quote:ip); друг IP – без промяна", rest.slice(0, 5).every((r) => r.status === 200) && rest[5].status === 429 && rest[5].json.scope === "quote:ip" && otherIp.status === 200, rest.map((r) => r.status).join());
  const noClient = []; for (let i = 0; i < 2; i++) noClient.push(await quote(q0, { client: null, ip: "198.51.100.8" }));
  check("2.3 стара страница без ключ на раздела → само лимитът по IP (не е блокирана)", noClient.every((r) => r.status === 200), "");
  await t.q("update api_limits set expires_at = now() - interval '1 second' where key like 'quote:client:%'");
  check("2.4 след края на прозореца броячът започва отначало", (await quote(q0, { client: A, ip: "198.51.100.9" })).status === 200, "");
  const keys = (await t.q("select key from api_limits")).rows.map((r: any) => r.key).join();
  check("2.5 броячите са в базата (общи за всички инстанции) и без IP адреси и ключове на раздели", /quote:ip:[a-f0-9]{24}/.test(keys) && !/203\.0\.113|198\.51|0{20}/.test(keys), keys.slice(0, 80));
  // Брояч, записан от друга инстанция на функцията (направо в базата), важи и тук
  const key = "quote:ip:" + (await ipHash("192.0.2.77"));
  await t.q("insert into api_limits (key, count, expires_at) values ($1, 1000, now() + interval '5 minutes')", [key]);
  const fromDb = await quote(q0, { client: hex(50), ip: "192.0.2.77" });
  check("2.6 лимитът се взема от базата (запис от друга инстанция важи), не от паметта на процеса", fromDb.status === 429 && fromDb.json.scope === "quote:ip", String(fromDb.status));
  await reset();
  LIMITS.quoteGlobalPerHour = 3;
  const g = []; for (let i = 0; i < 4; i++) g.push(await quote(q0, { client: hex(100 + i), ip: `192.0.2.${i + 1}` }));
  check("2.7 общ лимит за сайта (горна граница на натрупването на оферти) → 429 quote:all", g.slice(0, 3).every((r) => r.status === 200) && g[3].status === 429 && g[3].json.scope === "quote:all", g.map((r) => r.status).join());
  await reset();
  LIMITS.routePerIp = 2;
  const r3 = [await route("ул. Стара 1"), await route("ул. Стара 1"), await route("ул. Стара 1")];
  check("2.8 /api/route (по-стари страници): лимит по IP → 429 с Retry-After", r3[0].status === 200 && r3[2].status === 429 && Number(r3[2].retry) > 0, r3.map((r) => r.status).join());
}

// ===== 3. Бюджет за търсене при доставчика =====
{
  await reset();
  LIMITS.lookupsPerIp = 3;
  const cl = (i: number) => hex(200 + i);
  const r = []; for (let i = 0; i < 4; i++) r.push(await quote({ ...q0, delivery: `ул. Бюджет ${i + 1}` }, { client: cl(i) }));
  const cachedAgain = await quote({ ...q0, delivery: "ул. Бюджет 1" }, { client: cl(9) });
  const otherIp = await quote({ ...q0, delivery: "ул. Бюджет 4" }, { ip: "198.51.100.20", client: cl(10) });
  check("3.1 търсения при доставчика: 3 нови адреса от един IP → 4-тият 429 (lookup:ip); адрес от кеша не харчи бюджета",
    r.slice(0, 3).every((x) => x.status === 200) && r[3].status === 429 && r[3].json.scope === "lookup:ip" && cachedAgain.status === 200 && otherIp.status === 200, r.map((x) => x.status + (x.json.scope || "")).join());
  check("3.2 отказаното търсене не оставя „зает“ запис в кеша", (await t.q("select count(*)::int n from route_cache where status = 'pending'")).rows[0].n === 0, "");
  await reset();
  LIMITS.lookupsPerClient = 2;
  const c = []; for (let i = 0; i < 3; i++) c.push(await quote({ ...q0, delivery: `ул. Раздел ${i + 1}` }, { client: hex(300) }));
  check("3.3 търсения от един раздел (напр. писане на адрес буква по буква): 2 → 3-тото 429 (lookup:client)", c[2].status === 429 && c[2].json.scope === "lookup:client", c.map((x) => x.status).join());
  await reset();
  LIMITS.lookupsGlobalPerHour = 2;
  const gl = []; for (let i = 0; i < 3; i++) gl.push(await quote({ ...q0, delivery: `ул. Общо ${i + 1}` }, { client: hex(400 + i), ip: `192.0.2.${50 + i}` }));
  check("3.4 общ бюджет за търсене (горна граница на разхода) → 429 lookup:all", gl[2].status === 429 && gl[2].json.scope === "lookup:all", gl.map((x) => x.status).join());
  const legacy = await route("ул. Общо 9");
  check("3.5 същият бюджет важи и за /api/route", legacy.status === 429, String(legacy.status));
}

// ===== 4. Едновременни заявки от един IP =====
{
  await reset();
  LIMITS.inflightPerIp = 2;
  routes.delayMs = 300;
  const par = await Promise.all([1, 2, 3, 4].map((i) => quote({ ...q0, delivery: `ул. Паралел ${i}` }, { client: hex(500 + i) })));
  routes.delayMs = 0;
  const after = await quote(q0, { client: hex(510) });
  const left = (await t.q("select count from api_limits where key like 'inflight:%'")).rows[0].count;
  check("4.1 едновременни заявки от един IP над 2 → 429 (inflight:ip); след завършване мястото се освобождава",
    par.filter((r) => r.status === 200).length === 2 && par.filter((r) => r.status === 429 && r.json.scope === "inflight:ip").length === 2 && after.status === 200 && left === 0, par.map((r) => r.status).join());
  await t.q("update api_limits set count = 99 where key like 'inflight:%'");
  const stuck = await quote(q0, { client: hex(511) });
  await t.q("update api_limits set expires_at = now() - interval '1 second' where key like 'inflight:%'");
  const healed = await quote(q0, { client: hex(512) });
  check("4.2 прекъсната функция, която не е освободила мястото → броячът изтича сам (inflightTtlMs)", stuck.status === 429 && healed.status === 200 && LIMITS.inflightTtlMs === 30_000, `${stuck.status}/${healed.status}`);
}

// ===== 5. Едновременни заявки за един адрес: едно търсене при доставчика =====
{
  await reset();
  // Колко заявки към доставчика прави едно търсене за такъв адрес (последователно, нов адрес)
  let c0 = routes.calls;
  await quote({ ...q0, delivery: "ул. Еталон 1" }, { ip: "192.0.2.200" });
  const one = routes.calls - c0;
  routes.delayMs = 400;
  c0 = routes.calls;
  const par = await Promise.all(Array.from({ length: 10 }, (_, i) => quote({ ...q0, delivery: i % 2 ? "ул. Едновременна 1" : "  УЛ. едновременна   1 " }, { ip: `192.0.2.${100 + i}`, client: hex(600 + i) })));
  const parCalls = routes.calls - c0;
  check("5.1 10 едновременни оферти (10 IP адреса) за един нов адрес → едно търсене при доставчика, еднакъв резултат",
    par.every((r) => r.status === 200 && r.json.legs.del.km === 5) && parCalls === one, `заявки към доставчика: ${parCalls} (едно търсене = ${one})`);
  c0 = routes.calls;
  const mix = await Promise.all([
    ...Array.from({ length: 4 }, (_, i) => quote({ ...q0, delivery: "ул. Смесена 2" }, { ip: `192.0.2.${120 + i}` })),
    ...Array.from({ length: 4 }, (_, i) => route("ул. Смесена 2", `192.0.2.${130 + i}`)),
  ]);
  check("5.2 едновременни /api/quote и /api/route за един адрес → едно търсене", mix.every((r) => r.status === 200) && routes.calls - c0 === one, `${routes.calls - c0}`);
  c0 = routes.calls;
  const nf = await Promise.all(Array.from({ length: 5 }, (_, i) => quote({ ...q0, delivery: "ул. Няма 77" }, { ip: `192.0.2.${140 + i}` })));
  const nfCalls = routes.calls - c0;
  routes.delayMs = 0;
  c0 = routes.calls;
  await quote({ ...q0, delivery: "ул. Няма 78" }, { ip: "192.0.2.150" });
  const nfOne = routes.calls - c0;
  check("5.3 едновременни заявки за ненамерен адрес → едно търсене; всички получават 502 not_found", nf.every((r) => r.status === 502 && r.json.reason === "not_found") && nfCalls === nfOne, `${nfCalls} (едно = ${nfOne})`);
  c0 = routes.calls;
  const again = await quote({ ...q0, delivery: "ул. Няма 77" }, { ip: "192.0.2.151" });
  await t.q("update route_cache set expires_at = now() - interval '1 second' where status = 'fail'");
  const retry = await quote({ ...q0, delivery: "ул. Няма 77" }, { ip: "192.0.2.152" });
  check(`5.4 грешката се помни ${ROUTE_CACHE.failTtlMs / 1000} с (без нова заявка), след това повторният опит пита доставчика отново`, again.status === 502 && retry.status === 502 && routes.calls - c0 === nfOne, `${routes.calls - c0}`);
  // Изоставено търсене (функцията е прекъснала): заетият запис изтича и следващата заявка търси отново
  await t.q("insert into route_cache (key, status, claim_token, claimed_at, expires_at) values ('v1/' || encode(sha256(convert_to('ул. изоставена 3', 'UTF8')), 'hex'), 'pending', 'x', now() - interval '1 minute', now() - interval '1 second')");
  const stale = await quote({ ...q0, delivery: "ул. Изоставена 3" }, { ip: "192.0.2.153" });
  check("5.5 изоставено („заето“, изтекло) търсене не блокира адреса", stale.status === 200 && stale.json.legs.del.km === 5, String(stale.status));
}

// ===== 6. Повторно подаване след записана резервация =====
{
  await reset();
  const body = { ...bookingBody("Повтор", "2028-09-04", "10:00", "2028-09-06", "10:00", { carId: "golf", car: "golf", requestKey: "repeat-key-0001" }), contract: { ...contractData("2028-09-04", "10:00", "2028-09-06", "10:00"), del: null } };
  const b = await withQuote(body);
  const first = await post(b);
  const used = await post(b);
  const newKey = await post({ ...b, requestKey: "repeat-key-0002" });
  const nq = await quoteFor(b);
  const newKey2 = await post({ ...b, requestKey: "repeat-key-0002", quote: nq.json.quote, quoteTotalCents: nq.json.totalCents });
  await t.q("update price_quotes set expires_at = now() - interval '1 day' where booking_id = $1", [first.json.id]);
  const expired = await post(b);
  await t.q("delete from price_quotes where booking_id = $1", [first.json.id]); // само в тестовата база – като след почистване
  const gone = await post(b);
  check("6.1 повторно изпращане (същият ключ) след запис → същата резервация: с използвана, изтекла и изтрита оферта",
    first.status === 201 && [used, expired, gone].every((r) => r.status === 200 && r.json.duplicate === true && r.json.id === first.json.id), [used, expired, gone].map((r) => r.status).join());
  check("6.2 нов ключ (напр. ново натискане след „Назад“) с използваната оферта → 409 quote_used; с нова оферта → същата резервация (същият клиент и период)",
    newKey.status === 409 && newKey.json.error === "quote_used" && newKey2.status === 200 && newKey2.json.duplicate === true && newKey2.json.id === first.json.id, `${newKey.json.error} / ${newKey2.status}`);
  const stranger = await post({ ...b, email: "other@example.com" });
  check("6.3 същият ключ с друг имейл → не връща чужда резервация", stranger.status !== 200 && stranger.json.id !== first.json.id, String(stranger.status));
  check("6.4 записана е точно една резервация", (await t.q("select count(*)::int n from bookings where email = $1", [b.email])).rows[0].n === 1, "");
}

// ===== 7. Тайните ключове на офертите =====
{
  mail.sent.length = 0;
  const body = { ...bookingBody("Тайна", "2028-10-03", "10:00", "2028-10-05", "10:00", { carId: "passat", car: "passat", requestKey: "secret-key-0001" }), contract: { ...contractData("2028-10-03", "10:00", "2028-10-05", "10:00"), del: null } };
  const b = await withQuote(body);
  const token = b.quote as string;
  const r = await post(b);
  const s = await row(r.json.id);
  const q = (await t.q("select * from price_quotes where booking_id = $1", [s.id])).rows[0];
  const blobs = [...stores.values()].flatMap((m) => [...m.values()].map((it) => Buffer.from(it.data).toString("latin1"))).join();
  const db = JSON.stringify((await t.q("select * from bookings")).rows) + JSON.stringify((await t.q("select * from booking_events")).rows) + JSON.stringify((await t.q("select * from email_log")).rows);
  const jar = adminJar();
  setContext("deploy-preview", { cookies: jar, ip: "203.0.113.30" });
  const det = await (await adminBookingsFn(new Request(`${O}/api/admin/bookings/${s.id}`, { headers: { Origin: O } }), { ip: "203.0.113.30", params: { id: s.id } } as any)).text();
  setContext("deploy-preview");
  check("7.1 ключът на офертата не се пази: в базата е само SHA-256 хеш", !!q && q.id !== token && /^[a-f0-9]{64}$/.test(q.id), "");
  check("7.2 ключът не е в резервацията, историята, лога на писмата, договора, писмата, админ панела и логовете",
    !db.includes(token) && !blobs.includes(token) && !mail.sent.some((m) => m.html.includes(token)) && !det.includes(token) && !det.includes(q.id) && !logs.join().includes(token), "");
  check("7.3 технически таблици (оферти, лимити, кеш на маршрути) не са в резервните копия – резервацията пази сървърната разбивка в price_check",
    !Object.keys(TABLES).some((k) => /price_quotes|api_limits|route_cache/.test(k)) && (s.priceCheck as any).server.totalCents === s.totalCents, Object.keys(TABLES).join(","));
  await backupDatabase(true);
  const bk = [...(stores.get("deploypreview-backups")?.values() || [])].map((it) => Buffer.from(it.data).toString()).join();
  check("7.4 резервното копие на базата не съдържа ключове или хешове на оферти", bk.length > 0 && !bk.includes(token) && !bk.includes(q.id), `${bk.length} байта`);
}

// ===== 8. Натрупване на офертите и предложено почистване (само проверка) =====
{
  await t.q(`insert into price_quotes (id, input_hash, input, legs, version, days, lines, total_cents, deposit_cents, created_at, expires_at, booking_id) values
    ('${"a".repeat(64)}', 'h', '{}', '{}', 'v', 1, '[]', 100, 10000, now() - interval '9 days', now() - interval '8 days', null),
    ('${"b".repeat(64)}', 'h', '{}', '{}', 'v', 1, '[]', 100, 10000, now() - interval '9 days', now() - interval '8 days', '${"9".repeat(32)}'),
    ('${"c".repeat(64)}', 'h', '{}', '{}', 'v', 1, '[]', 100, 10000, now() - interval '2 days', now() - interval '2 days', null)`);
  const before = (await t.q("select count(*)::int n from price_quotes")).rows[0].n;
  const n = await quoteCleanup({ dryRun: true });
  const after = (await t.q("select count(*)::int n from price_quotes")).rows[0].n;
  check("8.1 предложеното правило (само преглед): неизползвани оферти, изтекли преди над 7 дни → 1; нищо не е изтрито", n === 1 && before === after, `${n}, ${before} → ${after}`);
  const del = await quoteCleanup({ dryRun: false }); // само в тестовата база
  const left = (await t.q("select id from price_quotes where id in ($1, $2, $3)", ["a".repeat(64), "b".repeat(64), "c".repeat(64)])).rows.map((r: any) => r.id[0]).sort().join();
  check("8.2 при изпълнение (тестова база): изтрива се само неизползваната стара оферта; използваната и скорошната остават", del === 1 && left === "b,c", left);
  check("8.3 при създаване на оферта не се изтрива нищо автоматично", (await t.q("select count(*)::int n from price_quotes where id = $1", ["c".repeat(64)])).rows[0].n === 1, "");
}

// ===== 9. Логовете са без адреси =====
{
  process.env.GOOGLE_MAPS_API_KEY = "test-only-not-a-real-key";
  const prev = http.handler;
  http.handler = async (url, init) => {
    if (url.includes("routes.googleapis.com")) return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Bad destination ул. Логова 5 Пловдив" } }, { status: 400 });
    return prev ? prev(url, init) : null;
  };
  logs.length = 0;
  await quote({ ...q0, delivery: "ул. Логова 5" }, { ip: "192.0.2.230" });
  await quote({ ...q0, delivery: "ул. Мрежа Логова 6" }, { ip: "192.0.2.231" });
  await route("ул. Мрежа Логова 7", "192.0.2.232");
  http.handler = prev;
  delete process.env.GOOGLE_MAPS_API_KEY;
  check("9.1 грешки при доставчика (Google с адрес в отговора, мрежова грешка) → в логовете само кодове, без адреси", logs.length > 0 && !logs.some((l) => /Логова|Пловдив|ул\./.test(l)), logs.join(" | ").slice(0, 160));
}

await finish();
