// Писма извън продукция: в Deploy Preview не се изпращат (BREVO_API_KEY е зададен за всички среди), заявката се записва,
// писмото е в email_log като неуспешно, а отговорът към сайта е notify: "failed" (сайтът показва резервното известие).
// В продукция писмата се изпращат. Само синтетични данни; Brevo е подменен (harness.ts).
import { bookingBody, check, finish, freshDb, mail, O, setContext, withQuote } from "./harness.ts";
import bookingsFn from "../../netlify/functions/bookings.mts";
import { mailAllowed } from "../../mail/index.ts";

const t = await freshDb("mailguard");
t.use();
const post = async (n: string) => bookingsFn(new Request(`${O}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await withQuote(bookingBody(n, "2029-09-01", "10:00", "2029-09-03", "10:00", { carId: "ka", requestKey: `guard-${n}-key1` }))) }), { params: {} } as any);

delete process.env.MAIL_OUTSIDE_PRODUCTION;
for (const ctx of ["deploy-preview", "branch-deploy", "dev", undefined]) {
  setContext(ctx);
  check(`1. ${ctx ?? "неизвестна среда"}: изпращането е забранено`, mailAllowed() === false, "");
}
setContext("deploy-preview");
const n0 = mail.calls;
const r = await post("PV");
const j = await r.json();
const log = (await t.q("select kind, status, error from email_log where booking_id = $1 order by id", [j.id])).rows;
check("2. Preview: заявката е записана (201), отговорът е notify: failed", r.status === 201 && j.notify === "failed", `${r.status} ${j.notify}`);
check("3. Preview: нито едно извикване към Brevo (до фирмата и до клиента)", mail.calls === n0, String(mail.calls - n0));
check("4. Preview: писмата са в email_log като неуспешни с причината", log.length === 2 && log.every((l: any) => l.status === "failed" && /disabled outside production/.test(l.error)), JSON.stringify(log.map((l: any) => l.kind + ":" + l.status)));
setContext("production");
const r2 = await post("PR");
const j2 = await r2.json();
check("5. Продукция: писмата се изпращат", r2.status === 201 && !j2.notify && mail.calls === n0 + 2, `${mail.calls - n0}`);
process.env.MAIL_OUTSIDE_PRODUCTION = "1";
setContext("deploy-preview");
check("6. MAIL_OUTSIDE_PRODUCTION=1 разрешава изрично (само тестове с подменена поща)", mailAllowed() === true, "");
await finish();
