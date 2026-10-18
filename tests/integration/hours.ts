// Работно време за получаване и връщане (db/hours.ts): пн–пт 08:00–20:00, сб–нд 09:00–19:00, местно време Europe/Sofia.
// Граничните часове се приемат; час извън графика, липсващ час и минала дата се отхвърлят от сървъра дори при ръчно
// променена заявка. Записаните резервации не се проверяват наново – потвърждаването им работи както досега.
import { eq } from "drizzle-orm";
import { bookingBody, check, finish, freshDb, O, setContext, schema, withQuote } from "./harness.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import { HOURS, sofiaToday, weekday, withinHours } from "../../db/hours.ts";

setContext("deploy-preview");
const t = await freshDb("hours");
t.use();
const call = (url: string, init: RequestInit = {}, id = "") => bookingsFn(new Request(url, init), { params: id ? { id } : {} } as any);
const create = async (body: any) => { const r = await call(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await withQuote(body)) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
let k = 0;
const req = (d1: string, t1: string, d2: string, t2: string, extra: Record<string, unknown> = {}) => bookingBody("H" + ++k, d1, t1, d2, t2, { requestKey: `hours-${k}-key`, ...extra });

// 1–4. Графикът по дни (2027-03-01 е понеделник, 2027-03-06 – събота, 2027-03-07 – неделя)
check("1. дни от седмицата", weekday("2027-03-01") === 1 && weekday("2027-03-06") === 6 && weekday("2027-03-07") === 0);
check("2. делничен ден: 08:00 и 20:00 се приемат, 07:59 и 20:01 – не",
  withinHours("2027-03-01", "08:00") && withinHours("2027-03-01", "20:00") && !withinHours("2027-03-01", "07:59") && !withinHours("2027-03-01", "20:01"));
check("3. събота и неделя: 09:00 и 19:00 се приемат, 08:59 и 19:01 – не",
  withinHours("2027-03-06", "09:00") && withinHours("2027-03-07", "19:00") && !withinHours("2027-03-06", "08:59") && !withinHours("2027-03-07", "19:01"));
// Смяна на часовото време (28.03.2027 и 31.10.2027 са недели): графикът е по местен час и не се измества
check("4. лятно / зимно часово време", withinHours("2027-03-28", "09:00") && !withinHours("2027-03-28", "08:30") && withinHours("2027-10-31", "19:00") && !withinHours("2027-10-31", "19:30"));
check("5. невалидни стойности", !withinHours("2027-03-01", "") && !withinHours("", "10:00") && !withinHours("2027-03-01", "24:00") && !withinHours("2027-03-01", "8:00"));
check("6. 7 дни в графика", Object.keys(HOURS).length === 7);
check("7. днешна дата в Europe/Sofia", sofiaToday(new Date("2027-03-01T22:30:00Z")) === "2027-03-02" && sofiaToday(new Date("2027-07-01T20:59:00Z")) === "2027-07-01" && sofiaToday(new Date("2027-07-01T21:00:00Z")) === "2027-07-02");

// 8–9. Сървърът приема граничните часове
const okEdge = await create(req("2027-03-01", "08:00", "2027-03-02", "20:00"));
check("8. делничен ден 08:00 → 20:00 се записва", okEdge.status === 201, String(okEdge.status));
const okWeekend = await create(req("2027-03-06", "09:00", "2027-03-07", "19:00", { carId: "golf" }));
check("9. събота 09:00 → неделя 19:00 се записва", okWeekend.status === 201, String(okWeekend.status));

// 10–15. Сървърът отхвърля ръчно променени заявки
const bad: [string, any][] = [
  ["10. получаване 07:59 в делничен ден", req("2027-04-05", "07:59", "2027-04-06", "10:00")],
  ["11. връщане 20:01 в делничен ден", req("2027-04-05", "10:00", "2027-04-06", "20:01")],
  ["12. получаване 08:30 в събота", req("2027-04-10", "08:30", "2027-04-12", "10:00")],
  ["13. връщане 19:30 в неделя", req("2027-04-05", "10:00", "2027-04-11", "19:30")],
];
for (const [n, body] of bad) {
  const r = await create(body);
  check(n, r.status === 400 && r.json.error === "hours", `${r.status} ${r.json.error}`);
}
const noTime = await create({ ...req("2027-04-05", "10:00", "2027-04-06", "10:00"), startTime: "", contract: undefined });
check("14. липсващ час не заобикаля проверката", noTime.status === 400, String(noTime.status));
const past = await create(req("2020-03-02", "10:00", "2020-03-03", "10:00"));
check("15. минала дата се отхвърля", past.status === 400, String(past.status));
const order = await create(req("2027-04-05", "12:00", "2027-04-05", "11:00"));
check("16. връщане преди получаване в същия ден", order.status === 400, String(order.status));
check("17. отхвърлените заявки не са записани", (await t.q("select count(*)::int n from bookings")).rows[0].n === 2);

// 18. Записана по-стара резервация извън новия график (напр. 22:00) се потвърждава както досега – без нова проверка на часа
const [old] = await t.db.insert(schema.bookings).values({
  id: "a".repeat(32), viewToken: "b".repeat(64), adminToken: "c".repeat(64), name: "ТЕСТ Стара", email: "old-hours@example.com", phone: "0000",
  lang: "bg", car: "Ford Ka", carId: "ka", pickup: "01.05.2027 22:00", dropoff: "02.05.2027 22:00", total: "40 €",
  startDate: "2027-05-01", endDate: "2027-05-02", startTime: "22:00", endTime: "22:00", payment: "cash",
}).returning();
const conf = await call(`${O}/api/bookings/${old.id}/manage?key=${old.adminToken}`, { method: "POST", body: new URLSearchParams({ action: "confirm" }) }, old.id);
const after = (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, old.id)))[0];
check("18. съществуваща резервация извън графика се потвърждава без промяна на часа", conf.status === 200 && after.status === "confirmed" && after.startTime === "22:00");

await finish();
