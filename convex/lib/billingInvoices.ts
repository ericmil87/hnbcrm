/**
 * Faturas (`billingInvoices`) espelhadas do Asaas. Pura nos mapeamentos; `upsertInvoiceFromPayment`
 * grava (checkout e webhook usam a mesma função). Valores em centavos; `dueDate` em ms UTC.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type PaymentLite = {
  id: string;
  subscription?: string | null;
  status?: string;
  value?: number;
  dueDate?: string;
  invoiceUrl?: string | null;
  billingType?: string;
  paymentDate?: string | null;
  description?: string | null;
  deleted?: boolean;
};

export type InvoiceStatus = Doc<"billingInvoices">["status"];

/** Status do Asaas -> status da fatura. */
export function invoiceStatusOf(payment: Pick<PaymentLite, "status" | "deleted">): InvoiceStatus {
  if (payment.deleted) return "canceled";
  switch (payment.status) {
    case "CONFIRMED":
    case "RECEIVED":
    case "RECEIVED_IN_CASH":
      return "paid";
    case "OVERDUE":
      return "overdue";
    case "REFUNDED":
    case "REFUND_REQUESTED":
    case "REFUND_IN_PROGRESS":
      return "refunded";
    default:
      return "pending";
  }
}

/** A cobrança está paga (CONFIRMED/RECEIVED)? Cartão confirma antes de receber: os dois liberam. */
export function isPaidStatus(status: string | undefined): boolean {
  return status === "CONFIRMED" || status === "RECEIVED" || status === "RECEIVED_IN_CASH";
}

export function paymentMethodOf(billingType: string | undefined): Doc<"billingInvoices">["paymentMethod"] {
  switch (billingType) {
    case "PIX":
      return "pix";
    case "BOLETO":
      return "boleto";
    case "CREDIT_CARD":
    case "DEBIT_CARD":
      return "card";
    default:
      return undefined;
  }
}

/** "2026-12-05" -> ms (meia-noite UTC); inválido -> undefined. */
export function dayToMs(day: string | null | undefined): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? "");
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : undefined;
}

/** Cria ou atualiza a fatura de um pagamento do Asaas (idempotente por `providerPaymentId`). */
export async function upsertInvoiceFromPayment(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; payment: PaymentLite; now: number }
): Promise<Id<"billingInvoices">> {
  const { payment, now } = args;
  const status = invoiceStatusOf(payment);
  const dueDate = dayToMs(payment.dueDate);
  const existing = await ctx.db
    .query("billingInvoices")
    .withIndex("by_provider_payment_id", (q) => q.eq("providerPaymentId", payment.id))
    .first();
  if (existing && existing.organizationId !== args.organizationId) {
    // Nunca mexe em fatura de outra org (id de pagamento repetido por engano/ataque).
    return existing._id;
  }
  // `paidAt`: o INSTANTE em que processamos o pagamento (o Asaas só manda o dia; o reembolso de 7 dias
  // conta 168 h reais). Evento antigo (reconciliação) usa o dia informado.
  const paymentDay = dayToMs(payment.paymentDate);
  const paidAt =
    status === "paid"
      ? (existing?.paidAt ?? (paymentDay !== undefined && now - paymentDay > 2 * 86_400_000 ? paymentDay + 12 * 3_600_000 : now))
      : existing?.paidAt;
  const fields = {
    status,
    ...(payment.value !== undefined ? { amountCents: Math.round(payment.value * 100) } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(payment.invoiceUrl ? { invoiceUrl: payment.invoiceUrl } : {}),
    ...(payment.subscription ? { providerSubscriptionId: payment.subscription } : {}),
    ...(payment.description ? { description: payment.description.slice(0, 200) } : {}),
    ...(paymentMethodOf(payment.billingType) ? { paymentMethod: paymentMethodOf(payment.billingType) } : {}),
    ...(paidAt !== undefined ? { paidAt } : {}),
    updatedAt: now,
  };
  if (existing) {
    await ctx.db.patch(existing._id, fields);
    return existing._id;
  }
  return await ctx.db.insert("billingInvoices", {
    organizationId: args.organizationId,
    source: "asaas",
    kind: "subscription",
    description: payment.description?.slice(0, 200) ?? "Assinatura HNBCRM",
    amountCents: Math.round((payment.value ?? 0) * 100),
    dueDate: dueDate ?? now,
    providerPaymentId: payment.id,
    createdBy: "system",
    createdAt: now,
    ...fields,
  });
}

/**
 * Cancelamento LOCAL de uma assinatura (checkout refeito, troca de plano, cancelamento,
 * reembolso): as faturas abertas dela (pending/overdue) viram `canceled` na hora, sem esperar o
 * webhook. Lê até 200 faturas da org (poucas por org).
 */
export async function cancelOpenInvoicesForSubscription(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  providerSubscriptionId: string,
  now: number
): Promise<number> {
  const rows = await ctx.db
    .query("billingInvoices")
    .withIndex("by_organization_and_due_date", (q) => q.eq("organizationId", organizationId))
    .order("desc")
    .take(200);
  let canceled = 0;
  for (const row of rows) {
    if (row.providerSubscriptionId !== providerSubscriptionId) continue;
    if (row.status !== "pending" && row.status !== "overdue") continue;
    await ctx.db.patch(row._id, { status: "canceled", updatedAt: now });
    canceled++;
  }
  return canceled;
}
