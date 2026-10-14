import { store } from "./stores.js";

// Тестове на връзката с HighLevel (GHL) в Deploy Preview: само фиксиран синтетичен контакт и фиксирана синтетична сделка.
// Не чете резервации или клиенти от сайта, не изпраща съобщения, не добавя етикети, не пуска workflows
// и никога не маркира нищо като won. Токенът остава на сървъра; грешките съдържат само стъпка, код и HTTP статус.

// Официална документация (проверена 14.10.2026) – текущата версия е "v3" и за двете групи:
// https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact
// https://marketplace.gohighlevel.com/docs/ghl/opportunities/create-opportunity (и search-opportunity, get-pipelines)
// OpenAPI: apps/v3/contacts-v3.json, apps/v3/opportunities-v3.json, apps/v3/locations-v3.json (customFields)
// в github.com/GoHighLevel/highlevel-api-docs
export const GHL_API = "https://services.leadconnectorhq.com";
export const GHL_VERSION = "v3";
const TIMEOUT_MS = 10_000;

export const FIXTURE = Object.freeze({
  firstName: "PTB",
  lastName: "TEST CONTACT",
  name: "PTB TEST CONTACT",
  email: "ptb-ghl-connectivity-test@example.com",
});
// Изходящ Do Not Disturb: dnd + dndSettings за всички канали от схемата DndSettingsSchemaV3
export const DND_CHANNELS = ["call", "email", "sms", "whatsApp", "gmb", "fb"] as const;
const DND = { status: "active", message: "PTB synthetic connectivity test - do not contact" };

export const OPPORTUNITY = Object.freeze({
  name: "PTB TEST BOOKING — NOT A REAL RESERVATION",
  pipeline: "Rentacar Bookings",
  stage: "Booking Request",
  status: "open",
  monetaryValue: 0,
  fields: Object.freeze([
    { name: "PTB Booking ID", dataType: "TEXT", value: "PTB-GHL-TEST-001" },
    { name: "PTB Car", dataType: "TEXT", value: "TEST CAR" },
    { name: "PTB Pickup Date", dataType: "DATE", value: "2026-11-01" },
    { name: "PTB Return Date", dataType: "DATE", value: "2026-11-05" },
  ] as const),
});

// Тялото се строи само от константите – данни от заявката не се приемат
const upsertBody = (locationId: string) => ({
  locationId,
  firstName: FIXTURE.firstName,
  lastName: FIXTURE.lastName,
  name: FIXTURE.name,
  email: FIXTURE.email,
  dnd: true,
  dndSettings: Object.fromEntries(DND_CHANNELS.map((c) => [c, { ...DND }])),
  createNewIfDuplicateAllowed: false,
});

const norm = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").toLowerCase() : "");
const empty = (v: unknown) => v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

// Съществуващ контакт се ползва само ако е точно синтетичният: същият имейл и име, без телефон, адрес или фирма
export function isFixtureContact(c: any) {
  if (!c || typeof c !== "object" || typeof c.id !== "string" || !c.id) return false;
  if (norm(c.email) !== FIXTURE.email) return false;
  const full = norm(c.name) || norm(`${c.firstName ?? ""} ${c.lastName ?? ""}`);
  if (full !== norm(FIXTURE.name)) return false;
  return ["phone", "address1", "city", "state", "postalCode", "companyName", "website", "dateOfBirth"].every((k) => empty(c[k]));
}

// Изходящият DND е потвърден, ако dnd=true и всеки канал е active/permanent (ключовете в отговора може да са с главни букви)
export function hasOutboundDnd(c: any) {
  if (c?.dnd !== true || !c.dndSettings || typeof c.dndSettings !== "object") return false;
  const byKey = new Map(Object.entries(c.dndSettings).map(([k, v]) => [k.toLowerCase(), v as any]));
  return DND_CHANNELS.every((ch) => ["active", "permanent"].includes(byKey.get(ch.toLowerCase())?.status));
}

export class StepError extends Error {
  constructor(public step: string, public upstream: number | null, public code = "upstream", public field?: string) {
    super(`${step}:${code}:${upstream ?? "-"}`);
  }
}

export async function ghl(step: string, token: string, path: string, init: RequestInit = {}) {
  let r: Response;
  try {
    r = await fetch(GHL_API + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch (e) {
    throw new StepError(step, null, e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network");
  }
  if (!r.ok) throw new StepError(step, r.status);
  const body = await r.json().catch(() => null);
  if (!body || typeof body !== "object") throw new StepError(step, r.status, "bad_response");
  return body as Record<string, any>;
}

// Кой контакт би обновил upsert (същото правило за дубликати като в HighLevel); null – няма такъв
async function lookupFixtureContact(token: string, locationId: string) {
  const q = new URLSearchParams({ locationId, email: FIXTURE.email });
  const dup = await ghl("lookup", token, `/contacts/search/duplicate?${q}`);
  let existing: any = null;
  if (Array.isArray(dup.contacts)) {
    if (dup.contacts.length > 1) throw new StepError("lookup", 200, "ambiguous_match");
    existing = dup.contacts[0] ?? null;
  } else if (dup.contact && typeof dup.contact === "object") existing = dup.contact;
  else if (dup.contact != null || !("contact" in dup)) throw new StepError("lookup", 200, "bad_response");
  if (existing && !isFixtureContact(existing)) throw new StepError("lookup", 200, "unrelated_match");
  return existing;
}

export async function runContactTest(token: string, locationId: string) {
  const existing = await lookupFixtureContact(token, locationId);
  const up = await ghl("upsert", token, "/contacts/upsert", { method: "POST", body: JSON.stringify(upsertBody(locationId)) });
  const c = up.contact;
  if (!c || typeof c.id !== "string" || typeof up.new !== "boolean") throw new StepError("upsert", 200, "bad_response");
  // Повторният тест трябва да ползва същия контакт; друг резултат се отчита като грешка
  if (existing ? up.new || c.id !== existing.id : !up.new) throw new StepError("upsert", 200, "unexpected_match");
  return { created: up.new, reused: !up.new, contactId: c.id, dnd: c.dnd === true };
}

// ===== Синтетична сделка (opportunity) =====

// Само чете: синтетичният контакт трябва вече да съществува, да е точно той и да е с изходящ DND
async function verifyContact(token: string, locationId: string) {
  const found = await lookupFixtureContact(token, locationId);
  if (!found) throw new StepError("contact", 200, "contact_missing");
  if (!isId(found.id)) throw new StepError("contact", 200, "bad_response");
  const full = (await ghl("contact", token, `/contacts/${found.id}`)).contact;
  if (!full || full.id !== found.id || !isFixtureContact(full)) throw new StepError("contact", 200, "contact_mismatch");
  if (!hasOutboundDnd(full)) throw new StepError("contact", 200, "dnd_not_confirmed");
  return found.id as string;
}

// Точно един pipeline и един етап с тези имена
async function findStage(token: string, locationId: string) {
  const r = await ghl("pipelines", token, `/opportunities/pipelines?${new URLSearchParams({ locationId })}`);
  if (!Array.isArray(r.pipelines)) throw new StepError("pipelines", 200, "bad_response");
  const ps = r.pipelines.filter((p: any) => norm(p?.name) === norm(OPPORTUNITY.pipeline));
  if (ps.length !== 1) throw new StepError("pipelines", 200, ps.length ? "ambiguous_pipeline" : "pipeline_missing");
  const stages = Array.isArray(ps[0].stages) ? ps[0].stages.filter((s: any) => norm(s?.name) === norm(OPPORTUNITY.stage)) : [];
  if (stages.length !== 1) throw new StepError("pipelines", 200, stages.length ? "ambiguous_stage" : "stage_missing");
  if (!isId(ps[0].id) || !isId(stages[0].id)) throw new StepError("pipelines", 200, "bad_response");
  return { pipelineId: ps[0].id as string, stageId: stages[0].id as string };
}

// Четирите полета на сделките: точно по едно с това име и с очаквания тип
async function findFields(token: string, locationId: string) {
  const r = await ghl("fields", token, `/locations/${locationId}/customFields?${new URLSearchParams({ model: "opportunity" })}`);
  if (!Array.isArray(r.customFields)) throw new StepError("fields", 200, "bad_response");
  return OPPORTUNITY.fields.map((f) => {
    const m = r.customFields.filter((c: any) => norm(c?.name) === norm(f.name) && (c.model == null || c.model === "opportunity"));
    if (m.length !== 1) throw new StepError("fields", 200, m.length ? "ambiguous_field" : "field_missing", f.name);
    if (m[0].dataType !== f.dataType) throw new StepError("fields", 200, "field_type_mismatch", f.name);
    if (typeof m[0].id !== "string" || !m[0].id) throw new StepError("fields", 200, "bad_response", f.name);
    return { ...f, id: m[0].id as string };
  });
}
type Field = Awaited<ReturnType<typeof findFields>>[number];

const HOUR = 3_600_000;
// Датата може да се върне като "YYYY-MM-DD", ISO време или epoch ms; приема се полунощ на същата дата в часова зона от -14 до +14 ч.
export function sameDate(v: unknown, ymd: string) {
  if (typeof v === "string" && v.trim() === ymd) return true;
  const t = typeof v === "number" ? v : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : typeof v === "string" && /^\d{10,13}$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(t)) return false;
  const ms = t < 1e11 ? t * 1000 : t;
  return Math.abs(ms - Date.parse(ymd + "T00:00:00Z")) <= 14 * HOUR;
}
const fieldValue = (cf: any) => cf?.fieldValue ?? cf?.fieldValueString ?? cf?.fieldValueDate ?? cf?.value;

// Тялото на сделката се строи само от константите и проверените ID-та
const opportunityBody = (stage: { pipelineId: string; stageId: string }, fields: Field[]) => ({
  name: OPPORTUNITY.name,
  pipelineId: stage.pipelineId,
  pipelineStageId: stage.stageId,
  status: OPPORTUNITY.status,
  monetaryValue: OPPORTUNITY.monetaryValue,
  customFields: fields.map((f) => ({ id: f.id, fieldValue: f.value })),
});

// Синтетичната сделка: точното име, свързана със синтетичния контакт, в pipeline-а и със статус open
function checkFixtureOpportunity(o: any, contactId: string, pipelineId: string, step: string) {
  if (!o || !isId(o.id) || (o.contactId ?? o.contact?.id) !== contactId || o.name !== OPPORTUNITY.name || o.pipelineId !== pipelineId) throw new StepError(step, 200, "unrelated_match");
  if (o.status !== OPPORTUNITY.status) throw new StepError(step, 200, "status_mismatch");
}

// Последната създадена тестова сделка (търсенето в HighLevel може да закъснее след създаване)
const STATE_KEY = (locationId: string) => `opportunity-${locationId}`;
async function remembered(locationId: string, contactId: string) {
  const s: any = await store("ghl-test").get(STATE_KEY(locationId), { type: "json" }).catch(() => {
    throw new StepError("state", null, "state_unavailable");
  });
  return s && s.contactId === contactId && isId(s.opportunityId) ? (s.opportunityId as string) : null;
}

export async function runOpportunityTest(token: string, locationId: string) {
  // 1. Проверки без запис: контакт + DND, pipeline и етап, четирите полета
  const contactId = await verifyContact(token, locationId);
  const stage = await findStage(token, locationId);
  const fields = await findFields(token, locationId);

  // 2. Всички сделки на синтетичния контакт: позволена е само една и тя трябва да е тестовата
  const q = new URLSearchParams({ locationId, contactId, status: "all", limit: "100" });
  const s = await ghl("search", token, `/opportunities/search?${q}`);
  if (!Array.isArray(s.opportunities)) throw new StepError("search", 200, "bad_response");
  if (typeof s.meta?.total === "number" && s.meta.total > s.opportunities.length) throw new StepError("search", 200, "ambiguous_match");
  for (const o of s.opportunities) checkFixtureOpportunity(o, contactId, stage.pipelineId, "search");
  if (s.opportunities.length > 1) throw new StepError("search", 200, "ambiguous_match");
  let existingId: string | null = s.opportunities[0]?.id ?? null;

  const known = await remembered(locationId, contactId);
  if (known && existingId && known !== existingId) throw new StepError("search", 200, "ambiguous_match");
  if (known && !existingId) {
    // Създадена при предишно пускане, но още не се вижда в търсенето – проверява се директно по ID
    const g = await ghl("get", token, `/opportunities/${known}`).catch((e) => {
      if (e instanceof StepError && (e.upstream === 404 || e.upstream === 400)) return null; // изтрита ръчно
      throw e;
    });
    if (g?.opportunity) {
      checkFixtureOpportunity(g.opportunity, contactId, stage.pipelineId, "get");
      existingId = known;
    }
  }

  // 3. Запис: обновяване на същата тестова сделка или създаване на нова
  const body = opportunityBody(stage, fields);
  let id: string;
  let saved = true;
  if (existingId) {
    await ghl("update", token, `/opportunities/${existingId}`, { method: "PUT", body: JSON.stringify(body) });
    id = existingId;
  } else {
    const c = await ghl("create", token, "/opportunities/", { method: "POST", body: JSON.stringify({ ...body, locationId, contactId }) });
    if (!isId(c.opportunity?.id)) throw new StepError("create", 200, "bad_response");
    id = c.opportunity.id;
    saved = await store("ghl-test").setJSON(STATE_KEY(locationId), { opportunityId: id, contactId, at: new Date().toISOString() }).then(() => true, () => false);
  }

  // 4. Проверка чрез четене само на тестовата сделка
  const o = (await ghl("verify", token, `/opportunities/${id}`)).opportunity;
  if (!o || o.id !== id) throw new StepError("verify", 200, "bad_response");
  checkFixtureOpportunity(o, contactId, stage.pipelineId, "verify");
  if (o.pipelineStageId !== stage.stageId) throw new StepError("verify", 200, "stage_mismatch");
  if ((o.monetaryValue ?? 0) !== 0) throw new StepError("verify", 200, "value_mismatch");
  const cfs = Array.isArray(o.customFields) ? o.customFields : [];
  const values: Record<string, string> = {};
  for (const f of fields) {
    const v = fieldValue(cfs.find((c: any) => c?.id === f.id));
    if (f.dataType === "DATE" ? !sameDate(v, f.value) : v !== f.value) throw new StepError("verify", 200, "field_mismatch", f.name);
    values[f.name] = f.value;
  }
  return { created: !existingId, reused: !!existingId, opportunityId: id, contactId, status: o.status, fields: values, remembered: saved };
}
