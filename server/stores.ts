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

export function storeName(name: StoreName, ctx = deployContext()) {
  return isProduction(ctx) ? name : `${ctx.toLowerCase().replace(/[^a-z0-9]/g, "") || "unknown"}-${name}`;
}

export const store = (name: StoreName) => getStore(storeName(name));
