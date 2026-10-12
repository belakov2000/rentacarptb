import { getUser, refreshSession } from "@netlify/identity";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bookingEvents } from "../db/schema.js";

// Сървърна проверка на администратора за всяка административна функция.
// Достъп има само потребител от Netlify Identity с роля "admin" (задава се от собственика в Netlify → Identity –
// потребителят сам не може да си я даде). Ако е зададена ADMIN_EMAILS, имейлът трябва да е и в този списък.
export type Admin = { id: string; email: string };

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

const allowList = () =>
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export function isAdminUser(u: { email?: string; roles?: string[]; appMetadata?: Record<string, unknown> } | null) {
  if (!u?.email) return false;
  const meta = (u.appMetadata?.roles as unknown) ?? [];
  const roles = [...(u.roles || []), ...(Array.isArray(meta) ? meta : [])];
  if (!roles.includes("admin")) return false;
  const list = allowList();
  return !list.length || list.includes(u.email.toLowerCase());
}

// Защита от CSRF: всяка промяна трябва да идва от същия сайт
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  return !!origin && origin === new URL(req.url).origin;
}

// Връща администратора или готов отговор 401 / 403
export async function requireAdmin(req: Request): Promise<Admin | Response> {
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return json({ error: "forbidden" }, 403);
  // Подновява изтичащия токен (1 ч.) с refresh токена от бисквитката
  await refreshSession().catch(() => null);
  const u = await getUser();
  if (!u) return json({ error: "unauthorized" }, 401);
  if (!isAdminUser(u)) return json({ error: "forbidden" }, 403);
  return { id: u.id, email: u.email! };
}

// Лог на административните действия (без лични данни на клиентите в details)
export async function audit(actor: string, action: string, details: Record<string, unknown> = {}, bookingId: string | null = null) {
  await db.insert(bookingEvents).values({ actor, action, details, bookingId });
}

// Ограничение на неуспешните опити за вход. Броят се по двойката имейл + IP адрес (10 за 15 мин.) и по IP адрес (30 за 15 мин.),
// затова трета страна от друг адрес не може да блокира собственика – блокира се само нейният адрес.
// IP адресът се пази само като хеш (без самия адрес).
export const LOGIN_LIMITS = { perEmailAndIp: 10, perIp: 30, windowMs: 15 * 60_000 };
export async function ipHash(ip: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${process.env.SITE_ID || "site"}:${ip || "unknown"}`));
  return Buffer.from(h).toString("hex").slice(0, 24);
}
export async function tooManyFailedLogins(email: string, ip: string) {
  const since = new Date(Date.now() - LOGIN_LIMITS.windowMs);
  const [r] = await db
    .select({
      pair: sql<number>`count(*) filter (where ${bookingEvents.actor} = ${email})::int`,
      ip: sql<number>`count(*)::int`,
    })
    .from(bookingEvents)
    .where(and(eq(bookingEvents.action, "admin.login_failed"), gte(bookingEvents.at, since), sql`${bookingEvents.details}->>'ip' = ${ip}`));
  return (r?.pair ?? 0) >= LOGIN_LIMITS.perEmailAndIp || (r?.ip ?? 0) >= LOGIN_LIMITS.perIp;
}
