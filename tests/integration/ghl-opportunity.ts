// Тест на синтетична сделка в HighLevel (/api/admin/ghl-test/opportunity): среда, вход, CSRF, проверки преди запис,
// съпоставяне на полетата, повторно пускане и грешки. HighLevel се симулира – няма реални заявки.
import { check, cookieJar, fakeJwt, finish, http, identity, mail, O, setContext } from "./harness.ts";
import { stores } from "./stubs/blobs.ts";
import fn from "../../netlify/functions/admin-ghl-test.mts";

const TOKEN = "pit-test-only-secret-0123456789";
const LOC = "LocTest123";
process.env.GHL_PRIVATE_INTEGRATION_TOKEN = TOKEN;
process.env.GHL_LOCATION_ID = LOC;
const EMAIL = "ptb-ghl-connectivity-test@example.com";
const NAME = "PTB TEST BOOKING — NOT A REAL RESERVATION";
const FIELDS = { "PTB Booking ID": "CF_BOOKING", "PTB Car": "CF_CAR", "PTB Pickup Date": "CF_PICKUP", "PTB Return Date": "CF_RETURN" };
const EXPECTED = { CF_BOOKING: "PTB-GHL-TEST-001", CF_CAR: "TEST CAR", CF_PICKUP: "2026-11-01", CF_RETURN: "2026-11-05" };

// ===== Симулиран HighLevel със състояние =====
type Call = { method: string; path: string; query: Record<string, string>; body: any };
const dndAll = (status = "active") => Object.fromEntries(["call", "email", "sms", "whatsApp", "gmb", "fb"].map((c) => [c, { status }]));
const fixtureContact = () => ({ id: "c1", name: "PTB TEST CONTACT", firstName: "Ptb", lastName: "Test Contact", email: EMAIL, phone: null, dnd: true, dndSettings: dndAll() as any });
const fields = () => [
  { id: "CF_BOOKING", name: "PTB Booking ID", dataType: "TEXT", model: "opportunity" },
  { id: "CF_CAR", name: "PTB Car", dataType: "TEXT", model: "opportunity" },
  { id: "CF_PICKUP", name: "PTB Pickup Date", dataType: "DATE", model: "opportunity" },
  { id: "CF_RETURN", name: "PTB Return Date", dataType: "DATE", model: "opportunity" },
  { id: "CF_OTHER", name: "Customer Notes", dataType: "LARGE_TEXT", model: "opportunity" },
];
const pipelines = () => [
  { id: "P1", name: "Rentacar Bookings", stages: [{ id: "S0", name: "New Lead" }, { id: "S1", name: "Booking Request" }, { id: "S2", name: "Confirmed" }] },
  { id: "P2", name: "Other Pipeline", stages: [{ id: "S9", name: "Booking Request" }] },
];
let g: ReturnType<typeof fresh>;
function fresh() {
  return {
    calls: [] as Call[],
    contact: fixtureContact() as any,
    lookup: null as null | (() => Response),
    pipelines: pipelines() as any[],
    fields: fields() as any[],
    opps: new Map<string, any>(),
    extraSearch: [] as any[], // „чужди“ резултати, които търсенето връща
    searchTotal: null as number | null,
    hidden: new Set<string>(), // създадени, но още невидими в търсенето (закъснение на индекса)
    lag: false,
    dateAsEpoch: false,
    tamper: null as null | ((o: any) => void), // HighLevel записва нещо различно
    fail: {} as Record<string, () => Response | Error>,
    next: 1,
  };
}
const paths = new Set<string>();
const step = (c: Call) =>
  c.path === "/contacts/search/duplicate" ? "lookup" : c.path.startsWith("/contacts/") ? "contact" : c.path === "/opportunities/pipelines" ? "pipelines" :
  c.path.endsWith("/customFields") ? "fields" : c.path === "/opportunities/search" ? "search" : c.path === "/opportunities/" ? "create" :
  c.method === "PUT" ? "update" : "get";
const stored = (o: any) => ({ ...o, customFields: o.customFields.map((cf: any) => ({ id: cf.id, fieldValue: g.dateAsEpoch && /^\d{4}-\d{2}-\d{2}$/.test(cf.fieldValue) ? Date.parse(cf.fieldValue + "T00:00:00+02:00") : cf.fieldValue })) });
const identityHandler = http.handler!;
http.handler = async (url, init) => {
  if (!url.startsWith("https://services.leadconnectorhq.com/")) return identityHandler(url, init);
  const u = new URL(url);
  const c: Call = { method: init.method || "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : null };
  g.calls.push(c); paths.add(c.method + " " + c.path.replace(/\/o\d+$/, "/{id}").replace(/\/c1$/, "/{contactId}"));
  if (init.headers?.Version !== "v3" || init.headers?.Authorization !== `Bearer ${TOKEN}`) return Response.json({}, { status: 401 });
  const f = g.fail[step(c)]?.();
  if (f instanceof Error) throw f;
  if (f) return f;
  switch (step(c)) {
    case "lookup": return g.lookup ? g.lookup() : Response.json({ contact: g.contact ? { ...g.contact } : null });
    case "contact": return g.contact && c.path === `/contacts/${g.contact.id}` ? Response.json({ contact: { ...g.contact } }) : Response.json({}, { status: 404 });
    case "pipelines": return Response.json({ pipelines: g.pipelines });
    case "fields": return c.path === `/locations/${LOC}/customFields` && c.query.model === "opportunity" ? Response.json({ customFields: g.fields }) : Response.json({}, { status: 400 });
    case "search": {
      const list = [...g.opps.values()].filter((o) => o.contactId === c.query.contactId && !g.hidden.has(o.id)).map(stored).concat(g.extraSearch);
      return Response.json({ opportunities: list, meta: { total: g.searchTotal ?? list.length } });
    }
    case "create": {
      const id = "o" + g.next++;
      const o = { id, ...c.body, createdAt: "now" };
      g.tamper?.(o);
      g.opps.set(id, o); if (g.lag) g.hidden.add(id);
      return Response.json({ opportunity: stored(o) }, { status: 201 });
    }
    case "update": {
      const id = c.path.split("/").pop()!;
      if (!g.opps.has(id)) return Response.json({}, { status: 404 });
      const o = { ...g.opps.get(id), ...c.body };
      g.tamper?.(o);
      g.opps.set(id, o);
      return Response.json({ opportunity: stored(o) });
    }
    case "get": {
      const o = g.opps.get(c.path.split("/").pop()!);
      return o ? Response.json({ opportunity: stored(o) }) : Response.json({ message: "not found" }, { status: 404 });
    }
  }
  return Response.json({}, { status: 404 });
};
const writes = () => g.calls.filter((c) => c.method !== "GET");
const reset = () => { g = fresh(); stores.delete("deploypreview-ghl-test"); };
reset();

// Логовете се прихващат – в тях не трябва да има токен или текст от HighLevel
const logs: string[] = [];
const original = { log: console.log, error: console.error, warn: console.warn };
for (const k of ["log", "error", "warn"] as const) {
  console[k] = (...a: unknown[]) => { const s = a.map(String).join(" "); if (!/^(PASS|FAIL) \|/.test(s)) logs.push(s); else original[k](...a); };
}

// ===== Сесии =====
identity.users.set("admin@example.com", { id: "1", email: "admin@example.com", password: "x", roles: ["admin"] });
identity.users.set("user@example.com", { id: "2", email: "user@example.com", password: "x", roles: [] });
const session = (email: string, roles: string[], known = true) => {
  const jar = cookieJar(); const t = fakeJwt(email, roles);
  if (known) identity.tokens.set(t, email);
  jar.set({ name: "nf_jwt", value: t }); return jar;
};
const adminJar = session("admin@example.com", ["admin"]);
const userJar = session("user@example.com", []);
const forgedJar = session("attacker@example.com", ["admin"], false);

async function req(opt: { method?: string; ctx?: string; jar?: ReturnType<typeof cookieJar>; origin?: string | null; body?: unknown } = {}) {
  const jar = opt.jar || cookieJar();
  setContext("ctx" in opt ? opt.ctx : "deploy-preview", { cookies: jar });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opt.origin !== null && opt.method === "POST") headers.Origin = opt.origin ?? O;
  const r = await fn(new Request(O + "/api/admin/ghl-test/opportunity", { method: opt.method || "GET", headers, body: opt.method === "POST" ? JSON.stringify(opt.body ?? {}) : undefined }));
  const text = await r.text();
  let j: any = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
const post = (o: Parameters<typeof req>[0] = {}) => req({ method: "POST", jar: adminJar, ...o });

// 1. Среда, вход и CSRF
for (const ctx of ["production", "branch-deploy", "dev", undefined]) {
  reset();
  const a = await req({ ctx, jar: adminJar }), b = await post({ ctx }), c = await req({ ctx, method: "POST" });
  check(`Сделка: среда ${ctx ?? "(липсва)"} → 404 (и с администратор), без HighLevel`, a.status === 404 && b.status === 404 && c.status === 404 && !g.calls.length, `${a.status}/${b.status}/${c.status}`);
}
reset();
const r401 = await req({ method: "POST" }), rForged = await post({ jar: forgedJar }), r403 = await post({ jar: userJar });
const rCross = await post({ origin: "https://evil.example" }), rNoOrigin = await post({ origin: null });
check("Сделка: без вход 401, подправен 401, без роля 403, чужд/липсващ Origin 403", r401.status === 401 && rForged.status === 401 && r403.status === 403 && rCross.status === 403 && rNoOrigin.status === 403, `${r401.status}/${rForged.status}/${r403.status}/${rCross.status}/${rNoOrigin.status}`);
check("Отказаните заявки не стигат до HighLevel", !g.calls.length, String(g.calls.length));
const st = await req({ jar: adminJar });
check("GET → само фиксираните данни, без заявки към HighLevel", st.status === 200 && st.json.opportunity?.name === NAME && st.json.opportunity?.pipeline === "Rentacar Bookings" && st.json.opportunity?.fields?.["PTB Pickup Date"] === "2026-11-01" && !g.calls.length && !st.text.includes(TOKEN), st.text.slice(0, 200));

// 2. Първо пускане: проверки → създаване → четене
reset();
const first = await post({ body: { contactId: "REAL_CONTACT", name: "Real booking", bookingId: "PTB-1234", car: "Golf", pickup: "2026-12-24", monetaryValue: 500, status: "won" } });
const order = g.calls.map(step).join(",");
check("Първо пускане → 200, създадена o1 за синтетичния контакт", first.status === 200 && first.json.ok && first.json.created === true && first.json.opportunityId === "o1" && first.json.contactId === "c1" && first.json.status === "open", first.text);
check("Ред: контакт → DND → pipeline → полета → търсене → създаване → четене", order === "lookup,contact,pipelines,fields,search,create,get", order);
const create = g.calls.find((c) => step(c) === "create")!;
const B = create?.body || {};
check("Тялото съдържа само фиксираната сделка – данните от заявката се игнорират",
  JSON.stringify(Object.keys(B).sort()) === JSON.stringify(["contactId", "customFields", "locationId", "monetaryValue", "name", "pipelineId", "pipelineStageId", "status"]) &&
  B.name === NAME && B.contactId === "c1" && B.locationId === LOC && B.pipelineId === "P1" && B.pipelineStageId === "S1" && B.status === "open" && B.monetaryValue === 0, JSON.stringify(B));
check("Полетата се записват по ID-тата, прочетени от API-то (без чужди полета)", JSON.stringify(Object.fromEntries((B.customFields || []).map((c: any) => [c.id, c.fieldValue]))) === JSON.stringify(EXPECTED) && B.customFields.every((c: any) => Object.keys(c).sort().join() === "fieldValue,id"), JSON.stringify(B.customFields));
check("Търсенето е само по синтетичния контакт в зададената локация (всички статуси)", JSON.stringify(g.calls.find((c) => step(c) === "search")?.query) === JSON.stringify({ locationId: LOC, contactId: "c1", status: "all", limit: "100" }), JSON.stringify(g.calls.find((c) => step(c) === "search")?.query));
check("Отговорът съдържа прочетените стойности на четирите полета", JSON.stringify(first.json.fields) === JSON.stringify({ "PTB Booking ID": "PTB-GHL-TEST-001", "PTB Car": "TEST CAR", "PTB Pickup Date": "2026-11-01", "PTB Return Date": "2026-11-05" }) && first.json.remembered === true, JSON.stringify(first.json.fields));

// 3. Последователно повторно пускане → същата сделка се обновява
g.calls = [];
const second = await post();
const third = await post();
check("2-ро и 3-то пускане → същата o1 (reused), без ново създаване", [second, third].every((r) => r.status === 200 && r.json.reused === true && r.json.opportunityId === "o1") && g.opps.size === 1 && !g.calls.some((c) => step(c) === "create"), `${second.text} / ${g.opps.size}`);
check("Обновяването е PUT само на /opportunities/o1 с фиксираните данни", g.calls.filter((c) => c.method === "PUT").every((c) => c.path === "/opportunities/o1" && c.body.name === NAME && c.body.status === "open" && !("contactId" in c.body)) && g.calls.filter((c) => c.method === "PUT").length === 2, "");

// 4. Закъснение на търсенето: запомненото ID предотвратява втора сделка
reset(); g.lag = true;
const lag1 = await post();
const lag2 = await post();
check("Търсенето още не вижда новата сделка → ползва се запомненото ID, без втора сделка", lag1.json.created === true && lag2.json.reused === true && lag2.json.opportunityId === lag1.json.opportunityId && g.opps.size === 1, `${lag1.json.opportunityId}/${lag2.json.opportunityId}/${g.opps.size}`);
g.opps.clear();
const afterDelete = await post();
check("Запомнената сделка е изтрита ръчно (404) → създава се нова", afterDelete.status === 200 && afterDelete.json.created === true && g.opps.size === 1, afterDelete.text);

// 5. Отказ преди запис
const aborts: [string, () => void, string, string][] = [
  ["няма синтетичен контакт", () => { g.contact = null; }, "contact", "contact_missing"],
  ["два контакта", () => { g.lookup = () => Response.json({ contacts: [fixtureContact(), { ...fixtureContact(), id: "c2" }] }); }, "lookup", "ambiguous_match"],
  ["контакт с телефон", () => { g.contact.phone = "+359888000000"; }, "lookup", "unrelated_match"],
  ["контакт с друго име", () => { g.contact.name = "Ivan Petrov"; g.contact.firstName = "Ivan"; g.contact.lastName = "Petrov"; }, "lookup", "unrelated_match"],
  ["пълният контакт се различава от намерения", () => { g.lookup = () => Response.json({ contact: fixtureContact() }); g.contact.address1 = "ул. 1"; }, "contact", "contact_mismatch"],
  ["DND е изключен", () => { g.contact.dnd = false; }, "contact", "dnd_not_confirmed"],
  ["DND за SMS е inactive", () => { g.contact.dndSettings.sms = { status: "inactive" }; }, "contact", "dnd_not_confirmed"],
  ["липсва DND канал", () => { delete g.contact.dndSettings.fb; }, "contact", "dnd_not_confirmed"],
  ["няма pipeline", () => { g.pipelines = [pipelines()[1]]; }, "pipelines", "pipeline_missing"],
  ["два pipeline-а с това име", () => { g.pipelines = [pipelines()[0], { ...pipelines()[0], id: "P3" }]; }, "pipelines", "ambiguous_pipeline"],
  ["няма етап", () => { g.pipelines[0].stages = [{ id: "S0", name: "New Lead" }]; }, "pipelines", "stage_missing"],
  ["липсва поле", () => { g.fields = fields().filter((f) => f.name !== "PTB Car"); }, "fields", "field_missing"],
  ["поле с грешен тип", () => { g.fields = fields().map((f) => f.name === "PTB Pickup Date" ? { ...f, dataType: "TEXT" } : f); }, "fields", "field_type_mismatch"],
  ["поле на контакти вместо на сделки", () => { g.fields = fields().map((f) => f.name === "PTB Car" ? { ...f, model: "contact" } : f); }, "fields", "field_missing"],
  ["две полета с едно име", () => { g.fields = [...fields(), { id: "CF_DUP", name: "PTB Booking ID", dataType: "TEXT", model: "opportunity" }]; }, "fields", "ambiguous_field"],
  ["търсенето връща чужда сделка", () => { g.extraSearch = [{ id: "real1", name: "Ivan – Golf", contactId: "REAL", pipelineId: "P1", status: "open" }]; }, "search", "unrelated_match"],
  ["друга сделка на синтетичния контакт", () => { g.extraSearch = [{ id: "x1", name: "Something else", contactId: "c1", pipelineId: "P1", status: "open" }]; }, "search", "unrelated_match"],
  ["тестовата сделка е в друг pipeline", () => { g.extraSearch = [{ id: "x2", name: NAME, contactId: "c1", pipelineId: "P2", status: "open" }]; }, "search", "unrelated_match"],
  ["две тестови сделки", () => { g.extraSearch = [1, 2].map((i) => ({ id: "x" + i, name: NAME, contactId: "c1", pipelineId: "P1", status: "open" })); }, "search", "ambiguous_match"],
  ["тестовата сделка е won", () => { g.extraSearch = [{ id: "x3", name: NAME, contactId: "c1", pipelineId: "P1", status: "won" }]; }, "search", "status_mismatch"],
  ["повече резултати от една страница", () => { g.searchTotal = 150; }, "search", "ambiguous_match"],
  ["непознат формат на търсенето", () => { g.fail.search = () => Response.json({ items: [] }); }, "search", "bad_response"],
];
for (const [label, setup, s, error] of aborts) {
  reset(); setup();
  const r = await post();
  check(`Отказ (${label}) → 502 ${s}/${error}, без запис`, r.status === 502 && r.json.step === s && r.json.error === error && !writes().length, r.text);
}
reset();
await post(); // o1 е запомнена
g.hidden.add("o1"); g.opps.set("o9", { id: "o9", name: NAME, contactId: "c1", pipelineId: "P1", status: "open", customFields: [] });
const mism = await post();
check("Запомнената сделка се различава от намерената → ambiguous_match, без запис", mism.status === 502 && mism.json.error === "ambiguous_match" && writes().length === 1, mism.text);
reset();
await post(); g.hidden.add("o1"); g.opps.get("o1").status = "won"; g.calls = [];
const wonKnown = await post();
check("Запомнената сделка е won → status_mismatch, без запис", wonKnown.status === 502 && wonKnown.json.error === "status_mismatch" && !writes().length, wonKnown.text);

// 6. Проверка чрез четене
reset(); g.dateAsEpoch = true;
const epoch = await post();
check("Датите се връщат като epoch ms (полунощ в Europe/Sofia) → приемат се", epoch.status === 200 && epoch.json.ok, epoch.text);
const readback: [string, (o: any) => void, string, string?][] = [
  ["друга стойност на PTB Car", (o) => { o.customFields = o.customFields.map((c: any) => c.id === "CF_CAR" ? { ...c, fieldValue: "GOLF" } : c); }, "field_mismatch", "PTB Car"],
  ["грешна дата на връщане", (o) => { o.customFields = o.customFields.map((c: any) => c.id === "CF_RETURN" ? { ...c, fieldValue: "2026-11-06" } : c); }, "field_mismatch", "PTB Return Date"],
  ["липсващо поле", (o) => { o.customFields = o.customFields.filter((c: any) => c.id !== "CF_BOOKING"); }, "field_mismatch", "PTB Booking ID"],
  ["друг етап", (o) => { o.pipelineStageId = "S2"; }, "stage_mismatch"],
  ["друга стойност", (o) => { o.monetaryValue = 100; }, "value_mismatch"],
];
for (const [label, t, error, field] of readback) {
  reset(); g.tamper = t;
  const r = await post();
  check(`Четене: ${label} → 502 verify/${error}${field ? " (" + field + ")" : ""}`, r.status === 502 && r.json.step === "verify" && r.json.error === error && r.json.field === field, r.text);
}

// 7. Грешки от HighLevel – само стъпка и HTTP статус
const LEAK = `upstream-detail Bearer ${TOKEN} location ${LOC}`;
const failures: [string, string, () => Response | Error, string, number | null][] = [
  ["pipelines", "pipelines 401", () => new Response(LEAK, { status: 401 }), "upstream", 401],
  ["fields", "полета 403", () => Response.json({ message: LEAK }, { status: 403 }), "upstream", 403],
  ["search", "търсене 500", () => new Response(LEAK, { status: 500 }), "upstream", 500],
  ["contact", "контакт – мрежа", () => new TypeError("fetch failed " + LEAK), "network", null],
  ["create", "създаване 422", () => Response.json({ message: LEAK }, { status: 422 }), "upstream", 422],
  ["create", "създаване – изтекло време", () => Object.assign(new Error(LEAK), { name: "TimeoutError" }), "timeout", null],
  ["get", "четене – не е JSON", () => new Response("<html>" + LEAK, { status: 200 }), "bad_response", 200],
];
for (const [s, label, f, error, upstreamStatus] of failures) {
  reset(); g.fail[s] = f;
  const r = await post();
  const st2 = s === "get" ? "verify" : s;
  check(`HighLevel ${label} → 502 ${st2}/${error}, без подробности`, r.status === 502 && r.json.step === st2 && r.json.error === error && r.json.upstreamStatus === upstreamStatus && !r.text.includes("upstream-detail") && !r.text.includes(TOKEN) && !r.text.includes(LOC), r.text);
}
reset(); await post(); g.calls = []; g.fail.update = () => Object.assign(new Error(LEAK), { name: "TimeoutError" });
const upd = await post();
check("HighLevel обновяване – изтекло време → 502 update/timeout", upd.status === 502 && upd.json.step === "update" && upd.json.error === "timeout", upd.text);

// 8. Обхват
const all = logs.join("\n");
check("Логовете не съдържат токена, Location ID или текст от HighLevel", !all.includes(TOKEN) && !all.includes(LOC) && !all.includes("upstream-detail"), "");
const allowed = ["GET /contacts/search/duplicate", "GET /contacts/{contactId}", "GET /opportunities/pipelines", `GET /locations/${LOC}/customFields`, "GET /opportunities/search", "POST /opportunities/", "PUT /opportunities/{id}", "GET /opportunities/{id}"];
check("Само разрешените заявки – без upsert на контакт, промяна на статус, workflows или съобщения", [...paths].every((p) => allowed.includes(p)), [...paths].join(", "));
check("Нито едно писмо към Brevo", mail.calls === 0, String(mail.calls));

Object.assign(console, original);
await finish();
