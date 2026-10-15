// Миграция 20261015022647_add_booking_cancel_handover върху база с вече записани резервации (как е в production преди deploy):
// старите записи и статуси се запазват, новите колони получават стойности по подразбиране, а новият код може да управлява
// старите потвърдени резервации. Проверява се и съвместимостта при връщане към предишната версия на кода
// (тя не знае новите колони и статуси). Само синтетични данни.
import { eq } from "drizzle-orm";
import { check, finish, freshDb, migrations, setContext, schema } from "./harness.ts";
import availabilityFn from "../../netlify/functions/availability.mts";
import { act } from "../../server/booking-actions.ts";

setContext("deploy-preview");
const MIG = "20261015022647_add_booking_cancel_handover";
const all = migrations();
const idx = all.indexOf(MIG);
check("1. новата миграция е последна и единствена след приложените 6", idx === 6 && all.length === 7, all.join(", "));
const t = await freshDb("migcancel", idx);
t.use();

// Записи, както ги прави предишната версия (само старите колони)
const old = [
  ["a".repeat(32), "pending", "2027-03-01", "2027-03-03", "punto"],
  ["b".repeat(32), "confirmed", "2027-03-05", "2027-03-08", "golf"],
  ["c".repeat(32), "rejected", "2027-03-10", "2027-03-12", "ka"],
  ["d".repeat(32), "confirmed", "2026-01-05", "2026-01-07", "passat"],
];
for (const [id, status, d1, d2, car] of old)
  await t.q(
    `insert into bookings (id, view_token, admin_token, status, name, email, phone, car, car_id, start_date, end_date, start_time, end_time, pickup, dropoff, total, note, payment, decided_at, created_at)
     values ($1, $2, $3, $4, $5, $6, '0000', 'Тестов', $7, $8::date, $9::date, '10:00', '10:00', $8::text || ' 10:00', $9::text || ' 10:00', '60 €', 'бележка', 'cash', case when $4 = 'pending' then null else now() end, now() - interval '3 days')`,
    [id, id + id, (id + id).replace(/./g, "f"), status, "ТЕСТ Миграция " + status, `mig-${status}@example.com`, car, d1, d2],
  );
await t.q(`insert into booking_events (booking_id, actor, action, details) values ($1, 'customer', 'booking.created', '{}'), ($1, 'owner-link', 'booking.confirm', '{}')`, [old[1][0]]);
await t.q(`insert into email_log (kind, booking_id, recipient, status, dedupe_key) values ('customer-decision', $1, 'mi***@example.com', 'sent', $2)`, [old[1][0], "customer-decision:" + old[1][0]]);
const snap = async (table: string, order: string) => JSON.stringify((await t.q(`select * from ${table} order by ${order}`)).rows);
const before = { bookings: (await t.q("select * from bookings order by id")).rows, events: await snap("booking_events", "id"), emails: await snap("email_log", "id") };
const busyBefore = await (await availabilityFn()).json();

await t.applyMigration(MIG);

const after = (await t.q("select * from bookings order by id")).rows;
const oldCols = Object.keys(before.bookings[0]);
check("2. брой записи и стари колони – без промяна", after.length === before.bookings.length && after.every((r: any, i: number) => oldCols.every((c) => JSON.stringify(r[c]) === JSON.stringify(before.bookings[i][c]))), `${after.length} записа`);
check("3. статусите са запазени", after.map((r: any) => r.status).join() === "pending,confirmed,rejected,confirmed", after.map((r: any) => r.status).join());
check("4. новите колони са с празни стойности по подразбиране", after.every((r: any) => r.handed_over_at === null && r.closed_at === null && r.handed_over_by === "" && r.closed_by === "" && r.close_reason === "" && r.close_note === ""), "");
check("5. историята и лога на писмата не са променени", (await snap("booking_events", "id")) === before.events && (await snap("email_log", "id")) === before.emails, "");
check("6. наличността е същата след миграцията", JSON.stringify(await (await availabilityFn()).json()) === JSON.stringify(busyBefore), JSON.stringify(busyBefore.cars));

// Новият код управлява стара потвърдена резервация
const r = await act(old[1][0], "cancel", { actor: "admin@example.com", reason: "customer", notify: false });
const b = (await t.db.select().from(schema.bookings).where(eq(schema.bookings.id, old[1][0])))[0];
check("7. стара потвърдена резервация се отменя с новия код (без имейл)", r.ok && b.status === "cancelled" && b.closedBy === "admin@example.com", "");
check("8. другите резервации не са засегнати", (await t.q("select id, status from bookings where id <> $1 order by id", [old[1][0]])).rows.map((x: any) => x.status).join() === "pending,rejected,confirmed", "");

// Връщане към предишната версия: тя записва и чете само старите колони – схемата го позволява
await t.q(
  `insert into bookings (id, view_token, admin_token, name, email, phone, car, pickup, dropoff) values ($1, $2, $3, 'ТЕСТ Стар код', 'old-code@example.com', '0', 'Ford Ka', 'x', 'y')`,
  ["e".repeat(32), "e".repeat(64), "9".repeat(64)],
);
const legacyRead = await t.q("select id, view_token, admin_token, status, name, email, car, car_id, start_date, end_date, start_time, end_time, pickup, dropoff, total, note, payment, decided_at from bookings where id = $1", ["e".repeat(32)]);
check("9. предишната версия може да записва и чете (новите колони не са задължителни)", legacyRead.rows.length === 1 && legacyRead.rows[0].status === "pending", "");
// Заявките на предишната версия броят като заети само status = 'confirmed' – отменената резервация не блокира и при нея
const legacyBusy = await t.q("select id from bookings where status = 'confirmed' and car_id = 'golf'");
check("10. при предишната версия отменената резервация също не блокира автомобила", legacyBusy.rows.length === 0, "");
// Предишната версия потвърждава само status = 'pending' – стар линк „Потвърди“ не възстановява отменена резервация
const legacyConfirm = await t.q("update bookings set status = 'confirmed' where id = $1 and status = 'pending' returning id", [old[1][0]]);
check("11. при предишната версия стар „Потвърди“ не възстановява отменената резервация", legacyConfirm.rows.length === 0 && (await t.q("select status from bookings where id = $1", [old[1][0]])).rows[0].status === "cancelled", "");

await finish();
