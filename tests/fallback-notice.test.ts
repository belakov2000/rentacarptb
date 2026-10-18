// node --experimental-strip-types --test tests/fallback-notice.test.ts
// Изпълнява същата функция fallbackNotice от index.html (между маркерите fallback-notice:start / end).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync("index.html", "utf8");
const src = html.slice(html.indexOf("/* fallback-notice:start */"), html.indexOf("/* fallback-notice:end */"));
const ctx: any = {};
vm.runInNewContext(src + "\nthis.fallbackNotice = fallbackNotice;", ctx);
const notice = (d: Record<string, unknown>) => ctx.fallbackNotice(d) as { subject: string; message: string; replyto?: string; from_name: string };

// Синтетични стойности на чувствителните полета – не трябва да се появят никъде в известието
const SENSITIVE = {
  egn: "8001019999", idn: "TESTID123456", dln: "TESTDL987654", idp: "МВР-ТЕСТ", addr: "ул. Тестова 99", city: "Тестоград", a1: "бул. Доставка 5", a2: "ул. Връщане 7",
  photos: "https://site.example/api/documents/" + "a".repeat(64), contract: "Договор за наем – съдържание", invoice: "ЕИК 999999999", note: "лична бележка",
};
const base = { car: "Ford Ka", from: "01.02.2029 10:00", to: "03.02.2029 10:00", m1: "addr", m2: "office", total: "40 €", name: "ТЕСТ Клиент", phone: "+359000000000", email: "client-test@example.com" };
const leaks = (n: object) => {
  const s = JSON.stringify(n);
  return Object.entries(SENSITIVE).filter(([, v]) => s.includes(v)).map(([k]) => k).concat(/\/api\/documents|https?:\/\//.test(s) ? ["link"] : []);
};
const allowedKeys = (n: object) => Object.keys(n).every((k) => ["subject", "from_name", "message", "replyto"].includes(k));

test("записана заявка: номер, автомобил, период, име и телефон – без чувствителни полета", () => {
  const n = notice({ ...base, ...SENSITIVE, ref: "5BBDD0" });
  assert.deepEqual(leaks(n), []);
  assert.ok(allowedKeys(n));
  assert.match(n.subject, /№ 5BBDD0/);
  for (const v of ["Ford Ka", "01.02.2029 10:00", "03.02.2029 10:00", "ТЕСТ Клиент", "+359000000000", "40 €"]) assert.ok(n.message.includes(v), v);
  assert.ok(!n.message.includes("client-test@example.com") && !n.replyto, "без имейл, когато заявката е записана");
  assert.match(n.message, /до\/от адрес на клиента – уточнете/); // видът на мястото, без самия адрес
});

test("мрежова грешка преди запис: само данни за връзка и заявката – без чувствителни полета", () => {
  const n = notice({ ...base, ...SENSITIVE, ref: "" });
  assert.deepEqual(leaks(n), []);
  assert.ok(allowedKeys(n));
  assert.match(n.subject, /без потвърден запис/);
  assert.match(n.message, /не получи потвърждение/);
  assert.ok(n.message.includes("client-test@example.com") && n.replyto === "client-test@example.com");
});

test("липсващи полета: известието се създава с „-“, без грешка и без празни данни", () => {
  for (const d of [{}, { ref: "" }, { ref: "ABCDEF" }, { name: null, phone: undefined, email: "", car: "", from: "", to: "" }]) {
    const n = notice(d);
    assert.deepEqual(leaks(n), []);
    assert.ok(allowedKeys(n));
    assert.match(n.message, /Автомобил: -/);
    assert.ok(!n.replyto);
  }
});

test("невалиден номер на заявка или имейл не се използват; нови редове не могат да вмъкнат текст", () => {
  const n = notice({ ...base, ref: "<b>x</b>", email: "bad\nBcc: x@y.z", name: "Име\nЕГН: 8001019999" });
  assert.ok(!n.subject.includes("<b>") && !n.replyto);
  assert.ok(!n.message.includes("\nЕГН"), "името е на един ред");
  assert.ok(!n.message.includes("Bcc:\n"));
});

test("в index.html няма друг път към Web3Forms освен това известие", () => {
  const code = html.replace(/<!--[\s\S]*?-->/g, "");
  assert.equal((code.match(/WEB3FORMS_KEY/g) || []).length, 2, "декларация + postNotice");
  assert.match(code, /access_key:WEB3FORMS_KEY,\.\.\.fallbackNotice\(d\)\}/);
  assert.ok(!/mailFields/.test(code), "старата функция с всички полета е премахната");
  const notice = code.slice(code.indexOf("function noticeData"), code.indexOf("const postNotice"));
  for (const f of ["egn", "idn", "dln", "addr", "a1", "a2", "city", "idp", "links", "PH["]) assert.ok(!notice.includes("R." + f) && !notice.includes(f + ":"), f);
});


test("резервното известие води до същия Preview през защитения админ панел, без таен токен", () => {
  const id="a".repeat(32), site="https://deploy-preview-54--rentacarptb.netlify.app";
  const n=notice({...base,ref:"AAAAAA",id,site,adminToken:"b".repeat(64)});
  assert.ok(n.message.includes(site+"/admin/bookings/"+id));
  assert.ok(!n.message.includes("b".repeat(64)));
  assert.ok(!notice({...base,ref:"AAAAAA",id,site:"https://evil.example"}).message.includes("evil.example"));
});
