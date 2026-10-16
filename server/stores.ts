import { getStore } from "@netlify/blobs";

// Хранилища на Netlify Blobs по среда.
// Blobs (за разлика от базата) са общи за всички deploy-ове на сайта, затова извън продукция всяка функция
// ползва отделни хранилища с префикс (напр. „deploypreview-contracts“). Продукционните файлове не се четат и не се променят.
// Средата идва от Netlify на сървъра (context.deploy.context), а не от адреса, заглавки или браузъра.
// При неизвестна среда се избира изолирано хранилище – по-безопасно е да липсва файл, отколкото да се промени продукционен.
export type StoreName = "contracts" | "documents" | "backups" | "mail-outbox";

export function deployContext(): string {
  const c = (globalThis as any).Netlify?.context?.deploy?.context;
  return typeof c === "string" && c ? c : "unknown";
}

export const isProduction = (ctx = deployContext()) => ctx === "production";

// Вид на средата за админ панела. Само стойностите, които Netlify подава на сървъра, са доказателство:
// „production“ – реалният сайт; deploy-preview, branch-deploy и dev (netlify dev) – тестова версия.
// Всичко друго (липсващ или непознат контекст) е „unknown“ – тогава панелът не твърди, че данните са тестови или изолирани.
// Файловете в Blobs при unknown отиват в отделни хранилища с префикс „unknown-“ (както досега), а базата
// се избира от платформата чрез връзката на конкретния deploy – кодът не я пренасочва.
export type EnvKind = "production" | "preview" | "unknown";
const PREVIEW_CONTEXTS = ["deploy-preview", "branch-deploy", "dev"];
export function envKind(ctx = deployContext()): EnvKind {
  return ctx === "production" ? "production" : PREVIEW_CONTEXTS.includes(ctx) ? "preview" : "unknown";
}
export const envInfo = (ctx = deployContext()) => ({ env: ctx, envKind: envKind(ctx), production: isProduction(ctx) });

export function storeName(name: StoreName, ctx = deployContext()) {
  return isProduction(ctx) ? name : `${ctx.toLowerCase().replace(/[^a-z0-9]/g, "") || "unknown"}-${name}`;
}

// strong: четене и списък веднага след запис (за архивирането и проверката му). По подразбиране Netlify Blobs е eventual –
// новозаписан ключ може да липсва от list() до около минута, затова проверката веднага след „Направи копие сега“
// показваше 0 копия при реално копирани файлове.
export const store = (name: StoreName, o: { strong?: boolean } = {}) =>
  o.strong ? getStore({ name: storeName(name), consistency: "strong" }) : getStore(storeName(name));
