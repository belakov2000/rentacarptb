// Локален сървър за браузърната проверка на целия път (заявка → потвърждаване → предаване → удължаване → връщане).
// Истинските функции от netlify/functions с временна PostgreSQL база (всички миграции), хранилища Blobs в паметта,
// прихванати имейли към Brevo, фалшив Netlify Identity и спрени външни заявки (harness.ts). Само синтетични данни.
// Стартира се от tests/e2e/run.mjs. Пише „READY <порт>“ на stdout.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { freshDb, identity, mail, setContext } from "../integration/harness.ts";
import * as F from "./functions.ts";

const t = await freshDb("e2e");
t.use();
identity.users.set("admin@example.com", { id: "1", email: "admin@example.com", password: "admin-pass-123", roles: ["admin"] });
const ORIGIN = `http://localhost:${process.env.E2E_PORT}`;

// Маршрути – както в config.path на функциите
const ROUTES: [RegExp, any, string[]][] = [
  [/^\/api\/admin\/(login|logout|me)$/, F.auth, []],
  [/^\/api\/admin\/bookings(?:\/([a-f0-9]+))?$/, F.adminBookings, ["id"]],
  [/^\/api\/admin\/payments(?:\/([a-f0-9]+))?$/, F.adminPayments, ["id"]],
  [/^\/api\/admin\/(?:cars(?:\/([\w-]+)(?:\/blocks(?:\/\d+)?)?)?|calendar)$/, F.fleet, ["id"]],
  [/^\/api\/admin\/customers(?:\/(\d+))?$/, F.customers, ["id"]],
  [/^\/api\/admin\/contracts(?:\/.*)?$/, F.contracts, []],
  [/^\/api\/admin\/settings$/, F.settings, []],
  [/^\/api\/admin\/dashboard$/, F.dashboard, []],
  [/^\/api\/admin\/emails$/, F.emails, []],
  [/^\/api\/admin\/backups$/, F.backups, []],
  [/^\/api\/admin\/ads(?:\/.*)?$/, F.ads, []],
  [/^\/api\/availability$/, F.availability, []],
  [/^\/api\/documents(?:\/([a-f0-9]{64}))?$/, F.documents, ["id"]],
  [/^\/api\/bookings(?:\/([a-f0-9]{32})(?:\/(?:manage|contract|documents|marketing))?)?$/, F.bookings, ["id"]],
  [/^\/api\/quote$/, F.quote, []],
];
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".js": "text/javascript", ".txt": "text/plain", ".xml": "application/xml" };

// Заявките се обработват една по една: Netlify.context (бисквитки) е общ за процеса
let queue = Promise.resolve();
createServer((nreq, nres) => {
  queue = queue.then(() => handle(nreq, nres)).catch((e) => {
    console.error("e2e server error", e);
    if (!nres.headersSent) nres.writeHead(500).end("error");
  });
}).listen(Number(process.env.E2E_PORT), () => console.log("READY " + process.env.E2E_PORT));

async function handle(nreq: any, nres: any) {
  const url = new URL(nreq.url, ORIGIN);
  const p = url.pathname;
  // Тестов изглед на прихванатите писма (само на този локален сървър)
  if (p === "/__e2e/mail") return send(nres, Response.json(mail.sent.map((m) => ({ to: m.to, subject: m.subject }))));
  if (p === "/__e2e/run/customer-emails") { await F.customerEmails(); return send(nres, Response.json({ ok: true })); }
  if (p === "/__e2e/sql") return send(nres, Response.json((await t.q(url.searchParams.get("q")!)).rows));
  for (const [re, fn, names] of ROUTES) {
    const m = re.exec(p);
    if (!m) continue;
    const chunks: Buffer[] = [];
    for await (const c of nreq) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(nreq.headers)) if (typeof v === "string") headers.set(k, v);
    const jar = new Map<string, string>();
    for (const part of (nreq.headers.cookie || "").split(/;\s*/)) { const i = part.indexOf("="); if (i > 0) jar.set(part.slice(0, i), decodeURIComponent(part.slice(i + 1))); }
    const set: string[] = [];
    const cookies = {
      get: (n: string) => jar.get(n),
      set: (c: any, v?: string) => { const o = typeof c === "string" ? { name: c, value: v! } : c; jar.set(o.name, o.value); set.push(`${o.name}=${encodeURIComponent(o.value)}; Path=/; HttpOnly; SameSite=Lax`); },
      delete: (n: any) => { const name = typeof n === "string" ? n : n.name; jar.delete(name); set.push(`${name}=; Path=/; Max-Age=0`); },
    };
    setContext("deploy-preview", { cookies, ip: "127.0.0.1" });
    const params = Object.fromEntries(names.map((n, i) => [n, m[i + 1]]).filter(([, v]) => v));
    const req = new Request(url, { method: nreq.method, headers, body: nreq.method === "GET" || nreq.method === "HEAD" ? undefined : body });
    const r: Response = await fn(req, { params, ip: "127.0.0.1", cookies } as any);
    setContext("deploy-preview");
    return send(nres, r, set);
  }
  // Статични файлове (сайтът и админ панелът – същите файлове като в Deploy Preview)
  let file = p === "/" || p === "/en/" || p === "/de/" ? "index.html" : p.startsWith("/admin") ? "admin/index.html" : p.slice(1);
  if (p.startsWith("/meta-pixel")) file = "meta-pixel/index.html";
  const abs = resolve(file);
  if (!abs.startsWith(resolve(".")) || !existsSync(abs) || /^(db|server|netlify|tests|node_modules|contract|mail)\//.test(file)) return send(nres, new Response("Not found", { status: 404 }));
  return send(nres, new Response(readFileSync(abs), { headers: { "Content-Type": TYPES[extname(abs)] || "application/octet-stream", "Cache-Control": "no-store" } }));
}

async function send(nres: any, r: Response, cookies: string[] = []) {
  const h: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => { h[k] = v; });
  if (cookies.length) h["set-cookie"] = cookies;
  nres.writeHead(r.status, h);
  nres.end(Buffer.from(await r.arrayBuffer()));
}
