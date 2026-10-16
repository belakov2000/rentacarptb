import { deployContext } from "../server/stores.js";
// Общи помощни функции за имейлите (Brevo) – ползват се от резервациите и от автоматичните напомняния.
export const OWNER_EMAIL = process.env.BOOKING_OWNER_EMAIL || "rentaptb_stroi@abv.bg";
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || OWNER_EMAIL;
const SENDER_NAME = "Rent a Car PTB";
export const PHONE = "+359877748693";

export const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Текстова версия на писмото – пощенските услуги (Gmail, Abv и др.) гледат по-благосклонно на писма, които имат и HTML, и текст
const toText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|tr|div|pre|h\d|li)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, "$2: $1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export type Attachment = { name: string; content: string }; // content – base64
// Извън продукция (Deploy Preview, branch deploy, dev, неизвестна среда) писма НЕ се изпращат: BREVO_API_KEY е зададен за
// всички среди и без тази проверка тестова заявка в Preview би стигнала до реалната поща на фирмата и до клиента.
// Писмото се записва в email_log като неуспешно (с причината), а сайтът показва резервното известие както при грешка.
// Изрично разрешаване (само за тестова среда с подменена поща): MAIL_OUTSIDE_PRODUCTION=1.
export const mailAllowed = () => deployContext() === "production" || process.env.MAIL_OUTSIDE_PRODUCTION === "1";
export async function sendMail(to: string, toName: string, subject: string, html: string, replyTo?: string, attachment?: Attachment[], lang = "bg", preheader = "") {
  if (!mailAllowed()) throw new Error(`Mail is disabled outside production (${deployContext()})`);
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error("BREVO_API_KEY is not set");
  // Мрежова грешка или изтекло време: Brevo може вече да е приел писмото, без отговорът да стигне до нас.
  // Такава грешка се отбелязва с uncertain = true – server/email.ts не я повтаря като обикновена грешка (риск от дублиране).
  let r: Response;
  try {
    r = await fetch("https://api.brevo.com/v3/smtp/email", {
    signal: AbortSignal.timeout(20_000),
    method: "POST",
    headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      to: [{ email: to, name: toName || to }],
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
      subject,
      // Пълен HTML документ с език и кратък текст за прегледа в пощата – писмата изглеждат като лична кореспонденция, не като бюлетин
      htmlContent: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head><body style="margin:0;padding:16px;background:#fff">${preheader ? `<div style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</div>` : ""}${html}</body></html>`,
      textContent: toText(html),
      // Транзакционно писмо (отговор на заявка на клиента) – уникална референция, за да не се групира с други писма в една нишка
      headers: { "X-Entity-Ref-ID": crypto.randomUUID(), "X-Auto-Response-Suppress": "OOF, AutoReply" },
      ...(attachment?.length ? { attachment } : {}),
    }),
  });
  } catch (e) {
    throw Object.assign(new Error(`Brevo network error: ${(e as Error)?.name || ""} ${(e as Error)?.message || e}`), { uncertain: true });
  }
  // Отговор с код за грешка – Brevo не е приел писмото
  if (!r.ok) throw new Error(`Brevo error ${r.status}: ${await r.text()}`);
}

export const btn = (href: string, label: string, bg: string, fg = "#fff") =>
  `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:${fg};padding:14px 26px;border-radius:999px;font-weight:700;text-decoration:none;margin:4px 8px 4px 0">${esc(label)}</a>`;
export const wrapMail = (body: string) =>
  `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0f1b2d;max-width:600px">${body}</div>`;
export const mailRow = (k: string, v: string) =>
  v ? `<tr><td style="padding:4px 14px 4px 0;color:#5b6577">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>` : "";
export const mailFooter = (why: string) =>
  `<p style="color:#5b6577;font-size:13px;border-top:1px solid #e6e9ef;padding-top:12px">${esc(why)}<br>Рента ПТБ Строй ЕООД · гр. Пловдив, бул. Дунав 10 · ${PHONE} · <a href="https://rentacar-ptb.com" style="color:#5b6577">rentacar-ptb.com</a></p>`;
