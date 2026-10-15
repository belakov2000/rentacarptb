import { AuthError, getUser, login, logout } from "@netlify/identity";
import type { Config, Context } from "@netlify/functions";
import { audit, ipHash, isAdminUser, json, requireAdmin, sameOrigin, tooManyFailedLogins } from "../../server/auth.js";
import { envInfo } from "../../server/stores.js";

// Вход в административния панел с Netlify Identity (бисквитката nf_jwt се задава от сървъра).
// POST /api/admin/login  { email, password }
// POST /api/admin/logout
// GET  /api/admin/me     – текущият администратор или 401 / 403
export default async (req: Request, context: Context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error("Admin auth error", e instanceof Error ? e.message : e);
    return json({ error: "unavailable" }, 503);
  }
};

async function handle(req: Request, context: Context) {
  const path = new URL(req.url).pathname;

  if (path.endsWith("/me")) {
    const admin = await requireAdmin(req);
    // Средата се показва в панела: тестова версия – с предупреждение; непозната – „Неизвестна среда“ (server/stores.ts)
    return admin instanceof Response ? admin : json({ email: admin.email, ...envInfo() });
  }

  if (req.method !== "POST" || !sameOrigin(req)) return json({ error: "forbidden" }, 403);

  if (path.endsWith("/logout")) {
    const u = await getUser();
    await logout().catch(() => null);
    if (u?.email) await audit(u.email, "admin.logout").catch(() => null);
    return json({ ok: true });
  }

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : "";
  const password = typeof body?.password === "string" ? body.password.slice(0, 200) : "";
  if (!/^\S+@\S+\.\S+$/.test(email) || !password) return json({ error: "invalid" }, 400);
  const ip = await ipHash(context.ip);
  if (await tooManyFailedLogins(email, ip)) return json({ error: "locked" }, 429);
  try {
    const u = await login(email, password);
    if (!isAdminUser(u)) {
      // Валиден потребител без роля admin – излиза веднага
      await logout().catch(() => null);
      await audit(email, "admin.login_denied", { ip });
      return json({ error: "forbidden" }, 403);
    }
    await audit(email, "admin.login", { ip });
    // Същите данни за средата като /me – без тях панелът след вход показваше „Тестова среда ()“ и в продукция
    return json({ email, ...envInfo() });
  } catch (e) {
    await audit(email, "admin.login_failed", { ip }).catch(() => null);
    if (e instanceof AuthError && (e.status === 400 || e.status === 401)) return json({ error: "credentials" }, 401);
    console.error("Admin login failed", e instanceof Error ? e.message : e);
    return json({ error: "unavailable" }, 503);
  }
}

export const config: Config = {
  path: ["/api/admin/login", "/api/admin/logout", "/api/admin/me"],
  method: ["GET", "POST"],
};
