/**
 * Troca de plano/ciclo de quem já paga (puro). A MESMA decisão serve a `billing.changePlan` e à
 * prévia `previewCheckout({mode:"change"})`: a prévia nunca diverge do que é enviado ao Asaas.
 *
 * Sem pro-rata (estilo App Store): upgrade vale agora, cobrando o valor cheio do plano novo e sem
 * crédito do restante do ciclo; downgrade só entra no fim do ciclo pago.
 */
import type { Doc } from "../_generated/dataModel";
import { priceCheckout, FALE_COM_A_GENTE_EMPRESA, type CheckoutCycle, type CheckoutPrice } from "./checkoutPricing";
import { ANNUAL_MONTHS_CHARGED, type PlanKey } from "./plans";

export type PlanChangeKind = "upgrade" | "downgrade" | "same";

type Shape = { plan: PlanKey; cycle: CheckoutCycle; chargeBrl: number };

/** Mensalidade equivalente: no anual o cliente paga 10 meses por 12. */
export function equivalentMonthlyBrl(cycle: CheckoutCycle, chargeBrl: number): number {
  return cycle === "yearly" ? chargeBrl / (ANNUAL_MONTHS_CHARGED + 2) : chargeBrl;
}

/**
 * Maior mensalidade equivalente, ou mensal -> anual, é upgrade; menor, ou anual -> mensal, é
 * downgrade; igual em tudo é "same" (nada a fazer). No mesmo plano o ciclo decide (mensal ->
 * anual custa mais adiantado, mesmo com a mensalidade equivalente menor).
 */
export function classifyPlanChange(current: Shape, next: Shape): PlanChangeKind {
  const cents = (n: number) => Math.round(n * 100);
  if (current.plan === next.plan) {
    if (current.cycle !== next.cycle) return current.cycle === "monthly" ? "upgrade" : "downgrade";
    const a = cents(current.chargeBrl);
    const b = cents(next.chargeBrl);
    return b > a ? "upgrade" : b < a ? "downgrade" : "same";
  }
  const a = cents(equivalentMonthlyBrl(current.cycle, current.chargeBrl));
  const b = cents(equivalentMonthlyBrl(next.cycle, next.chargeBrl));
  return b > a ? "upgrade" : "downgrade";
}

export const CHANGE_NEEDS_SUBSCRIPTION =
  "Para trocar de plano você precisa de uma assinatura ativa. Assine um plano em Configurações › Uso e fatura.";
export const CHANGE_UNSUPPORTED_CYCLE = "Seu ciclo de cobrança atual não permite troca online. Fale com a gente: contato@hnbcrm.com";
export const CHANGE_CANCELING = "Sua assinatura está com cancelamento agendado. Reative antes de trocar de plano.";
export const CHANGE_SAME = "Você já está nesse plano e ciclo.";
export const CHANGE_OPEN_INVOICE = "Você tem uma fatura em aberto. Pague antes de trocar de plano.";
export const CHANGE_NO_PERIOD_END = "Não conseguimos confirmar o fim do seu ciclo agora. Tente de novo em instantes.";

export type ChangeOrgInfo = {
  status: string | null;
  plan: PlanKey | null;
  /** Ciclo da assinatura atual (`orgSubscriptions.billingCycle`). */
  cycle: "monthly" | "yearly" | "quarterly" | null;
  groupsAddon: boolean;
  extraChannels: number;
  priceLock: NonNullable<Doc<"organizations">["billing"]>["priceLock"] | null;
  hasSubscription: boolean;
  /** Cancelamento agendado (`cancelAt`): reative antes de trocar. */
  canceling: boolean;
  currentPeriodEnd: number | null;
};

export type PlanChangeEvaluation =
  | {
      ok: true;
      kind: PlanChangeKind;
      price: CheckoutPrice;
      currentChargeBrl: number;
      /** Downgrade: fim do ciclo pago (`null` se ainda não conhecido). Upgrade: vale agora (undefined). */
      effectiveAt?: number | null;
    }
  | { ok: false; refusal: string };

export function evaluatePlanChange(args: {
  plan: PlanKey;
  cycle: CheckoutCycle;
  groupsAddon: boolean;
  org: ChangeOrgInfo;
  now: number;
}): PlanChangeEvaluation {
  const { org } = args;
  if (args.plan === "empresa" || org.plan === "empresa") return { ok: false, refusal: FALE_COM_A_GENTE_EMPRESA };
  if ((org.status !== "active" && org.status !== "past_due") || !org.plan || !org.hasSubscription) {
    return { ok: false, refusal: CHANGE_NEEDS_SUBSCRIPTION };
  }
  if (org.canceling) return { ok: false, refusal: CHANGE_CANCELING };
  if (org.cycle === "quarterly") return { ok: false, refusal: CHANGE_UNSUPPORTED_CYCLE };
  const currentCycle: CheckoutCycle = org.cycle === "yearly" ? "yearly" : "monthly";
  const billing = { plan: org.plan, extraChannels: org.extraChannels, priceLock: org.priceLock ?? undefined };
  const target = priceCheckout({ plan: args.plan, cycle: args.cycle, groupsAddon: args.groupsAddon, billing, now: args.now });
  if (!target.ok) return { ok: false, refusal: "O add-on Grupos existe só no plano Essencial." };
  const current = priceCheckout({ plan: org.plan, cycle: currentCycle, groupsAddon: org.groupsAddon, billing, now: args.now });
  if (!current.ok) return { ok: false, refusal: FALE_COM_A_GENTE_EMPRESA };
  const kind = classifyPlanChange(
    { plan: org.plan, cycle: currentCycle, chargeBrl: current.price.chargeBrl },
    { plan: args.plan, cycle: args.cycle, chargeBrl: target.price.chargeBrl }
  );
  return {
    ok: true,
    kind,
    price: target.price,
    currentChargeBrl: current.price.chargeBrl,
    ...(kind === "downgrade" ? { effectiveAt: org.currentPeriodEnd } : {}),
  };
}

/** A trava de preço vale só no plano que ela cobriu: ao trocar de plano, perde o valor combinado. */
export function lockAfterPlanChange<L extends { monthlyBrl?: number; discountPct?: number }>(
  lock: L | undefined,
  fromPlan: PlanKey | undefined,
  toPlan: PlanKey
): L | undefined {
  if (!lock || fromPlan === toPlan) return lock;
  if (lock.discountPct === undefined) return undefined;
  return { ...lock, monthlyBrl: undefined };
}
