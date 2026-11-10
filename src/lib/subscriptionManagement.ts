/**
 * Regras puras da gestão da assinatura (painel "Uso e fatura"): próxima cobrança,
 * cancelamento, mudança agendada, troca de plano (upgrade/downgrade), reembolso e dados
 * de cobrança. Sem React e sem relógio (o `now` entra por argumento). O servidor é a fonte
 * do que acontece; aqui só se escolhe o texto e quando mostrar cada ação.
 */
import { annualMonthlyBrl, monthlyPriceBrl } from "../../convex/lib/billingMath";
import { PLANS, type PlanKey } from "../../convex/lib/plans";
import { formatDate, formatMoney } from "./format";
import { onlyDigits } from "../../convex/lib/brDocument";

export type SubscriptionCycle = "monthly" | "yearly" | "quarterly";

export interface ScheduledChange {
  plan: PlanKey;
  cycle: SubscriptionCycle;
  effectiveAt: number;
}

/** Assinatura como o front a recebe (`subscription` de getMyEntitlements/getUsageSummary). */
export interface SubscriptionInfo {
  billingCycle: SubscriptionCycle | null;
  paymentStatus: "ok" | "pending" | "overdue" | null;
  hasSubscription: boolean;
  currentPeriodEnd?: number | null;
  nextChargeBrl?: number | null;
  nextChargeAt?: number | null;
  cancelAt?: number | null;
  scheduledChange?: ScheduledChange | null;
  refundEligibleUntil?: number | null;
}

const brl = (v: number) => formatMoney(v);

/** "Próxima cobrança: R$ 497,00 em 20/12/26" (ou `null` sem cobrança futura ou com cancelamento agendado). */
export function nextChargeText(sub: SubscriptionInfo | null | undefined): string | null {
  if (!sub?.hasSubscription || sub.cancelAt) return null;
  if (sub.nextChargeBrl == null || sub.nextChargeAt == null) return null;
  return `Próxima cobrança: ${brl(sub.nextChargeBrl)} em ${formatDate(sub.nextChargeAt)}`;
}

export function cancelScheduledText(sub: SubscriptionInfo | null | undefined): string | null {
  if (!sub?.cancelAt) return null;
  return `Cancelamento agendado para ${formatDate(sub.cancelAt)}. Você usa o plano até lá.`;
}

export function scheduledChangeText(sub: SubscriptionInfo | null | undefined): string | null {
  const c = sub?.scheduledChange;
  if (!c) return null;
  return `Muda para ${PLANS[c.plan].label} em ${formatDate(c.effectiveAt)}.`;
}

/** Cancelar: assinatura ativa ou em atraso, ainda não cancelada, e quem gerencia. */
export function canCancelSubscription(args: {
  mode: string;
  sub: SubscriptionInfo | null | undefined;
  canManage: boolean;
}): boolean {
  return (
    args.canManage &&
    args.sub?.hasSubscription === true &&
    !args.sub.cancelAt &&
    (args.mode === "active" || args.mode === "past_due")
  );
}

/** Reativar: há cancelamento agendado e o período ainda não acabou. */
export function canReactivateSubscription(args: {
  sub: SubscriptionInfo | null | undefined;
  canManage: boolean;
  now: number;
}): boolean {
  const end = args.sub?.cancelAt;
  return args.canManage && end != null && end > args.now;
}

/** Reembolso (7 dias do 1º pagamento) só enquanto a janela está aberta. */
export function canRequestRefund(args: {
  sub: SubscriptionInfo | null | undefined;
  canManage: boolean;
  now: number;
}): boolean {
  const until = args.sub?.refundEligibleUntil;
  return args.canManage && until != null && until > args.now;
}

export function cancelConfirmText(cancelAt: number | null | undefined, periodEnd: number | null | undefined): string {
  const end = cancelAt ?? periodEnd;
  const until = end != null ? `até ${formatDate(end)}` : "até o fim do período pago";
  return `A assinatura não será renovada. Você usa ${until}; depois a conta fica em modo leitura e você pode exportar tudo.`;
}

export function refundConfirmText(amountBrl: number | null | undefined): string {
  const value = amountBrl != null ? ` de ${brl(amountBrl)}` : "";
  return `Reembolso integral${value} em até alguns dias, no mesmo meio de pagamento. A conta passa para modo leitura agora.`;
}

// ── Troca de plano ──────────────────────────────────────────────────────────

export type ChangeKind = "upgrade" | "downgrade" | "same";

function cycleRank(cycle: SubscriptionCycle): number {
  return cycle === "yearly" ? 2 : cycle === "quarterly" ? 1 : 0;
}

/**
 * Upgrade ou downgrade (orientação para o texto; o servidor decide e devolve o `kind`).
 * Plano mais caro = upgrade; mesmo plano, ciclo mais longo = upgrade.
 */
export function planChangeKind(
  current: { plan: PlanKey; cycle: SubscriptionCycle },
  target: { plan: PlanKey; cycle: SubscriptionCycle },
): ChangeKind {
  const a = PLANS[current.plan].monthlyBrl;
  const b = PLANS[target.plan].monthlyBrl;
  if (b !== a) return b > a ? "upgrade" : "downgrade";
  const ca = cycleRank(current.cycle);
  const cb = cycleRank(target.cycle);
  if (cb === ca) return "same";
  return cb > ca ? "upgrade" : "downgrade";
}

export function changeKindLabel(kind: ChangeKind): string {
  return kind === "upgrade" ? "Upgrade" : kind === "downgrade" ? "Downgrade" : "Plano atual";
}

/** Texto do que acontece ao trocar (`chargeBrl` = valor cheio do novo ciclo, do servidor). */
export function changeNotice(
  kind: ChangeKind,
  args: { chargeBrl: number | null; effectiveAt: number | null },
): string | null {
  if (kind === "upgrade") {
    const today = args.chargeBrl != null ? ` ${brl(args.chargeBrl)}` : "";
    return `Você paga${today} hoje e o novo ciclo começa hoje. Os dias restantes do plano atual não são devolvidos.`;
  }
  if (kind === "downgrade") {
    const when = args.effectiveAt != null ? `a partir de ${formatDate(args.effectiveAt)}` : "na próxima renovação";
    return `Vale ${when}; até lá você continua no plano atual.`;
  }
  return null;
}

/** Mensalidade de tabela de um plano no ciclo (anual = equivalente mensal). */
export function planMonthlyForCycle(plan: PlanKey, cycle: SubscriptionCycle): number {
  return cycle === "yearly" ? (annualMonthlyBrl(plan) ?? monthlyPriceBrl(plan)) : monthlyPriceBrl(plan);
}

// ── Dados de cobrança ───────────────────────────────────────────────────────

/** "•••.•••.•••-25" (CPF) ou "••.•••.•••/••••-81" (CNPJ): só os 2 últimos dígitos à mostra. */
export function maskDocument(raw: string | null | undefined): string | null {
  const d = onlyDigits(raw ?? "");
  const last = d.slice(-2);
  if (d.length === 11) return `•••.•••.•••-${last}`;
  if (d.length === 14) return `••.•••.•••/••••-${last}`;
  return d.length >= 2 ? `•••${last}` : null;
}

/** Valor da 1ª fatura paga (a elegível ao reembolso): a de menor `paidAt`. */
export function firstPaidAmountBrl(
  invoices: ReadonlyArray<{ status: string; paidAt: number | null; amountCents: number }> | null | undefined,
): number | null {
  let first: { paidAt: number; amountCents: number } | null = null;
  for (const inv of invoices ?? []) {
    if (inv.status !== "paid" || inv.paidAt == null) continue;
    if (first === null || inv.paidAt < first.paidAt) first = { paidAt: inv.paidAt, amountCents: inv.amountCents };
  }
  return first ? first.amountCents / 100 : null;
}
