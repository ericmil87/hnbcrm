/**
 * Regras puras do checkout de assinatura (painel "Uso e fatura"). A validação aqui só
 * evita ida e volta: o servidor valida tudo de novo e calcula o preço (a fonte é ele).
 */
import { isValidCpfCnpj, onlyDigits } from "../../convex/lib/brDocument";
import { hasEmailShape, normalizeEmail } from "../../convex/lib/emailAddress";
import { priceCheckout, CHECKOUT_PLANS, type CheckoutCycle, type CheckoutPlan } from "../../convex/lib/checkoutPricing";
import { ANNUAL_MONTHS_CHARGED } from "../../convex/lib/plans";
import type { PriceLock } from "../../convex/lib/billingMath";

export { CHECKOUT_PLANS };
export type { CheckoutCycle, CheckoutPlan };

export interface CheckoutForm {
  plan: CheckoutPlan;
  cycle: CheckoutCycle;
  groupsAddon: boolean;
  billingName: string;
  document: string;
  billingEmail: string;
}

export type CheckoutErrors = Partial<Record<"billingName" | "document" | "billingEmail" | "groupsAddon", string>>;

export const EMPTY_CHECKOUT_FORM: CheckoutForm = {
  plan: "profissional",
  cycle: "monthly",
  groupsAddon: false,
  billingName: "",
  document: "",
  billingEmail: "",
};

/** CPF "000.000.000-00" até 11 dígitos; acima disso CNPJ "00.000.000/0000-00" (máx. 14). */
export function formatCpfCnpj(raw: string): string {
  const d = onlyDigits(raw).slice(0, 14);
  if (d.length <= 11) {
    return d
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, "$1.$2.$3-$4");
  }
  return d
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})(\d)/, "$1.$2.$3/$4")
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})(\d)/, "$1.$2.$3/$4-$5");
}

export function validateCheckoutForm(form: CheckoutForm): CheckoutErrors {
  const errors: CheckoutErrors = {};
  const name = form.billingName.trim();
  if (name.length < 2 || name.length > 120) errors.billingName = "Informe o nome ou a razão social (2 a 120 caracteres).";
  if (!isValidCpfCnpj(form.document)) errors.document = "CPF ou CNPJ inválido. Confira os números.";
  if (!hasEmailShape(form.billingEmail)) errors.billingEmail = "Informe um e-mail financeiro válido.";
  if (form.groupsAddon && form.plan !== "essencial") errors.groupsAddon = "O add-on Grupos existe só no plano Essencial.";
  return errors;
}

export function isCheckoutReady(form: CheckoutForm): boolean {
  return Object.keys(validateCheckoutForm(form)).length === 0;
}

/** Dados prontos para `startCheckout` (documento só com dígitos, e-mail normalizado). */
export function toCheckoutArgs(form: CheckoutForm) {
  return {
    plan: form.plan,
    cycle: form.cycle,
    groupsAddon: form.plan === "essencial" && form.groupsAddon ? true : undefined,
    billingName: form.billingName.trim(),
    document: onlyDigits(form.document),
    billingEmail: normalizeEmail(form.billingEmail),
  };
}

export interface CheckoutSummary {
  /** Mensalidade (com preço combinado, se houver). */
  monthlyBrl: number;
  listMonthlyBrl: number;
  /** Valor de cada cobrança: a mensalidade, ou 10 mensalidades no anual. */
  chargeBrl: number;
  /** Anual: meses pagos e meses de graça, para o texto "2 meses grátis". */
  yearly: { paidMonths: number; freeMonths: number } | null;
  lockApplied: boolean;
}

/** Estimativa pelo catálogo (o servidor recalcula; canais extra gravados na org não entram aqui). */
export function checkoutSummary(args: {
  plan: CheckoutPlan;
  cycle: CheckoutCycle;
  groupsAddon: boolean;
  priceLock?: PriceLock | null;
  now: number;
}): CheckoutSummary | null {
  const r = priceCheckout({
    plan: args.plan,
    cycle: args.cycle,
    groupsAddon: args.groupsAddon && args.plan === "essencial",
    billing: { extraChannels: undefined, priceLock: args.priceLock ?? undefined },
    now: args.now,
  });
  if (!r.ok) return null;
  return {
    monthlyBrl: r.price.monthlyBrl,
    listMonthlyBrl: r.price.listMonthlyBrl,
    chargeBrl: r.price.chargeBrl,
    yearly:
      args.cycle === "yearly"
        ? { paidMonths: ANNUAL_MONTHS_CHARGED, freeMonths: 12 - ANNUAL_MONTHS_CHARGED }
        : null,
    lockApplied: r.price.lockApplied,
  };
}

export interface SummaryLine {
  id: string;
  label: string;
  /** Valor mensal da linha (a cobrança do ciclo é a soma × meses cobrados). */
  amountBrl: number;
}

/** Forma do retorno de `api.billing.previewCheckout`. */
export interface PreviewLike {
  chargeBrl: number | null;
  listBrl: number | null;
  monthlyBrl: number | null;
  priceSource: "price_lock" | "table" | null;
  lines: SummaryLine[];
  cycleMonths: number;
  refusal?: string;
}

export interface ServerSummary {
  summary: CheckoutSummary | null;
  lines: SummaryLine[];
  refusal: string | null;
}

/** Prévia do servidor -> o que o modal mostra (o servidor é a fonte do valor). */
export function summaryFromPreview(p: PreviewLike): ServerSummary {
  if (p.refusal !== undefined || p.chargeBrl === null || p.monthlyBrl === null || p.listBrl === null) {
    return { summary: null, lines: [], refusal: p.refusal ?? null };
  }
  const months = p.cycleMonths > 0 ? p.cycleMonths : 1;
  const listMonthlyBrl = Math.round((p.listBrl / months) * 100) / 100;
  return {
    summary: {
      monthlyBrl: p.monthlyBrl,
      listMonthlyBrl,
      chargeBrl: p.chargeBrl,
      yearly: months > 1 ? { paidMonths: months, freeMonths: 12 - months } : null,
      lockApplied: p.priceSource === "price_lock",
    },
    lines: p.lines,
    refusal: null,
  };
}

/** Esta conta pode abrir o checkout? (Ativo/atrasado: trocar de plano é com a gente, o servidor recusa.) */
export function canStartCheckout(mode: string): boolean {
  return mode === "trial" || mode === "read_only" || mode === "canceled";
}

export function checkoutButtonLabel(hasSubscription: boolean): string {
  return hasSubscription ? "Trocar plano" : "Assinar plano";
}

export type InvoiceStatus = "pending" | "paid" | "overdue" | "canceled" | "refunded";

export function invoiceStatusLabel(s: InvoiceStatus): string {
  switch (s) {
    case "paid":
      return "Paga";
    case "overdue":
      return "Em atraso";
    case "canceled":
      return "Cancelada";
    case "refunded":
      return "Reembolsada";
    default:
      return "Aguardando pagamento";
  }
}

export function invoiceStatusTone(s: InvoiceStatus): "success" | "warning" | "error" | "default" {
  if (s === "paid") return "success";
  if (s === "overdue") return "error";
  if (s === "pending") return "warning";
  return "default";
}

/** A recusa "Recebemos um pagamento e ele está sendo processado…" é aviso, não erro. */
export function isPaymentProcessingMessage(message: string): boolean {
  return message.startsWith("Recebemos um pagamento");
}

export type PriceSource = "price_lock" | "table";

/** Nota sobre a origem do preço da fatura criada (só quando não é a tabela). */
export function priceSourceNote(source: PriceSource | null | undefined): string | null {
  return source === "price_lock" ? "Preço especial da sua conta aplicado nesta fatura." : null;
}

export interface SubscriptionLike {
  paymentStatus: "ok" | "pending" | "overdue" | null;
  hasSubscription: boolean;
}

/** Aviso do estado do pagamento da assinatura (ou `null` quando está tudo certo). */
export function paymentNotice(
  sub: SubscriptionLike | null | undefined,
): { tone: "warning" | "error"; text: string } | null {
  if (!sub) return null;
  if (sub.paymentStatus === "pending") {
    return {
      tone: "warning",
      text: "Aguardando o pagamento da 1ª fatura. O plano é liberado assim que o pagamento for confirmado.",
    };
  }
  if (sub.paymentStatus === "overdue") {
    return {
      tone: "error",
      text: "Há uma fatura em atraso. Pague pelo link da fatura para evitar que a conta passe para modo leitura.",
    };
  }
  return null;
}
