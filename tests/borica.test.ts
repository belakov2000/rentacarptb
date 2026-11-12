// node --experimental-strip-types --test tests/borica.test.ts
// Протокол на БОРИКА (server/borica.ts) спрямо примерите в P-OM-41 v7.0: символен низ за подпис (MAC_GENERAL), подпис RSA-SHA256,
// проверка на отговора, полета на заявката и резултат по ACTION / RC. Ключовете са генерирани само за теста.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  amountOf, centsOf, fieldsOf, GATEWAY, loadPrivateKey, loadPublicKey, MAC_REQUEST, MAC_RESPONSE, macString, mInfo, outcomeOf, paymentRequest, pemOf,
  signMac, statusRequest, timestamp, verifyMac, verifyResponse, type Terminal,
} from "../server/borica.ts";

const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const merchant = pair(), borica = pair(), other = pair();
const T: Terminal = { mode: "test", terminal: "V1800001", merchant: "1600000001", currency: "EUR", key: loadPrivateKey(merchant.privateKey)!, borica: loadPublicKey(borica.publicKey)!, gateway: GATEWAY.test };

test("символен низ за заявка „Плащане“ – табл. 11 (78 знака)", () => {
  const s = macString(MAC_REQUEST["1"], { TERMINAL: "V1800001", TRTYPE: "1", AMOUNT: "9.00", CURRENCY: "BGN", ORDER: "154744", TIMESTAMP: "20201012124757", NONCE: "9EADBD70C0A5AFBAD3DF405902602F79" });
  assert.equal(s, "8V18000011149.003BGN61547441420201012124757329EADBD70C0A5AFBAD3DF405902602F79-");
  assert.equal(s.length, 78);
});
test("символен низ за отговор – табл. 12 (124 знака, празни PARES_STATUS и ECI → „-“)", () => {
  const s = macString(MAC_RESPONSE, { ACTION: "1", RC: "00", APPROVAL: "S97539", TERMINAL: "V1800001", TRTYPE: "1", AMOUNT: "9.00", CURRENCY: "BGN", ORDER: "154744", RRN: "028601253152", INT_REF: "97E2F39EFCA1CAF1", PARES_STATUS: "", ECI: "", TIMESTAMP: "20201012160009", NONCE: "9EADBD70C0A5AFBAD3DF405902602F79" });
  assert.equal(s, "112006S975398V18000011149.003BGN6154744120286012531521697E2F39EFCA1CAF1--1420201012160009329EADBD70C0A5AFBAD3DF405902602F79-");
  assert.equal(s.length, 124);
});
test("символен низ за проверка за статус – табл. 15 (без RFU)", () => {
  assert.equal(macString(MAC_REQUEST["90"], { TERMINAL: "V1800001", TRTYPE: "90", ORDER: "114233", NONCE: "622CAAA8BF20C5A21A917DCB8401C336" }), "8V1800001290611423332622CAAA8BF20C5A21A917DCB8401C336");
});
test("отговор на проверка за статус – пример 6.2 (отказана отмяна, празни полета)", () => {
  const s = macString(MAC_RESPONSE, { ACTION: "3", RC: "-24", APPROVAL: "", TERMINAL: "V1800001", TRTYPE: "90", AMOUNT: "", CURRENCY: "USD", ORDER: "114233", RRN: "", INT_REF: "", PARES_STATUS: "", ECI: "", TIMESTAMP: "20201016084907", NONCE: "B1A1B57F8D66EF6B604690BF7141B53C" });
  assert.equal(s, "133-24-8V1800001290-3USD6114233----142020101608490732B1A1B57F8D66EF6B604690BF7141B53C-");
});

test("заявка „Плащане“: задължителните полета от табл. 3 и валиден подпис", () => {
  const now = new Date("2026-11-12T10:20:30Z");
  const { fields: f, mac } = paymentRequest(T, { amountCents: 8150, order: "000123", desc: "Rent a Car PTB - booking ABC123", merchName: "Rent a Car PTB", merchUrl: "https://rentacar-ptb.com", lang: "BG", adOrderId: "000123PTBABC123", cardholder: { name: "IVAN IVANOV", email: "a@example.com", billAddrLine1: "Plovdiv, ul. Test 1" }, now });
  for (const k of ["TERMINAL", "TRTYPE", "AMOUNT", "CURRENCY", "ORDER", "DESC", "MERCHANT", "MERCH_NAME", "ADDENDUM", "AD.CUST_BOR_ORDER_ID", "TIMESTAMP", "M_INFO", "NONCE", "P_SIGN"]) assert.ok(f[k], k);
  assert.equal(f.TRTYPE, "1");
  assert.equal(f.AMOUNT, "81.50");
  assert.equal(f.ADDENDUM, "AD,TD");
  assert.equal(f.TIMESTAMP, "20261112102030");
  assert.match(f.NONCE, /^[0-9A-F]{32}$/);
  assert.match(f.P_SIGN, /^[0-9A-F]{512}$/);
  assert.ok(f["AD.CUST_BOR_ORDER_ID"].startsWith(f.ORDER) && !f["AD.CUST_BOR_ORDER_ID"].includes(";"));
  assert.deepEqual(JSON.parse(Buffer.from(f.M_INFO, "base64").toString("utf8")), { cardholderName: "IVAN IVANOV", email: "a@example.com", billAddrLine1: "Plovdiv, ul. Test 1" });
  assert.equal(mac, macString(MAC_REQUEST["1"], f));
  assert.ok(verifyMac(mac, f.P_SIGN, loadPublicKey(merchant.publicKey)!), "подписът се проверява с публичния ключ на търговеца");
  assert.ok(!verifyMac(mac.replace("81.50", "81.51"), f.P_SIGN, loadPublicKey(merchant.publicKey)!), "друга сума → невалиден подпис");
});
test("заявка: невалиден ORDER / AD.CUST_BOR_ORDER_ID / сума се отказват", () => {
  const base = { amountCents: 100, order: "000123", desc: "x", merchName: "x", merchUrl: "https://x", lang: "BG" as const, adOrderId: "000123AB", cardholder: { name: "A B", email: "a@b.c", billAddrLine1: "x" } };
  assert.throws(() => paymentRequest(T, { ...base, order: "12345" }));
  assert.throws(() => paymentRequest(T, { ...base, adOrderId: "000123A;B" }));
  assert.throws(() => paymentRequest(T, { ...base, adOrderId: "999999AB" }));
  assert.throws(() => paymentRequest(T, { ...base, amountCents: 0 }));
});
test("проверка за статус: TRTYPE 90, TRAN_TRTYPE 1, подпис само върху TERMINAL, TRTYPE, ORDER, NONCE", () => {
  const { fields: f, mac } = statusRequest(T, "000123", "622CAAA8BF20C5A21A917DCB8401C336");
  assert.equal(mac, "8V1800001290600012332622CAAA8BF20C5A21A917DCB8401C336");
  assert.equal(f.TRAN_TRTYPE, "1");
  assert.ok(verifyMac(mac, f.P_SIGN, loadPublicKey(merchant.publicKey)!));
});

const resp = (o: Record<string, string> = {}, key = borica.privateKey) => {
  const f: Record<string, string> = { ACTION: "0", RC: "00", APPROVAL: "S12345", TERMINAL: "V1800001", TRTYPE: "1", AMOUNT: "81.50", CURRENCY: "EUR", ORDER: "000123", RRN: "028601253152", INT_REF: "97E2F39EFCA1CAF1", PARES_STATUS: "Y", ECI: "05", TIMESTAMP: "20261112102530", NONCE: "9EADBD70C0A5AFBAD3DF405902602F79", ...o };
  f.P_SIGN = signMac(macString(MAC_RESPONSE, f), loadPrivateKey(key)!);
  return f;
};
test("отговор: проверка на подписа с публичния ключ на БОРИКА", () => {
  assert.ok(verifyResponse(resp(), T.borica));
  assert.ok(!verifyResponse({ ...resp(), AMOUNT: "1.00" }, T.borica), "променена сума");
  assert.ok(!verifyResponse({ ...resp(), RC: "00", ACTION: "0", ORDER: "000124" }, T.borica), "друга поръчка");
  assert.ok(!verifyResponse(resp({}, other.privateKey), T.borica), "подпис с друг ключ");
  assert.ok(!verifyResponse({ ...resp(), P_SIGN: "" }, T.borica), "без подпис");
  assert.ok(!verifyResponse({ ...resp(), P_SIGN: "ZZ" }, T.borica), "невалиден hex");
  // STATUSMSG, CARD и CARDHOLDERINFO не участват в подписа (табл. 10)
  assert.ok(verifyResponse({ ...resp(), STATUSMSG: "Approved", CARD: "5100XXXXXXXX0022" }, T.borica));
});
test("резултат: само ACTION 0 + RC 00 е плащане; положителен RC – окончателен отказ; отрицателен – неокончателен", () => {
  assert.equal(outcomeOf({ ACTION: "0", RC: "00" }), "paid");
  assert.equal(outcomeOf({ ACTION: "2", RC: "05" }), "declined");
  assert.equal(outcomeOf({ ACTION: "2", RC: "1A" }), "declined");
  assert.equal(outcomeOf({ ACTION: "3", RC: "-19" }), "pending");
  assert.equal(outcomeOf({ ACTION: "1", RC: "00" }), "pending", "дублирана трансакция не е ново плащане");
  assert.equal(outcomeOf({ ACTION: "21", RC: "65" }), "pending", "Soft Decline – терминалът повтаря автоматично (т. 4.7), не е окончателно");
  assert.equal(outcomeOf({ ACTION: "3", RC: "05" }), "pending", "положителен RC без ACTION 2 не е доказан отказ");
  assert.equal(outcomeOf({ ACTION: "3", RC: "-40" }), "timeout", "само RC -40 има изрично правило (стр. 18)");
  assert.equal(outcomeOf({ ACTION: "3", RC: "-31" }), "pending");
  assert.equal(outcomeOf({ ACTION: "3", RC: "-24" }), "pending", "непозната трансакция не е доказан неуспех");
  assert.equal(outcomeOf({ RC: "00" }), "pending");
  assert.equal(outcomeOf({}), "pending");
});
test("помощни: сума, време, PEM от environment variable, полета от формуляра", () => {
  assert.equal(amountOf(100), "1.00");
  assert.equal(amountOf(8150), "81.50");
  assert.equal(centsOf("81.50"), 8150);
  assert.equal(centsOf("81.5"), null);
  assert.equal(centsOf("81,50"), null);
  assert.equal(timestamp(new Date("2026-01-02T03:04:05Z")), "20260102030405");
  assert.equal(pemOf(merchant.privateKey.replace(/\n/g, "\\n")).trim(), merchant.privateKey.trim());
  assert.ok(pemOf(Buffer.from(merchant.privateKey).toString("base64")).includes("BEGIN PRIVATE KEY"));
  assert.equal(pemOf("not a key"), "");
  assert.equal(loadPrivateKey("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"), null);
  const small = generateKeyPairSync("rsa", { modulusLength: 1024, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  assert.equal(loadPrivateKey(small.privateKey), null, "ключ под 2048 бита");
  const enc = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "test-only" } });
  assert.ok(loadPrivateKey(enc.privateKey, "test-only"), "ключ с парола");
  assert.equal(loadPrivateKey(enc.privateKey, "wrong"), null);
  assert.equal(loadPrivateKey(enc.privateKey), null);
  assert.deepEqual(fieldsOf([["ACTION", "0"], ["x", "1"], ["RC", 5 as any], ["AD.CUST_BOR_ORDER_ID", "1"]]), { ACTION: "0", "AD.CUST_BOR_ORDER_ID": "1" });
  assert.equal(JSON.parse(Buffer.from(mInfo({ a: "Пловдив" }), "base64").toString("utf8")).a, "Пловдив");
});
test("адресите на БОРИКА са от т. 2.2", () => {
  assert.equal(GATEWAY.test, "https://3dsgate-dev.borica.bg/cgi-bin/cgi_link");
  assert.equal(GATEWAY.live, "https://3dsgate.borica.bg/cgi-bin/cgi_link");
});
