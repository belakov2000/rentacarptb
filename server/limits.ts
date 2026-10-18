import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { ipHash } from "./auth.js";

// Ограничения на публичните заявки за цена (/api/quote) и разстояние (/api/route).
// Броячите са в базата (таблица api_limits) – общи за всички инстанции на функциите, не в паметта на един процес.
// Ключовете съдържат само хешове: IP адресът (ipHash) и случайният ключ на браузъра (X-Client-Id) не се пазят.
//
// Общ IP адрес (офис, мобилен оператор, хотел): лимитът по IP е висок; по-строгият лимит е по ключа на браузъра,
// който е отделен за всеки раздел (sessionStorage). Скъпата част – търсене при доставчика на маршрути (липса в кеша) –
// има собствен бюджет по IP и общ бюджет за сайта. Адрес от кеша не харчи бюджет за търсене.
// Стойностите са в един обект, за да могат тестовете да ги намалят; на сървъра не се променят.
export const LIMITS = {
  windowMs: 10 * 60_000,
  quotePerClient: 60, // оферти за 10 мин. от един раздел на браузъра
  quotePerIp: 300, // оферти за 10 мин. от един IP адрес (много клиенти зад общ IP)
  quoteGlobalPerHour: 3000, // всички оферти за сайта за 1 час – горна граница за натрупването на записи
  routePerIp: 120, // /api/route (само за по-стари отворени страници) за 10 мин. от един IP
  lookupsPerClient: 20, // търсения при доставчика (липса в кеша) за 10 мин. от един раздел
  lookupsPerIp: 60, // търсения при доставчика за 10 мин. от един IP
  lookupsGlobalPerHour: 600, // търсения при доставчика за сайта за 1 час – горна граница на разхода
  // Предложения за адрес от Google (/api/places): всяко натискане на клавиш след пауза е заявка (платена в Google)
  placesPerClient: 120, // за 10 мин. от един раздел (около 15–25 адреса)
  placesPerIp: 400, // за 10 мин. от един IP адрес
  placesGlobalPerHour: 2000, // за сайта за 1 час – горна граница на разхода за предложения
  inflightPerIp: 8, // едновременни заявки за цена / разстояние от един IP
  inflightTtlMs: 30_000, // броячът на едновременните заявки се нулира, ако функция прекъсне, без да го намали
};

export type Who = { ip: string; client: string | null };
const CLIENT_RE = /^[a-f0-9]{32}$/;
export async function who(req: Request, ip: string | undefined): Promise<Who> {
  const c = req.headers.get("x-client-id") || "";
  return { ip: await ipHash(ip || ""), client: CLIENT_RE.test(c) ? await ipHash("client:" + c) : null };
}

// Брояч с фиксиран прозорец: +1 и резултатът; при изтекъл прозорец започва отначало
async function bump(key: string, windowMs: number, by = 1) {
  const r: any = await db.execute(sql`
    insert into api_limits (key, count, expires_at) values (${key}, ${by}, now() + make_interval(secs => ${windowMs / 1000}))
    on conflict (key) do update set
      count = case when api_limits.expires_at <= now() then ${by} else api_limits.count + ${by} end,
      expires_at = case when api_limits.expires_at <= now() then excluded.expires_at else api_limits.expires_at end
    returning count, extract(epoch from (expires_at - now()))::int as ttl`);
  const row = (Array.isArray(r) ? r : r.rows)[0];
  return { count: Number(row.count), ttl: Math.max(1, Number(row.ttl)) };
}

export type Limited = { ok: false; scope: string; retryAfter: number };
type Rule = [key: string, limit: number, windowMs: number];
// Всички правила се отчитат; първото превишено връща отказ с време за изчакване (секунди)
async function hit(rules: Rule[]): Promise<{ ok: true } | Limited> {
  let fail: Limited | null = null;
  for (const [key, limit, windowMs] of rules) {
    const b = await bump(key, windowMs);
    if (b.count > limit && !fail) fail = { ok: false, scope: key.split(":").slice(0, 2).join(":"), retryAfter: b.ttl };
  }
  return fail || { ok: true };
}

export const quoteLimit = (w: Who) =>
  hit([
    ...(w.client ? [[`quote:client:${w.client}`, LIMITS.quotePerClient, LIMITS.windowMs] as Rule] : []),
    [`quote:ip:${w.ip}`, LIMITS.quotePerIp, LIMITS.windowMs],
    ["quote:all", LIMITS.quoteGlobalPerHour, 3600_000],
  ]);
export const placesLimit = (w: Who) =>
  hit([
    ...(w.client ? [[`places:client:${w.client}`, LIMITS.placesPerClient, LIMITS.windowMs] as Rule] : []),
    [`places:ip:${w.ip}`, LIMITS.placesPerIp, LIMITS.windowMs],
    ["places:all", LIMITS.placesGlobalPerHour, 3600_000],
  ]);
export const routeLimit = (w: Who) => hit([[`route:ip:${w.ip}`, LIMITS.routePerIp, LIMITS.windowMs]]);
// Бюджет за търсене при доставчика – отчита се само когато заявката наистина ще пита доставчика (липса в кеша)
export const lookupBudget = (w: Who) =>
  hit([
    ...(w.client ? [[`lookup:client:${w.client}`, LIMITS.lookupsPerClient, LIMITS.windowMs] as Rule] : []),
    [`lookup:ip:${w.ip}`, LIMITS.lookupsPerIp, LIMITS.windowMs],
    ["lookup:all", LIMITS.lookupsGlobalPerHour, 3600_000],
  ]);

// Едновременни заявки от един IP. Ако функция прекъсне, без да освободи мястото, броячът изтича след inflightTtlMs.
export async function inflight<T>(w: Who, fn: () => Promise<T>, busy: (retryAfter: number) => T): Promise<T> {
  const key = `inflight:ip:${w.ip}`;
  const b = await bump(key, LIMITS.inflightTtlMs);
  const release = () => db.execute(sql`update api_limits set count = greatest(count - 1, 0) where key = ${key}`).catch(() => null);
  if (b.count > LIMITS.inflightPerIp) {
    await release();
    return busy(1);
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}

export const tooMany = (l: { scope: string; retryAfter: number }) =>
  Response.json(
    { error: "rate_limited", scope: l.scope, retryAfter: l.retryAfter },
    { status: 429, headers: { "Retry-After": String(l.retryAfter), "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } },
  );

// Тялото на заявката: най-много maxBytes (по-голямото не се чете и не се обработва)
export async function readJson(req: Request, maxBytes = 4096): Promise<any | "too_large" | null> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > maxBytes) return "too_large";
  const text = await req.text().catch(() => "");
  if (new TextEncoder().encode(text).length > maxBytes) return "too_large";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
