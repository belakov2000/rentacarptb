import type { Config, Context } from "@netlify/functions";
import jpeg from "jpeg-js";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bookingEvents, bookings } from "../../db/schema.js";
import { audit, ipHash, requireAdmin } from "../../server/auth.js";
import { store as blobStore } from "../../server/stores.js";

// Снимки на лична карта / шофьорска книжка от формата за резервация.
// POST /api/documents          – качва една JPEG снимка, връща { url } (формата качва снимките преди заявката)
// GET  /api/documents/:id      – показва снимката САМО на вписан администратор (бисквитката от админ панела се изпраща
//                                 и при отваряне на линк в нов раздел). Без вход – към входа в панела, след това обратно тук.
//                                 Всяко отваряне се записва в историята (document.view). Няма режим за публичен достъп.
// Проверки при качване: само JPEG, до 4 MB, файлът се декодира изцяло (jpeg-js) с ограничение на резолюцията и паметта,
// размери 200–4000 px; ограничение на броя качвания по IP адрес (пази се само хеш) и общо за сайта.
const MAX_BYTES = 4 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{64}$/;
export const UPLOAD_LIMITS = { perIp: 60, total: 600, windowMs: 60 * 60_000, minSide: 200, maxSide: 4000, maxMP: 16 };
const HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const err = (error: string, status: number) => Response.json({ error }, { status, headers: HEADERS });

// Декодиране на цялото изображение – повреден, подправен или прекалено голям файл се отхвърля
export function checkJpeg(bytes: Uint8Array): { ok: true; width: number; height: number } | { ok: false; error: string } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return { ok: false, error: "not_jpeg" };
  let img: { width: number; height: number };
  try {
    img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, maxResolutionInMP: UPLOAD_LIMITS.maxMP, maxMemoryUsageInMB: 128, tolerantDecoding: false });
  } catch {
    return { ok: false, error: "invalid_image" };
  }
  const { width, height } = img;
  const L = UPLOAD_LIMITS;
  if (!width || !height || Math.min(width, height) < L.minSide || Math.max(width, height) > L.maxSide) return { ok: false, error: "dimensions" };
  return { ok: true, width, height };
}

async function tooManyUploads(ip: string) {
  const since = new Date(Date.now() - UPLOAD_LIMITS.windowMs);
  const [r] = await db
    .select({ total: sql<number>`count(*)::int`, ip: sql<number>`count(*) filter (where ${bookingEvents.details}->>'ip' = ${ip})::int` })
    .from(bookingEvents)
    .where(and(eq(bookingEvents.action, "document.upload"), gte(bookingEvents.at, since)));
  return (r?.ip ?? 0) >= UPLOAD_LIMITS.perIp || (r?.total ?? 0) >= UPLOAD_LIMITS.total;
}

export default async (req: Request, context: Context) => {
  // Извън продукция – отделно хранилище (виж server/stores.ts)
  const store = blobStore("documents");

  if (req.method === "POST") {
    if ((req.headers.get("content-type") || "").split(";")[0].trim() !== "image/jpeg") return err("Only JPEG images are accepted", 415);
    const declared = Number(req.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) return err("Image is empty or too large", 413);
    const ip = await ipHash(context.ip);
    if (await tooManyUploads(ip)) return err("Too many uploads", 429);
    const body = await req.arrayBuffer();
    if (!body.byteLength || body.byteLength > MAX_BYTES) return err("Image is empty or too large", 413);
    const c = checkJpeg(new Uint8Array(body));
    if (!c.ok) return err(c.error === "dimensions" ? "Image dimensions are not accepted" : "Invalid JPEG image", 415);
    // Дълъг случаен ключ – линкът не може да бъде отгатнат
    const id = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
    await store.set(id, body, { metadata: { uploadedAt: new Date().toISOString(), width: c.width, height: c.height, bytes: body.byteLength } });
    // Без лични данни: само хеш на IP адреса и размерите (за ограничението на качванията)
    await db.insert(bookingEvents).values({ bookingId: null, actor: "customer", action: "document.upload", details: { ip, width: c.width, height: c.height, bytes: body.byteLength } }).catch(() => null);
    return Response.json({ url: `${new URL(req.url).origin}/api/documents/${id}` }, { status: 201, headers: HEADERS });
  }

  const id = context.params.id;
  if (!id || !ID_RE.test(id)) return new Response("Not found", { status: 404, headers: HEADERS });
  const admin = await requireAdmin(req);
  if (admin instanceof Response) {
    // Отваряне от браузъра (линк от по-старо писмо): без вход – към входа в панела, който след вход връща към снимката
    if (admin.status === 401 && (req.headers.get("accept") || "").includes("text/html"))
      return new Response(null, { status: 303, headers: { ...HEADERS, Location: `/admin/?doc=${id}` } });
    return admin;
  }
  const data = await store.get(id, { type: "arrayBuffer" });
  if (!data) return new Response("Not found", { status: 404, headers: HEADERS });
  const [b] = await db.select({ id: bookings.id }).from(bookings).where(sql`${bookings.documents} @> ${JSON.stringify([{ id }])}::jsonb`).limit(1).catch(() => []);
  await audit(admin.email, "document.view", { via: "link" }, b?.id ?? null).catch(() => null);
  return new Response(data, { headers: { ...HEADERS, "Content-Type": "image/jpeg", "Content-Disposition": `inline; filename="dokument.jpg"` } });
};

export const config: Config = {
  path: ["/api/documents", "/api/documents/:id"],
  method: ["GET", "POST"],
};
