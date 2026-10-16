// Плащания по резервации: значение на видовете и сметки за получения приход.
// Всички суми са в евроцентове. Записите не се изтриват и не се променят задно – възстановяването е отделен запис
// (kind = refund) с refundOf към оригиналното плащане, затова по него се вижда какво точно е върнато.
//
// Видове (kind):
//   deposit  – аванс по наема (част от цената на наема)                       → приход
//   partial  – частично плащане по наема                                      → приход
//   final    – окончателно плащане по наема                                   → приход
//   extra    – допълнителни услуги и такси (доставка, столче, километри и др.) → приход
//   security – гаранционен депозит (напр. 100 €), връща се на клиента          → НЕ е приход
//   refund   – възстановяване; отнася се към вида на оригиналното плащане: връщане на гаранционен депозит
//              намалява само държания депозит, а връщане на плащане по наема намалява прихода
// Статус: expected (очаквано) | received (получено; за refund – върнато) | failed (неуспешно).
// „refunded“ е от по-старата схема: плащането е било получено (връщането е отделен запис) – брои се като получено.
// Приход е само реално получено плащане (статус received и дата на плащане). Потвърдена заявка, офертната цена
// (bookings.total) или предаден автомобил сами по себе си не са приход.
export const KINDS = ["deposit", "partial", "final", "extra", "security", "refund"] as const;
export const REVENUE_KINDS: readonly string[] = ["deposit", "partial", "final", "extra"];
export const METHODS = ["cash", "bank", "card", "other"] as const;
export const KIND_BG: Record<string, string> = {
  deposit: "Аванс по наема",
  partial: "Частично плащане по наема",
  final: "Окончателно плащане по наема",
  extra: "Допълнителни услуги / такси",
  security: "Гаранционен депозит (не е приход)",
  refund: "Възстановяване",
};
export const METHOD_BG: Record<string, string> = { cash: "В брой", bank: "По банков път", card: "С карта", other: "Друго" };
export const PAY_STATUS_BG: Record<string, string> = { expected: "Очаквано", received: "Получено", failed: "Неуспешно", refunded: "Получено (възстановено)" };

export type Pay = {
  id: string; bookingId: string; amountCents: number; currency: string; kind: string; status: string; paidAt: Date | string | null; refundOf: string | null;
};
const isReceived = (p: Pay) => (p.status === "received" || p.status === "refunded") && !!p.paidAt;
const before = (p: Pay, until?: Date) => !until || new Date(p.paidAt as any).getTime() <= until.getTime();

export type Summary = {
  rentalReceived: number; rentalRefunded: number; rentalNet: number;
  securityReceived: number; securityRefunded: number; securityHeld: number;
  expected: number; nonEur: number;
};
// Обобщение за една резервация (или за всички подадени плащания). until – отчитат се само плащания с дата до този момент.
export function summarize(list: Pay[], until?: Date): Summary {
  const byId = new Map(list.map((p) => [p.id, p]));
  const s: Summary = { rentalReceived: 0, rentalRefunded: 0, rentalNet: 0, securityReceived: 0, securityRefunded: 0, securityHeld: 0, expected: 0, nonEur: 0 };
  for (const p of list) {
    if (p.currency !== "EUR") { s.nonEur++; continue; }
    if (p.status === "expected") { if (p.kind !== "refund") s.expected += p.amountCents; continue; }
    if (!isReceived(p) || !before(p, until)) continue;
    if (p.kind === "refund") {
      const o = p.refundOf ? byId.get(p.refundOf) : undefined;
      if (!o) continue; // възстановяване без оригинал не се отчита (API-то не позволява такова)
      if (o.kind === "security") s.securityRefunded += p.amountCents;
      else if (REVENUE_KINDS.includes(o.kind)) s.rentalRefunded += p.amountCents;
    } else if (p.kind === "security") s.securityReceived += p.amountCents;
    else if (REVENUE_KINDS.includes(p.kind)) s.rentalReceived += p.amountCents;
  }
  s.rentalNet = s.rentalReceived - s.rentalRefunded;
  s.securityHeld = s.securityReceived - s.securityRefunded;
  return s;
}

// Колко още може да бъде възстановено по едно плащане (вече върнатите и очакваните възстановявания се изваждат)
export function refundableLeft(original: Pay, list: Pay[]) {
  if (original.kind === "refund" || !isReceived(original)) return 0;
  const done = list.filter((p) => p.kind === "refund" && p.refundOf === original.id && p.status !== "failed").reduce((a, p) => a + p.amountCents, 0);
  return Math.max(0, original.amountCents - done);
}

// ===== Финансово състояние на една резервация (за детайлите в панела) =====
// agreedCents – договорената сума (bookings.totalCents; при удължаване – новата обща сума). null / totalReview – не е определена.
// balance – остатък за плащане (> 0) или надплащане (< 0) по наема спрямо нетно полученото. Определя се само за потвърдена
// резервация с определена сума. За отменени, отказани и неявили се резервации договорената цена НЕ се представя като дълг:
// задължението (неустойка, връщане на аванс) се уточнява от администратора → „review“. Нищо тук не създава плащания.
export type BalanceState = "due" | "paid" | "overpaid" | "review" | "not_due";
export function finance(b: { status: string; totalCents: number | null; totalReview: string }, list: Pay[]) {
  const s = summarize(list);
  const agreedCents = b.totalCents != null && !b.totalReview ? b.totalCents : null;
  let state: BalanceState, balanceCents: number | null = null;
  if (b.status === "confirmed") {
    if (agreedCents == null) state = "review";
    else {
      balanceCents = agreedCents - s.rentalNet;
      state = balanceCents > 0 ? "due" : balanceCents < 0 ? "overpaid" : "paid";
    }
  } else if (b.status === "pending" || b.status === "rejected") state = s.rentalNet || s.securityHeld ? "review" : "not_due";
  else state = "review"; // cancelled | no_show
  return { ...s, agreedCents, balanceCents, balanceState: state };
}
