// Вход: администратор, потребител без роля, невалидна сесия, вход/изход, ограничение на опитите и защита на /api/admin/*.
import { check, cookieJar, fakeJwt, finish, freshDb, identity, O, setContext } from "./harness.ts";
import authFn from "../../netlify/functions/admin-auth.mts";
import backupsFn from "../../netlify/functions/admin-backups.mts";
import emailsFn from "../../netlify/functions/admin-emails.mts";
import validateFn from "../../netlify/functions/identity-validate.mts";

const t = await freshDb("auth");
t.use();
identity.users.set("admin@example.com", { id: "1", email: "admin@example.com", password: "admin-pass-123", roles: ["admin"] });
identity.users.set("user@example.com", { id: "2", email: "user@example.com", password: "user-pass-123", roles: [] });

// Една заявка от „браузър“ с бисквитки и IP адрес
async function req(fn: any, path: string, opt: { method?: string; body?: unknown; origin?: string | null; jar?: ReturnType<typeof cookieJar>; ip?: string } = {}) {
  const jar = opt.jar || cookieJar();
  setContext("deploy-preview", { cookies: jar, ip: opt.ip || "203.0.113.1" });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opt.origin !== null) headers.Origin = opt.origin ?? O;
  const r = await fn(new Request(O + path, { method: opt.method || "GET", headers, body: opt.body ? JSON.stringify(opt.body) : undefined }), { ip: opt.ip || "203.0.113.1", params: {} } as any);
  return { status: r.status, json: await r.json().catch(() => ({})), jar };
}
const login = (email: string, password: string, ip?: string, jar?: ReturnType<typeof cookieJar>) => req(authFn, "/api/admin/login", { method: "POST", body: { email, password }, ip, jar });

// 1. Администратор: вход → me → изход
const admin = await login("admin@example.com", "admin-pass-123");
check("Вход на администратор → 200 и сесия", admin.status === 200 && admin.jar.map.has("nf_jwt"), `HTTP ${admin.status}`);
const me = await req(authFn, "/api/admin/me", { jar: admin.jar });
check("me с валидна сесия → администраторът и средата", me.status === 200 && me.json.email === "admin@example.com" && me.json.env === "deploy-preview" && me.json.production === false, JSON.stringify(me.json));
const out = await req(authFn, "/api/admin/logout", { method: "POST", jar: admin.jar });
check("Изход → сесията е изтрита и токенът е отменен в Identity", out.status === 200 && !admin.jar.map.has("nf_jwt") && identity.calls.includes("/logout"), "");
const afterOut = await req(authFn, "/api/admin/me", { jar: admin.jar });
check("me след изход → 401", afterOut.status === 401, `HTTP ${afterOut.status}`);

// 2. Потребител без роля
const user = await login("user@example.com", "user-pass-123");
check("Вход на потребител без роля → 403 и без сесия", user.status === 403 && !user.jar.map.has("nf_jwt"), `HTTP ${user.status}`);
// Дори с валиден токен (напр. от друг вход) – няма достъп
const ujar = cookieJar();
const utok = fakeJwt("user@example.com"); identity.tokens.set(utok, "user@example.com"); ujar.set({ name: "nf_jwt", value: utok });
// 3. Невалидна сесия: токен с роля admin, който Identity не познава (подправен)
const fjar = cookieJar(); fjar.set({ name: "nf_jwt", value: fakeJwt("attacker@example.com", ["admin"]) });
const ajar = (await login("admin@example.com", "admin-pass-123")).jar;

// 4. Всички административни функции
const ENDPOINTS: [string, any, string, string][] = [
  ["GET /api/admin/me", authFn, "/api/admin/me", "GET"],
  ["GET /api/admin/backups?status", backupsFn, "/api/admin/backups?status", "GET"],
  ["GET /api/admin/backups", backupsFn, "/api/admin/backups", "GET"],
  ["POST /api/admin/backups", backupsFn, "/api/admin/backups", "POST"],
  ["GET /api/admin/emails", emailsFn, "/api/admin/emails", "GET"],
];
for (const [label, fn, path, method] of ENDPOINTS) {
  const none = await req(fn, path, { method });
  const forged = await req(fn, path, { method, jar: fjar });
  const noRole = await req(fn, path, { method, jar: ujar });
  const ok = await req(fn, path, { method, jar: ajar });
  const cross = method === "POST" ? await req(fn, path, { method, jar: ajar, origin: "https://evil.example" }) : null;
  const noOrigin = method === "POST" ? await req(fn, path, { method, jar: ajar, origin: null }) : null;
  const pass = none.status === 401 && forged.status === 401 && noRole.status === 403 && ok.status === 200 && (!cross || (cross.status === 403 && noOrigin!.status === 403));
  check(`${label}: без вход 401, подправен 401, без роля 403, админ 200${cross ? ", чужд/липсващ Origin 403" : ""}`, pass, `${none.status}/${forged.status}/${noRole.status}/${ok.status}${cross ? `/${cross.status}/${noOrigin!.status}` : ""}`);
}

// 5. Списък с разрешени имейли (ADMIN_EMAILS)
process.env.ADMIN_EMAILS = "other@example.com";
const denied = await req(authFn, "/api/admin/me", { jar: ajar });
delete process.env.ADMIN_EMAILS;
check("ADMIN_EMAILS: администратор извън списъка → 403", denied.status === 403, `HTTP ${denied.status}`);

// 6. Защита от многократни опити по имейл + IP, без блокиране на собственика от чужд адрес
const IP_A = "198.51.100.7", IP_B = "192.0.2.44", IP_C = "198.51.100.99";
const codes: number[] = [];
for (let i = 0; i < 11; i++) codes.push((await login("admin@example.com", "wrong-" + i, IP_A)).status);
check("10 грешни пароли от адрес A → 11-ият опит е блокиран (429)", codes.slice(0, 10).every((c) => c === 401) && codes[10] === 429, codes.join(","));
const fromA = await login("admin@example.com", "admin-pass-123", IP_A);
check("…и правилната парола от адрес A е временно блокирана", fromA.status === 429, `HTTP ${fromA.status}`);
const fromB = await login("admin@example.com", "admin-pass-123", IP_B);
check("Собственикът от друг адрес (B) влиза нормално", fromB.status === 200, `HTTP ${fromB.status}`);
const spray: number[] = [];
for (let i = 0; i < 31; i++) spray.push((await login(`guess${i}@example.com`, "x", IP_C)).status);
check("30 опита от един адрес с различни имейли → адресът е блокиран", spray[30] === 429 && spray.slice(0, 30).every((c) => c === 401), `31-ви опит: ${spray[30]}`);
const ipStored = (await t.q("select count(*)::int n from booking_events where details::text like '%198.51.100%'")).rows[0].n;
check("IP адресите не се пазят в явен вид (само хеш)", ipStored === 0, "");

// 7. Публична регистрация и неправилни заявки
const reg = await validateFn();
check("Регистрацията се отказва от identity-validate", reg.status === 403, `HTTP ${reg.status}`);
check("Вход без Origin → 403", (await req(authFn, "/api/admin/login", { method: "POST", body: { email: "admin@example.com", password: "admin-pass-123" }, origin: null })).status === 403, "");
check("Вход с невалиден имейл → 400", (await req(authFn, "/api/admin/login", { method: "POST", body: { email: "x", password: "y" } })).status === 400, "");
await finish();
