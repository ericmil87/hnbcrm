/**
 * Fim do ciclo pago (puro). Regra única: vencimento (`dueDate`) da ÚLTIMA fatura paga + 1 ciclo.
 * Não usa o `nextDueDate` da assinatura do Asaas, que pode já apontar para o ciclo seguinte (cobrança
 * gerada com antecedência). Datas em ms, meia-noite UTC (como `billingInvoices.dueDate`).
 */
export type PeriodCycle = "monthly" | "yearly" | "quarterly" | null | undefined;

const MONTHS: Record<"monthly" | "yearly" | "quarterly", number> = { monthly: 1, quarterly: 3, yearly: 12 };

/** Soma meses em UTC mantendo o dia, limitado ao último dia do mês de destino (31/01 + 1 = 28/02). */
export function addMonthsUtc(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, last));
}

/** `dueDate` da última fatura paga + 1 ciclo. Ciclo ausente conta como mensal. */
export function periodEndAfter(lastPaidDueDate: number, cycle: PeriodCycle): number {
  return addMonthsUtc(lastPaidDueDate, MONTHS[cycle ?? "monthly"]);
}

type PeriodInvoice = {
  kind: string;
  status: string;
  dueDate: number;
  amountCents: number;
  providerSubscriptionId?: string;
};

/**
 * Última fatura de assinatura PAGA da assinatura atual (maior vencimento). Faturas antigas sem o id
 * da assinatura contam; as de OUTRA assinatura (antes de um upgrade) não.
 */
export function lastPaidSubscriptionInvoice<T extends PeriodInvoice>(
  invoices: readonly T[],
  subscriptionIds: ReadonlyArray<string | undefined>
): T | null {
  const ids = subscriptionIds.filter((i): i is string => i !== undefined);
  let last: T | null = null;
  for (const inv of invoices) {
    if (inv.kind !== "subscription" || inv.status !== "paid") continue;
    if (inv.providerSubscriptionId !== undefined && !ids.includes(inv.providerSubscriptionId)) continue;
    if (!last || inv.dueDate > last.dueDate) last = inv;
  }
  return last;
}

/**
 * Período atual da assinatura. `currentPeriodEnd` gravado vale; se ausente (org que pagou antes de o
 * app gravá-lo), calcula pela MESMA regra: vencimento da última fatura paga + 1 ciclo (e o início é
 * esse vencimento). `lastPaid` serve também de fonte do valor da próxima cobrança.
 */
export function resolvePeriod<T extends PeriodInvoice>(args: {
  currentPeriodEnd?: number;
  cycle: PeriodCycle;
  invoices: readonly T[];
  subscriptionIds: ReadonlyArray<string | undefined>;
}): { periodStart: number | null; periodEnd: number | null; lastPaid: T | null } {
  const lastPaid = lastPaidSubscriptionInvoice(args.invoices, args.subscriptionIds);
  if (args.currentPeriodEnd !== undefined) {
    return { periodStart: lastPaid?.dueDate ?? null, periodEnd: args.currentPeriodEnd, lastPaid };
  }
  if (!lastPaid) return { periodStart: null, periodEnd: null, lastPaid: null };
  return { periodStart: lastPaid.dueDate, periodEnd: periodEndAfter(lastPaid.dueDate, args.cycle), lastPaid };
}
