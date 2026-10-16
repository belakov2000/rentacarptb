// Снимки на документите към резервацията (хранилище documents, виж netlify/functions/documents.mts).
// Снимките на документите, качени от формата (/api/documents), са в текста на заявката („СНИМКИ НА ДОКУМЕНТИТЕ“).
// Записват се само ключовете от същия сайт – за отваряне от админ панела след вход. Без снимки – null.
export function documentsOf(message: string, origin: string) {
  const i = message.lastIndexOf("СНИМКИ НА ДОКУМЕНТИТЕ");
  if (i < 0) return null;
  const out: { label: string; id: string }[] = [];
  for (const line of message.slice(i).split("\n").slice(1)) {
    const m = /^(.{1,80}?):\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    let u: URL;
    try { u = new URL(m[2]); } catch { continue; }
    const id = /^\/api\/documents\/([a-f0-9]{64})$/.exec(u.pathname)?.[1];
    if (id && u.origin === origin && out.length < 8) out.push({ label: m[1].trim(), id });
  }
  return out.length ? out : null;
}
