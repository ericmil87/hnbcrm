/**
 * Fim do desconto de fundador com prazo (puro). Quando `priceLock.until` vence, a assinatura
 * do Asaas ainda cobra o valor travado: o cron diário a reprecifica para a TABELA (só para as
 * próximas cobranças). Idempotência: depois de reprecificar, `orgSubscriptions.priceLockedUntil`
 * guarda o `until` já tratado (a mesma trava nunca é reprecificada duas vezes).
 */
import type { Doc } from "../_generated/dataModel";
import { priceCheckout } from "./checkoutPricing";
import type { PlanKey } from "./plans";

export type RepricePlan = {
  lockUntil: number;
  plan: Exclude<PlanKey, "empresa">;
  cycle: "monthly" | "yearly";
  providerSubscriptionId: string;
  /** Valor de CADA cobrança depois da trava (tabela). */
  chargeBrl: number;
  monthlyBrl: number;
};

export function repriceAfterLockExpiry(
  org: Pick<Doc<"organizations">, "billing"> | null,
  sub: Doc<"orgSubscriptions"> | null,
  now: number
): RepricePlan | null {
  const billing = org?.billing;
  const lock = billing?.priceLock;
  if (!billing || !lock || lock.until === undefined || lock.until > now) return null;
  // Só desconto de FUNDADOR volta sozinho para a tabela. Trava congelada ("frozen") vencida NUNCA
  // reprecifica: o cliente combinou aquele valor, então o Eric decide e avisa (ver
  // `internalBillingReport.frozenLockExpired`).
  if (lock.kind !== "founder") return null;
  // Só quem paga: trial/read_only/canceled/legacy não têm assinatura em cobrança.
  if (billing.status !== "active" && billing.status !== "past_due") return null;
  // Empresa é preço negociado: nunca reprecifica sozinho.
  if (!billing.plan || billing.plan === "empresa") return null;
  if (!sub || sub.billingProvider !== "asaas" || !sub.providerSubscriptionId) return null;
  // Troca de plano agendada, upgrade pendente ou cancelamento agendado: o valor do Asaas já foi
  // decidido pelo ciclo de vida (repreçar sobrescreveria o do plano novo ou ressuscitaria cobrança).
  if (sub.scheduledChange || sub.pendingUpgrade || sub.cancelAt !== undefined) return null;
  if (sub.billingCycle !== "monthly" && sub.billingCycle !== "yearly") return null;
  if (sub.priceLockedUntil === lock.until) return null; // já tratada
  const priced = priceCheckout({
    plan: billing.plan,
    cycle: sub.billingCycle,
    groupsAddon: sub.addons?.groupsAddon === true && billing.plan === "essencial",
    billing: { plan: billing.plan, extraChannels: billing.extraChannels, priceLock: lock },
    now,
  });
  if (!priced.ok) return null;
  return {
    lockUntil: lock.until,
    plan: billing.plan,
    cycle: sub.billingCycle,
    providerSubscriptionId: sub.providerSubscriptionId,
    chargeBrl: priced.price.chargeBrl,
    monthlyBrl: priced.price.monthlyBrl,
  };
}
