import { eq } from "drizzle-orm";
import {
  adminJar,
  cookieJar,
  O,
  freshDb,
  check,
  finish,
  mail,
  schema,
  setContext,
} from "./harness.ts";
import { recordSale, deliverSale, type Payment } from "../../server/fiscal.ts";
import { auditXml, report, validatedXml } from "../../server/fiscal-report.ts";
import { fiscalPdf } from "../../server/fiscal-pdf.ts";
import handler from "../../netlify/functions/admin-fiscal.mts";
import iconv from "iconv-lite";

const env = await freshDb("fiscal");
env.use();
setContext("production");
const { bookings, payments, fiscalSales } = schema;
async function reserve(n: number, company: boolean) {
  const [b] = await env.db
    .insert(bookings)
    .values({
      id: n.toString().padStart(32, "a"),
      viewToken: "view" + n,
      adminToken: "admin" + n,
      name: "Тест",
      email: "example@example.com",
      phone: "test",
      car: "Седан",
      pickup: "",
      dropoff: "",
      createdAt: new Date("2026-10-01T10:00:00Z"),
      totalCents: 5000,
      invoice: company ? "Тест ЕООД\nЕИК 123456789\nПловдив" : "",
    })
    .returning();
  return b;
}
async function pay(b: any, key: string, kind = "final") {
  const [p] = await env.db
    .insert(payments)
    .values({
      id: key.padStart(32, "b"),
      bookingId: b.id,
      amountCents: 5000,
      method: "card",
      kind,
      status: "received",
      paidAt: new Date("2026-11-01T10:00:00Z"),
      idempotencyKey: key,
      createdBy: "test",
    })
    .returning();
  return p as Payment;
}
const card = {
  rrn: "123456789012",
  terminal: "V6200750",
  breakdown: {
    days: 1,
    unitCents: 5500,
    rentCents: 5500,
    renty10Cents: 0,
    cardDiscountCents: 500,
    extras: [],
  } as any,
};
const b1 = await reserve(1, true),
  b2 = await reserve(2, true),
  b3 = await reserve(3, false);
const p1 = await pay(b1, "1"),
  p2 = await pay(b2, "2"),
  p3 = await pay(b3, "3"),
  hold = await pay(b1, "4", "security");
for (const [b, p] of [
  [b1, p1],
  [b1, p1],
  [b3, p3],
  [b1, hold],
  [b2, p2],
])
  await env.db.transaction((tx) => recordSale(tx, b, p, card));
const sales = await env.db.select().from(fiscalSales);
const first = sales.find((s) => s.id === p1.id);
check(
  "Първите две фирмени фактури са последователни",
  first.invoice === "1000000001" &&
    sales.find((s) => s.id === p2.id).invoice === "1000000002",
);
check(
  "Повторно потвърждение и гаранция не създават документи",
  sales.length === 3 && first.receipt === "0000000001",
);
check(
  "Частен клиент получава документа за продажба",
  !sales.find((s) => s.id === p3.id).invoice &&
    !!sales.find((s) => s.id === p3.id).receipt,
);
await deliverSale(p1.id);
await deliverSale(p1.id);
check(
  "Едно изпращане за всеки PDF при повторение",
  mail.sent.length === 2 && mail.sent.every((m) => m.attachments === 1),
);
check(
  "Електронният документ съдържа PDF и QR изображение",
  (await fiscalPdf(first, false)).length > 5000,
);
check(
  "Авансът преди връщането не влиза в отчета за услугите",
  (await report("2026-11")).orders.length === 0,
);
await env.db
  .update(bookings)
  .set({ returnedAt: new Date("2026-11-30T22:30:00Z") })
  .where(eq(bookings.id, b1.id));
const [r] = await env.db
  .insert(payments)
  .values({
    id: "e".repeat(32),
    bookingId: b1.id,
    amountCents: 1000,
    method: "card",
    kind: "refund",
    refundOf: p1.id,
    status: "received",
    paidAt: new Date("2026-12-05T10:00:00Z"),
    idempotencyKey: "refund-test",
    createdBy: "test",
  })
  .returning();
const month = await report("2026-12");
check(
  "Месец по българско време, един наем и едно възстановяване",
  month.orders.length === 1 &&
    month.refunds.length === 1 &&
    !month.issues.length,
);
const xml = iconv.decode(await validatedXml(auditXml(month)), "windows-1251");
check(
  "Валиден XML по XSD с кодировка и реални реквизити",
  xml.includes("Седан") &&
    xml.includes("<e_shop_n>RF0008363</e_shop_n>") &&
    xml.includes("<trans_n>123456789012</trans_n>") &&
    xml.includes("<ord_vat>0.00</ord_vat>") &&
    xml.includes("<r_amount>10.00</r_amount>"),
);
let rejected = false;
try {
  await validatedXml("<audit/>");
} catch {
  rejected = true;
}
check("Невалиден XML се блокира", rejected);
const request = (query: string) =>
  handler(new Request(O + "/api/admin/fiscal?" + query));
setContext("deploy-preview", { cookies: cookieJar() });
check(
  "Справката изисква вход",
  (await request("month=2026-12")).status === 401,
);
setContext("deploy-preview", { cookies: adminJar() });
const preview = await (await request("month=2026-12")).json();
check(
  "Администраторът вижда наема и възстановяването",
  preview.orders.length === 1 && preview.refunds.length === 1,
);
const download = await request("month=2026-12&format=xml");
check(
  "Изтегляне на валидиран XML",
  download.status === 200 &&
    download.headers
      .get("Content-Disposition")
      ?.includes("RF0008363_2026-12.xml") === true,
);
const file = await request("payment=" + p1.id + "&kind=invoice");
check(
  "Администраторът изтегля издадената фактура",
  file.status === 200 &&
    file.headers.get("Content-Disposition")?.includes("1000000001.pdf") ===
      true,
);
await finish();
