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
import { createPrivateKey, createPublicKey, createSign, createVerify, randomBytes, type KeyObject } from "node:crypto";

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
// PEM може да е подаден с истински нови редове, с „\n“ или като base64 на целия PEM текст (един ред – удобно за Netlify).
export function pemOf(v: string | undefined) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.includes("-----BEGIN")) return s.replace(/\\n/g, "\n");
  try {
    const d = Buffer.from(s, "base64").toString("utf8");
    return d.includes("-----BEGIN") ? d : "";
  } catch {
    return "";
  }
}
// Грешките не съдържат ключа или паролата – само вида на проблема
export function loadPrivateKey(pem: string, passphrase?: string): KeyObject | null {
  try {
    const k = createPrivateKey(passphrase ? { key: pem, format: "pem", passphrase } : { key: pem, format: "pem" });
    return k.asymmetricKeyType === "rsa" && (k.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 ? k : null;
  } catch {
    return null;
  }
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
export type Outcome = "paid" | "declined" | "timeout" | "pending";
export function outcomeOf(f: Partial<Fields>): Outcome {
  const action = String(f.ACTION ?? ""), rc = String(f.RC ?? "");
  if (action === "0" && rc === "00") return "paid";
  if (action === "2" && /^[0-9A-Z]{2}$/.test(rc) && rc !== "00") return "declined";
  if (action === "3" && rc === "-40") return "timeout";
  return "pending";
}

// Отговорът от формата на BACKREF / JSON от проверката: само текстови полета, с ограничена дължина
export function fieldsOf(o: Iterable<[string, unknown]>): Fields {
  const f: Fields = {};
  for (const [k, v] of o) if (/^[A-Z_.]{2,30}$/.test(k) && typeof v === "string") f[k] = v.slice(0, 1024);
  return f;
}
