// Суми в евроцентове (цели числа). Приема само точния формат на сайта: „261 €“ или „829,47 €“ –
// същото правило като миграцията backfill_total_cents_seed_cars. При друг формат връща null (сумата се проверява ръчно).
const TOTAL_RE = /^(\d{1,6})(?:,(\d{2}))? €$/;

export function parseTotalCents(total: string): number | null {
  const m = TOTAL_RE.exec(total);
  return m ? Number(m[1]) * 100 + Number(m[2] || 0) : null;
}

export const totalReviewOf = (total: string) => (parseTotalCents(total) != null ? "" : total.trim() ? "unparsed" : "empty");

export const euros = (cents: number) => (cents / 100).toFixed(2).replace(".", ",") + " €";

// Сума, въведена от администратора: „120“, „120,50“ или „120.50“ (без знак, до 999 999,99) → евроцентове; иначе null
export function parseAmountCents(v: unknown): number | null {
  const m = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(String(v ?? "").trim().replace(/\s*€$/, ""));
  return m ? Number(m[1]) * 100 + Number((m[2] || "0").padEnd(2, "0")) : null;
}
