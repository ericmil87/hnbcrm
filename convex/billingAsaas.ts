/**
 * Cobrança pelo Asaas: funções INTERNAS (nenhuma pública). O checkout (`billing.startCheckout`)
 * e as ops chamam estas para ler contexto, carimbar a tentativa e gravar o resultado; o webhook
 * (`billingHttp.ts`) ingere e processa eventos aqui. A API do Asaas só é tocada por
 * `lib/asaasApi.ts`. A org nunca vem do corpo do evento: é resolvida relendo o pagamento.
 *
 * PII (documento, e-mail financeiro) mora em `orgSubscriptions`, nunca em log nem em audit.
 */
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireAccountWithEmail, requirePermission } from "./lib/auth";
import { applySubscriptionChange, setBillingStatus, type OrgBillingInput } from "./lib/entitlementsOps";
import { cancelOpenInvoicesForSubscription, dayToMs, invoiceStatusOf, isPaidStatus, upsertInvoiceFromPayment } from "./lib/billingInvoices";
import {
  AsaasError,
  getPayment,
  getSubscription,
  isAsaasEnabled,
  updateSubscriptionValue,
  type AsaasPayment,
  type AsaasSubscription,
} from "./lib/asaasApi";
import { repriceAfterLockExpiry } from "./lib/lockExpiry";
import { resolveEntitlements } from "./lib/entitlements";
import { rearmScheduledMessagesForOrg } from "./billingCron";
import { notifyBillingAdmins } from "./lib/billingNotify";
import { formatBrl } from "./lib/aiSpend";
import { PLANS } from "./lib/plans";

const planKeyValidator = v.union(v.literal("essencial"), v.literal("profissional"), v.literal("escala"), v.literal("empresa"));
const CHECKOUT_COOLDOWN_MS = 60_000;

export const paymentLiteValidator = v.object({
  id: v.string(),
  subscription: v.optional(v.union(v.string(), v.null())),
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
    plan: v.union(planKeyValidator, v.null()),
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
      plan: org.billing?.plan ?? null,
      trialEndsAt: org.billing?.trialEndsAt ?? null,
      extraChannels: org.billing?.extraChannels ?? 0,
      priceLock: org.billing?.priceLock ? { ...org.billing.priceLock } : null,
      providerSubscriptionId: sub?.providerSubscriptionId ?? null,
    };
  },
});

/** Mesmo contexto do checkout, SEM sessão: só para as ops (`internal*` rodadas pelo operador). */
export const internalCheckoutContextOps = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.object({
    orgName: v.string(),
    quiet: v.boolean(),
    status: v.union(v.string(), v.null()),
    plan: v.union(planKeyValidator, v.null()),
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
      plan: org.billing?.plan ?? null,
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
    /** Assinatura anterior cancelada no Asaas por este checkout: as faturas abertas dela viram canceled. */
    canceledSubscriptionId: v.optional(v.string()),
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
    if (args.canceledSubscriptionId) {
      await cancelOpenInvoicesForSubscription(ctx, args.organizationId, args.canceledSubscriptionId, now);
    }
    if (args.firstPayment) {
      await upsertInvoiceFromPayment(ctx, { organizationId: args.organizationId, payment: args.firstPayment, now });
    }
    return null;
  },
});

// ── Webhook: ingestão, releitura na API e aplicação ─────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** Carência após o vencimento (a conta segue funcionando: `past_due` = `active` nos gates). */
const GRACE_DAYS = 7;
const MAX_ATTEMPTS = 5;

const paymentEventValidator = v.object({
  ...paymentLiteValidator.fields,
  customer: v.optional(v.union(v.string(), v.null())),
  externalReference: v.optional(v.union(v.string(), v.null())),
});
const subscriptionEventValidator = v.object({
  id: v.string(),
  customer: v.optional(v.union(v.string(), v.null())),
  externalReference: v.optional(v.union(v.string(), v.null())),
  status: v.optional(v.string()),
  deleted: v.optional(v.boolean()),
  /** Relido na API (só nos eventos de pagamento confirmado): fim do ciclo e valor da cobrança. */
  nextDueDate: v.optional(v.string()),
  value: v.optional(v.number()),
  cycle: v.optional(v.string()),
});
type PaymentEvent = typeof paymentEventValidator.type;
type SubscriptionEvent = typeof subscriptionEventValidator.type;

function toPaymentEvent(p: AsaasPayment): PaymentEvent {
  return {
    id: p.id,
    status: p.status,
    value: p.value,
    dueDate: p.dueDate,
    invoiceUrl: p.invoiceUrl ?? null,
    billingType: p.billingType,
    paymentDate: p.paymentDate ?? p.confirmedDate ?? null,
    description: p.description ?? null,
    deleted: p.deleted === true,
    customer: p.customer ?? null,
    subscription: p.subscription ?? null,
    externalReference: p.externalReference ?? null,
  };
}
function toSubscriptionEvent(s: AsaasSubscription): SubscriptionEvent {
  return {
    id: s.id,
    customer: s.customer ?? null,
    externalReference: s.externalReference ?? null,
    status: s.status,
    deleted: s.deleted === true,
    nextDueDate: s.nextDueDate,
    value: s.value,
    cycle: s.cycle,
  };
}

/** "2026-12-05" -> "05/12/2026" (texto do aviso). */
function brDay(day: string | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : undefined;
}

/** Grava o evento (dedupe por `eventId`) e agenda o processamento. Repetido = no-op. */
export const internalIngestEvent = internalMutation({
  args: {
    eventId: v.string(),
    event: v.string(),
    paymentId: v.optional(v.string()),
    subscriptionId: v.optional(v.string()),
  },
  returns: v.object({ inserted: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("billingWebhookEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .first();
    if (existing) return { inserted: false };
    const id = await ctx.db.insert("billingWebhookEvents", {
      provider: "asaas",
      eventId: args.eventId,
      event: args.event,
      ...(args.paymentId ? { providerPaymentId: args.paymentId } : {}),
      ...(args.subscriptionId ? { providerSubscriptionId: args.subscriptionId } : {}),
      receivedAt: Date.now(),
      status: "pending",
      attempts: 0,
    });
    await ctx.scheduler.runAfter(0, internal.billingAsaas.internalProcessEvent, { eventDocId: id });
    return { inserted: true };
  },
});

export const internalGetEvent = internalQuery({
  args: { eventDocId: v.id("billingWebhookEvents") },
  returns: v.union(
    v.null(),
    v.object({
      status: v.string(),
      event: v.string(),
      providerPaymentId: v.union(v.string(), v.null()),
      providerSubscriptionId: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const ev = await ctx.db.get(args.eventDocId);
    if (!ev) return null;
    return {
      status: ev.status,
      event: ev.event,
      providerPaymentId: ev.providerPaymentId ?? null,
      providerSubscriptionId: ev.providerSubscriptionId ?? null,
    };
  },
});

/** Falha ao reler na API: tenta de novo com backoff (até 5); depois `failed`. */
export const internalMarkEventFailed = internalMutation({
  args: { eventDocId: v.id("billingWebhookEvents"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ev = await ctx.db.get(args.eventDocId);
    if (!ev || ev.status !== "pending") return null;
    const attempts = ev.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(ev._id, { status: "failed", attempts, error: args.error.slice(0, 200), processedAt: Date.now() });
      return null;
    }
    await ctx.db.patch(ev._id, { attempts, error: args.error.slice(0, 200) });
    await ctx.scheduler.runAfter(60_000 * 2 ** (attempts - 1), internal.billingAsaas.internalProcessEvent, { eventDocId: ev._id });
    return null;
  },
});

/**
 * Processa um evento: NÃO confia no corpo do webhook. Relê o pagamento (ou a assinatura) na API do
 * Asaas com a nossa chave e só então decide (um token vazado não consegue "pagar" uma fatura).
 */
export const internalProcessEvent = internalAction({
  args: { eventDocId: v.id("billingWebhookEvents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ev = await ctx.runQuery(internal.billingAsaas.internalGetEvent, { eventDocId: args.eventDocId });
    if (!ev || ev.status !== "pending") return null;
    if (!isAsaasEnabled()) return null; // chave removida: o evento fica pendente
    let payment: PaymentEvent | null = null;
    let subscription: SubscriptionEvent | null = null;
    try {
      if (ev.providerPaymentId) {
        try {
          payment = toPaymentEvent(await getPayment(ev.providerPaymentId));
        } catch (e) {
          if (!(e instanceof AsaasError && e.status === 404)) throw e;
        }
        // Pagamento confirmado: relê a ASSINATURA para gravar o fim do ciclo (`nextDueDate`) e o valor.
        // Melhor esforço: sem isso a ativação segue, só sem a data do próximo ciclo.
        if ((ev.event === "PAYMENT_CONFIRMED" || ev.event === "PAYMENT_RECEIVED") && payment?.subscription) {
          try {
            subscription = toSubscriptionEvent(await getSubscription(payment.subscription));
          } catch {
            subscription = null;
          }
        }
      } else if (ev.providerSubscriptionId) {
        try {
          subscription = toSubscriptionEvent(await getSubscription(ev.providerSubscriptionId));
        } catch (e) {
          if (!(e instanceof AsaasError && e.status === 404)) throw e;
          subscription = { id: ev.providerSubscriptionId, deleted: true };
        }
      }
    } catch (e) {
      const status = e instanceof AsaasError ? e.status : 0;
      await ctx.runMutation(internal.billingAsaas.internalMarkEventFailed, {
        eventDocId: args.eventDocId,
        error: `falha ao reler no Asaas (HTTP ${status})`,
      });
      return null;
    }
    await ctx.runMutation(internal.billingAsaas.internalApplyEvent, { eventDocId: args.eventDocId, payment, subscription });
    return null;
  },
});

async function auditWebhook(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  event: string,
  reason: string,
  severity: "medium" | "high",
  now: number
): Promise<void> {
  await ctx.db.insert("auditLogs", {
    organizationId,
    entityType: "organization",
    entityId: organizationId,
    action: "update",
    actorType: "api",
    metadata: { kind: "billing_webhook", event, reason },
    description: `Cobrança (Asaas): ${reason}`,
    severity,
    createdAt: now,
  });
}

const isInvalidTransition = (e: unknown): e is ConvexError<{ from: string; to: string }> =>
  e instanceof ConvexError && typeof e.data === "object" && e.data !== null && (e.data as { code?: string }).code === "invalid_transition";

/**
 * Aplica o evento já RELIDO na API. A org vem da assinatura gravada no checkout (e do
 * `externalReference`, que precisa bater): nunca do corpo do webhook. Org sem assinatura no
 * gateway (legacy "pura") nunca é tocada. Nenhum evento coloca a org em `read_only`.
 */
export const internalApplyEvent = internalMutation({
  args: {
    eventDocId: v.id("billingWebhookEvents"),
    payment: v.optional(v.union(paymentEventValidator, v.null())),
    subscription: v.optional(v.union(subscriptionEventValidator, v.null())),
  },
  returns: v.object({ outcome: v.union(v.literal("processed"), v.literal("ignored"), v.literal("failed")) }),
  handler: async (ctx, args) => {
    const ev = await ctx.db.get(args.eventDocId);
    if (!ev || ev.status !== "pending") return { outcome: "ignored" as const };
    const now = Date.now();
    const finish = async (
      status: "processed" | "ignored" | "failed",
      error?: string,
      organizationId?: Id<"organizations">
    ) => {
      await ctx.db.patch(ev._id, {
        status,
        processedAt: now,
        ...(error ? { error: error.slice(0, 200) } : {}),
        ...(organizationId ? { organizationId } : {}),
      });
      return { outcome: status };
    };
    const payment = args.payment ?? null;
    const subscription = args.subscription ?? null;

    // ── Fatura primeiro: DELETED/REFUNDED corrigem a fatura mesmo quando a assinatura é antiga ──
    // (checkout refeito/troca de plano cancelam a assinatura anterior: o evento dela chega com um
    // id que já não é o da org, e antes a fatura ficava "Aguardando pagamento" para sempre).
    let invoiceOrgId: Id<"organizations"> | null = null;
    if (ev.providerPaymentId && (ev.event === "PAYMENT_DELETED" || ev.event === "PAYMENT_REFUNDED")) {
      const inv = await ctx.db
        .query("billingInvoices")
        .withIndex("by_provider_payment_id", (q) => q.eq("providerPaymentId", ev.providerPaymentId!))
        .first();
      if (inv) {
        invoiceOrgId = inv.organizationId;
        // Pagamento que sumiu da API (404) = removido. Senão vale o estado RELIDO.
        const next =
          ev.event === "PAYMENT_DELETED"
            ? payment === null
              ? ("canceled" as const)
              : invoiceStatusOf(payment)
            : payment && invoiceStatusOf(payment) === "refunded"
              ? ("refunded" as const)
              : null;
        if (next && next !== inv.status && !(inv.status === "paid" && next === "canceled")) {
          await ctx.db.patch(inv._id, { status: next, updatedAt: now });
        }
        if (ev.event === "PAYMENT_DELETED") return await finish("processed", undefined, inv.organizationId);
      }
    }

    // ── Resolve a org (assinatura gravada no checkout + externalReference que bate) ──
    const subId = payment?.subscription ?? subscription?.id ?? ev.providerSubscriptionId ?? null;
    let sub: Doc<"orgSubscriptions"> | null = subId
      ? await ctx.db
          .query("orgSubscriptions")
          .withIndex("by_provider_subscription", (q) => q.eq("providerSubscriptionId", subId))
          .first()
      : null;
    const ref = payment?.externalReference ?? subscription?.externalReference ?? null;
    const refOrgId = ref ? ctx.db.normalizeId("organizations", ref) : null;
    if (!sub && refOrgId) {
      const byOrg = await ctx.db
        .query("orgSubscriptions")
        .withIndex("by_organization", (q) => q.eq("organizationId", refOrgId))
        .first();
      if (byOrg?.providerSubscriptionId && (!subId || byOrg.providerSubscriptionId === subId)) sub = byOrg;
    }
    if (!sub) {
      return invoiceOrgId
        ? await finish("processed", "fatura atualizada; sem assinatura vinculada", invoiceOrgId)
        : await finish("ignored", "sem assinatura vinculada");
    }
    const orgId = sub.organizationId;
    if (refOrgId && refOrgId !== orgId) {
      await auditWebhook(ctx, orgId, ev.event, "externalReference diverge da assinatura", "high", now);
      return await finish("failed", "organização divergente", orgId);
    }
    const customer = payment?.customer ?? subscription?.customer ?? null;
    if (customer && sub.providerCustomerId && customer !== sub.providerCustomerId) {
      await auditWebhook(ctx, orgId, ev.event, "cliente do pagamento diverge do cadastrado", "high", now);
      return await finish("failed", "cliente divergente", orgId);
    }
    if (subId && sub.providerSubscriptionId !== subId) {
      return invoiceOrgId
        ? await finish("processed", "fatura atualizada; assinatura antiga", orgId)
        : await finish("ignored", "assinatura antiga", orgId);
    }
    const org = await ctx.db.get(orgId);
    if (!org) return await finish("ignored", "organização removida");

    switch (ev.event) {
      case "PAYMENT_CREATED":
      case "PAYMENT_UPDATED":
      case "PAYMENT_DELETED": {
        if (!payment) return await finish("ignored", "pagamento não encontrado", orgId);
        await upsertInvoiceFromPayment(ctx, { organizationId: orgId, payment, now });
        return await finish("processed", undefined, orgId);
      }

      case "PAYMENT_CONFIRMED":
      case "PAYMENT_RECEIVED": {
        if (!payment) return await finish("ignored", "pagamento não encontrado", orgId);
        if (!isPaidStatus(payment.status)) return await finish("ignored", `pagamento ${payment.status ?? "sem status"}`, orgId);
        await upsertInvoiceFromPayment(ctx, { organizationId: orgId, payment, now });
        const billing = org.billing;
        const targetPlan = sub.pendingPlanChange?.plan ?? billing?.plan;
        const nextDue = dayToMs(subscription?.nextDueDate);
        const paidSub = {
          paymentStatus: "ok" as const,
          graceUntil: undefined,
          currentPeriodStart: now,
          ...(nextDue !== undefined ? { currentPeriodEnd: nextDue } : {}),
          ...(subscription?.value !== undefined ? { chargeCents: Math.round(subscription.value * 100) } : {}),
        };
        try {
          if (!targetPlan) {
            // Sem plano pendente nem gravado (ex.: venda manual sem checkout): só registra o pagamento.
            await applySubscriptionChange(ctx, { organizationId: orgId, patch: { subscription: paidSub }, source: "webhook", reason: "Pagamento confirmado (Asaas)", audit: "none" });
          } else if (billing && (billing.status === "active" || billing.status === "past_due") && billing.plan === targetPlan) {
            // Renovação: org já paga. past_due volta a active; active só carimba o pagamento.
            const { updatedAt: _u, ...current } = billing;
            void _u;
            await applySubscriptionChange(ctx, {
              organizationId: orgId,
              patch: { ...(billing.status === "past_due" ? { billing: { ...current, status: "active" as const } } : {}), subscription: paidSub },
              source: "webhook",
              reason: "Pagamento confirmado (Asaas)",
              ...(billing.status === "active" ? { audit: "none" as const } : {}),
            });
          } else {
            // Ativação (trial, read_only, canceled, legacy ou sem plano) ou troca de plano.
            const { updatedAt: _u, ...billingNoStamp } = billing ?? { status: "legacy" as const, updatedAt: 0 };
            void _u;
            const current: OrgBillingInput = billingNoStamp;
            const wasBlocked = !resolveEntitlements(org, now).outboundAllowed;
            const groups = targetPlan === "essencial" && sub.addons?.groupsAddon === true;
            const addons = targetPlan === "essencial" ? { ...(current.addons ?? {}), groups } : current.addons ? { ...current.addons, groups: undefined } : undefined;
            await applySubscriptionChange(ctx, {
              organizationId: orgId,
              patch: {
                billing: { ...current, plan: targetPlan, status: "active", ...(addons ? { addons } : {}) },
                subscription: { ...paidSub, pendingPlanChange: undefined },
              },
              source: "webhook",
              reason: "Pagamento confirmado (Asaas)",
            });
            // Saiu do modo leitura: as agendadas retidas voltam (campanhas pausadas: o cliente retoma).
            if (wasBlocked) await rearmScheduledMessagesForOrg(ctx, orgId);
          }
        } catch (e) {
          if (isInvalidTransition(e)) return await finish("ignored", `invalid_transition ${e.data.from}->${e.data.to}`, orgId);
          throw e;
        }
        // Recibo: aviso aos admins (o Asaas já manda o e-mail dele ao cliente, então só admins).
        await notifyBillingAdmins(ctx, {
          organizationId: orgId,
          type: "plan_payment_received",
          data: {
            ...(targetPlan ? { planLabel: PLANS[targetPlan].label } : {}),
            ...(payment.value !== undefined ? { amountBrl: formatBrl(payment.value) } : {}),
          },
          dedupeKey: `plan_payment_received:${payment.id}`,
        });
        return await finish("processed", undefined, orgId);
      }

      case "PAYMENT_OVERDUE": {
        if (!payment) return await finish("ignored", "pagamento não encontrado", orgId);
        await upsertInvoiceFromPayment(ctx, { organizationId: orgId, payment, now });
        // Fora de ordem (ex.: RECEIVED chegou antes do OVERDUE atrasado): vale o estado RELIDO.
        if (payment.status !== "OVERDUE") return await finish("ignored", `pagamento ${payment.status ?? "sem status"}, não vencido`, orgId);
        const due = dayToMs(payment.dueDate);
        const graceUntil = (due ?? now) + GRACE_DAYS * DAY_MS;
        const status = org.billing?.status;
        try {
          if (status === "active") {
            // active -> past_due (libera igual; o aviso é o recurso). NUNCA read_only.
            await setBillingStatus(ctx, { organizationId: orgId, status: "past_due", paymentStatus: "overdue", graceUntil, source: "webhook", reason: "Fatura vencida (Asaas)" });
            await notifyBillingAdmins(ctx, {
              organizationId: orgId,
              type: "plan_payment_overdue",
              data: { dueDate: brDay(payment.dueDate) },
              dedupeKey: `plan_payment_overdue:${payment.id}`,
            });
          } else {
            // past_due já avisado; trial/read_only/canceled/legacy: só marca o pagamento, sem mudar status.
            await applySubscriptionChange(ctx, { organizationId: orgId, patch: { subscription: { paymentStatus: "overdue", ...(status === "past_due" ? { graceUntil } : {}) } }, source: "webhook", reason: "Fatura vencida (Asaas)", audit: "none" });
          }
        } catch (e) {
          if (isInvalidTransition(e)) return await finish("ignored", `invalid_transition ${e.data.from}->${e.data.to}`, orgId);
          throw e;
        }
        return await finish("processed", undefined, orgId);
      }

      case "PAYMENT_REFUNDED": {
        if (payment) await upsertInvoiceFromPayment(ctx, { organizationId: orgId, payment, now });
        // Estorno: só o paymentStatus + audit high. Quem decide o que fazer com a conta é o Eric.
        await applySubscriptionChange(ctx, { organizationId: orgId, patch: { subscription: { paymentStatus: "pending" } }, source: "webhook", reason: "Pagamento estornado (Asaas)", severity: "high" });
        return await finish("processed", undefined, orgId);
      }

      case "SUBSCRIPTION_DELETED":
      case "SUBSCRIPTION_INACTIVATED": {
        await applySubscriptionChange(ctx, { organizationId: orgId, patch: { subscription: { paymentStatus: "pending" } }, source: "webhook", reason: "Assinatura encerrada no Asaas", severity: "high" });
        return await finish("processed", undefined, orgId);
      }

      default:
        return await finish("ignored", "evento não tratado", orgId);
    }
  },
});

// ── Fim da trava de preço: reprecifica a assinatura para a tabela ───────────

/** Plano de repreço da org (ou null se não há o que fazer). `now` vem do chamador (action). */
export const internalRepriceContext = internalQuery({
  args: { organizationId: v.id("organizations"), now: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      providerSubscriptionId: v.string(),
      chargeBrl: v.number(),
      monthlyCents: v.number(),
      lockUntil: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    const sub = await ctx.db
      .query("orgSubscriptions")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .first();
    const plan = repriceAfterLockExpiry(org, sub, args.now);
    if (!plan) return null;
    return {
      providerSubscriptionId: plan.providerSubscriptionId,
      chargeBrl: plan.chargeBrl,
      monthlyCents: Math.round(plan.monthlyBrl * 100),
      lockUntil: plan.lockUntil,
    };
  },
});

/** Carimba o repreço pela porta (audit high) e guarda o `until` já tratado. Revalida (idempotente). */
export const internalRecordReprice = internalMutation({
  args: { organizationId: v.id("organizations"), monthlyCents: v.number(), lockUntil: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    const sub = await ctx.db
      .query("orgSubscriptions")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .first();
    const plan = repriceAfterLockExpiry(org, sub, Date.now());
    if (!plan || plan.lockUntil !== args.lockUntil) return null;
    await applySubscriptionChange(ctx, {
      organizationId: args.organizationId,
      patch: { subscription: { basePriceCents: args.monthlyCents, priceLockedUntil: args.lockUntil } },
      source: "cron",
      reason: "Fim do desconto/trava: assinatura reprecificada para a tabela",
      severity: "high",
    });
    return null;
  },
});

/**
 * Chamada pelo cron diário (`internalBillingTick`) para cada org pagante cuja trava venceu:
 * PUT na assinatura do Asaas (só as próximas cobranças) e depois o carimbo. Falhou na API: nada é
 * carimbado, e o cron tenta de novo amanhã.
 */
export const internalRepriceExpiredLock = internalAction({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!isAsaasEnabled()) return null;
    const plan = await ctx.runQuery(internal.billingAsaas.internalRepriceContext, {
      organizationId: args.organizationId,
      now: Date.now(),
    });
    if (!plan) return null;
    try {
      await updateSubscriptionValue(plan.providerSubscriptionId, plan.chargeBrl);
    } catch {
      return null;
    }
    await ctx.runMutation(internal.billingAsaas.internalRecordReprice, {
      organizationId: args.organizationId,
      monthlyCents: plan.monthlyCents,
      lockUntil: plan.lockUntil,
    });
    return null;
  },
});

// ── Reconciliação de faturas (ops) ──────────────────────────────────────────

/** Página de faturas abertas (pending/overdue) com id de pagamento do provedor. Só leitura. */
export const internalOpenInvoicesPage = internalQuery({
  args: {
    organizationId: v.optional(v.id("organizations")),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  returns: v.object({
    items: v.array(
      v.object({
        invoiceId: v.id("billingInvoices"),
        organizationId: v.id("organizations"),
        providerPaymentId: v.string(),
        status: v.string(),
      })
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const numItems = Math.min(Math.max(Math.floor(args.pageSize ?? 50), 1), 100);
    const orgId = args.organizationId;
    const page = orgId
      ? await ctx.db
          .query("billingInvoices")
          .withIndex("by_organization_and_due_date", (q) => q.eq("organizationId", orgId))
          .paginate({ numItems, cursor: args.cursor ?? null })
      : await ctx.db.query("billingInvoices").paginate({ numItems, cursor: args.cursor ?? null });
    const items = page.page
      .filter((r) => (r.status === "pending" || r.status === "overdue") && r.providerPaymentId !== undefined)
      .map((r) => ({
        invoiceId: r._id,
        organizationId: r.organizationId,
        providerPaymentId: r.providerPaymentId!,
        status: r.status as string,
      }));
    return { items, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** Corrige SÓ o status da fatura (nunca o estado da org). `paidAt` só para `paid`. */
export const internalSetInvoiceStatus = internalMutation({
  args: {
    invoiceId: v.id("billingInvoices"),
    status: v.union(v.literal("pending"), v.literal("paid"), v.literal("overdue"), v.literal("canceled"), v.literal("refunded")),
    paidAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const inv = await ctx.db.get(args.invoiceId);
    if (!inv) return null;
    await ctx.db.patch(inv._id, {
      status: args.status,
      ...(args.status === "paid" ? { paidAt: inv.paidAt ?? args.paidAt ?? Date.now() } : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});
