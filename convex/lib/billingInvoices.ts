/**
 * Faturas (`billingInvoices`) espelhadas do Asaas. Pura nos mapeamentos; `upsertInvoiceFromPayment`
 * grava (checkout e webhook usam a mesma função). Valores em centavos; `dueDate` em ms UTC.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type PaymentLite = {
  id: string;
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
  const paidAt = status === "paid" ? (dayToMs(payment.paymentDate) ?? existing?.paidAt ?? now) : existing?.paidAt;
  const fields = {
    status,
    ...(payment.value !== undefined ? { amountCents: Math.round(payment.value * 100) } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(payment.invoiceUrl ? { invoiceUrl: payment.invoiceUrl } : {}),
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
