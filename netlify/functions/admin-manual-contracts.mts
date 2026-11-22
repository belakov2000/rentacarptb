import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import type { Config } from "@netlify/functions";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { cars } from "../../db/schema.js";
import { buildContract, contractFileName, parseContract, type ContractData } from "../../contract/index.js";
import { audit, json, requireAdmin } from "../../server/auth.js";
import { days } from "../../server/pricing.js";
import { store } from "../../server/stores.js";
import { printableContract } from "../../server/manual-contract-print.js";
import { checkJpeg } from "./documents.mts";

const BASE = "/api/admin/manual-contracts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD_PREFIX = "manual/records/";
const slots = ["id-front", "id-back", "licence-front", "licence-back"];
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const photoUploadsEnabled = () => process.env.MANUAL_CONTRACT_PHOTOS_ENABLED === "true";
const inventory = { id: cars.id, brand: cars.brand, model: cars.model, reg: cars.reg };
type Saved = {
  id: string; data: ContractData; revision: number; docx: string;
  createdAt: string; createdBy: string; updatedAt: string; updatedBy: string;
};
const recordKey = (id: string) => RECORD_PREFIX + id;
const photoPrefix = (id: string) => "manual/photos/" + id + "/";
const recordStore = () => store("contracts", { strong: true });
const photoStore = () => store("documents", { strong: true });
const missing = () => json({ error: "not_found" }, 404);
const conflict = () => json({ error: "revision_conflict" }, 409);

async function detail(saved: Saved) {
  const prefix = photoPrefix(saved.id);
  const listing = await photoStore().list({ prefix });
  const documents = listing.blobs.map(b => ({ slot: b.key.slice(prefix.length), etag: b.etag })).filter(d => slots.includes(d.slot));
  const { docx, ...record } = saved;
  return { ...record, documents, photoUploadsEnabled: photoUploadsEnabled() };
}

async function list() {
  const records = recordStore();
  const [{ blobs }, vehicles] = await Promise.all([
    records.list({ prefix: RECORD_PREFIX }),
    db.select(inventory).from(cars).orderBy(asc(cars.sort)),
  ]);
  const rows = [];
  // Archive listings only need metadata, never the saved Word contents or ID photographs.
  for (let from = 0; from < blobs.length; from += 20) {
    const part = await Promise.all(blobs.slice(from, from + 20).map(b => records.getMetadata(b.key)));
    for (const summary of part) if (summary) rows.push(summary.metadata);
  }
  rows.sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return json({ rows, cars: vehicles, photoUploadsEnabled: photoUploadsEnabled() });
}

function validDate(s: string) {
  const ms = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

function manualData(raw: any) {
  if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !raw.name.trim() ||
    raw.name.length > 200 || typeof raw.carId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.carId)) return null;
  // Reject control characters that OOXML cannot represent, including in optional free text.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(JSON.stringify(raw).replace(/\\\\/g, "").replace(/\\u(00[01][a-f\d])/ig, (_, hex) => String.fromCharCode(parseInt(hex,16))))) return null;
  const data = parseContract(raw, raw.name.trim(), raw.carId);
  if (!data || data.rent == null || !validDate(data.d1) || !validDate(data.d2) || !data.t1 || !data.t2 ||
    data.d1 + data.t1 >= data.d2 + data.t2 || raw.d1 !== data.d1 || raw.d2 !== data.d2 || raw.t1 !== data.t1 || raw.t2 !== data.t2) return null;
  data.days = days(data.d1, data.t1, data.d2, data.t2);
  if ((data.idd && !validDate(data.idd)) || (data.dld && !validDate(data.dld))) return null;
  if (raw.appendix != null) {
    if (!Array.isArray(raw.appendix) || raw.appendix.length > 32 ||
      raw.appendix.some((line: unknown) => typeof line !== "string" || line.length > 1000)) return null;
    data.appendix = raw.appendix.map((line: string) => line.trim()).filter(Boolean);
  }
  return data;
}

// The archived Word file uses the current fleet details in both handover protocols.
function officeWord(data: ContractData, car: {brand:string; model:string; reg:string}) {
  const parts = unzipSync(buildContract(data));
  const labelValues: Record<string,string> = {
    "Марка / Модел: ": [car.brand,car.model].filter(Boolean).join(" "),
    "Регистрационен номер: ": car.reg,
  };
  const xml = strFromU8(parts["word/document.xml"]).replace(
    /(<w:t(?:\s[^>]*)?>)(Марка \/ Модел: |Регистрационен номер: )[^<]*(<\/w:t>)/g,
    (original, start, label, end) => {
      const value = labelValues[label];
      if (!value) return original;
      const safe = value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      return start + label + safe + end;
    });
  parts["word/document.xml"] = strToU8(xml);
  return zipSync(parts,{level:6});
}

async function save(req: Request, id: string, actor: string) {
  if (!req.headers.get("content-type")?.startsWith("application/json")) return json({error:"content_type"},415);
  const text = await req.text();
  if (text.length > 50_000) return json({ error:"too_large" },413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error:"invalid" },400); }
  const data = manualData(body?.data);
  if (!data || !Number.isSafeInteger(body.revision) || body.revision < 0) return json({ error:"invalid" },400);
  const target = recordStore();
  const existing = await target.getWithMetadata(recordKey(id), { type:"json" });
  const previous = existing?.data as Saved | undefined;
  const [car] = await db.select(inventory).from(cars).where(eq(cars.id,data.carId));
  if (!car) return json({ error:"car" },400);


  // A repeated request after an interrupted response returns the previously committed result.
  if (previous?.revision !== body.revision && previous) {
    if (previous.revision === body.revision + 1 && previous.updatedBy === actor &&
      JSON.stringify(data) === JSON.stringify(previous.data)) return json(await detail(previous));
    return conflict();
  }
  if (!previous && body.revision !== 0) return missing();
  if (existing && !existing.etag) return conflict();

  const updatedAt = new Date().toISOString();
  const saved: Saved = {
    id, data, revision: body.revision + 1, updatedAt, updatedBy: actor,
    createdAt: previous?.createdAt || updatedAt, createdBy: previous?.createdBy || actor,
    docx: Buffer.from(officeWord(data,car)).toString("base64"),
  };
  // One conditional write saves the form and the exact generated file together.
  const summary = { id, name:data.name, carId:data.carId, d1:data.d1, d2:data.d2, updatedAt, revision:saved.revision };
  const write = await target.setJSON(recordKey(id),saved,{
    ...(existing ? {onlyIfMatch:existing.etag!} : {onlyIfNew:true}), metadata:summary,
  });
  if (!write.modified) return conflict();
  await audit(actor,"manual_contract.save",{ id,revision:saved.revision }).catch(() => null);
  return json(await detail(saved), previous ? 200 : 201);
}

async function photograph(req: Request, id: string, slot: string, actor: string) {
  if (!slots.includes(slot) || !await recordStore().getMetadata(recordKey(id))) return missing();
  const source = photoStore(), key = photoPrefix(id) + slot;
  if (req.method === "GET") {
    const file = await source.get(key, {type:"arrayBuffer"});
    if (!file) return missing();
    await audit(actor,"manual_contract.document.view",{id,slot});
    return new Response(file,{ headers:{...headers,"Content-Type":"image/jpeg","Content-Disposition":"inline; filename=document.jpg"} });
  }
  if (!photoUploadsEnabled()) return json({ error:"photo_upload_disabled" },403);
  if (req.headers.get("content-type")?.split(";")[0].trim() !== "image/jpeg") return json({error:"not_jpeg"},415);
  const max = 4 * 1024 * 1024;
  if (Number(req.headers.get("content-length")) > max) return json({error:"too_large"},413);
  const file = await req.arrayBuffer();
  if (!file.byteLength || file.byteLength > max) return json({error:"too_large"},413);
  const valid = checkJpeg(new Uint8Array(file));
  if (!valid.ok) return json({ error:valid.error },415);
  const expected = req.headers.get("if-match");
  if (expected === "*" || (expected && expected.length > 256)) return json({error:"invalid"},400);
  const write = await source.set(key,file, {
    ...(expected ? {onlyIfMatch:expected} : {onlyIfNew:true}),
    metadata:{uploadedBy:actor,uploadedAt:new Date().toISOString(),width:valid.width,height:valid.height},
  });
  if (!write.modified) return conflict();
  await audit(actor,"manual_contract.document.save",{id,slot}).catch(() => null);
  return json({slot,etag:write.etag});
}

export default async function handler(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const path = new URL(req.url).pathname;
  if (req.method === "GET" && path === BASE) return list();
  const [id,action,slot,...extra] = path.slice(BASE.length + 1).split("/");
  if (!UUID.test(id) || extra.length) return missing();
  if (action === "document" && slot && (req.method === "GET" || req.method === "POST")) return photograph(req,id,slot,admin.email);
  if (action && action !== "file" && action !== "print" || slot) return missing();
  if (!action && req.method === "POST") return save(req,id,admin.email);
  if (req.method !== "GET") return json({error:"method"},405);
  const saved = await recordStore().get(recordKey(id),{type:"json"}) as Saved | null;
  if (!saved) return missing();
  if (!action) return json(await detail(saved));
  const file = Buffer.from(saved.docx,"base64");
  if (action === "file") return new Response(file,{headers:{...headers,"Content-Type":DOCX,"Content-Disposition":`attachment; filename="${contractFileName(saved.data)}"`}});
  return new Response(printableContract(file),{headers:{...headers,"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'"}});
}

export const config: Config = {
  path: ["/api/admin/manual-contracts", "/api/admin/manual-contracts/:id", "/api/admin/manual-contracts/:id/file", "/api/admin/manual-contracts/:id/print", "/api/admin/manual-contracts/:id/document/:slot"],
  method: ["GET","POST"],
};
