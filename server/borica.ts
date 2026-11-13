// Протокол на БОРИКА за виртуален ПОС (APGW, интеграция чрез CGI / WWW Forms).
// Източник: „Сигурни плащания чрез интернет (протокол EMV 3DS) – Инструкция за виртуални търговци“, P-OM-41, версия 7.0 / 26.03.2026.
// Тук са само описаните в документа полета, адреси и алгоритъм – без бизнес логика и без достъп до базата.
//
//  • Заявка „Плащане“ TRTYPE=1 (т. 4.1, табл. 3) – HTML форма, изпратена с HTTP POST през браузъра на клиента към cgi_link (т. 2.2).
//  • Отговор (т. 3.2, табл. 2) – HTTP POST от браузъра към BACKREF; адресът се задава от банката за терминала (т. 2.1), не в заявката.
//  • „Проверка за статус“ TRTYPE=90 (т. 4.2, табл. 5) – директно от сървъра, GET или POST; отговорът е JSON; данни за последните 24 ч.
//  • Подпис P_SIGN (т. 5.1, 5.7, 5.8, табл. 10, прил. 9.1–9.2): RSA с SHA-256 (openssl_sign … OPENSSL_ALGO_SHA256) върху символен низ
//    по схема MAC_GENERAL: за всяко поле – дължината в байтове (UTF-8) и стойността; липсващо поле и RFU – един байт „-“ (0x2D).
//    Подписът е 256 байта, шестнадесетично, главни букви.
//  • Успешна трансакция е само ACTION = "0" и RC = "00" (т. 3.2). Отрицателните RC могат да се променят в рамките на GUARDTIME
//    (15 мин.); резултатът от проверка за статус след 16 мин. е окончателен; положителните RC, различни от 00, са окончателни (т. 9.5.1).
import { createHash, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes, X509Certificate, type KeyObject } from "node:crypto";

// т. 2.2 – адреси за заявките (всички типове трансакции)
export const GATEWAY = {
  test: "https://3dsgate-dev.borica.bg/cgi-bin/cgi_link",
  live: "https://3dsgate.borica.bg/cgi-bin/cgi_link",
} as const;
export type Mode = keyof typeof GATEWAY;

export const GUARDTIME_MS = 15 * 60_000; // т. 1.2.1, т. 4
export const FINAL_AFTER_MS = 16 * 60_000; // т. 9.5.1 – GUARDTIME + 1 мин. буфер
export const STATUS_WINDOW_MS = 24 * 3600_000; // т. 2.1, т. 4.2 – APGW пази данни за последните 24 ч.

// Табл. 10 (MAC_GENERAL) – поредността на полетата е задължителна (т. 5.7, 5.8)
export const MAC_REQUEST: Record<"1" | "90", readonly string[]> = {
  "1": ["TERMINAL", "TRTYPE", "AMOUNT", "CURRENCY", "ORDER", "TIMESTAMP", "NONCE", "RFU"],
  "90": ["TERMINAL", "TRTYPE", "ORDER", "NONCE"],
};
export const MAC_RESPONSE = ["ACTION", "RC", "APPROVAL", "TERMINAL", "TRTYPE", "AMOUNT", "CURRENCY", "ORDER", "RRN", "INT_REF", "PARES_STATUS", "ECI", "TIMESTAMP", "NONCE", "RFU"] as const;

export type Fields = Record<string, string>;

// Символен низ за подпис: <дължина в байтове><стойност> за всяко поле; липсващо / празно поле и RFU → „-“
export function macString(order: readonly string[], f: Partial<Fields>) {
  return order
    .map((k) => {
      if (k === "RFU") return "-";
      const v = f[k];
      return v == null || v === "" ? "-" : Buffer.byteLength(v, "utf8") + v;
    })
    .join("");
}

export const signMac = (data: string, key: KeyObject) => createSign("RSA-SHA256").update(data, "utf8").sign(key).toString("hex").toUpperCase();
export function verifyMac(data: string, signHex: string, key: KeyObject) {
  if (!/^[0-9A-Fa-f]{2,1024}$/.test(signHex || "") || signHex.length % 2) return false;
  try {
    return createVerify("RSA-SHA256").update(data, "utf8").verify(key, Buffer.from(signHex, "hex"));
  } catch {
    return false;
  }
}

// ===== Ключове от environment variables (само на сървъра) =====
// Нормализиране на PEM – само форматът на записа, не съдържанието: обхващащи кавички, „\n“ / „\r\n“ като текст, CRLF,
// нови редове, заменени с интервали при поставяне в едноредово поле, и base64 на целия PEM. Тялото на всеки блок се сглобява
// наново (base64 на редове по 64 знака), заглавките Proc-Type / DEK-Info на криптиран ключ в стар формат се запазват.
// Нищо не се отгатва: невалиден base64, липсващ END ред или различни BEGIN / END означават, че ключът не е прочетен.
export type PemFix = "quotes" | "escaped_newlines" | "crlf" | "spaces" | "base64_wrapped";
export type PemInfo = { pem: string; labels: string[]; fixes: PemFix[]; format: "pem" | "base64_pem" | "binary" | "not_pem" | "empty" };
const BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END ([A-Z0-9 ]+)-----/g;
export function normalizePem(v: string | undefined): PemInfo {
  const fixes = new Set<PemFix>();
  let s = String(v ?? "").trim();
  if (!s) return { pem: "", labels: [], fixes: [], format: "empty" };
  if (/^(["'])[\s\S]*\1$/.test(s)) { s = s.slice(1, -1).trim(); fixes.add("quotes"); }
  let format: PemInfo["format"] = "pem";
  if (!s.includes("-----BEGIN")) {
    const compact = s.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return { pem: "", labels: [], fixes: [...fixes], format: "not_pem" };
    const d = Buffer.from(compact, "base64");
    const txt = d.toString("utf8");
    if (!txt.includes("-----BEGIN")) return { pem: "", labels: [], fixes: [...fixes], format: d[0] === 0x30 ? "binary" : "not_pem" };
    s = txt.trim();
    format = "base64_pem";
    fixes.add("base64_wrapped");
  }
  if (/\\r\\n|\\n|\\r/.test(s)) { s = s.replace(/\\r\\n|\\n|\\r/g, "\n"); fixes.add("escaped_newlines"); }
  if (/\r/.test(s)) { s = s.replace(/\r\n?/g, "\n"); fixes.add("crlf"); }
  const out: string[] = [], labels: string[] = [];
  for (const m of s.matchAll(BLOCK)) {
    const [, begin, raw, end] = m;
    if (begin !== end) return { pem: "", labels, fixes: [...fixes], format: "not_pem" };
    let body = raw.trim();
    // Заглавки на стар криптиран формат (RFC 1421): „Proc-Type: 4,ENCRYPTED“ и „DEK-Info: <алгоритъм>,<IV>“
    const headers: string[] = [];
    for (const h of ["Proc-Type", "DEK-Info"]) {
      const hm = new RegExp(`(?:^|\\s)${h}:\\s*([A-Za-z0-9,-]+)`).exec(body);
      if (hm) { headers.push(`${h}: ${hm[1]}`); body = body.replace(hm[0], " "); }
    }
    const lines = raw.trim().split("\n");
    if (lines.length === 1 && /\s/.test(raw.trim())) fixes.add("spaces");
    const b64 = body.replace(/\s+/g, "");
    if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { pem: "", labels, fixes: [...fixes], format: "not_pem" };
    labels.push(begin);
    out.push(`-----BEGIN ${begin}-----\n${headers.length ? headers.join("\n") + "\n\n" : ""}${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${begin}-----\n`);
  }
  if (!out.length) return { pem: "", labels, fixes: [...fixes], format: "not_pem" };
  return { pem: out.join(""), labels, fixes: [...fixes], format };
}
export const pemOf = (v: string | undefined) => normalizePem(v).pem;

export const MIN_RSA_BITS = 2048; // т. 5.2: „openssl genrsa … 2048“
const PRIVATE_LABELS = ["PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "RSA PRIVATE KEY"];
const PUBLIC_LABELS = ["PUBLIC KEY", "RSA PUBLIC KEY", "CERTIFICATE"];

// Частният ключ. Паролата се опитва точно както е подадена; само ако не става – и без крайни интервали / нов ред
// (честа грешка при поставяне). Грешна парола остава грешна. Изискванията (RSA, ≥ 2048 бита) не се променят.
function openPrivate(pem: string, passphrase?: string) {
  const tries = passphrase ? [passphrase, ...(passphrase.trim() !== passphrase && passphrase.trim() ? [passphrase.trim()] : [])] : [undefined];
  let error = "";
  for (const [i, p] of tries.entries()) {
    try {
      const k = createPrivateKey(p !== undefined ? { key: pem, format: "pem", passphrase: p } : { key: pem, format: "pem" });
      return { key: k, trimmed: i > 0, error: "" };
    } catch (e) {
      error = String((e as { code?: string })?.code || "ERR_UNKNOWN").slice(0, 60);
    }
  }
  return { key: null, trimmed: false, error };
}
// Грешките не съдържат ключа или паролата – само вида на проблема
export function loadPrivateKey(pem: string, passphrase?: string): KeyObject | null {
  const r = openPrivate(pem, passphrase);
  return r.key && r.key.asymmetricKeyType === "rsa" && (r.key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_RSA_BITS ? r.key : null;
}
// Публичният ключ на APGW (т. 2.1): .pem с публичен ключ или сертификат (.cer в PEM вид)
export function loadPublicKey(pem: string): KeyObject | null {
  try {
    const k = createPublicKey(pem);
    return k.asymmetricKeyType === "rsa" ? k : null;
  } catch {
    return null;
  }
}

// ===== Безопасна диагностика (админ панел) =====
// Връща само: вид и формат на записа, приложени поправки на формата, дали е прочетен / отключен, тип и размер на ключа,
// публични отпечатъци (SHA-256 на публичния ключ; MD5 на модула като „openssl … -modulus | openssl md5“ от т. 5.6 – за
// сравнение с подписания сертификат от БОРИКА) и сроковете на сертификата. Никога: ключ, парола, base64, част от стойност.
export type KeyDiag = {
  present: boolean; format: PemInfo["format"]; labels: string[]; fixes: PemFix[]; wrongFile?: string;
  readable: boolean; error?: string; type?: string; bits?: number; bitsOk?: boolean;
  encrypted?: boolean; passphrase?: "not_needed" | "ok" | "ok_after_trim" | "wrong" | "missing" | "unused";
  publicSha256?: string; modulusMd5?: string; certificate?: { validFrom: string; validTo: string; expired: boolean };
};
const md5Modulus = (k: KeyObject) => {
  const n = (k.export({ format: "jwk" }) as { n?: string }).n;
  return n ? createHash("md5").update(`Modulus=${Buffer.from(n, "base64url").toString("hex").toUpperCase()}\n`).digest("hex") : "";
};
const spkiSha = (k: KeyObject) => createHash("sha256").update(k.export({ type: "spki", format: "der" })).digest("hex");
function wrong(labels: string[], expected: string[]) {
  const l = labels.find((x) => !expected.includes(x));
  return l ? (l === "CERTIFICATE REQUEST" ? "csr" : l === "CERTIFICATE" || l.includes("PUBLIC") ? "public_not_private" : l.includes("PRIVATE") ? "private_not_public" : "other") : undefined;
}
export function diagnosePrivateKey(v: string | undefined, passphrase: string | undefined): KeyDiag {
  const info = normalizePem(v);
  const d: KeyDiag = { present: info.format !== "empty", format: info.format, labels: info.labels, fixes: info.fixes, readable: false };
  if (!info.pem) return d;
  const w = wrong(info.labels.slice(0, 1), PRIVATE_LABELS);
  if (w) return { ...d, wrongFile: w };
  d.encrypted = info.labels[0] === "ENCRYPTED PRIVATE KEY" || /Proc-Type: 4,ENCRYPTED/.test(info.pem);
  const r = openPrivate(info.pem, passphrase || undefined);
  if (!r.key) return { ...d, error: r.error, passphrase: d.encrypted ? (passphrase ? "wrong" : "missing") : undefined };
  d.readable = true;
  d.passphrase = d.encrypted ? (r.trimmed ? "ok_after_trim" : "ok") : passphrase ? "unused" : "not_needed";
  d.type = r.key.asymmetricKeyType;
  d.bits = r.key.asymmetricKeyDetails?.modulusLength;
  d.bitsOk = d.type === "rsa" && (d.bits ?? 0) >= MIN_RSA_BITS;
  if (d.type === "rsa") { const pub = createPublicKey(r.key); d.publicSha256 = spkiSha(pub); d.modulusMd5 = md5Modulus(pub); }
  return d;
}
export function diagnosePublicKey(v: string | undefined): KeyDiag {
  const info = normalizePem(v);
  const d: KeyDiag = { present: info.format !== "empty", format: info.format, labels: info.labels, fixes: info.fixes, readable: false };
  if (!info.pem) return d;
  const w = wrong(info.labels.slice(0, 1), PUBLIC_LABELS);
  if (w) return { ...d, wrongFile: w };
  try {
    const k = createPublicKey(info.pem);
    Object.assign(d, { readable: true, type: k.asymmetricKeyType, bits: k.asymmetricKeyDetails?.modulusLength, publicSha256: spkiSha(k) });
    d.bitsOk = d.type === "rsa" && (d.bits ?? 0) >= MIN_RSA_BITS;
    if (d.type === "rsa") d.modulusMd5 = md5Modulus(k);
    if (info.labels[0] === "CERTIFICATE") {
      const c = new X509Certificate(info.pem);
      d.certificate = { validFrom: new Date(c.validFrom).toISOString(), validTo: new Date(c.validTo).toISOString(), expired: Date.now() > Date.parse(c.validTo) };
    }
  } catch (e) {
    d.error = String((e as { code?: string })?.code || "ERR_UNKNOWN").slice(0, 60);
  }
  return d;
}

export type Terminal = { mode: Mode; terminal: string; merchant: string; currency: string; key: KeyObject; borica: KeyObject; gateway: string };

// ===== Помощни полета =====
export const nonce = () => randomBytes(16).toString("hex").toUpperCase(); // 16 непредсказуеми байта, A–F и 0–9 (табл. 1)
export const randomOrder = () => String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0"); // 6 цифри (табл. 1)
// TIMESTAMP – UTC, YYYYMMDDHHMMSS (табл. 1, т. 5.8: gmdate('YmdHis'))
export const timestamp = (d = new Date()) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
// AMOUNT – с десетична точка, напр. „12.00“ (т. 3.3)
export const amountOf = (cents: number) => (cents / 100).toFixed(2);
export const centsOf = (amount: string | undefined) => (/^\d{1,10}\.\d{2}$/.test(amount || "") ? Math.round(Number(amount) * 100) : null);
// M_INFO – Base64 на JSON (табл. 1)
export const mInfo = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

export type PaymentInput = {
  amountCents: number; order: string; desc: string; merchName: string; merchUrl: string; lang: "BG" | "EN";
  adOrderId: string; cardholder: { name: string; email: string; billAddrLine1: string };
  nonce?: string; now?: Date;
};
// Полета на заявка „Плащане“ (табл. 3) с подпис. Връща и символния низ (за тестовете; не се записва в лог).
export function paymentRequest(t: Terminal, i: PaymentInput) {
  if (!/^\d{6}$/.test(i.order)) throw new Error("ORDER must be 6 digits");
  if (!Number.isInteger(i.amountCents) || i.amountCents <= 0) throw new Error("AMOUNT must be positive");
  if (!/^\d{6}[A-Za-z0-9]{1,16}$/.test(i.adOrderId) || !i.adOrderId.startsWith(i.order)) throw new Error("AD.CUST_BOR_ORDER_ID must be ORDER + up to 16 latin letters/digits");
  const f: Fields = {
    TERMINAL: t.terminal,
    TRTYPE: "1",
    AMOUNT: amountOf(i.amountCents),
    CURRENCY: t.currency,
    ORDER: i.order,
    DESC: i.desc.slice(0, 50),
    MERCHANT: t.merchant,
    MERCH_NAME: i.merchName.slice(0, 80),
    MERCH_URL: i.merchUrl.slice(0, 250),
    COUNTRY: "BG",
    LANG: i.lang,
    ADDENDUM: "AD,TD",
    "AD.CUST_BOR_ORDER_ID": i.adOrderId,
    TIMESTAMP: timestamp(i.now),
    M_INFO: mInfo({ cardholderName: i.cardholder.name.slice(0, 45), email: i.cardholder.email, billAddrLine1: i.cardholder.billAddrLine1.slice(0, 50) }),
    NONCE: i.nonce || nonce(),
  };
  const mac = macString(MAC_REQUEST["1"], f);
  f.P_SIGN = signMac(mac, t.key);
  return { fields: f, mac };
}

// Заявка „Проверка за статус“ (табл. 5) – подпис върху TERMINAL, TRTYPE, ORDER, NONCE (табл. 10, пример 6.2)
export function statusRequest(t: Terminal, order: string, n = nonce()) {
  const f: Fields = { TERMINAL: t.terminal, TRTYPE: "90", ORDER: order, TRAN_TRTYPE: "1", NONCE: n };
  const mac = macString(MAC_REQUEST["90"], f);
  f.P_SIGN = signMac(mac, t.key);
  return { fields: f, mac };
}

// Проверка на подписа на отговор (т. 5.8) с публичния ключ на APGW за съответната среда
export const verifyResponse = (f: Partial<Fields>, borica: KeyObject) => verifyMac(macString(MAC_RESPONSE, f), String(f.P_SIGN || ""), borica);

// Резултат по ACTION / RC – само случаите с изрично основание в P-OM-41:
//   paid     – ACTION 0 и RC 00 (стр. 16, т. 3.2: „Успешна трансакция е само тази, която завършва с RC „00“ и Action „0“.“)
//   declined – ACTION 2 и положителен RC, различен от 00 (стр. 18, табл. 4: ACTION 2 – „Трансакцията е отказана от издателя“;
//              стр. 56, т. 9.5.1: „Положителни кодове, различни от 00 – те са окончателни“)
//   timeout  – ACTION 3 и RC -40 (стр. 18, т. 4.2) – окончателен неуспех САМО при проверка за статус на трансакция,
//              по-стара от GUARDTIME (проверява се в server/card-pay.ts → applyResult)
//   pending  – всичко останало (други отрицателни RC, ACTION 1 / 7 / 21, непознат отговор): не е плащане и не е доказан неуспех
//   cancelled – ACTION 3 и RC -25 (стр. 49, табл. 23: „Transaction confirmation state was canceled by user – Допълнителното
//              потвърждение на трансакцията е отказано от картодържателя“). Окончателно САМО при проверка за статус след
//              GUARDTIME + 1 мин. (стр. 56, т. 9.5.1: при „Back“ отрицателният код може да се промени и трансакцията да е успешна;
//              „Резултатът, получен след повече от 16 минути … е окончателен“). По-рано – опитът остава отворен.
export type Outcome = "paid" | "declined" | "timeout" | "cancelled" | "pending";
export function outcomeOf(f: Partial<Fields>): Outcome {
  const action = String(f.ACTION ?? ""), rc = String(f.RC ?? "");
  if (action === "0" && rc === "00") return "paid";
  if (action === "2" && /^[0-9A-Z]{2}$/.test(rc) && rc !== "00") return "declined";
  if (action === "3" && rc === "-40") return "timeout";
  if (action === "3" && rc === "-25") return "cancelled";
  return "pending";
}

// Отговорът от формата на BACKREF / JSON от проверката: само текстови полета, с ограничена дължина
export function fieldsOf(o: Iterable<[string, unknown]>): Fields {
  const f: Fields = {};
  for (const [k, v] of o) if (/^[A-Z_.]{2,30}$/.test(k) && typeof v === "string") f[k] = v.slice(0, 1024);
  return f;
}
