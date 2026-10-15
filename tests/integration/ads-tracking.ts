// Рекламен източник (UTM), плащания, отчет „Реклами: заявки и ROAS“ и разпознаване на средата.
// Само синтетични данни и тестови получатели (@example.com); имейлите към Brevo се прихващат (harness.ts).
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { bookingBody, check, contractData, cookieJar, finish, freshDb, identity, O, schema, setContext } from "./harness.ts";
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
  const r = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bookingBody(s, d, "10:00", d, "18:00", { requestKey: `ads-${s}-key`, contract: contractData(d, "10:00", d, "18:00"), ...extra })) }), { params: {} } as any);
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
const sp = await adm(adsFn, "/api/admin/ads/spend", { method: "POST", body: { campaign: CAMPAIGN, content: "video_a_woman", periodStart: from, periodEnd: today, amount: "17,35" } });
await adm(adsFn, "/api/admin/ads/spend", { method: "POST", body: { campaign: CAMPAIGN, content: "video_b_man", periodStart: from, periodEnd: today, amount: "0" } });
const partSp = await adm(adsFn, "/api/admin/ads/spend", { method: "POST", body: { campaign: CAMPAIGN, content: "video_b_man", periodStart: new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10), periodEnd: today, amount: "35" } });
check("39. Невалиден разход се отказва", (await adm(adsFn, "/api/admin/ads/spend", { method: "POST", body: { campaign: "<b>x</b>", content: "", periodStart: from, periodEnd: today, amount: "1" } })).status === 400 && (await adm(adsFn, "/api/admin/ads/spend", { method: "POST", body: { campaign: CAMPAIGN, periodStart: today, periodEnd: from, amount: "1" } })).status === 400, "");
r = await rep();
ra = rowOf(r, "video_a_woman"); rb = rowOf(r, "video_b_man");
check("40. CPL = разход / заявки; цена за резервация с плащане; ROAS = приход / разход", sp.status === 201 && ra.spendCents === 1735 && ra.cplCents === 1735 && ra.costPerPaidCents === 1735 && Math.abs(ra.roas - 14050 / 1735) < 1e-9, `ROAS ${ra.roas?.toFixed(2)}`);
check("41. Нулев разход: CPL 0 €, без плащане → цена „Няма данни“, ROAS „Няма данни“ (деление на 0)", rb.spendCents === 0 && rb.cplCents === 0 && rb.costPerPaidCents === null && rb.roas === null, JSON.stringify([rb.spendCents, rb.cplCents, rb.costPerPaidCents, rb.roas]));
check("42. Разход с частично застъпване не се разпределя, а се показва отделно", partSp.status === 201 && r.partialSpend.length === 1 && r.partialSpend[0].amountCents === 3500, "");
check("43. Планираният бюджет (35 €) не се използва автоматично", !readFileSync("server/ad-report.ts", "utf8").includes("3500") && ra.spendCents === 1735, "");
const old = await rep(`&paidUntil=${new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10)}`);
check("44. Плащания до избрана дата: по-късните не се броят; показва се докога", rowOf(old, "video_a_woman").revenueCents === 0 && Date.parse(old.paidUntil) < Date.now() - 19 * 864e5, old.paidUntil);
const del = await adm(adsFn, `/api/admin/ads/spend/${sp.json.row.id}`, { method: "POST", body: { action: "delete" }, params: { id: String(sp.json.row.id) } });
check("45. Изтрит разход не се отчита, но остава в базата", del.status === 200 && rowOf(await rep(), "video_a_woman").spendCents === null && (await t.q("select count(*)::int n from ad_spend")).rows[0].n === 3, "");
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
