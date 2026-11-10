/**
 * Cobrança pelo Asaas: funções INTERNAS (nenhuma pública). O checkout (`billing.startCheckout`)
 * e as ops chamam estas para ler contexto, carimbar a tentativa e gravar o resultado; o webhook
 * (`billingHttp.ts`) ingere e processa eventos aqui. A API do Asaas só é tocada por
 * `lib/asaasApi.ts`. A org nunca vem do corpo do evento: é resolvida relendo o pagamento.
 *
 * PII (documento, e-mail financeiro) mora em `orgSubscriptions`, nunca em log nem em audit.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { requireAccountWithEmail, requirePermission } from "./lib/auth";
import { applySubscriptionChange } from "./lib/entitlementsOps";
import { upsertInvoiceFromPayment } from "./lib/billingInvoices";

const planKeyValidator = v.union(v.literal("essencial"), v.literal("profissional"), v.literal("escala"), v.literal("empresa"));
const CHECKOUT_COOLDOWN_MS = 60_000;

export const paymentLiteValidator = v.object({
  id: v.string(),
  status: v.optional(v.string()),
  value: v.optional(v.number()),
  dueDate: v.optional(v.string()),
  invoiceUrl: v.optional(v.union(v.string(), v.null())),
  billingType: v.optional(v.string()),
  paymentDate: v.optional(v.union(v.string(), v.null())),
  description: v.optional(v.union(v.string(), v.null())),
  deleted: v.optional(v.boolean()),
});

// ── Checkout ────────────────────────────────────────────────────────────────

/** Contexto do checkout (settings:manage + conta com e-mail). Sem documento nem e-mail na saída. */
export const internalCheckoutContext = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.object({
    orgName: v.string(),
    quiet: v.boolean(),
    status: v.union(v.string(), v.null()),
    trialEndsAt: v.union(v.number(), v.null()),
    extraChannels: v.number(),
    priceLock: v.union(
      v.null(),
      v.object({
        kind: v.union(v.literal("founder"), v.literal("frozen")),
        monthlyBrl: v.optional(v.number()),
        discountPct: v.optional(v.number()),
        until: v.optional(v.number()),
      })
    ),
    providerSubscriptionId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    const sub = await ctx.db
      .query("orgSubscriptions")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .first();
    return {
      orgName: org.name,
      quiet: org.billing?.quiet === true,
      status: org.billing?.status ?? null,
      trialEndsAt: org.billing?.trialEndsAt ?? null,
      extraChannels: org.billing?.extraChannels ?? 0,
      priceLock: org.billing?.priceLock ? { ...org.billing.priceLock } : null,
      providerSubscriptionId: sub?.providerSubscriptionId ?? null,
    };
  },
});

/** Anti duplo clique: carimba a tentativa (60 s) pela porta; uma segunda dentro da janela é recusada. */
export const internalBeginCheckout = internalMutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    const now = Date.now();
    const sub = await ctx.db
      .query("orgSubscriptions")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .first();
    if (sub?.checkoutStartedAt !== undefined && now - sub.checkoutStartedAt < CHECKOUT_COOLDOWN_MS) {
      throw new ConvexError("Já estamos criando a sua assinatura. Aguarde alguns segundos e tente de novo.");
    }
    await applySubscriptionChange(ctx, {
      organizationId: args.organizationId,
      patch: { subscription: { checkoutStartedAt: now } },
      source: "checkout",
      reason: "Início do checkout",
      actor: member._id,
      audit: "none",
    });
    return null;
  },
});

/** Grava o resultado do checkout (ids, ciclo, tomador, plano pendente) e a 1ª fatura. NÃO muda status nem plano. */
export const internalSaveCheckout = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    plan: planKeyValidator,
    providerCustomerId: v.string(),
    providerSubscriptionId: v.string(),
    billingCycle: v.union(v.literal("monthly"), v.literal("yearly")),
    billingEmail: v.string(),
    billingDocument: v.string(),
    billingName: v.string(),
    groupsAddon: v.boolean(),
    extraChannels: v.number(),
    monthlyCents: v.number(),
    firstPayment: v.optional(paymentLiteValidator),
    /** Chamado por op (sem sessão): o ator é o sistema. */
    viaOps: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const member = args.viaOps ? null : await requirePermission(ctx, args.organizationId, "settings", "manage");
    await applySubscriptionChange(ctx, {
      organizationId: args.organizationId,
      patch: {
        subscription: {
          billingProvider: "asaas",
          providerCustomerId: args.providerCustomerId,
          providerSubscriptionId: args.providerSubscriptionId,
          billingCycle: args.billingCycle,
          billingEmail: args.billingEmail,
          billingDocument: args.billingDocument,
          billingName: args.billingName,
          pendingPlanChange: { plan: args.plan, at: now },
          basePriceCents: args.monthlyCents,
          addons: { groupsAddon: args.groupsAddon, extraChannels: args.extraChannels },
          paymentStatus: "pending",
          checkoutStartedAt: undefined,
        },
      },
      // `checkout` só escreve campos de cobrança; a ops de venda manual usa a mesma variante.
      source: "checkout",
      reason: args.viaOps ? "Assinatura criada por op" : "Assinatura criada no checkout",
      actor: member?._id,
      severity: "high",
    });
    if (args.firstPayment) {
      await upsertInvoiceFromPayment(ctx, { organizationId: args.organizationId, payment: args.firstPayment, now });
    }
    return null;
  },
});
