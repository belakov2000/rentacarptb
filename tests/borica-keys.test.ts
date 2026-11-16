// node --experimental-strip-types --test tests/borica-keys.test.ts
// Четене на ключовете от environment variables и безопасната диагностика (server/borica.ts): формати на PEM (нови редове
// като „\n“, CRLF, интервали, кавички, base64), парола, размер на ключа, грешен файл – и че диагностиката не съдържа
// нищо от ключа, паролата или стойността. Всички ключове са генерирани само за теста.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diagnosePrivateKey, diagnosePublicKey, loadPrivateKey, loadPublicKey, normalizePem, pemOf, signMac, verifyMac } from "../server/borica.ts";

const gen = (bits = 2048, pass?: string) => generateKeyPairSync("rsa", { modulusLength: bits, publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: pass ? { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: pass } : { type: "pkcs8", format: "pem" } });
const PASS = "test-only-Pass 123";
const plain = gen(), enc = gen(2048, PASS), small = gen(1024);
const body = (pem: string) => pem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");

// Никаква част от тайната (ред от base64 на ключа, паролата) не трябва да се появява в диагностиката
function noSecrets(d: unknown, pem: string, pass = "") {
  const j = JSON.stringify(d);
  for (const line of pem.split("\n").filter((l) => l.length > 20 && !l.startsWith("-----"))) assert.ok(!j.includes(line.slice(0, 16)), "диагностиката съдържа част от ключа");
  if (pass) assert.ok(!j.includes(pass.trim()), "диагностиката съдържа паролата");
  assert.ok(!/BEGIN|END|MII/.test(j), "диагностиката съдържа PEM");
}

const variants = (pem: string): [string, string, string[]][] => [
  ["истински нови редове", pem, []],
  ["\\n като текст (едноредово поле)", pem.trim().replace(/\n/g, "\\n"), ["escaped_newlines"]],
  ["\\r\\n като текст", pem.trim().replace(/\n/g, "\\r\\n"), ["escaped_newlines"]],
  ["Windows CRLF", pem.replace(/\n/g, "\r\n"), ["crlf"]],
  ["интервали вместо нови редове", pem.trim().replace(/\n/g, " "), ["spaces"]],
  ["в кавички", `"${pem.trim()}"`, ["quotes"]],
  ["base64 на целия PEM", Buffer.from(pem).toString("base64"), ["base64_wrapped"]],
  ["base64 на PEM, пренесен на редове", Buffer.from(pem).toString("base64").replace(/(.{76})/g, "$1\n"), ["base64_wrapped"]],
  ["интервали около стойността", `  \n${pem}\n  `, []],
];

test("PEM: всички начини на запис на частния ключ дават същия ключ и валиден подпис", () => {
  const ref = loadPrivateKey(plain.privateKey)!;
  const pub = loadPublicKey(plain.publicKey)!;
  for (const [name, v, fixes] of variants(plain.privateKey)) {
    const n = normalizePem(v);
    const k = loadPrivateKey(n.pem);
    assert.ok(k, name);
    assert.equal(k!.export({ format: "jwk" }).n, ref.export({ format: "jwk" }).n, name);
    assert.ok(verifyMac("data", signMac("data", k!), pub), name);
    for (const f of fixes) assert.ok(n.fixes.includes(f as any), `${name}: очаква поправка ${f}, има ${n.fixes}`);
    const d = diagnosePrivateKey(v, undefined);
    assert.ok(d.readable && d.bitsOk && d.passphrase === "not_needed", name);
    noSecrets(d, plain.privateKey);
  }
});
test("PEM: публичният ключ на БОРИКА във всички записи", () => {
  for (const [name, v] of variants(plain.publicKey)) {
    assert.ok(loadPublicKey(pemOf(v)), name);
    const d = diagnosePublicKey(v);
    assert.ok(d.readable && d.type === "rsa" && d.bits === 2048, name);
    noSecrets(d, plain.publicKey);
  }
});
test("PEM: повредени стойности не се „поправят“ на сляпо", () => {
  const p = plain.privateKey;
  assert.equal(pemOf(p.replace("-----END PRIVATE KEY-----", "")), "", "без END ред");
  assert.equal(pemOf(p.replace("END PRIVATE KEY", "END PUBLIC KEY")), "", "различни BEGIN / END");
  assert.equal(pemOf(p.replace(/(MII.{10})/, "$1!@#")), "", "невалиден base64");
  assert.equal(pemOf("not a key"), "");
  assert.equal(normalizePem("").format, "empty");
  const broken = p.replace(/\n([A-Za-z0-9+/]{64})\n/, "\n$1X\n"); // символ в повече – формата е валиден, ключът не
  assert.equal(loadPrivateKey(pemOf(broken)), null);
  const d = diagnosePrivateKey(broken, undefined);
  assert.ok(d.present && !d.readable && typeof d.error === "string");
  noSecrets(d, p);
});

test("Парола: вярна, грешна, липсваща, ненужна, с нов ред в края", () => {
  let d = diagnosePrivateKey(enc.privateKey, PASS);
  assert.ok(d.readable && d.encrypted && d.passphrase === "ok" && d.bitsOk);
  noSecrets(d, enc.privateKey, PASS);
  d = diagnosePrivateKey(enc.privateKey, "wrong-pass");
  assert.ok(!d.readable && d.encrypted && d.passphrase === "wrong");
  noSecrets(d, enc.privateKey, "wrong-pass");
  d = diagnosePrivateKey(enc.privateKey, undefined);
  assert.ok(!d.readable && d.passphrase === "missing");
  d = diagnosePrivateKey(enc.privateKey, PASS + "\n");
  assert.ok(d.readable && d.passphrase === "ok_after_trim", "нов ред в края на паролата");
  assert.ok(loadPrivateKey(pemOf(enc.privateKey), PASS + "\r\n"));
  assert.equal(loadPrivateKey(pemOf(enc.privateKey), PASS.slice(0, -1)), null, "непълна парола остава грешна");
  assert.equal(loadPrivateKey(pemOf(enc.privateKey), PASS.replace(" ", "")), null, "интервалите вътре в паролата не се премахват");
  d = diagnosePrivateKey(plain.privateKey, "some-pass");
  assert.ok(d.readable && d.passphrase === "unused");
  // Криптиран ключ, подаден с \n като текст
  d = diagnosePrivateKey(enc.privateKey.trim().replace(/\n/g, "\\n"), PASS);
  assert.ok(d.readable && d.passphrase === "ok" && d.fixes.includes("escaped_newlines"));
});

test("Размер: RSA под 2048 бита не се приема; диагностиката го показва отделно", () => {
  assert.equal(loadPrivateKey(small.privateKey), null);
  const d = diagnosePrivateKey(small.privateKey, undefined);
  assert.ok(d.readable && d.type === "rsa" && d.bits === 1024 && d.bitsOk === false);
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1", publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  assert.equal(loadPrivateKey(ec.privateKey), null, "не-RSA ключ");
  const e = diagnosePrivateKey(ec.privateKey, undefined);
  assert.ok(e.readable && e.type === "ec" && e.bitsOk === false);
  assert.equal(loadPublicKey(ec.publicKey), null);
  assert.ok(diagnosePublicKey(ec.publicKey).bitsOk === false);
});

test("Грешен файл: CSR, публичен вместо частен, частен вместо публичен, двоичен", () => {
  assert.equal(diagnosePrivateKey(plain.publicKey, undefined).wrongFile, "public_not_private");
  const pk = diagnosePublicKey(plain.privateKey);
  assert.equal(pk.wrongFile, "private_not_public");
  noSecrets(pk, plain.privateKey);
  assert.equal(diagnosePrivateKey("-----BEGIN CERTIFICATE REQUEST-----\nMIIBAA==\n-----END CERTIFICATE REQUEST-----", undefined).wrongFile, "csr");
  const der = gen().privateKey;
  assert.equal(diagnosePrivateKey(body(der), undefined).format, "binary", "base64 на DER без BEGIN/END");
});

test("OpenSSL: ключове като от т. 5.2 (genrsa -aes256), стар формат с Proc-Type, сертификат; MD5 на модула като т. 5.6", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "borica-keys-"));
  const sh = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString();
  try { sh(["version"]); } catch { t.skip("няма openssl"); return; }
  sh(["genrsa", "-aes256", "-passout", "pass:" + PASS, "-out", "k.key", "2048"]);
  sh(["rsa", "-in", "k.key", "-passin", "pass:" + PASS, "-aes256", "-passout", "pass:" + PASS, "-traditional", "-out", "trad.key"]);
  sh(["req", "-x509", "-new", "-key", "k.key", "-passin", "pass:" + PASS, "-subj", "/CN=test.example/OU=VTEST001/O=Test/C=BG", "-days", "2", "-out", "c.cer"]);
  const key = readFileSync(join(dir, "k.key"), "utf8"), trad = readFileSync(join(dir, "trad.key"), "utf8"), cer = readFileSync(join(dir, "c.cer"), "utf8");
  assert.match(trad, /Proc-Type: 4,ENCRYPTED/);
  const expected = sh(["x509", "-noout", "-modulus", "-in", "c.cer"]);
  const md5 = createHash("md5").update(expected).digest("hex");
  for (const [name, v] of [["PKCS#8 криптиран", key], ["стар формат", trad], ["стар формат с \\n", trad.trim().replace(/\n/g, "\\n")], ["стар формат с интервали", trad.trim().replace(/\n/g, " ")], ["стар формат CRLF", trad.replace(/\n/g, "\r\n")]] as const) {
    const d = diagnosePrivateKey(v, PASS);
    assert.ok(d.readable && d.passphrase === "ok" && d.bitsOk, name);
    assert.equal(d.modulusMd5, md5, `${name}: MD5 на модула = openssl x509 -modulus | md5`);
    noSecrets(d, v, PASS);
  }
  const c = diagnosePublicKey(cer);
  assert.ok(c.readable && c.bits === 2048 && c.certificate && !c.certificate.expired && c.modulusMd5 === md5);
  assert.ok(loadPublicKey(pemOf(cer.replace(/\n/g, "\\n"))));
  // DER сертификат (.cer в двоичен вид) – не се приема, показва се „binary“
  sh(["x509", "-in", "c.cer", "-outform", "der", "-out", "c.der"]);
  assert.equal(diagnosePublicKey(readFileSync(join(dir, "c.der")).toString("base64")).format, "binary");
});
