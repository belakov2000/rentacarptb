// Рекламен източник (UTM) на нова заявка.
// Правило за атрибуция (същото е в браузъра, index.html – „Рекламен източник“):
//  • записва се последното посещение с валидни UTM параметри в рамките на 30 дни преди заявката;
//  • валидно посещение има поне utm_source, utm_medium и utm_campaign; utm_content и utm_term са по избор;
//  • директно посещение без UTM не презаписва запазения източник;
//  • всички параметри са от едно и също посещение (не се смесват), а utmAt е моментът на това посещение;
//  • в браузъра се пази само при съгласие за маркетингови бисквитки – без съгласие заявката е без източник.
// Сървърът не вярва на браузъра: проверява всяка стойност отново, ограничава дължината и отхвърля целия източник,
// ако задължително поле или моментът на посещението са невалидни. Пълният адрес на страницата не се приема и не се пази.
export const ATTRIBUTION_DAYS = 30;
export const UTM_MAX = 100;
// Букви, цифри, интервал и _ . - + ~ | ( ) – без @ (имейли), : / ? & = # (адреси и параметри), кавички и < >
const UTM_RE = /^[\p{L}\p{N} _.\-+~|()]+$/u;
export const UTM_FIELDS = ["source", "medium", "campaign", "content", "term"] as const;
export type Utm = { utmSource: string; utmMedium: string; utmCampaign: string; utmContent: string | null; utmTerm: string | null; utmAt: Date };

export function utmValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= UTM_MAX && UTM_RE.test(s) ? s : null;
}

// Връща проверения източник или null (без източник). now – за тестовете.
export function parseAttribution(a: unknown, now = Date.now()): Utm | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const [source, medium, campaign] = [utmValue(o.source), utmValue(o.medium), utmValue(o.campaign)];
  if (!source || !medium || !campaign) return null;
  const at = typeof o.at === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(o.at) ? Date.parse(o.at) : NaN;
  // Моментът трябва да е в рамките на 30 дни (с 5 мин. толеранс за часовника на устройството)
  if (!Number.isFinite(at) || at > now + 5 * 60_000 || at < now - ATTRIBUTION_DAYS * 864e5) return null;
  return { utmSource: source, utmMedium: medium, utmCampaign: campaign, utmContent: utmValue(o.content), utmTerm: utmValue(o.term), utmAt: new Date(at) };
}

// Имена на рекламните варианти (utm_content) в админ панела
export const VARIANT_LABEL: Record<string, string> = {
  video_a_woman: "Видео А — жена",
  video_b_man: "Видео Б — мъж",
};
export const variantLabel = (content: string | null | undefined) => (content ? VARIANT_LABEL[content.toLowerCase()] || content : "");
