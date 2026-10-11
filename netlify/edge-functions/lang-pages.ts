import type { Config, Context } from "@netlify/edge-functions";

// /en/ и /de/ – същата страница (index.html), но със заглавие, описание, canonical и lang за съответния език.
// Съдържанието се превежда от скрипта в страницата според адреса.
const SITE = "https://rentacar-ptb.com";

const PAGES: Record<string, { lang: string; locale: string; title: string; description: string; social: string; imageAlt: string }> = {
  en: {
    lang: "en",
    locale: "en_GB",
    title: "Rent a Car Plovdiv from €15 per day | Renta PTB Stroy",
    description:
      "Car rental in Plovdiv from €15 per day. Delivery to Plovdiv Airport and to any address in Bulgaria, unlimited mileage for rentals over 2 days, €100 deposit. Book online.",
    social:
      "Serviced cars, delivery to Plovdiv Airport and across Bulgaria, unlimited mileage for rentals over 2 days and a €100 deposit.",
    imageAlt: "Renta PTB Stroy – car rental in Plovdiv",
  },
  de: {
    lang: "de",
    locale: "de_DE",
    title: "Mietwagen in Plowdiw (Plovdiv) ab 15 € pro Tag | Renta PTB Stroy",
    description:
      "Autovermietung in Plowdiw ab 15 € pro Tag. Lieferung zum Flughafen Plowdiw und an jede Adresse in Bulgarien, unbegrenzte Kilometer ab 2 Tagen Miete, 100 € Kaution. Online buchen.",
    social:
      "Gewartete Fahrzeuge, Lieferung zum Flughafen Plowdiw und in ganz Bulgarien, unbegrenzte Kilometer ab 2 Tagen Miete und 100 € Kaution.",
    imageAlt: "Renta PTB Stroy – Autovermietung in Plowdiw",
  },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export default async (req: Request, context: Context) => {
  const key = new URL(req.url).pathname.split("/")[1];
  const page = PAGES[key];
  if (!page) return;

  let res = await context.next();
  if (!res.ok) res = await fetch(new URL("/", req.url));
  if (!res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return res;

  const url = `${SITE}/${key}/`;
  const others = ["bg_BG", "en_GB", "de_DE"].filter((l) => l !== page.locale);
  const head = [
    `<title>${esc(page.title)}</title>`,
    `<meta name="description" content="${esc(page.description)}">`,
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:locale" content="${page.locale}">`,
    ...others.map((l) => `<meta property="og:locale:alternate" content="${l}">`),
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${esc(page.title)}">`,
    `<meta property="og:description" content="${esc(page.social)}">`,
    `<meta property="og:image:alt" content="${esc(page.imageAlt)}">`,
    `<meta name="twitter:title" content="${esc(page.title)}">`,
    `<meta name="twitter:description" content="${esc(page.social)}">`,
  ].join("\n");

  const html = (await res.text())
    .replace('<html lang="bg">', `<html lang="${page.lang}">`)
    .replace(/<!--seo-->[\s\S]*?<!--\/seo-->/, `<!--seo-->\n${head}\n<!--/seo-->`);

  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("etag");
  headers.set("content-type", "text/html; charset=UTF-8");
  return new Response(html, { status: 200, headers });
};

export const config: Config = {
  path: ["/en/", "/de/"],
};
