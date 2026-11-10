/**
 * Fluxos de ciclo de vida da assinatura no Asaas (troca de plano, cancelamento, reativação,
 * reembolso, dados de cobrança). Chamados só pelas actions de `billing.ts`, depois de autorizar e
 * decidir (as decisões puras estão em `planChange.ts` e `refund.ts`). Toda escrita local passa pelas
 * mutations de `billingAsaas.ts` (porta de cobrança); a API do Asaas só por `asaasApi.ts`.
 */
import { ConvexError } from "convex/values";
import type { Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { lifecycleContextValidator } from "../billingAsaas";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  AsaasError,
  cancelSubscription,
  createSubscription,
  getPayment,
  getSubscription,
  listSubscriptionPayments,
  refundPayment,
  updateSubscription,
  upsertCustomer,
} from "./asaasApi";
import { onlyDigits } from "./brDocument";
import { dayToMs, isPaidStatus } from "./billingInvoices";
import { brazilDay, type CheckoutCycle, type CheckoutPrice } from "./checkoutPricing";
import { checkoutErrorFor, PAYMENT_BEING_PROCESSED } from "./asaasCheckout";
import { CHANGE_NO_PERIOD_END } from "./planChange";
import { PLANS, type PlanKey } from "./plans";
import { checkRefund, REFUND_REFUSED_MESSAGE } from "./refund";

export type LifecycleInfo = Infer<typeof lifecycleContextValidator>;

const ASAAS_CYCLE = { monthly: "MONTHLY", yearly: "YEARLY" } as const;
const NOT_AVAILABLE = "Não foi possível concluir agora. Tente de novo em instantes ou fale com a gente.";

const cents = (brl: number) => Math.round(brl * 100);
const planLabel = (plan: PlanKey, cycle: CheckoutCycle) => `HNBCRM · plano ${PLANS[plan].label}${cycle === "yearly" ? " (anual)" : ""}`;

/** Uma assinatura que ainda não foi paga pode ser descartada; se já recebeu pagamento, recusa. */
async function assertNoPaymentThenCancel(subscriptionId: string): Promise<void> {
  try {
    const payments = await listSubscriptionPayments(subscriptionId);
    if (payments.some((p) => isPaidStatus(p.status))) throw new ConvexError(PAYMENT_BEING_PROCESSED);
  } catch (e) {
    if (e instanceof ConvexError) throw e;
    if (!(e instanceof AsaasError && e.status === 404)) throw checkoutErrorFor(e);
  }
  try {
    await cancelSubscription(subscriptionId);
  } catch {
    // já removida
  }
}

/** Fim do ciclo pago em ms: o gravado ou, se faltar, o `nextDueDate` relido do Asaas. */
async function periodEndOf(info: LifecycleInfo): Promise<number> {
  if (info.currentPeriodEnd !== null) return info.currentPeriodEnd;
  if (!info.providerSubscriptionId) throw new ConvexError(CHANGE_NO_PERIOD_END);
  try {
    const end = dayToMs((await getSubscription(info.providerSubscriptionId)).nextDueDate);
    if (end !== undefined) return end;
  } catch {
    // cai no erro abaixo
  }
  throw new ConvexError(CHANGE_NO_PERIOD_END);
}

/**
 * Upgrade: assinatura NOVA (valor cheio, 1º vencimento hoje, sem crédito do ciclo atual). O plano só
 * troca quando o pagamento dela confirma (webhook). Devolve o link da fatura hospedada.
 */
export async function runUpgrade(
  ctx: ActionCtx,
  args: {
    organizationId: Id<"organizations">;
    info: LifecycleInfo;
    plan: PlanKey;
    cycle: CheckoutCycle;
    groupsAddon: boolean;
    price: CheckoutPrice;
    now: number;
  }
): Promise<{ invoiceUrl: string | null }> {
  const { info, price } = args;
  if (!info.providerCustomerId) throw new ConvexError(NOT_AVAILABLE);
  // Troca anterior que ficou sem pagar: sai antes (se ela já recebeu, recusa).
  if (info.pendingUpgradeSubscriptionId) await assertNoPaymentThenCancel(info.pendingUpgradeSubscriptionId);
  let createdId: string | null = null;
  try {
    const subscription = await createSubscription({
      customer: info.providerCustomerId,
      value: price.chargeBrl,
      cycle: ASAAS_CYCLE[args.cycle],
      nextDueDate: brazilDay(args.now),
      description: planLabel(args.plan, args.cycle),
      externalReference: args.organizationId,
    });
    createdId = subscription.id;
    let first: Awaited<ReturnType<typeof listSubscriptionPayments>>[number] | undefined;
    try {
      first = (await listSubscriptionPayments(subscription.id))[0];
    } catch {
      // o link também chega pelo webhook PAYMENT_CREATED
    }
    await ctx.runMutation(internal.billingAsaas.internalSaveUpgrade, {
      organizationId: args.organizationId,
      subscriptionId: subscription.id,
      plan: args.plan,
      cycle: args.cycle,
      groupsAddon: args.groupsAddon,
      monthlyCents: cents(price.monthlyBrl),
      chargeCents: cents(price.chargeBrl),
      ...(info.pendingUpgradeSubscriptionId ? { canceledSubscriptionId: info.pendingUpgradeSubscriptionId } : {}),
      ...(first
        ? {
            firstPayment: {
              id: first.id,
              subscription: subscription.id,
              status: first.status,
              value: first.value,
              dueDate: first.dueDate,
              invoiceUrl: first.invoiceUrl ?? null,
              billingType: first.billingType,
              description: first.description ?? null,
            },
          }
        : {}),
    });
    return { invoiceUrl: first?.invoiceUrl ?? null };
  } catch (e) {
    if (createdId) {
      try {
        await cancelSubscription(createdId);
      } catch {
        // melhor esforço
      }
    }
    throw checkoutErrorFor(e);
  }
}

/**
 * Downgrade: o Asaas passa a cobrar o valor/ciclo novo nas PRÓXIMAS cobranças (a cobrança já gerada
 * do próximo ciclo e ainda não paga é reprecificada) e o app guarda a troca para `effectiveAt`
 * (fim do ciclo pago), que o cron aplica.
 */
export async function runDowngrade(
  ctx: ActionCtx,
  args: {
    organizationId: Id<"organizations">;
    info: LifecycleInfo;
    plan: PlanKey;
    cycle: CheckoutCycle;
    groupsAddon: boolean;
    price: CheckoutPrice;
    currentChargeBrl: number;
  }
): Promise<{ effectiveAt: number }> {
  const { info, price } = args;
  if (!info.providerSubscriptionId) throw new ConvexError(NOT_AVAILABLE);
  const effectiveAt = await periodEndOf(info);
  const currentCycle: CheckoutCycle = info.cycle === "yearly" ? "yearly" : "monthly";
  try {
    await updateSubscription(info.providerSubscriptionId, {
      value: price.chargeBrl,
      cycle: ASAAS_CYCLE[args.cycle],
      updatePendingPayments: true,
    });
  } catch (e) {
    throw checkoutErrorFor(e);
  }
  try {
    await ctx.runMutation(internal.billingAsaas.internalSaveScheduledChange, {
      organizationId: args.organizationId,
      currentPeriodEnd: effectiveAt,
      scheduledChange: {
        plan: args.plan,
        cycle: args.cycle,
        effectiveAt,
        chargeCents: cents(price.chargeBrl),
        groupsAddon: args.groupsAddon,
      },
    });
  } catch (e) {
    // Gravação local falhou: devolve o valor antigo ao Asaas para não cobrar diferente do app.
    try {
      await updateSubscription(info.providerSubscriptionId, {
        value: info.chargeCents !== null ? info.chargeCents / 100 : args.currentChargeBrl,
        cycle: ASAAS_CYCLE[currentCycle],
        updatePendingPayments: true,
      });
    } catch {
      // melhor esforço
    }
    throw e;
  }
  return { effectiveAt };
}

/** Desfaz a troca agendada: restaura o valor/ciclo atuais no Asaas e limpa a agenda. */
export async function runCancelScheduledChange(
  ctx: ActionCtx,
  args: { organizationId: Id<"organizations">; info: LifecycleInfo; currentChargeBrl: number }
): Promise<void> {
  const { info } = args;
  if (!info.providerSubscriptionId) throw new ConvexError(NOT_AVAILABLE);
  const currentCycle: CheckoutCycle = info.cycle === "yearly" ? "yearly" : "monthly";
  try {
    await updateSubscription(info.providerSubscriptionId, {
      value: info.chargeCents !== null ? info.chargeCents / 100 : args.currentChargeBrl,
      cycle: ASAAS_CYCLE[currentCycle],
      updatePendingPayments: true,
    });
  } catch (e) {
    throw checkoutErrorFor(e);
  }
  await ctx.runMutation(internal.billingAsaas.internalClearScheduledChange, { organizationId: args.organizationId });
}

/**
 * Cancelamento: apaga a assinatura no Asaas agora (nenhuma cobrança nova) e agenda o fim do acesso
 * para o fim do ciclo já pago. O status segue `active` até `cancelAt` (o cron encerra).
 */
export async function runCancel(
  ctx: ActionCtx,
  args: { organizationId: Id<"organizations">; info: LifecycleInfo; now: number }
): Promise<{ cancelAt: number }> {
  const { info } = args;
  if (!info.providerSubscriptionId) throw new ConvexError(NOT_AVAILABLE);
  const cancelAt = Math.max(await periodEndOf(info), args.now);
  try {
    await cancelSubscription(info.providerSubscriptionId);
  } catch (e) {
    if (!(e instanceof AsaasError && e.status === 404)) throw checkoutErrorFor(e);
  }
  let canceledPending: string | undefined;
  if (info.pendingUpgradeSubscriptionId) {
    try {
      await cancelSubscription(info.pendingUpgradeSubscriptionId);
    } catch {
      // melhor esforço: a fatura dela é cancelada localmente
    }
    canceledPending = info.pendingUpgradeSubscriptionId;
  }
  await ctx.runMutation(internal.billingAsaas.internalSaveCancel, {
    organizationId: args.organizationId,
    cancelAt,
    ...(canceledPending ? { canceledPendingSubscriptionId: canceledPending } : {}),
  });
  return { cancelAt };
}

/** Reativa antes do fim: assinatura nova, 1º vencimento no `cancelAt` (nada é cobrado agora). */
export async function runReactivate(
  ctx: ActionCtx,
  args: { organizationId: Id<"organizations">; info: LifecycleInfo; plan: PlanKey; cycle: CheckoutCycle; chargeBrl: number; cancelAt: number }
): Promise<void> {
  const { info } = args;
  if (!info.providerCustomerId) throw new ConvexError(NOT_AVAILABLE);
  let createdId: string | null = null;
  try {
    const subscription = await createSubscription({
      customer: info.providerCustomerId,
      value: args.chargeBrl,
      cycle: ASAAS_CYCLE[args.cycle],
      nextDueDate: new Date(args.cancelAt).toISOString().slice(0, 10),
      description: planLabel(args.plan, args.cycle),
      externalReference: args.organizationId,
    });
    createdId = subscription.id;
    let first: Awaited<ReturnType<typeof listSubscriptionPayments>>[number] | undefined;
    try {
      first = (await listSubscriptionPayments(subscription.id))[0];
    } catch {
      // o webhook PAYMENT_CREATED traz a fatura
    }
    await ctx.runMutation(internal.billingAsaas.internalSaveReactivate, {
      organizationId: args.organizationId,
      subscriptionId: subscription.id,
      ...(first
        ? {
            firstPayment: {
              id: first.id,
              subscription: subscription.id,
              status: first.status,
              value: first.value,
              dueDate: first.dueDate,
              invoiceUrl: first.invoiceUrl ?? null,
              billingType: first.billingType,
              description: first.description ?? null,
            },
          }
        : {}),
    });
  } catch (e) {
    if (createdId) {
      try {
        await cancelSubscription(createdId);
      } catch {
        // melhor esforço
      }
    }
    throw checkoutErrorFor(e);
  }
}

/**
 * Reembolso automático: só a PRIMEIRA fatura paga, até 168 h depois do pagamento, uma vez. Confere o
 * pagamento no Asaas, estorna o valor total, apaga a assinatura e leva a org a `canceled` (modo
 * leitura, exportação liberada).
 */
export async function runRefund(
  ctx: ActionCtx,
  args: { organizationId: Id<"organizations">; info: LifecycleInfo; now: number }
): Promise<void> {
  const { info } = args;
  const first = info.firstPaid;
  const check = checkRefund({
    invoices: first
      ? [
          {
            _id: first.id,
            status: first.status as "paid" | "refunded",
            paidAt: first.paidAt,
            providerPaymentId: first.providerPaymentId ?? undefined,
            kind: "subscription",
          },
        ]
      : [],
    refundedAt: info.refundedAt ?? undefined,
    orgStatus: info.status ?? "",
    hasProviderSubscription: info.providerSubscriptionId !== null,
    now: args.now,
  });
  if (!check.eligible) throw new ConvexError(REFUND_REFUSED_MESSAGE);
  const paymentId = check.invoice.providerPaymentId as string;
  try {
    // O pagamento tem que estar pago também no Asaas (o estado local pode estar atrasado).
    const payment = await getPayment(paymentId);
    if (!isPaidStatus(payment.status)) throw new ConvexError(REFUND_REFUSED_MESSAGE);
    await refundPayment(paymentId);
  } catch (e) {
    if (e instanceof ConvexError) throw e;
    throw new ConvexError("Não foi possível estornar agora. Tente de novo em instantes ou fale com a gente: contato@hnbcrm.com");
  }
  // O dinheiro já foi devolvido: o resto é melhor esforço, mas o estado local TEM que refletir.
  for (const id of [info.providerSubscriptionId, info.pendingUpgradeSubscriptionId]) {
    if (!id) continue;
    try {
      await cancelSubscription(id);
    } catch {
      // já removida
    }
  }
  await ctx.runMutation(internal.billingAsaas.internalFinishRefund, {
    organizationId: args.organizationId,
    providerPaymentId: paymentId,
  });
}

/** Atualiza o cliente no Asaas e depois os dados guardados no app. */
export async function runUpdateBillingDetails(
  ctx: ActionCtx,
  args: { organizationId: Id<"organizations">; billingName: string; document: string; billingEmail: string }
): Promise<void> {
  const document = onlyDigits(args.document);
  try {
    await upsertCustomer({
      name: args.billingName,
      cpfCnpj: document,
      email: args.billingEmail,
      externalReference: args.organizationId,
    });
  } catch (e) {
    throw checkoutErrorFor(e);
  }
  await ctx.runMutation(internal.billingAsaas.internalSaveBillingDetails, {
    organizationId: args.organizationId,
    billingName: args.billingName,
    billingDocument: document,
    billingEmail: args.billingEmail,
  });
}
