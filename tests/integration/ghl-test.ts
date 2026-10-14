// Тест на HighLevel (/api/admin/ghl-test): само в Deploy Preview, само за администратор, защита от CSRF, фиксиран
// синтетичен контакт, повторно пускане и грешки от HighLevel. HighLevel се симулира – няма реални заявки.
import { check, cookieJar, fakeJwt, finish, http, identity, mail, O, setContext } from "./harness.ts";
import fn from "../../netlify/functions/admin-ghl-test.mts";

const TOKEN = "pit-test-only-secret-0123456789";
process.env.GHL_PRIVATE_INTEGRATION_TOKEN = TOKEN;
process.env.GHL_LOCATION_ID = "LocTest123";
const EMAIL = "ptb-ghl-connectivity-test@example.com";

// ===== Симулиран HighLevel =====
type Call = { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: any };
const ghl = {
  calls: [] as Call[],
  paths: new Set<string>(), // всички заявки през целия тест
  lookup: (): Response | Error => Response.json({ contact: null }),
  upsert: (_b: any): Response | Error => Response.json({ new: true, contact: { id: "c1", name: "PTB TEST CONTACT", email: EMAIL, dnd: true }, traceId: "t" }),
};
const identityHandler = http.handler!;
http.handler = async (url, init) => {
  if (!url.startsWith("https://services.leadconnectorhq.com/")) return identityHandler(url, init);
  const u = new URL(url);
  const c: Call = { method: init.method || "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
  ghl.calls.push(c);
  ghl.paths.add(c.method + " " + c.path);
  const r = c.path === "/contacts/search/duplicate" && c.method === "GET" ? ghl.lookup() : c.path === "/contacts/upsert" && c.method === "POST" ? ghl.upsert(c.body) : Response.json({}, { status: 404 });
  if (r instanceof Error) throw r;
  return r;
};
const reset = () => { ghl.calls = []; ghl.lookup = () => Response.json({ contact: null }); };

// Логовете се прихващат – в тях не трябва да има токен или текст от HighLevel
const logs: string[] = [];
const original = { log: console.log, error: console.error, warn: console.warn };
for (const k of ["log", "error", "warn"] as const) {
  const orig = console[k];
  console[k] = (...a: unknown[]) => { const s = a.map(String).join(" "); if (!/^(PASS|FAIL) \|/.test(s)) logs.push(s); else orig(...a); };
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
  const r = await fn(new Request(O + "/api/admin/ghl-test", { method: opt.method || "GET", headers, body: opt.method === "POST" ? JSON.stringify(opt.body ?? {}) : undefined }));
  const text = await r.text();
  let j: any = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
const post = (o: Parameters<typeof req>[0] = {}) => req({ method: "POST", jar: adminJar, ...o });

// 1. Среда: само deploy-preview, иначе 404 още преди входа – и без заявки към HighLevel
for (const ctx of ["production", "branch-deploy", "dev", undefined]) {
  reset();
  const g = await req({ ctx, jar: adminJar });
  const p = await post({ ctx });
  const anon = await req({ ctx, method: "POST" });
  check(`Среда ${ctx ?? "(липсва)"} → 404 за GET/POST (и с вход на администратор), без HighLevel`, g.status === 404 && p.status === 404 && anon.status === 404 && !ghl.calls.length, `${g.status}/${p.status}/${anon.status}/${ghl.calls.length}`);
}

// 2. Вход и CSRF
reset();
const none = await req({ method: "POST" });
const noneGet = await req();
const forged = await post({ jar: forgedJar });
const noRole = await post({ jar: userJar });
const cross = await post({ origin: "https://evil.example" });
const noOrigin = await post({ origin: null });
check("Без вход 401 (GET и POST), подправен токен 401, без роля admin 403", none.status === 401 && noneGet.status === 401 && forged.status === 401 && noRole.status === 403, `${none.status}/${noneGet.status}/${forged.status}/${noRole.status}`);
check("POST с чужд или липсващ Origin → 403", cross.status === 403 && noOrigin.status === 403, `${cross.status}/${noOrigin.status}`);
check("Отказаните заявки не стигат до HighLevel", ghl.calls.length === 0, String(ghl.calls.length));

// 3. Зареждане на страницата (GET) – само състояние, без запис
reset();
const st = await req({ jar: adminJar });
check("GET с администратор → 200, configured, API v3, без заявки към HighLevel", st.status === 200 && st.json.configured === true && st.json.apiVersion === "v3" && st.json.context === "deploy-preview" && !ghl.calls.length, st.text);
check("GET не връща токена или Location ID", !st.text.includes(TOKEN) && !st.text.includes("LocTest123"), "");

// 4. Липсващи настройки
reset();
process.env.GHL_PRIVATE_INTEGRATION_TOKEN = "";
const nc = await post();
process.env.GHL_PRIVATE_INTEGRATION_TOKEN = TOKEN;
check("Без токен → 503 not_configured и без заявки", nc.status === 503 && nc.json.error === "not_configured" && !ghl.calls.length, nc.text);

// 5. Първо пускане: няма контакт → upsert създава синтетичния
reset();
const first = await post({ body: { email: "real.customer@example.com", phone: "+359888000000", name: "Иван Иванов", address1: "ул. 1", bookingId: "b1" } });
const lookup = ghl.calls[0], up = ghl.calls[1];
check("Първо пускане → 200, created, същият ID", first.status === 200 && first.json.ok && first.json.created === true && first.json.contactId === "c1" && first.json.dnd === true, first.text);
check("Точно 2 заявки: проверка по имейл + upsert", ghl.calls.length === 2 && lookup.path === "/contacts/search/duplicate" && up.path === "/contacts/upsert", ghl.calls.map((c) => c.method + " " + c.path).join(", "));
check("Проверката търси само по фиксирания имейл в зададената локация", JSON.stringify(lookup?.query) === JSON.stringify({ locationId: "LocTest123", email: EMAIL }), JSON.stringify(lookup?.query));
check("Заявките са с Version: v3 и Bearer токен само в заглавката", ghl.calls.every((c) => c.headers.Version === "v3" && c.headers.Authorization === `Bearer ${TOKEN}`), "");
const B = up?.body || {};
check("Тялото съдържа само фиксирания контакт – данните от заявката се игнорират",
  JSON.stringify(Object.keys(B).sort()) === JSON.stringify(["createNewIfDuplicateAllowed", "dnd", "dndSettings", "email", "firstName", "lastName", "locationId", "name"]) &&
  B.email === EMAIL && B.name === "PTB TEST CONTACT" && B.firstName === "PTB" && B.lastName === "TEST CONTACT" && B.locationId === "LocTest123" && B.createNewIfDuplicateAllowed === false,
  JSON.stringify(B));
check("Изходящ DND: dnd=true и всички 6 канала active", B.dnd === true && JSON.stringify(Object.keys(B.dndSettings || {}).sort()) === JSON.stringify(["call", "email", "fb", "gmb", "sms", "whatsApp"]) && Object.values(B.dndSettings).every((s: any) => s.status === "active"), JSON.stringify(B.dndSettings));
check("Без телефон, адрес, етикети, фирма или полета по избор", !["phone", "address1", "city", "postalCode", "tags", "customFields", "companyName", "inboundDndSettings"].some((k) => k in B), "");

// 6. Повторно пускане: намира същия синтетичен контакт (HighLevel може да промени главните букви) → обновява него
reset();
ghl.lookup = () => Response.json({ contact: { id: "c1", firstName: "Ptb", lastName: "Test Contact", email: "PTB-GHL-Connectivity-Test@example.com", phone: null, tags: [] } });
ghl.upsert = () => Response.json({ new: false, contact: { id: "c1", email: EMAIL, dnd: true }, traceId: "t" });
const again = await post();
check("Повторно пускане → същият контакт е обновен (reused)", again.status === 200 && again.json.reused === true && again.json.created === false && again.json.contactId === "c1" && ghl.calls.length === 2, again.text);

// 7. Чужд или нееднозначен контакт → отказ преди запис
const aborts: [string, () => Response][] = [
  ["друго име", () => Response.json({ contact: { id: "x1", name: "Ivan Petrov", email: EMAIL } })],
  ["има телефон", () => Response.json({ contact: { id: "x2", name: "PTB TEST CONTACT", email: EMAIL, phone: "+359888000000" } })],
  ["има адрес", () => Response.json({ contact: { id: "x3", name: "PTB TEST CONTACT", email: EMAIL, address1: "ул. 1" } })],
  ["друг имейл", () => Response.json({ contact: { id: "x4", name: "PTB TEST CONTACT", email: "other@example.com" } })],
  ["без ID", () => Response.json({ contact: { name: "PTB TEST CONTACT", email: EMAIL } })],
];
for (const [label, l] of aborts) {
  reset(); ghl.lookup = l;
  const r = await post();
  check(`Съществуващ контакт (${label}) → 502 unrelated_match, без upsert`, r.status === 502 && r.json.error === "unrelated_match" && r.json.step === "lookup" && ghl.calls.length === 1, r.text);
}
reset();
ghl.lookup = () => Response.json({ contacts: [{ id: "c1", name: "PTB TEST CONTACT", email: EMAIL }, { id: "c2", name: "PTB TEST CONTACT", email: EMAIL }] });
const amb = await post();
check("Два съвпадащи контакта → 502 ambiguous_match, без upsert", amb.status === 502 && amb.json.error === "ambiguous_match" && ghl.calls.length === 1, amb.text);
reset();
ghl.lookup = () => Response.json({ unexpected: true });
const shape = await post();
check("Непознат формат на отговора от проверката → отказ, без upsert", shape.status === 502 && shape.json.error === "bad_response" && ghl.calls.length === 1, shape.text);

// 8. Upsert не върна очаквания контакт
reset();
ghl.lookup = () => Response.json({ contact: { id: "c1", name: "PTB TEST CONTACT", email: EMAIL } });
ghl.upsert = () => Response.json({ new: false, contact: { id: "OTHER" } });
const other = await post();
ghl.upsert = () => Response.json({ new: true, contact: { id: "c9" } });
const dupNew = await post();
reset();
ghl.upsert = () => Response.json({ new: false, contact: { id: "c5" } });
const hidden = await post();
check("Upsert върна друг контакт / нов вместо същия / обнови неоткрит → unexpected_match", [other, dupNew, hidden].every((r) => r.status === 502 && r.json.error === "unexpected_match" && r.json.ok === false), `${other.json.error}/${dupNew.json.error}/${hidden.json.error}`);

// 9. Грешки от HighLevel – само стъпка и HTTP статус, без текст от отговора и без токен
const LEAK = `upstream-detail Bearer ${TOKEN} location LocTest123`;
const failures: [string, () => void, string, string, number | null][] = [
  ["проверка 401", () => { ghl.lookup = () => new Response(LEAK, { status: 401 }); }, "lookup", "upstream", 401],
  ["проверка 429", () => { ghl.lookup = () => Response.json({ message: LEAK }, { status: 429 }); }, "lookup", "upstream", 429],
  ["проверка – мрежа", () => { ghl.lookup = () => new TypeError("fetch failed " + LEAK); }, "lookup", "network", null],
  ["upsert 422", () => { ghl.upsert = () => Response.json({ message: LEAK }, { status: 422 }); }, "upsert", "upstream", 422],
  ["upsert 500", () => { ghl.upsert = () => new Response(LEAK, { status: 500 }); }, "upsert", "upstream", 500],
  ["upsert – изтекло време", () => { ghl.upsert = () => Object.assign(new Error(LEAK), { name: "TimeoutError" }); }, "upsert", "timeout", null],
  ["upsert – не е JSON", () => { ghl.upsert = () => new Response("<html>" + LEAK, { status: 200 }); }, "upsert", "bad_response", 200],
];
for (const [label, setup, step, error, upstreamStatus] of failures) {
  reset(); ghl.upsert = () => Response.json({ new: true, contact: { id: "c1" } }); setup();
  const r = await post();
  check(`HighLevel ${label} → 502 ${step}/${error}, без подробности`, r.status === 502 && r.json.step === step && r.json.error === error && r.json.upstreamStatus === upstreamStatus && !r.text.includes("upstream-detail") && !r.text.includes(TOKEN), r.text);
}

// 10. Обхват: само проверка и upsert – без сделки, съобщения, workflows, етикети, Brevo или Web3Forms
const all = logs.join("\n");
check("Логовете не съдържат токена, Location ID или текст от HighLevel", !all.includes(TOKEN) && !all.includes("LocTest123") && !all.includes("upstream-detail"), "");
check("Към HighLevel има само проверка по имейл и upsert", JSON.stringify([...ghl.paths].sort()) === JSON.stringify(["GET /contacts/search/duplicate", "POST /contacts/upsert"]), [...ghl.paths].join(", "));
check("Нито едно писмо към Brevo", mail.calls === 0, String(mail.calls));

Object.assign(console, original);
await finish();
