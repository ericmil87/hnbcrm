/**
 * Reembolso automático (direito de arrependimento): só a PRIMEIRA fatura paga da org, até 7 dias
 * (168 h) depois do pagamento, uma única vez. Puro: quem lê as faturas é o chamador.
 */
export const REFUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type RefundInvoiceLite = {
  _id: string;
  status: "pending" | "paid" | "overdue" | "canceled" | "refunded";
  paidAt?: number;
  providerPaymentId?: string;
  kind: string;
};

/** Primeira fatura de assinatura efetivamente paga (paga ou já estornada), a mais antiga por `paidAt`. */
export function firstPaidInvoice<T extends RefundInvoiceLite>(invoices: T[]): T | null {
  let first: T | null = null;
  for (const inv of invoices) {
    if (inv.kind !== "subscription") continue;
    if (inv.status !== "paid" && inv.status !== "refunded") continue;
    if (inv.paidAt === undefined) continue;
    if (!first || inv.paidAt < (first.paidAt as number)) first = inv;
  }
  return first;
}

export type RefundCheck =
  | { eligible: true; invoice: RefundInvoiceLite; until: number }
  | { eligible: false; reason: "already_refunded" | "no_payment" | "not_first" | "expired" | "not_active" };

/** Elegibilidade do reembolso. `candidateId` (opcional) é a fatura que o cliente quer reembolsar. */
export function checkRefund(args: {
  invoices: RefundInvoiceLite[];
  candidateId?: string;
  refundedAt?: number;
  orgStatus: string;
  hasProviderSubscription: boolean;
  now: number;
}): RefundCheck {
  if (args.refundedAt !== undefined) return { eligible: false, reason: "already_refunded" };
  if (args.orgStatus !== "active" && args.orgStatus !== "past_due") return { eligible: false, reason: "not_active" };
  if (!args.hasProviderSubscription) return { eligible: false, reason: "not_active" };
  const first = firstPaidInvoice(args.invoices);
  if (!first || first.status !== "paid" || !first.providerPaymentId) return { eligible: false, reason: "no_payment" };
  if (args.candidateId !== undefined && args.candidateId !== first._id) return { eligible: false, reason: "not_first" };
  const until = (first.paidAt as number) + REFUND_WINDOW_MS;
  if (args.now > until) return { eligible: false, reason: "expired" };
  return { eligible: true, invoice: first, until };
}

export const REFUND_REFUSED_MESSAGE =
  "O reembolso automático vale até 7 dias após o primeiro pagamento. Fale com a gente: contato@hnbcrm.com";
