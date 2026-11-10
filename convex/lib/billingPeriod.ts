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
