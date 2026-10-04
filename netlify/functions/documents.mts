import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

// Снимки на лична карта / шофьорска книжка от формата за резервация.
// POST /api/documents          – качва една JPEG снимка, връща { url }
// GET  /api/documents/:id      – показва снимката (линкът се изпраща само в имейла до фирмата)
const MAX_BYTES = 4 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{64}$/;

export default async (req: Request, context: Context) => {
  const store = getStore("documents");

  if (req.method === "POST") {
    if ((req.headers.get("content-type") || "").split(";")[0].trim() !== "image/jpeg") {
      return Response.json({ error: "Only JPEG images are accepted" }, { status: 415 });
    }
    const body = await req.arrayBuffer();
    if (!body.byteLength || body.byteLength > MAX_BYTES) {
      return Response.json({ error: "Image is empty or too large" }, { status: 413 });
    }
    const bytes = new Uint8Array(body);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      return Response.json({ error: "Invalid JPEG image" }, { status: 415 });
    }
    // Дълъг случаен ключ – линкът не може да бъде отгатнат
    const id = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
    await store.set(id, body);
    return Response.json({ url: `${new URL(req.url).origin}/api/documents/${id}` }, { status: 201 });
  }

  const id = context.params.id;
  if (!id || !ID_RE.test(id)) return new Response("Not found", { status: 404 });
  const data = await store.get(id, { type: "arrayBuffer" });
  if (!data) return new Response("Not found", { status: 404 });
  return new Response(data, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
};

export const config: Config = {
  path: ["/api/documents", "/api/documents/:id"],
  method: ["GET", "POST"],
};
