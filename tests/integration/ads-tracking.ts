// Рекламен източник (UTM), плащания, отчет „Реклами: заявки и ROAS“ и разпознаване на средата.
// Само синтетични данни и тестови получатели (@example.com); имейлите към Brevo се прихващат (harness.ts).
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { bookingBody, check, contractData, cookieJar, finish, freshDb, identity, O, schema, setContext, withQuote } from "./harness.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import authFn from "../../netlify/functions/admin-auth.mts";
import adminBookingsFn from "../../netlify/functions/admin-bookings.mts";
import paymentsFn from "../../netlify/functions/admin-payments.mts";
import adsFn from "../../netlify/functions/admin-ads.mts";
import { parseAttribution, variantLabel } from "../../server/attribution.ts";
import { buildReport, sofiaMidnight } from "../../server/ad-report.ts";
import { summarize } from "../../server/payments.ts";
import { deployContext, envKind, storeName } from "../../server/stores.ts";
import { planRestore, RESTORE_ORDER } from "../../server/restore.ts";

const t = await freshDb("ads");
t.use();
identity.users.set("admin@example.com", { id: "1", email: "admin@example.com", password: "admin-pass-123", roles: ["admin"] });
const CAMPAIGN = "ptb_plovdiv_video_test";
const ad = (content: string, at = new Date().toISOString(), extra: Record<string, unknown> = {}) => ({ source: "meta", medium: "paid_social", campaign: CAMPAIGN, content, at, ...extra });
const row = async (id: string) => (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0];
const create = async (s: string, d: string, extra: Record<string, unknown>) => {
  setContext("deploy-preview");
  const r = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await withQuote(bookingBody(s, d, "10:00", d, "18:00", { requestKey: `ads-${s}-key`, contract: contractData(d, "10:00", d, "18:00"), ...extra }))) }), { params: {} } as any);
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

// ===== 1. Двата рекламни варианта стигат до записаната заявка =====
const A = await create("UTMA", "2027-06-01", { attribution: ad("video_a_woman", new Date(Date.now() - 2 * 864e5).toISOString()) });
const B = await create("UTMB", "2027-06-03", { attribution: ad("video_b_man") });
const a = await row(A.json.id), b = await row(B.json.id);
check("1. Видео А: всички UTM параметри и моментът на посещението са записани", A.status === 201 && a.utmSource === "meta" && a.utmMedium === "paid_social" && a.utmCampaign === CAMPAIGN && a.utmContent === "video_a_woman" && a.utmTerm === null && Math.abs(a.utmAt!.getTime() - (Date.now() - 2 * 864e5)) < 60_000, `${a.utmContent} @ ${a.utmAt?.toISOString()}`);
check("2. Видео Б: записано отделно", B.status === 201 && b.utmContent === "video_b_man" && b.utmCampaign === CAMPAIGN, b.utmContent || "");
check("3. Имена на вариантите", variantLabel("video_a_woman") === "Видео А — жена" && variantLabel("video_b_man") === "Видео Б — мъж" && variantLabel("other") === "other" && variantLabel(null) === "", "");

// ===== 2. Директно посещение / отказано съгласие / изтекла атрибуция =====
const D = await create("DIRECT", "2027-06-05", {}); // без съгласие браузърът не изпраща attribution
const E = await create("EXPIRED", "2027-06-07", { attribution: ad("video_a_woman", new Date(Date.now() - 31 * 864e5).toISOString()) });
const d = await row(D.json.id), e = await row(E.json.id);
const empty = (x: any) => [x.utmSource, x.utmMedium, x.utmCampaign, x.utmContent, x.utmTerm, x.utmAt].every((v) => v === null);
check("4. Без източник (директно посещение или отказано съгласие) → празни полета", D.status === 201 && empty(d), "");
check("5. Изтекла атрибуция (31 дни) → без източник", E.status === 201 && empty(e), "");
check("6. Посещение в бъдещето или без момент → без източник", parseAttribution(ad("x", new Date(Date.now() + 3600_000).toISOString())) === null && parseAttribution({ ...ad("x"), at: undefined }) === null, "");
check("7. 29 дни назад → валидно", parseAttribution(ad("x", new Date(Date.now() - 29 * 864e5).toISOString()))?.utmContent === "x", "");

// ===== 3. Повторно изпращане: без втора резервация и без смяна на източника =====
const before = (await t.q("select count(*)::int n from bookings")).rows[0].n;
const A2 = await create("UTMA", "2027-06-01", { attribution: ad("video_b_man") });
const a2 = await row(A.json.id);
check("8. Повторно изпращане със същия ключ → същата заявка, източникът не се променя", A2.status === 200 && A2.json.duplicate === true && A2.json.id === A.json.id && (await t.q("select count(*)::int n from bookings")).rows[0].n === before && a2.utmContent === "video_a_woman", `HTTP ${A2.status}`);

// ===== 4. Валидиране и екраниране =====
const XSS = "<img src=x onerror=alert(1)>";
check("9. HTML / скрипт в задължително поле → целият източник се отхвърля", parseAttribution(ad("video_a_woman", undefined, { campaign: XSS })) === null && parseAttribution(ad("video_a_woman", undefined, { source: '"><script>alert(1)</script>' })) === null, "");
const bad = parseAttribution(ad(XSS, undefined, { term: "x".repeat(101) }));
check("10. Невалидни незадължителни полета (HTML, >100 знака) се изпускат, останалите са от същото посещение", bad?.utmContent === null && bad?.utmTerm === null && bad?.utmCampaign === CAMPAIGN, "");
check("11. Имейл, адрес и параметри не се приемат като стойност", ["ivan@example.com", "https://evil.example/?t=1", "a=b&c=d", "x#y"].every((v) => parseAttribution(ad(v))?.utmContent === null), "");
check("12. Без utm_source / utm_medium / utm_campaign → без източник", parseAttribution({ source: "meta", campaign: CAMPAIGN, at: new Date().toISOString() }) === null && parseAttribution("meta") === null, "");
const X = await create("XSS", "2027-06-09", { attribution: { ...ad(XSS), url: "https://rentacar-ptb.com/?utm_source=meta&email=ivan@example.com", fbclid: "secret" } });
const x = await row(X.json.id);
check("13. Сървърът записва само проверените полета (не адреса и не други параметри)", X.status === 201 && x.utmContent === null && x.utmSource === "meta" && !JSON.stringify(x).includes("ivan@") && !JSON.stringify(x).includes("secret"), "");
const adminHtml = readFileSync("admin/index.html", "utf8");
check("14. Админ панелът екранира всяка UTM стойност (esc)", /\["utm_source",b\.utmSource\]/.test(adminHtml) && /kv\.map\(\(\[k,x\]\)=>`<div><span>\$\{esc\(k\)\}<\/span><b>\$\{esc\(x\)\}<\/b><\/div>`\)/.test(adminHtml), "");

// ===== 5. Админ: вход, среда, подробности за заявката =====
const jar = cookieJar();
async function adm(fn: any, path: string, opt: { method?: string; body?: unknown; params?: Record<string, string>; ctx?: string } = {}) {
  setContext(opt.ctx || "deploy-preview", { cookies: jar, ip: "203.0.113.5" });
  const r = await fn(new Request(O + path, { method: opt.method || "GET", headers: { "Content-Type": "application/json", Origin: O }, body: opt.body ? JSON.stringify(opt.body) : undefined }), { ip: "203.0.113.5", params: opt.params || {} } as any);
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const unauth = await paymentsFn(new Request(O + "/api/admin/payments"), { params: {} } as any);
const unauth2 = await adsFn(new Request(O + "/api/admin/ads/spend"), { params: {} } as any);
check("15. Плащания и отчет без вход → 401", unauth.status === 401 && unauth2.status === 401, `${unauth.status} ${unauth2.status}`);
const lg = await adm(authFn, "/api/admin/login", { method: "POST", body: { email: "admin@example.com", password: "admin-pass-123" } });
check("16. Вход връща и средата (без това панелът показваше „Тестова среда ()“)", lg.status === 200 && lg.json.envKind === "preview" && lg.json.env === "deploy-preview" && lg.json.production === false, JSON.stringify(lg.json));
const meProd = await adm(authFn, "/api/admin/me", { ctx: "production" });
check("17. Production → envKind production", meProd.json.envKind === "production" && meProd.json.production === true, JSON.stringify(meProd.json));
(globalThis as any).Netlify = { context: { deploy: { context: "", id: "", published: false }, cookies: jar, url: new URL(O) } };
const meUnknown = await authFn(new Request(O + "/api/admin/me"), { params: {} } as any).then((r: Response) => r.json());
check("18. Празен контекст от платформата → „unknown“ (не production и не preview)", meUnknown.envKind === "unknown" && meUnknown.production === false && meUnknown.env === "unknown", JSON.stringify(meUnknown));
(globalThis as any).Netlify = undefined;
check("19. Без Netlify.context → unknown; файловете – в изолирано хранилище, не в продукционното", deployContext() === "unknown" && envKind() === "unknown" && storeName("contracts") === "unknown-contracts", storeName("contracts"));
check("20. Непознат контекст → unknown; branch-deploy и dev → preview", envKind("something-else") === "unknown" && envKind("branch-deploy") === "preview" && envKind("dev") === "preview" && envKind("deploy-preview") === "preview", "");
check("21. Банер: „Неизвестна среда“ без твърдение за тестова/изолирана база", /Неизвестна среда: /.test(adminHtml) && !/Неизвестна среда[^<]*отделна база/.test(adminHtml) && /const k=ME\.envKind\|\|"unknown"/.test(adminHtml), "");
const det = await adm(adminBookingsFn, `/api/admin/bookings/${a.id}`, { params: { id: a.id } });
const detD = await adm(adminBookingsFn, `/api/admin/bookings/${d.id}`, { params: { id: d.id } });
check("22. Подробности за заявката съдържат рекламния източник", det.json.booking.utmContent === "video_a_woman" && det.json.booking.utmAt && !("adminToken" in det.json.booking), "");
check("23. Стара/директна заявка: полетата са празни („Няма записан източник“ в панела)", detD.json.booking.utmSource === null && /Няма записан източник/.test(adminHtml), "");

// ===== 6. Плащания: приход, частични плащания, гаранционен депозит, възстановявания =====
let k = 0;
const pay = (bookingId: string, kind: string, amount: string, extra: Record<string, unknown> = {}) =>
  adm(paymentsFn, "/api/admin/payments", { method: "POST", body: { bookingId, kind, method: "cash", amount, status: "received", idempotencyKey: `ads-pay-${++k}-key`, ...extra } });
const p1 = await pay(a.id, "deposit", "50");
await pay(a.id, "partial", "70,50");
const sec = await pay(a.id, "security", "100");
const secId = sec.json.payments.find((p: any) => p.kind === "security").id;
const exp = await pay(a.id, "final", "40", { status: "expected" });
let s = exp.json.summary;
check("24. Аванс + частично плащане = приход; гаранционният депозит не е приход; очакваното не е приход", s.rentalNet === 12050 && s.securityHeld === 10000 && s.expected === 4000, JSON.stringify(s));
const secRefund = await pay(a.id, "refund", "100", { refundOf: secId });
s = secRefund.json.summary;
check("25. Връщането на гаранционния депозит не намалява прихода", secRefund.status === 201 && s.rentalNet === 12050 && s.securityHeld === 0, JSON.stringify(s));
const depId = p1.json.payments.find((p: any) => p.kind === "deposit").id;
const over = await pay(a.id, "refund", "60", { refundOf: depId });
check("26. Възстановяване над платената сума се отказва", over.status === 400 && over.json.error === "refund_amount", over.json.error);
const part = await pay(a.id, "refund", "20", { refundOf: depId });
check("27. Частично възстановяване на аванса намалява прихода", part.json.summary.rentalNet === 10050 && part.json.summary.rentalRefunded === 2000, JSON.stringify(part.json.summary));
const again = await adm(paymentsFn, "/api/admin/payments", { method: "POST", body: { bookingId: a.id, kind: "deposit", method: "cash", amount: "50", status: "received", idempotencyKey: "ads-pay-1-key" } });
check("28. Повторно изпращане на същата форма не създава второ плащане", again.status === 200 && again.json.duplicate === true && again.json.payments.length === 6, `${again.json.payments?.length} плащания`);
check("29. Втори refund на гаранцията (вече върната изцяло) се отказва", (await pay(a.id, "refund", "1", { refundOf: secId })).json.error === "refund_amount", "");
check("30. Невалидни данни се отказват (сума, вид, бъдеща дата, refund без оригинал)", (await pay(a.id, "deposit", "-5")).status === 400 && (await pay(a.id, "gift", "5")).status === 400 && (await pay(a.id, "deposit", "5", { paidAt: new Date(Date.now() + 864e5).toISOString() })).json.error === "paid_at" && (await pay(a.id, "refund", "5")).json.error === "refund_of", "");
const expId = exp.json.payments.find((p: any) => p.status === "expected").id;
const recv = await adm(paymentsFn, `/api/admin/payments/${expId}`, { method: "POST", body: { status: "received" }, params: { id: expId } });
const recv2 = await adm(paymentsFn, `/api/admin/payments/${expId}`, { method: "POST", body: { status: "failed" }, params: { id: expId } });
check("31. Очаквано → получено се отчита; повторна промяна се отказва", recv.status === 200 && recv.json.summary.rentalNet === 14050 && recv2.status === 409, `${recv.json.summary?.rentalNet}`);
const evs = (await t.q("select action from booking_events where booking_id = $1 and action like 'payment.%'", [a.id])).rows.map((x: any) => x.action);
check("32. История: 4 плащания, 2 възстановявания и 1 промяна на статус са в booking_events (отказаните не)", evs.length === 7 && evs.filter((x: string) => x === "payment.refund").length === 2 && evs.includes("payment.status"), evs.join(", "));
const lst = await adm(paymentsFn, "/api/admin/payments");
check("33. Списък на всички плащания", lst.status === 200 && lst.json.rows.length === 6, "");
// Чисти сметки (без база): refund към security / към наем, неуспешно, друга валута, дата след отчета
const P = (id: string, kind: string, amountCents: number, o: Partial<any> = {}) => ({ id, bookingId: "b", amountCents, currency: "EUR", kind, status: "received", paidAt: new Date("2027-01-10T10:00:00Z"), refundOf: null, ...o });
const sum = summarize([P("1", "deposit", 5000), P("2", "security", 10000), P("3", "refund", 10000, { refundOf: "2" }), P("4", "extra", 1500), P("5", "final", 9000, { status: "failed" }), P("6", "final", 7000, { currency: "BGN" }), P("7", "final", 3000, { paidAt: new Date("2027-02-01T10:00:00Z") }), P("8", "refund", 500, { refundOf: "4" })], new Date("2027-01-31T21:59:59Z"));
check("34. summarize: неуспешно, друга валута и плащане след датата на отчета не се броят", sum.rentalNet === 6000 && sum.securityHeld === 0 && sum.nonEur === 1, JSON.stringify(sum));

// ===== 7. Отчет по кампания и вариант; разход =====
await t.q("update bookings set status = 'confirmed' where id = any($1)", [[a.id, b.id]]);
const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10); // приблизително днес по българско време
const from = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
const rep = async (q = "") => (await adm(adsFn, `/api/admin/ads/report?from=${from}&to=${today}${q}`)).json;
let r = await rep();
const rowOf = (rr: any, c: string | null) => rr.rows.find((x: any) => (c == null ? x.campaign == null : x.content === c));
let ra = rowOf(r, "video_a_woman"), rb = rowOf(r, "video_b_man"), rn = rowOf(r, null);
check("35. Заявки, потвърдени и с получено плащане по вариант", ra.leads === 1 && ra.confirmed === 1 && ra.paid === 1 && rb.leads === 1 && rb.confirmed === 1 && rb.paid === 0, JSON.stringify([ra, rb].map((x) => [x.label, x.leads, x.confirmed, x.paid])));
check("36. Нетен приход без гаранционния депозит и след възстановяванията", ra.revenueCents === 14050 && rb.revenueCents === 0, String(ra.revenueCents));
check("37. Без въведен разход → CPL, цена за плащане и ROAS са „Няма данни“ (null)", ra.spendCents === null && ra.cplCents === null && ra.costPerPaidCents === null && ra.roas === null, "");
check("38. Заявки без източник (директна и изтекла) – отделен ред „Няма записан източник“; без вариант – „(без вариант)“", rn.label === "Няма записан източник" && rn.leads === 2 && rowOf(r, "")?.label === "(без вариант)", String(rn.leads));
let sk = 0;
const spend = (body: Record<string, unknown>, key = `ads-spend-${++sk}-key`) => adm(adsFn, "/api/admin/ads/spend", { method: "POST", body: { campaign: CAMPAIGN, idempotencyKey: key, ...body } });
const fix = (id: number, amount: string, key = `ads-fix-${++sk}-key`) => adm(adsFn, `/api/admin/ads/spend/${id}`, { method: "POST", body: { action: "correct", amount, idempotencyKey: key }, params: { id: String(id) } });
const day = (n: number) => new Date(Date.now() + 3 * 3600_000 + n * 864e5).toISOString().slice(0, 10);
const sp = await spend({ content: "video_a_woman", periodStart: from, periodEnd: today, amount: "17,35" });
await spend({ content: "video_b_man", periodStart: from, periodEnd: today, amount: "0" });
// Отделен вариант с период, който започва преди избрания – частично застъпване
const partSp = await spend({ content: "video_c_test", periodStart: day(-20), periodEnd: today, amount: "35" });
check("39. Невалиден разход се отказва (кампания, обърнат период, без ключ)", (await spend({ campaign: "<b>x</b>", content: "", periodStart: from, periodEnd: today, amount: "1" })).status === 400 && (await spend({ periodStart: today, periodEnd: from, amount: "1" })).status === 400 && (await adm(adsFn, "/api/admin/ads/spend", { method: "POST", body: { campaign: CAMPAIGN, content: "x_nokey", periodStart: from, periodEnd: today, amount: "1" } })).json.error === "key", "");
r = await rep();
ra = rowOf(r, "video_a_woman"); rb = rowOf(r, "video_b_man");
const rc = rowOf(r, "video_c_test");
check("40. CPL = разход / заявки; цена за резервация с плащане; ROAS = приход / разход", sp.status === 201 && ra.spendCents === 1735 && ra.cplCents === 1735 && ra.costPerPaidCents === 1735 && Math.abs(ra.roas - 14050 / 1735) < 1e-9 && !ra.spendIncomplete, `ROAS ${ra.roas?.toFixed(2)}`);
check("41. Нулев разход: CPL 0 €, без плащане → цена „Няма данни“, ROAS „Няма данни“ (деление на 0)", rb.spendCents === 0 && rb.cplCents === 0 && rb.costPerPaidCents === null && rb.roas === null, JSON.stringify([rb.spendCents, rb.cplCents, rb.costPerPaidCents, rb.roas]));
check("42. Частично застъпващ се разход: не се разпределя, вариантът е „непълен“, без показатели", partSp.status === 201 && r.partialSpend.length === 1 && r.partialSpend[0].amountCents === 3500 && rc.spendIncomplete === true && rc.spendCents === null && rc.cplCents === null && rc.costPerPaidCents === null && rc.roas === null, JSON.stringify(rc));
check("43. Планираният бюджет (35 €) не се използва автоматично", !readFileSync("server/ad-report.ts", "utf8").includes("3500") && ra.spendCents === 1735, "");
const old = await rep(`&paidUntil=${day(-20)}`);
check("44. Плащания до избрана дата: по-късните не се броят; показва се докога", rowOf(old, "video_a_woman").revenueCents === 0 && Date.parse(old.paidUntil) < Date.now() - 19 * 864e5, old.paidUntil);
const del = await adm(adsFn, `/api/admin/ads/spend/${sp.json.row.id}`, { method: "POST", body: { action: "delete" }, params: { id: String(sp.json.row.id) } });
check("45. Изтрит разход не се отчита, но остава в базата", del.status === 200 && rowOf(await rep(), "video_a_woman").spendCents === null && (await t.q("select count(*)::int n from ad_spend")).rows[0].n === 3, "");

// ===== 7a. Разход: повторно изпращане, застъпване, едновременни заявки, корекция =====
const V = "video_spend_test";
const s1 = await spend({ content: V, periodStart: day(-6), periodEnd: day(-4), amount: "10" }, "spend-same-form-key");
const s1b = await spend({ content: V, periodStart: day(-6), periodEnd: day(-4), amount: "10" }, "spend-same-form-key");
const activeV = async () => (await t.q("select id, amount_cents, period_start::text ps, period_end::text pe, replaces_id from ad_spend where campaign = $2 and content = $1 and deleted_at is null order by id", [V, CAMPAIGN])).rows;
check("50. Повторно изпращане на същата форма → същият запис, без втори", s1.status === 201 && s1b.status === 200 && s1b.json.duplicate === true && s1b.json.row.id === s1.json.row.id && (await activeV()).length === 1, `HTTP ${s1.status}/${s1b.status}`);
const s1c = await spend({ content: V, periodStart: day(-6), periodEnd: day(-4), amount: "99" }, "spend-same-form-key");
check("51. Същият ключ с други данни → отказ (не се презаписва)", s1c.status === 409 && s1c.json.error === "key_conflict" && (await activeV())[0].amount_cents === 1000, s1c.json.error);
const ov = await spend({ content: V, periodStart: day(-4), periodEnd: day(-2), amount: "5" });
check("52. Застъпващ се период (общ ден) за същата кампания и вариант → 409 overlap със засегнатия запис", ov.status === 409 && ov.json.error === "overlap" && ov.json.conflicts?.[0]?.id === s1.json.row.id && (await activeV()).length === 1, JSON.stringify(ov.json));
const inside = await spend({ content: V, periodStart: day(-5), periodEnd: day(-5), amount: "5" });
check("53. Период изцяло вътре в съществуващ → също се отказва", inside.status === 409 && inside.json.error === "overlap", "");
const adj = await spend({ content: V, periodStart: day(-3), periodEnd: day(-1), amount: "7" });
const otherVar = await spend({ content: V + "_b", periodStart: day(-6), periodEnd: day(-4), amount: "3" });
const otherCamp = await spend({ campaign: "other_campaign", content: V, periodStart: day(-6), periodEnd: day(-4), amount: "3" });
check("54. Съседен период, друг вариант или друга кампания за същите дни → разрешено", adj.status === 201 && otherVar.status === 201 && otherCamp.status === 201, `${adj.status} ${otherVar.status} ${otherCamp.status}`);
const direct = await t.q("insert into ad_spend (campaign, content, period_start, period_end, amount_cents, created_by) values ($1, $2, $3, $4, 1, 't')", [CAMPAIGN, V, day(-5), day(-5)]).then(() => "ok", (e) => e.code);
check("55. Ограничението е в базата: пряк запис със застъпване се отказва (23P01)", direct === "23P01", String(direct));
// Едновременни заявки
const V2 = "video_concurrent";
const same = await Promise.all(Array.from({ length: 10 }, () => spend({ content: V2, periodStart: day(-30), periodEnd: day(-25), amount: "12" }, "spend-concurrent-same-key")));
const nV2 = async () => (await t.q("select count(*)::int n from ad_spend where content = $1 and deleted_at is null", [V2])).rows[0].n;
check("56. 10 едновременни изпращания със същия ключ → 1 запис, останалите връщат него", (await nV2()) === 1 && same.filter((x) => x.status === 201).length === 1 && same.filter((x) => x.json.duplicate).length === 9 && new Set(same.map((x) => x.json.row?.id)).size === 1, same.map((x) => x.status).join(","));
const many = await Promise.all(Array.from({ length: 10 }, (_, i) => spend({ content: V2 + "_x", periodStart: day(-30 + (i % 3)), periodEnd: day(-24), amount: String(10 + i) })));
const nX = (await t.q("select count(*)::int n from ad_spend where content = $1 and deleted_at is null", [V2 + "_x"])).rows[0].n;
check("57. 10 едновременни застъпващи се разхода с различни ключове → само 1 активен, 9 × 409 overlap", nX === 1 && many.filter((x) => x.status === 201).length === 1 && many.filter((x) => x.status === 409 && x.json.error === "overlap").length === 9, many.map((x) => x.status).join(","));
// Корекция
const repV = async () => (await adm(adsFn, `/api/admin/ads/report?from=${day(-6)}&to=${day(-4)}`)).json.rows.find((x: any) => x.campaign === CAMPAIGN && x.content === V);
const beforeFix = await repV();
const f1 = await fix(s1.json.row.id, "12,50", "spend-fix-key-1");
const f1b = await fix(s1.json.row.id, "12,50", "spend-fix-key-1");
const actAfter = await activeV();
const afterFix = await repV();
check("58. Корекция: старият запис се закрива, новият го заменя (replacesId), сумата се брои веднъж", beforeFix.spendCents === 1000 && f1.status === 201 && f1.json.row.replacesId === s1.json.row.id && afterFix.spendCents === 1250 && actAfter.filter((x: any) => x.ps === day(-6)).length === 1, `${beforeFix.spendCents} → ${afterFix.spendCents}`);
check("59. Повторно изпращане на същата корекция → без втора замяна", f1b.status === 200 && f1b.json.duplicate === true && f1b.json.row.id === f1.json.row.id, `HTTP ${f1b.status}`);
const oldRow = (await t.q("select deleted_at, deleted_by from ad_spend where id = $1", [s1.json.row.id])).rows[0];
check("60. Коригираният запис остава в историята (deleted_at, deleted_by)", !!oldRow.deleted_at && oldRow.deleted_by === "admin@example.com", "");
const f2 = await fix(s1.json.row.id, "20");
check("61. Корекция на вече заменен запис → 409 already_replaced", f2.status === 409 && f2.json.error === "already_replaced", f2.json.error);
const cc = await Promise.all(Array.from({ length: 5 }, (_, i) => fix(f1.json.row.id, String(30 + i))));
const nAct = (await activeV()).filter((x: any) => x.ps === day(-6));
check("62. 5 едновременни корекции на един запис → точно 1 успешна, 1 активен запис", cc.filter((x) => x.status === 201).length === 1 && cc.filter((x) => x.json.error === "already_replaced").length === 4 && nAct.length === 1, cc.map((x) => x.status + ":" + (x.json.error || "")).join(",") + " активни " + nAct.length);
const reAdd = await spend({ content: V2 + "_x", periodStart: day(-30), periodEnd: day(-24), amount: "1" });
const delX = (await t.q("select id from ad_spend where content = $1 and deleted_at is null", [V2 + "_x"])).rows[0].id;
await adm(adsFn, `/api/admin/ads/spend/${delX}`, { method: "POST", body: { action: "delete" }, params: { id: String(delX) } });
const reAdd2 = await spend({ content: V2 + "_x", periodStart: day(-30), periodEnd: day(-24), amount: "1" });
check("63. След изтриване същият период може да се въведе отново", reAdd.status === 409 && reAdd2.status === 201, `${reAdd.status} → ${reAdd2.status}`);
// Отчет: вариант с пълен и частично изключен разход
const Vp = "video_partial";
await spend({ content: Vp, periodStart: day(-8), periodEnd: day(-6), amount: "5" }); // извън/частично
await spend({ content: Vp, periodStart: day(-5), periodEnd: day(-2), amount: "10" }); // изцяло вътре
const pr = rowOf((await adm(adsFn, `/api/admin/ads/report?from=${day(-7)}&to=${day(-2)}`)).json, Vp);
const full = rowOf((await adm(adsFn, `/api/admin/ads/report?from=${day(-8)}&to=${day(-2)}`)).json, Vp);
check("64. Вариант с пълен и частично изключен разход → „непълен“: без сума, CPL, цена и ROAS", pr.spendIncomplete === true && pr.spendCents === null && pr.cplCents === null && pr.costPerPaidCents === null && pr.roas === null, JSON.stringify(pr));
check("65. Период, който обхваща всички записи изцяло → пълен разход 15 €", full.spendIncomplete === false && full.spendCents === 1500, String(full.spendCents));
const pureInc = buildReport({ from: "2027-01-05", to: "2027-01-10", paidUntil: new Date("2027-02-01T00:00:00Z"), payments: [P("p", "final", 20000, { bookingId: "b1" })],
  bookings: [{ id: "b1", status: "confirmed", utmCampaign: "c", utmContent: "v", utmSource: "meta", utmMedium: "paid_social" }],
  spend: [{ id: 1, campaign: "c", content: "v", periodStart: "2027-01-05", periodEnd: "2027-01-10", amountCents: 1000, currency: "EUR" }, { id: 2, campaign: "c", content: "v", periodStart: "2027-01-01", periodEnd: "2027-01-04", amountCents: 900, currency: "EUR" }, { id: 3, campaign: "c", content: "v", periodStart: "2027-01-11", periodEnd: "2027-01-12", amountCents: 900, currency: "EUR" }, { id: 4, campaign: "c", content: "w", periodStart: "2027-01-03", periodEnd: "2027-01-06", amountCents: 700, currency: "EUR" }] });
const pv = pureInc.rows.find((x: any) => x.content === "v"), pw = pureInc.rows.find((x: any) => x.content === "w");
check("66. buildReport: записи изцяло извън периода не правят варианта непълен; частичният – прави", pv.spendIncomplete === false && pv.spendCents === 1000 && pv.roas === 20 && pw.spendIncomplete === true && pw.roas === null && pureInc.partialSpend.length === 1, JSON.stringify([pv.spendCents, pv.roas, pw.spendIncomplete]));
check("46. Невалиден период на отчета → 400", (await adm(adsFn, `/api/admin/ads/report?from=${today}&to=${from}`)).status === 400, "");
// Кохорта по българско време
check("47. Начало на деня по българско време (лятно / зимно)", sofiaMidnight("2027-07-01").toISOString() === "2027-06-30T21:00:00.000Z" && sofiaMidnight("2027-01-15").toISOString() === "2027-01-14T22:00:00.000Z", "");
const pure = buildReport({ from: "2027-01-01", to: "2027-01-14", paidUntil: new Date("2027-02-01T00:00:00Z"), bookings: [{ id: "b", status: "rejected", utmCampaign: "c", utmContent: "video_a_woman", utmSource: "meta", utmMedium: "paid_social" }], payments: [P("1", "security", 10000)], spend: [] });
check("48. Само гаранционен депозит → 0 € приход и не е „резервация с плащане“; отказана не е потвърдена", pure.rows[0].revenueCents === 0 && pure.rows[0].paid === 0 && pure.rows[0].confirmed === 0, "");

// ===== 8. Резервни копия: новата таблица е включена; по-старите копия без нея се приемат =====
const tables = Object.fromEntries(RESTORE_ORDER.filter((n) => n !== "ad_spend").map((n) => [n, []]));
const text = JSON.stringify({ version: 2, env: "deploy-preview", createdAt: new Date().toISOString(), tables });
const sha = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex");
const plan = await planRestore(text, sha, t.q as any);
check("49. Старо резервно копие без ad_spend може да се провери за възстановяване", plan.ok && plan.tables.ad_spend?.inSnapshot === 0, plan.problems.join(" "));

await finish();
