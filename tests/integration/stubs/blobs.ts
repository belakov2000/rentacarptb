// Симулирано хранилище Netlify Blobs в паметта: etag = md5 на съдържанието; възможни са забавяне и грешки
import { createHash } from "node:crypto";
type Item = { data: Uint8Array; metadata: Record<string, unknown>; etag: string };
export const stores = new Map<string, Map<string, Item>>();
// eventualMs: как в Netlify Blobs по подразбиране (consistency „eventual“) list() не вижда ключове, записани в последните eventualMs;
// хранилище, отворено с consistency: "strong", ги вижда веднага
export const faults = { delayMs: 0, failGetAfter: Infinity as number, gets: 0, eventualMs: 0 };
const writtenAt = new Map<string, number>();
const buf = async (d: any) => typeof d === "string" ? new TextEncoder().encode(d) : d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : new Uint8Array(d);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// По избор хранилищата се пазят на диск (BLOB_STUB_DIR) – за тестове, които пускат отделен процес (scripts/restore.ts)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const FILE = () => process.env.BLOB_STUB_DIR && `${process.env.BLOB_STUB_DIR}/stores.json`;
export function saveStores() {
  const f = FILE(); if (!f) return;
  const out: Record<string, Record<string, { d: string; m: Record<string, unknown>; e: string }>> = {};
  for (const [n, m] of stores) out[n] = Object.fromEntries([...m].map(([k, it]) => [k, { d: Buffer.from(it.data).toString("base64"), m: it.metadata, e: it.etag }]));
  writeFileSync(f, JSON.stringify(out));
}
export function loadStores() {
  const f = FILE(); if (!f || !existsSync(f)) return;
  stores.clear();
  for (const [n, m] of Object.entries(JSON.parse(readFileSync(f, "utf8")) as Record<string, any>))
    stores.set(n, new Map(Object.entries(m).map(([k, it]: [string, any]) => [k, { data: new Uint8Array(Buffer.from(it.d, "base64")), metadata: it.m, etag: it.e }])));
}
if (process.env.BLOB_STUB_CHILD) loadStores();
export function getStore(arg: string | { name: string; consistency?: string }) {
  const name = typeof arg === "string" ? arg : arg.name;
  const strong = typeof arg === "object" && arg.consistency === "strong";
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name)!;
  const out = (it: Item, type?: string) => type === "text" ? new TextDecoder().decode(it.data) : type === "json" ? JSON.parse(new TextDecoder().decode(it.data)) : it.data.buffer.slice(it.data.byteOffset, it.data.byteOffset + it.data.byteLength);
  return {
    async set(key: string, data: any, o: any = {}) { const d = await buf(data); writtenAt.set(name + "\u0000" + key, Date.now()); m.set(key, { data: d, metadata: JSON.parse(JSON.stringify(o.metadata || {})), etag: '"' + createHash("md5").update(d).digest("hex") + '"' }); if (process.env.BLOB_STUB_CHILD) saveStores(); },
    async setJSON(key: string, v: any, o: any = {}) { return this.set(key, JSON.stringify(v), o); },
    async get(key: string, o: any = {}) { const it = m.get(key); return it ? out(it, o.type) : null; },
    async getWithMetadata(key: string, o: any = {}) {
      faults.gets++; if (faults.gets > faults.failGetAfter) throw new Error("simulated network failure");
      if (faults.delayMs) await sleep(faults.delayMs);
      const it = m.get(key); return it ? { data: out(it, o.type), metadata: it.metadata, etag: it.etag } : null; },
    async getMetadata(key: string) { const it = m.get(key); return it ? { etag: it.etag, metadata: it.metadata } : null; },
    async list(o: any = {}) { return { blobs: [...m.entries()].filter(([k]) => !o.prefix || k.startsWith(o.prefix)).filter(([k]) => strong || !faults.eventualMs || Date.now() - (writtenAt.get(name + "\u0000" + k) ?? 0) > faults.eventualMs).map(([key, it]) => ({ key, etag: it.etag })), directories: [] }; },
    async delete(key: string) { m.delete(key); if (process.env.BLOB_STUB_CHILD) saveStores(); },
  };
}

// Отпечатък на хранилище: всеки ключ с etag и SHA-256 на съдържанието – за доказване, че нищо не е променено
export function fingerprint(name: string) {
  const m = stores.get(name) || new Map();
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, it]) => `${k}=${it.etag}:${createHash("sha256").update(it.data).digest("hex")}:${JSON.stringify(it.metadata)}`).join("\n");
}
