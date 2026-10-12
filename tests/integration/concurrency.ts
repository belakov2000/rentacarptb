// Едновременни потвърждения и повторни заявки – реален PostgreSQL с много връзки (транзакции и заключвания като в продукция).
import { bookingBody, check, finish, freshDb, mail, O, setContext, schema } from "./harness.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import { eq, sql } from "drizzle-orm";

setContext("deploy-preview");
const t = await freshDb("concurrency");
t.use();
mail.delayMs = 15; // имейлът отнема време – прозорецът за състезание е реалистичен
const create = async (body: any) => {
  const r = await bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: {} } as any);
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const decide = async (id: string, action: string) => {
  const [b] = await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, id));
  const r = await bookingsFn(new Request(`${O}/api/bookings/${id}/manage?key=${b.adminToken}`, { method: "POST", body: new URLSearchParams({ action }) }), { params: { id } } as any);
  return r.text();
};
const count = async (where = sql`true`) => (await t.db.select({ n: sql<number>`count(*)::int` }).from(schema.bookings).where(where))[0].n;

// 1. Конфликтни заявки, потвърдени в един и същи момент (20 кръга по 2–5 заявки)
let bad = 0, rounds = 0, totalConfirmed = 0;
for (let round = 0; round < 20; round++) {
  const day = String(1 + round).padStart(2, "0");
  const n = 2 + (round % 4);
  const ids: string[] = [];
  // Всички периоди в кръга се застъпват помежду си (10:0k → 12:00)
  for (let k = 0; k < n; k++) ids.push((await create(bookingBody(`R${round}x${k}`, `2028-01-${day}`, `10:0${k}`, `2028-01-${day}`, "12:00", { carId: "golf", requestKey: `round-${round}-${k}-xxxx` }))).json.id);
  await Promise.all(ids.map((id) => decide(id, "confirm")));
  const c = await count(sql`car_id='golf' and status='confirmed' and start_date = ${`2028-01-${day}`}`);
  totalConfirmed += c; rounds++;
  if (c !== 1) bad++;
}
check("Едновременно потвърждение: само една от конфликтните резервации", bad === 0, `${rounds} кръга, ${totalConfirmed} потвърдени (по 1 на кръг), кръгове с двойно потвърждение: ${bad}`);

// 2. Заключването не спира несвързани резервации: различни автомобили и непокриващи се периоди се потвърждават едновременно
const free = [
  await create(bookingBody("F1", "2028-02-01", "10:00", "2028-02-02", "10:00", { carId: "ka", requestKey: "free-1-xxxxxx" })),
  await create(bookingBody("F2", "2028-02-01", "10:00", "2028-02-02", "10:00", { carId: "ibiza", requestKey: "free-2-xxxxxx" })),
  await create(bookingBody("F3", "2028-02-05", "10:00", "2028-02-06", "10:00", { carId: "ka", requestKey: "free-3-xxxxxx" })),
];
await Promise.all(free.map((f) => decide(f.json.id, "confirm")));
check("Несвързани резервации се потвърждават едновременно", (await count(sql`status='confirmed' and start_date between '2028-02-01' and '2028-02-06'`)) === 3, "3/3 потвърдени");

// 3. Буфер 60 минути и при потвърждаване (A: 2028-03-01 10:00 → 2028-03-03 10:00)
const A = await create(bookingBody("A", "2028-03-01", "10:00", "2028-03-03", "10:00", { carId: "punto", requestKey: "buf-A-xxxxxx" }));
await decide(A.json.id, "confirm");
const edge: [string, string, string, string, string, boolean][] = [
  ["след 59 мин", "2028-03-03", "10:59", "2028-03-04", "10:00", false],
  ["след 60 мин", "2028-03-03", "11:00", "2028-03-04", "10:00", true],
  ["преди 59 мин", "2028-02-28", "10:00", "2028-03-01", "09:01", false],
  ["преди 60 мин", "2028-02-28", "10:00", "2028-03-01", "09:00", true],
];
for (const [label, d1, t1, d2, t2, allowed] of edge) {
  const tag = "E" + d1.replace(/-/g, "") + t1.replace(":", "") + t2.replace(":", "");
  const r = await create(bookingBody(tag, d1, t1, d2, t2, { carId: "punto", requestKey: `buf-${tag}` }));
  check(`Буфер: получаване/връщане ${label} – ${allowed ? "разрешено" : "отказ"}`, allowed ? r.status === 201 : r.status === 409, `HTTP ${r.status}`);
}
// Чакаща заявка в буфера (създадена, преди A да бъде потвърдена) не може да бъде потвърдена
const B = await create(bookingBody("B", "2028-03-10", "10:00", "2028-03-12", "10:00", { carId: "punto", requestKey: "buf-B-xxxxxx" }));
const C = await create(bookingBody("C", "2028-03-12", "10:30", "2028-03-13", "10:00", { carId: "punto", requestKey: "buf-C-xxxxxx" }));
await decide(B.json.id, "confirm");
const html = await decide(C.json.id, "confirm");
check("Буфер при потвърждаване: 30 мин след връщане – отказ", html.includes("датите вече са заети") && (await count(sql`id=${C.json.id} and status='pending'`)) === 1, "");

// 4. Едно и също изпращане 10 пъти едновременно (същият requestKey)
mail.sent.length = 0;
const before = await count();
const same = bookingBody("DUP", "2028-04-01", "10:00", "2028-04-02", "10:00", { carId: "passat", requestKey: "dup-key-123456" });
const rs = await Promise.all(Array.from({ length: 10 }, () => create(same)));
const ids = new Set(rs.map((r) => r.json.id));
check("10 едновременни изпращания с един ключ → 1 резервация", (await count()) - before === 1 && ids.size === 1, `нови резервации: ${(await count()) - before}, различни номера в отговорите: ${ids.size}, HTTP ${[...new Set(rs.map((r) => r.status))].join("/")}`);
check("…и по едно писмо до фирмата и до клиента", mail.sent.filter((m) => m.subject.includes("ТЕСТ DUP")).length === 1 && mail.sent.filter((m) => m.to === "test-dup@example.com").length === 1, `писма: ${mail.sent.length}`);
// Повторен опит след изгубен отговор (същият ключ, по-късно)
const late = await create(same);
check("Повторно изпращане по-късно със същия ключ → същата резервация", late.json.id === [...ids][0] && late.status === 200 && (await count()) - before === 1, `HTTP ${late.status}`);

// 5. Стари страници без ключ: 5 еднакви изпращания едновременно
const b2 = await count();
const old = bookingBody("OLD", "2028-05-01", "10:00", "2028-05-02", "10:00", { carId: "passat" });
const ro = await Promise.all(Array.from({ length: 5 }, () => create(old)));
check("5 едновременни изпращания без ключ (стара страница) → 1 резервация", (await count()) - b2 === 1 && new Set(ro.map((r) => r.json.id)).size === 1, `нови: ${(await count()) - b2}`);
// Различен ключ, но същото съдържание до 10 мин. (двоен клик след презареждане) → същата резервация
const r3 = await create({ ...old, requestKey: "other-key-1234" });
check("Същото съдържание с нов ключ до 10 мин. → без дубликат", r3.json.id === ro[0].json.id, "");
// След отказ клиентът може да изпрати същата заявка отново
await decide(ro[0].json.id, "reject");
const r4 = await create({ ...old, requestKey: "after-reject-1" });
check("След отказ същата заявка се приема като нова", r4.status === 201 && r4.json.id !== ro[0].json.id, `HTTP ${r4.status}`);
// Чужд ключ с друг имейл не връща чужда резервация
const r5 = await create({ ...bookingBody("X", "2028-06-01", "10:00", "2028-06-02", "10:00"), requestKey: "dup-key-123456" });
check("Чужд ключ с друг имейл не разкрива чужда резервация", r5.status === 400 && !r5.json.token, `HTTP ${r5.status}`);
// Уникалното ограничение в базата
const dupKey = await t.q("select count(*)::int n from (select request_key from bookings where request_key is not null group by 1 having count(*) > 1) x");
check("Уникален индекс bookings.request_key", dupKey.rows[0].n === 0 && (await t.q("select indexdef from pg_indexes where indexname='bookings_request_key_idx'")).rows[0].indexdef.includes("UNIQUE"), "");
await finish();
