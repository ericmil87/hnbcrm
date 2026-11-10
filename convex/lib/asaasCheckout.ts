/**
 * Orquestra a criação da assinatura no Asaas (compartilhada por `billing.startCheckout` e pela
 * op de venda manual): cliente -> notificações -> (cancela assinatura anterior não paga) ->
 * assinatura -> 1ª cobrança -> grava pela porta. O status/plano da org NÃO muda aqui: só o
 * pagamento confirmado (webhook) libera o plano.
 */
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  AsaasError,
  cancelSubscription,
  configureCustomerNotifications,
  createSubscription,
  listSubscriptionPayments,
  upsertCustomer,
} from "./asaasApi";
import { onlyDigits } from "./brDocument";
import type { CheckoutCycle } from "./checkoutPricing";
import { PLANS, type PlanKey } from "./plans";

export type CheckoutFlowInput = {
  organizationId: Id<"organizations">;
  /** Empresa só entra por op (venda manual com preço negociado). */
  plan: PlanKey;
  cycle: CheckoutCycle;
  groupsAddon: boolean;
  extraChannels: number;
  billingName: string;
  document: string;
  billingEmail: string;
  /** Mensalidade efetiva (R$) e valor de cada cobrança (R$), já calculados no servidor. */
  monthlyBrl: number;
  chargeBrl: number;
  nextDueDate: string;
  quiet: boolean;
  previousSubscriptionId?: string | null;
  viaOps?: boolean;
};

export const CHECKOUT_UNAVAILABLE =
  "Não foi possível iniciar a cobrança agora. Tente de novo em instantes ou fale com a gente.";
export const CHECKOUT_BAD_DATA = "Confira os dados de cobrança (documento e e-mail) e tente de novo.";

/** Erro do Asaas -> mensagem PT-BR segura (sem corpo, sem dados do cliente). */
export function checkoutErrorFor(e: unknown): ConvexError<string> {
  if (e instanceof ConvexError) return e as ConvexError<string>;
  if (e instanceof AsaasError && (e.status === 400 || e.status === 422)) return new ConvexError(CHECKOUT_BAD_DATA);
  return new ConvexError(CHECKOUT_UNAVAILABLE);
}

export async function runAsaasCheckout(
  ctx: ActionCtx,
  input: CheckoutFlowInput
): Promise<{ invoiceUrl: string | null; providerSubscriptionId: string; providerCustomerId: string }> {
  const document = onlyDigits(input.document);
  let createdSubscriptionId: string | null = null;
  try {
    const customer = await upsertCustomer({
      name: input.billingName,
      cpfCnpj: document,
      email: input.billingEmail,
      externalReference: input.organizationId,
    });
    // Notificações do Asaas são cortesia: falhar aqui não pode bloquear a venda.
    try {
      await configureCustomerNotifications(customer.id, { quiet: input.quiet });
    } catch {
      // segue
    }
    // Assinatura anterior que nunca foi paga: cancela para não deixar duas cobrando.
    if (input.previousSubscriptionId) {
      try {
        await cancelSubscription(input.previousSubscriptionId);
      } catch {
        // já removida ou inexistente
      }
    }
    const subscription = await createSubscription({
      customer: customer.id,
      value: input.chargeBrl,
      cycle: input.cycle === "yearly" ? "YEARLY" : "MONTHLY",
      nextDueDate: input.nextDueDate,
      description: `HNBCRM · plano ${PLANS[input.plan].label}${input.cycle === "yearly" ? " (anual)" : ""}`,
      externalReference: input.organizationId,
    });
    createdSubscriptionId = subscription.id;
    let payments: Awaited<ReturnType<typeof listSubscriptionPayments>> = [];
    try {
      payments = await listSubscriptionPayments(subscription.id);
    } catch {
      // o link também chega pelo webhook PAYMENT_CREATED
    }
    const first = payments[0];
    await ctx.runMutation(internal.billingAsaas.internalSaveCheckout, {
      organizationId: input.organizationId,
      plan: input.plan,
      providerCustomerId: customer.id,
      providerSubscriptionId: subscription.id,
      billingCycle: input.cycle,
      billingEmail: input.billingEmail,
      billingDocument: document,
      billingName: input.billingName,
      groupsAddon: input.groupsAddon,
      extraChannels: input.extraChannels,
      monthlyCents: Math.round(input.monthlyBrl * 100),
      ...(first
        ? {
            firstPayment: {
              id: first.id,
              status: first.status,
              value: first.value,
              dueDate: first.dueDate,
              invoiceUrl: first.invoiceUrl ?? null,
              billingType: first.billingType,
              description: first.description ?? null,
            },
          }
        : {}),
      ...(input.viaOps ? { viaOps: true } : {}),
    });
    return {
      invoiceUrl: first?.invoiceUrl ?? null,
      providerSubscriptionId: subscription.id,
      providerCustomerId: customer.id,
    };
  } catch (e) {
    // Assinatura criada mas não gravada: remove para não sobrar cobrança órfã.
    if (createdSubscriptionId) {
      try {
        await cancelSubscription(createdSubscriptionId);
      } catch {
        // melhor esforço
      }
    }
    throw checkoutErrorFor(e);
  }
}
