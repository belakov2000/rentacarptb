// HTML страници за плащането с карта (страницата от връзката в имейла и страницата след връщане от БОРИКА).
// Без външни ресурси; CSP разрешава изпращане на формуляр само към сайта и към адресите на БОРИКА (server/borica.ts → GATEWAY).
import { breakdownRows, ct, langOf, type Breakdown } from "../mail/card.js";
import { esc, PHONE } from "../mail/index.js";
import { GATEWAY } from "./borica.js";

export const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  // Връзката съдържа таен ключ – не се изпраща като Referer към БОРИКА или други сайтове (same-origin: само към този сайт).
  // „no-referrer“ не става: тогава браузърът праща Origin: null при изпращането на формуляра и защитата от CSRF го отказва.
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; form-action 'self' ${new URL(GATEWAY.test).origin} ${new URL(GATEWAY.live).origin}; base-uri 'none'; frame-ancestors 'none'`,
};

const CSS = `body{font-family:Arial,sans-serif;background:#f3f5f9;color:#0f1b2d;margin:0;padding:16px}main{max-width:560px;margin:0 auto;background:#fff;border-radius:22px;padding:22px}h1{font-size:1.4rem;margin:0 0 12px}
table{width:100%;border-collapse:collapse;margin:12px 0}td{padding:8px 0;border-bottom:1px solid #e6e9ef;vertical-align:top}td+td{text-align:right;white-space:nowrap;padding-left:12px}td small{color:#5b6577}tr.sum td{font-size:1.1rem;font-weight:700;border-bottom:0}
.hint{color:#5b6577;font-size:.9rem}.box{border-radius:14px;padding:12px 14px;margin:12px 0}.ok{background:#d9f5e3;color:#11643a}.bad{background:#fde2e0;color:#9b1c13}.warn{background:#fff4cc}.test{background:#0f1b2d;color:#fff;font-weight:700}
label{display:block;font-weight:700;margin:14px 0 6px;font-size:.9rem}input{width:100%;box-sizing:border-box;font:inherit;padding:12px;border:1px solid #cdd3dd;border-radius:12px}
button,.btn{display:block;box-sizing:border-box;text-align:center;text-decoration:none;font:inherit;font-weight:700;border:0;border-radius:999px;padding:15px 22px;cursor:pointer;width:100%;margin-top:14px;background:#1a8f4c;color:#fff}.btn.dark{background:#0f1b2d}`;

export function html(lang: string, title: string, body: string, status = 200) {
  return new Response(`<!doctype html><html lang="${langOf(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`, { status, headers: HEADERS });
}
export const t = (lang: string, k: string, v: Record<string, string> = {}) => ct(lang, k, { phone: PHONE, ...v });
export const msg = (lang: string, cls: string, h: string, info: string) => `<div class="box ${cls}"><b>${esc(t(lang, h))}</b></div><p>${esc(t(lang, info))}</p>`;
export const testBanner = (lang: string, mode: string | null) => (mode === "test" ? `<div class="box test">${esc(t(lang, "test"))}</div>` : "");

export function breakdownTable(bd: Breakdown, lang: string) {
  const rows = breakdownRows(bd, lang);
  return `<table>${rows.map(([k, v, n], i) => `<tr${i === rows.length - 1 ? ' class="sum"' : ""}><td>${esc(k)}${n ? `<br><small>${esc(n)}</small>` : ""}</td><td>${esc(v)}</td></tr>`).join("")}</table>
<p class="hint">${esc(t(lang, "deposit", { dep: (bd.depositCents / 100).toFixed(2).replace(".", ",").replace(/,00$/, "") + " €" }))}</p>`;
}
export const sofiaTime = (d: Date, lang: string) => d.toLocaleString(langOf(lang) === "bg" ? "bg-BG" : langOf(lang) === "de" ? "de-DE" : "en-GB", { timeZone: "Europe/Sofia", dateStyle: "short", timeStyle: "short" });

// Автоматично изпращане на подписания формуляр към БОРИКА (с бутон, ако скриптовете са спрени)
export function redirectForm(lang: string, action: string, fields: Record<string, string>) {
  const inputs = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return html(lang, t(lang, "title"), `<h1>${esc(t(lang, "title"))}</h1><p>${esc(t(lang, "goBank"))}</p><form id="borica" method="post" action="${esc(action)}" accept-charset="UTF-8">${inputs}<button>${esc(t(lang, "goBankBtn"))}</button></form><p class="hint">${esc(t(lang, "noScript"))}</p><script>document.getElementById("borica").submit()</script>`);
}
