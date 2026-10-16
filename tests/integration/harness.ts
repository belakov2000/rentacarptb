// Обща среда за интеграционните тестове: реален PostgreSQL (отделна временна база за всеки тест, всички миграции),
// хранилища Netlify Blobs в паметта и прихванати имейли към Brevo. Не се свързва с Netlify, Brevo или реални данни.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as schema from "../../db/schema.ts";
import { state } from "./stubs/db.ts";

export { schema };
export const MIG = "netlify/database/migrations";
export const migrations = () => readdirSync(MIG).sort();
export const sha = (d: Uint8Array | ArrayBuffer | string) => createHash("sha256").update(typeof d === "string" ? d : new Uint8Array(d as ArrayBuffer)).digest("hex");

// ===== База =====
const ADMIN_URL = process.env.TEST_DATABASE_URL!;
if (!ADMIN_URL) throw new Error("TEST_DATABASE_URL is not set – run tests via tests/integration/run.mjs");
const pools: pg.Pool[] = [];
export async function freshDb(name: string, upTo = Infinity) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const dbName = `t_${name}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await admin.query(`create database ${dbName}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  pools.push(pool);
  const q = (text: string, params?: unknown[]) => pool.query(text, params as any[]);
  const applyMigration = async (m: string) => {
    for (const st of readFileSync(`${MIG}/${m}/migration.sql`, "utf8").split("--> statement-breakpoint")) if (st.trim()) await pool.query(st);
  };
  for (const m of migrations().slice(0, upTo === Infinity ? undefined : upTo)) await applyMigration(m);
  const db = drizzle({ client: pool, schema });
  return { url, pool, q, db, applyMigration, use: () => { state.db = db; } };
}
export const closeAll = () => Promise.all(pools.map((p) => p.end()));

// ===== Среда на Netlify (както я подава платформата на сървъра) =====
export function setContext(ctx: string | undefined, extra: Record<string, unknown> = {}) {
  (globalThis as any).Netlify = ctx ? { context: { deploy: { context: ctx, id: "test", published: true }, url: new URL(O), ...extra } } : undefined;
}
// Бисквитки на един „браузър“ (Netlify.context.cookies в сървърната функция)
export function cookieJar() {
  const m = new Map<string, string>();
  return { get: (n: string) => m.get(n), set: (c: { name: string; value: string }) => void m.set(c.name, c.value), delete: (n: string) => void m.delete(n), map: m };
}

// ===== Имейли към Brevo =====
export const mail = {
  sent: [] as { to: string; subject: string; attachments: number; html: string }[],
  // Връща текст на грешка (Brevo отказва) или null (изпраща)
  fail: null as null | ((m: { to: string; attachments: number }) => string | null),
  // Мрежов проблем: "timeout" – няма отговор и писмото НЕ е прието; "lost" – Brevo ПРИЕМА писмото, но отговорът се губи
  network: null as null | ((m: { to: string; subject: string }) => "timeout" | "lost" | null),
  delayMs: 0,
  calls: 0,
};
process.env.BREVO_API_KEY = "test-only-not-a-real-key";
// Пощата е подменена (fetch по-долу) – изпращането извън продукция е разрешено само в тестовете (виж mail/index.ts)
process.env.MAIL_OUTSIDE_PRODUCTION = "1";
process.env.URL = "https://site.example";
export const http = { handler: null as null | ((url: string, init: any) => Response | Promise<Response> | null) };
globalThis.fetch = (async (url: any, init: any = {}) => {
  const other = http.handler && (await http.handler(String(url), init));
  if (other) return other;
  if (!String(url).includes("api.brevo.com")) throw new Error("unexpected network call in test: " + url);
  mail.calls++;
  const b = JSON.parse(init.body);
  if (mail.delayMs) await new Promise((r) => setTimeout(r, mail.delayMs));
  const m = { to: b.to[0].email, attachments: b.attachment?.length || 0 };
  const net = mail.network?.({ to: m.to, subject: b.subject });
  if (net === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  if (net === "lost") {
    mail.sent.push({ ...m, subject: b.subject, html: b.htmlContent }); // писмото е прието и ще бъде доставено
    throw new TypeError("fetch failed: other side closed");
  }
  const err = mail.fail?.(m);
  if (err) return new Response(err, { status: 503 });
  mail.sent.push({ ...m, subject: b.subject, html: b.htmlContent });
  return new Response("{}", { status: 201 });
}) as any;

// ===== Резултати =====
export const results: [string, boolean, string][] = [];
export const check = (n: string, ok: boolean, info = "") => {
  results.push([n, ok, info]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${n} | ${info}`);
};
export async function finish() {
  await closeAll();
  const f = results.filter((r) => !r[1]).length;
  console.log(`\nОБЩО: ${results.length - f} PASS, ${f} FAIL`);
  process.exitCode = f ? 1 : 0;
}
export const rejects = async (p: Promise<unknown>) => { try { await p; return false; } catch { return true; } };

// ===== Заявки към функциите =====
export const O = "https://preview.example";
export function bookingBody(s: string, d1: string, t1: string, d2: string, t2: string, extra: Record<string, unknown> = {}) {
  return {
    name: `ТЕСТ ${s}`, email: `test-${s.toLowerCase()}@example.com`, phone: "+359000000000", lang: "bg", car: "Volkswagen Passat", carId: "passat",
    startDate: d1, endDate: d2, startTime: t1, endTime: t2, payment: "cash", pickup: `${d1} ${t1}`, dropoff: `${d2} ${t2}`, total: "50 €", message: "ТЕСТ",
    ...extra,
  };
}
export const contractData = (d1: string, t1: string, d2: string, t2: string) => ({
  citizen: "BG", idt: "id", idn: "000", egn: "0000000000", d1, t1, d2, t2, days: 2, rent: 50, seat: 0, seatN: 0, del: { addr: "тест", km: 5, rate: 1 }, ret: null, abroad: [],
});

// ===== Фалшив Netlify Identity (GoTrue): /token, /user, /logout – както ги вика @netlify/identity на сървъра =====
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const identity = {
  users: new Map<string, { id: string; email: string; password: string; roles: string[] }>(),
  tokens: new Map<string, string>(), // валидни токени → имейл
  calls: [] as string[],
};
export function fakeJwt(email: string, roles: string[] = [], exp = Math.floor(Date.now() / 1000) + 3600) {
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u-" + email, email, exp, app_metadata: { roles } })}.${b64("sig-" + Math.random())}`;
}
http.handler = async (url, init) => {
  const m = /\/\.netlify\/identity(\/[a-z]+)/.exec(url);
  if (!m) return null;
  identity.calls.push(m[1]);
  const userJson = (u: any) => Response.json({ id: u.id, email: u.email, confirmed_at: "2026-01-01T00:00:00Z", app_metadata: { roles: u.roles, provider: "email" }, user_metadata: {}, role: "" });
  if (m[1] === "/token") {
    const p = new URLSearchParams(String(init.body));
    const u = identity.users.get(String(p.get("username")).toLowerCase());
    if (!u || u.password !== p.get("password")) return Response.json({ error: "invalid_grant", error_description: "Invalid email or password" }, { status: 400 });
    const t = fakeJwt(u.email, u.roles);
    identity.tokens.set(t, u.email);
    return Response.json({ access_token: t, token_type: "bearer", expires_in: 3600, refresh_token: "r-" + Math.random() });
  }
  const tok = String(init.headers?.Authorization || init.headers?.authorization || "").replace(/^Bearer /, "");
  const email = identity.tokens.get(tok);
  if (m[1] === "/user") return email ? userJson(identity.users.get(email)) : Response.json({ msg: "Invalid token" }, { status: 401 });
  if (m[1] === "/logout") { identity.tokens.delete(tok); return new Response(null, { status: 204 }); }
  return Response.json({}, { status: 404 });
};
