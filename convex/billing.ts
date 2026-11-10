/**
 * Queries e mutation da tela "Uso e fatura" (billing B3). Fino: a lógica está em
 * `lib/billingViews.ts`, `lib/billingMath.ts` e `lib/entitlements.ts`.
 *
 *  - `getMyEntitlements`: qualquer membro, lê SÓ o doc da org (barata: o banner e os
 *    gates assinam). Preço/priceLock/teto só para quem tem `settings:view`.
 *  - Resto das queries: `settings:view`; a escrita (`setOverage`) é `settings:manage`
 *    + conta com e-mail. Nenhuma query lê o relógio.
 *  - Nunca devolve telefone nem e-mail; nome do contato só com `contacts:view`.
 */
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { action, mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { getActiveMembership, requireAccountWithEmail, requirePermission } from "./lib/auth";
import { hasPermission, resolvePermissions, type Role } from "./lib/permissions";
import { applySubscriptionChange } from "./lib/entitlementsOps";
import { attendanceBillingValidator } from "./schema";
import { isValidMonthKey, monthStartUtcMs, nextMonthStartUtcMs } from "./lib/aiSpend";
import { totalAttendances } from "./lib/attendanceLedger";

import { buildMyEntitlements, initialsOf, isValidOverageCap, resolvePlanView, safeContactName } from "./lib/billingViews";
import { estimateInvoice } from "./lib/billingMath";
import { isAsaasEnabled } from "./lib/asaasApi";
import { isValidCpfCnpj } from "./lib/brDocument";
import { isDeliverableEmail } from "./lib/emailAddress";
import { FALE_COM_A_GENTE_EMPRESA, evaluateCheckout, firstDueDate } from "./lib/checkoutPricing";
import { runAsaasCheckout } from "./lib/asaasCheckout";
import { PLANS } from "./lib/plans";

const planKeyValidator = v.union(
  v.literal("essencial"),
  v.literal("profissional"),
  v.literal("escala"),
  v.literal("empresa")
);
const modeValidator = v.union(
  v.literal("legacy"),
  v.literal("trial"),
  v.literal("active"),
  v.literal("past_due"),
  v.literal("read_only"),
  v.literal("canceled")
);
const priceLockValidator = v.object({
  kind: v.union(v.literal("founder"), v.literal("frozen")),
  monthlyBrl: v.optional(v.number()),
  discountPct: v.optional(v.number()),
  until: v.optional(v.number()),
});
const gatedFeaturesValidator = v.object({
  groups: v.boolean(),
  departments: v.boolean(),
  translation: v.boolean(),
  api: v.boolean(),
  central: v.boolean(),
  units: v.boolean(),
  attribution: v.boolean(),
});
const minPlanForValidator = v.object({
  groups: planKeyValidator,
  departments: planKeyValidator,
  translation: planKeyValidator,
  api: planKeyValidator,
  central: planKeyValidator,
  units: planKeyValidator,
  attribution: planKeyValidator,
});
/** Assinatura vista pelo cliente: nunca documento, e-mail nem ids do provedor. */
const subscriptionViewValidator = v.object({
  billingCycle: v.union(v.literal("monthly"), v.literal("yearly"), v.literal("quarterly"), v.null()),
  paymentStatus: v.union(v.literal("ok"), v.literal("pending"), v.literal("overdue"), v.null()),
  provider: v.union(v.literal("manual"), v.literal("asaas"), v.null()),
  hasSubscription: v.boolean(),
});

function subscriptionView(sub: Doc<"orgSubscriptions"> | null) {
  return {
    billingCycle: sub?.billingCycle ?? null,
    paymentStatus: sub?.paymentStatus ?? null,
    provider: sub?.billingProvider ?? null,
    hasSubscription: sub?.providerSubscriptionId !== undefined,
  };
}

async function loadSubscription(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return await ctx.db
    .query("orgSubscriptions")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .first();
}

const byKindValidator = v.record(v.string(), v.object({ runs: v.number(), costUsdMicros: v.number() }));
const MAX_PAGE = 100;
const SCAN_CAP = 1000;

// ── getMyEntitlements ───────────────────────────────────────────────────────

export const getMyEntitlements = query({
  args: { organizationId: v.id("organizations") },
  // `null` para quem não é membro ativo (o front depende disso em deep links entre orgs).
  returns: v.union(v.null(), v.object({
    mode: modeValidator,
    planId: v.union(planKeyValidator, v.null()),
    planLabel: v.union(v.string(), v.null()),
    trialEndsAt: v.optional(v.number()),
    readOnly: v.boolean(),
    limits: v.union(
      v.null(),
      v.object({
        channels: v.union(v.number(), v.null()),
        attendances: v.union(v.number(), v.null()),
        campaignSends: v.union(v.number(), v.null()),
        aiGroups: v.union(v.number(), v.null()),
      })
    ),
    features: gatedFeaturesValidator,
    minPlanFor: minPlanForValidator,
    overage: v.object({ enabled: v.boolean(), capBrl: v.union(v.number(), v.null()) }),
    usageLevel: v.union(v.literal("ok"), v.literal("warn80"), v.literal("limit100")),
    usageAlertMonth: v.optional(v.string()),
    pricing: v.optional(
      v.object({
        listMonthlyBrl: v.union(v.number(), v.null()),
        priceLock: v.union(priceLockValidator, v.null()),
      })
    ),
    /** Só para quem tem `settings:view` (lê a assinatura: 1 documento a mais). */
    subscription: v.optional(subscriptionViewValidator),
  })),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const member = await getActiveMembership(ctx, args.organizationId, userId);
    if (!member) return null;
    const perms = resolvePermissions(member.role as Role, member.permissions as never);
    const org = await ctx.db.get(args.organizationId);
    const canView = hasPermission(perms, "settings", "view");
    const view = buildMyEntitlements(org, canView);
    if (canView) view.subscription = subscriptionView(await loadSubscription(ctx, args.organizationId));
    return view;
  },
});

// ── getUsageSummary ─────────────────────────────────────────────────────────

export const getUsageSummary = query({
  args: {
    organizationId: v.id("organizations"),
    month: v.string(),
    /**
     * Relógio do CLIENTE (arredondado). Só decide se um `priceLock.until` já venceu na
     * estimativa; ausente = a trava vale. A query nunca lê `Date.now()`.
     */
    now: v.optional(v.number()),
  },
  returns: v.object({
    month: v.string(),
    periodStart: v.number(),
    periodEnd: v.number(),
    mode: modeValidator,
    planId: v.union(planKeyValidator, v.null()),
    attendances: v.object({
      total: v.number(),
      included: v.number(),
      credit: v.number(),
      overage: v.number(),
      suggestOnly: v.number(),
      overageBrlCents: v.number(),
      limit: v.union(v.number(), v.null()),
    }),
    campaignSends: v.object({ used: v.number(), limit: v.union(v.number(), v.null()) }),
    credits: v.array(
      v.object({
        granted: v.number(),
        consumed: v.number(),
        remaining: v.number(),
        expiresAt: v.number(),
        source: v.union(v.literal("pack"), v.literal("courtesy"), v.literal("migration")),
      })
    ),
    packBalance: v.number(),
    overage: v.object({
      enabled: v.boolean(),
      capBrl: v.union(v.number(), v.null()),
      unitBrlCents: v.union(v.number(), v.null()),
    }),
    byo: v.boolean(),
    costUsdMicros: v.number(),
    byKind: byKindValidator,
    subscription: subscriptionViewValidator,
    estimate: v.union(
      v.null(),
      v.object({
        planBrl: v.number(),
        extraChannelsBrl: v.number(),
        groupsAddonBrl: v.number(),
        listBrl: v.number(),
        recurringBrl: v.number(),
        overageBrl: v.number(),
        totalBrl: v.number(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    if (!isValidMonthKey(args.month)) throw new ConvexError("Informe o mês no formato AAAA-MM");
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    const periodStart = monthStartUtcMs(args.month);
    const periodEnd = nextMonthStartUtcMs(args.month);
    const ent = resolvePlanView(org);

    const usage = await ctx.db
      .query("aiUsageMonthly")
      .withIndex("by_organization_and_month", (q) => q.eq("organizationId", args.organizationId).eq("month", args.month))
      .unique();
    const meter = await ctx.db
      .query("orgUsageMonthly")
      .withIndex("by_organization_and_month", (q) => q.eq("organizationId", args.organizationId).eq("month", args.month))
      .unique();
    const creditDocs = await ctx.db
      .query("usageCredits")
      .withIndex("by_organization_and_expires", (q) => q.eq("organizationId", args.organizationId).gt("expiresAt", periodStart))
      .take(10);
    const credits = creditDocs.map((c) => ({
      granted: c.granted,
      consumed: c.consumed,
      remaining: Math.max(0, c.granted - c.consumed),
      expiresAt: c.expiresAt,
      source: c.source,
    }));

    const billing = org.billing;
    const byo = org.settings.aiConfig?.providerConfig?.mode === "byo";
    const overageUnits = meter?.attendancesOverage ?? 0;
    const estimate =
      ent.gated && ent.plan && billing?.status !== "trial"
        ? estimateInvoice({
            plan: ent.plan,
            units: billing?.units,
            extraChannels: billing?.extraChannels,
            groupsAddon: billing?.addons?.groups === true,
            overageAttendances: overageUnits,
            byo,
            priceLock: billing?.priceLock ?? null,
            now: args.now ?? 0,
          })
        : null;

    return {
      month: args.month,
      periodStart,
      periodEnd,
      mode: billing ? billing.status : ("legacy" as const),
      planId: ent.gated ? ent.plan : null,
      attendances: {
        // Congelado (código antigo) + contatos do livro (B2).
        total: totalAttendances(usage, meter),
        included: meter?.attendancesIncluded ?? 0,
        credit: meter?.attendancesCredit ?? 0,
        overage: overageUnits,
        suggestOnly: meter?.attendancesSuggestOnly ?? 0,
        overageBrlCents: meter?.overageBrlCents ?? 0,
        limit: Number.isFinite(ent.limits.aiAttendances) ? ent.limits.aiAttendances : null,
      },
      campaignSends: {
        used: meter?.campaignSends ?? 0,
        limit: Number.isFinite(ent.limits.campaignSends) ? ent.limits.campaignSends : null,
      },
      credits,
      packBalance: credits.reduce((sum, c) => sum + c.remaining, 0),
      overage: {
        enabled: ent.overage.enabled,
        capBrl: ent.overage.enabled ? ent.overage.capBrlCents / 100 : null,
        unitBrlCents: ent.gated ? ent.overage.unitBrlCents : null,
      },
      byo,
      costUsdMicros: usage?.costUsdMicros ?? 0,
      byKind: usage?.byKind ?? {},
      subscription: subscriptionView(await loadSubscription(ctx, args.organizationId)),
      estimate,
    };
  },
});

// ── getChannelAndGroupUsage (só o painel assina) ────────────────────────────

export const getChannelAndGroupUsage = query({
  args: { organizationId: v.id("organizations") },
  returns: v.object({
    channels: v.object({ active: v.number(), limit: v.union(v.number(), v.null()), truncated: v.boolean() }),
    aiGroups: v.object({ used: v.number(), limit: v.union(v.number(), v.null()), truncated: v.boolean() }),
  }),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const org = await ctx.db.get(args.organizationId);
    const ent = resolvePlanView(org);

    // Itera o índice (sem take + filtro): conta tudo até a trava de leitura.
    let active = 0;
    let seen = 0;
    let channelsTruncated = false;
    for await (const c of ctx.db
      .query("channelConfigs")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))) {
      if (c.status !== "disabled") active++;
      if (++seen >= SCAN_CAP) {
        channelsTruncated = true;
        break;
      }
    }
    let groups = 0;
    let groupsSeen = 0;
    let groupsTruncated = false;
    for await (const g of ctx.db
      .query("groupChats")
      .withIndex("by_organization_and_monitored", (q) => q.eq("organizationId", args.organizationId).eq("monitored", true))) {
      if (g.ai?.mode === "mention") groups++;
      if (++groupsSeen >= SCAN_CAP) {
        groupsTruncated = true;
        break;
      }
    }
    return {
      channels: {
        active,
        limit: Number.isFinite(ent.limits.channels) ? ent.limits.channels : null,
        truncated: channelsTruncated,
      },
      aiGroups: {
        used: groups,
        limit: Number.isFinite(ent.limits.groupsWithAi) ? ent.limits.groupsWithAi : null,
        truncated: groupsTruncated,
      },
    };
  },
});

// ── getUsageHistory ─────────────────────────────────────────────────────────

export const getUsageHistory = query({
  args: { organizationId: v.id("organizations"), months: v.optional(v.number()) },
  returns: v.array(
    v.object({
      month: v.string(),
      attendances: v.number(),
      included: v.number(),
      credit: v.number(),
      overage: v.number(),
      suggestOnly: v.number(),
      overageBrlCents: v.number(),
      campaignSends: v.number(),
      runs: v.number(),
      costUsdMicros: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const months = args.months ?? 6;
    if (!Number.isInteger(months) || months < 1 || months > 12) {
      throw new ConvexError("months deve ser um inteiro entre 1 e 12");
    }
    const ai = await ctx.db
      .query("aiUsageMonthly")
      .withIndex("by_organization_and_month", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(months);
    const meters = await ctx.db
      .query("orgUsageMonthly")
      .withIndex("by_organization_and_month", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(months);
    const byMonth = new Map(meters.map((m) => [m.month, m]));
    const aiMonths = new Set(ai.map((a) => a.month));
    const rowFor = (month: string, a: Doc<"aiUsageMonthly"> | null, m: Doc<"orgUsageMonthly"> | undefined) => ({
      month,
      attendances: totalAttendances(a, m),
      included: m?.attendancesIncluded ?? 0,
      credit: m?.attendancesCredit ?? 0,
      overage: m?.attendancesOverage ?? 0,
      suggestOnly: m?.attendancesSuggestOnly ?? 0,
      overageBrlCents: m?.overageBrlCents ?? 0,
      campaignSends: m?.campaignSends ?? 0,
      runs: a?.runs ?? 0,
      costUsdMicros: a?.costUsdMicros ?? 0,
    });
    const rows = ai.map((a) => rowFor(a.month, a, byMonth.get(a.month)));
    for (const m of meters) {
      if (!aiMonths.has(m.month)) rows.push(rowFor(m.month, null, m));
    }
    rows.sort((a, b) => (a.month < b.month ? 1 : -1));
    return rows.slice(0, months);
  },
});

// ── listAttendances ─────────────────────────────────────────────────────────

export const listAttendances = query({
  args: {
    organizationId: v.id("organizations"),
    month: v.string(),
    billing: v.optional(attendanceBillingValidator),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(
    v.object({
      id: v.id("aiAttendances"),
      contactLabel: v.string(),
      billing: attendanceBillingValidator,
      firstAt: v.number(),
      unitPriceBrlCents: v.union(v.number(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "view");
    if (!isValidMonthKey(args.month)) throw new ConvexError("Informe o mês no formato AAAA-MM");
    if (args.paginationOpts.numItems > MAX_PAGE) throw new ConvexError(`Peça no máximo ${MAX_PAGE} itens por página`);
    const perms = resolvePermissions(member.role as Role, member.permissions as never);
    const canSeeNames = hasPermission(perms, "contacts", "view");

    const billingFilter = args.billing;
    const result = billingFilter
      ? await ctx.db
          .query("aiAttendances")
          .withIndex("by_organization_and_month_and_billing", (q) =>
            q.eq("organizationId", args.organizationId).eq("month", args.month).eq("billing", billingFilter)
          )
          .order("desc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("aiAttendances")
          .withIndex("by_organization_and_month_and_firstAt", (q) =>
            q.eq("organizationId", args.organizationId).eq("month", args.month)
          )
          .order("desc")
          .paginate(args.paginationOpts);

    const page = await Promise.all(
      result.page.map(async (row) => {
        let name: string | undefined;
        const contactId = ctx.db.normalizeId("contacts", row.contactKey);
        if (contactId) {
          const contact = await ctx.db.get(contactId);
          if (contact && contact.organizationId === args.organizationId) {
            name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || undefined;
          }
        } else {
          const leadId = ctx.db.normalizeId("leads", row.contactKey);
          const lead = leadId ? await ctx.db.get(leadId) : null;
          // O título do lead sem contato pode ser telefone/e-mail: passa pelo filtro abaixo.
          if (lead && lead.organizationId === args.organizationId) name = lead.title;
        }
        return {
          id: row._id,
          contactLabel: canSeeNames ? safeContactName(name) : initialsOf(name),
          billing: row.billing,
          firstAt: row.firstAt,
          unitPriceBrlCents: row.unitPriceBrlCents ?? null,
        };
      })
    );
    return { ...result, page };
  },
});

// ── setOverage ──────────────────────────────────────────────────────────────

const FALE_COM_A_GENTE =
  "O excedente só está disponível em planos contratados e ativos. Fale com a gente para ativar o seu plano.";

export const setOverage = mutation({
  args: {
    organizationId: v.id("organizations"),
    enabled: v.boolean(),
    /** R$ inteiro, 1 a 100.000. Ao desligar pode ser omitido (mantém o teto anterior). */
    capBrl: v.optional(v.number()),
  },
  returns: v.object({ enabled: v.boolean(), capBrl: v.number() }),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx, member.userId);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    const billing = org.billing;
    // Sem plano/legacy nunca. Teste, só leitura e cancelada não LIGAM o excedente, mas
    // DESLIGAR é permitido em qualquer status com plano (é a saída a favor do cliente).
    if (!billing || !billing.plan || billing.status === "legacy") {
      throw new ConvexError(FALE_COM_A_GENTE);
    }
    if (args.enabled && billing.status !== "active" && billing.status !== "past_due") {
      throw new ConvexError(FALE_COM_A_GENTE);
    }
    const capBrl = args.capBrl ?? (args.enabled ? undefined : billing.overage?.capBrl ?? 1);
    if (capBrl === undefined || !isValidOverageCap(capBrl)) {
      throw new ConvexError("O teto do excedente deve ser um valor inteiro entre R$ 1 e R$ 100.000");
    }
    const now = Date.now();
    const { updatedAt: _ignored, ...current } = billing;
    void _ignored;
    await applySubscriptionChange(ctx, {
      organizationId: args.organizationId,
      patch: {
        billing: {
          ...current,
          overage: { enabled: args.enabled, capBrl, updatedAt: now, updatedBy: member._id },
        },
      },
      source: "customer",
      reason: args.enabled ? `Excedente ligado com teto de R$ ${capBrl}` : "Excedente desligado",
      actor: member._id,
      severity: "high",
    });
    return { enabled: args.enabled, capBrl };
  },
});

// ── startCheckout (self-service de assinatura pelo Asaas) ───────────────────

/**
 * Cria cliente + assinatura no Asaas e devolve o link da 1ª fatura (hospedada: o cliente escolhe
 * Pix, boleto ou cartão lá; nenhum dado de cartão passa por aqui). `settings:manage` + conta com
 * e-mail. O preço é SEMPRE calculado no servidor pelo catálogo (o `priceLock` da org vence); o
 * cliente não envia valor. O status da org NÃO muda aqui: só o pagamento confirmado libera o plano.
 */
export const startCheckout = action({
  args: {
    organizationId: v.id("organizations"),
    plan: planKeyValidator,
    cycle: v.union(v.literal("monthly"), v.literal("yearly")),
    groupsAddon: v.optional(v.boolean()),
    billingName: v.string(),
    document: v.string(),
    billingEmail: v.string(),
  },
  returns: v.object({ invoiceUrl: v.union(v.string(), v.null()), priceSource: v.union(v.literal("price_lock"), v.literal("table")) }),
  handler: async (ctx, args): Promise<{ invoiceUrl: string | null; priceSource: "price_lock" | "table" }> => {
    if (!isAsaasEnabled()) {
      throw new ConvexError("A assinatura online ainda não está disponível. Fale com a gente para contratar.");
    }
    if (args.plan === "empresa") throw new ConvexError(FALE_COM_A_GENTE_EMPRESA);
    const billingName = args.billingName.trim();
    if (billingName.length < 2 || billingName.length > 120) {
      throw new ConvexError("Informe o nome ou a razão social para a nota fiscal (2 a 120 caracteres).");
    }
    if (!isValidCpfCnpj(args.document)) throw new ConvexError("CPF ou CNPJ inválido. Confira os números e tente de novo.");
    const billingEmail = args.billingEmail.trim().toLowerCase();
    if (!isDeliverableEmail(billingEmail)) throw new ConvexError("Informe um e-mail financeiro válido.");

    // Autoriza (settings:manage + conta com e-mail) e lê o necessário.
    const info = await ctx.runQuery(internal.billingAsaas.internalCheckoutContext, { organizationId: args.organizationId });
    const now = Date.now();
    // Mesma decisão da prévia (`previewCheckout`): plano ativo recusa, senão o preço do servidor.
    const evaluation = evaluateCheckout({
      plan: args.plan,
      cycle: args.cycle,
      groupsAddon: args.groupsAddon === true,
      org: { status: info.status, plan: info.plan, extraChannels: info.extraChannels, priceLock: info.priceLock },
      now,
    });
    if (!evaluation.ok) throw new ConvexError(evaluation.refusal);
    const priced = { price: evaluation.price };

    await ctx.runMutation(internal.billingAsaas.internalBeginCheckout, { organizationId: args.organizationId });
    const trialValid = info.status === "trial" && info.trialEndsAt !== null && info.trialEndsAt > now;
    const out = await runAsaasCheckout(ctx, {
      organizationId: args.organizationId,
      plan: args.plan,
      cycle: args.cycle,
      groupsAddon: args.groupsAddon === true,
      extraChannels: info.extraChannels,
      billingName,
      document: args.document,
      billingEmail,
      monthlyBrl: priced.price.monthlyBrl,
      chargeBrl: priced.price.chargeBrl,
      nextDueDate: firstDueDate(now, trialValid ? (info.trialEndsAt ?? undefined) : undefined),
      quiet: info.quiet,
      previousSubscriptionId: info.providerSubscriptionId,
    });
    return { invoiceUrl: out.invoiceUrl, priceSource: priced.price.priceSource };
  },
});

// ── listInvoices ────────────────────────────────────────────────────────────

const INVOICES_LIMIT = 24;

/**
 * Faturas da org (as 24 mais recentes por vencimento). `settings:view`. Sem PII: o link da fatura
 * é a página hospedada do Asaas; documento, e-mail e ids do provedor nunca saem daqui.
 */
export const listInvoices = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(
    v.object({
      id: v.id("billingInvoices"),
      kind: v.string(),
      description: v.string(),
      amountCents: v.number(),
      dueDate: v.number(),
      status: v.union(v.literal("pending"), v.literal("paid"), v.literal("overdue"), v.literal("canceled"), v.literal("refunded")),
      paidAt: v.union(v.number(), v.null()),
      paymentMethod: v.union(v.literal("pix"), v.literal("boleto"), v.literal("card"), v.literal("transfer"), v.null()),
      invoiceUrl: v.union(v.string(), v.null()),
      nfseNumber: v.union(v.string(), v.null()),
      nfseUrl: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const rows = await ctx.db
      .query("billingInvoices")
      .withIndex("by_organization_and_due_date", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(INVOICES_LIMIT);
    return rows.map((r) => ({
      id: r._id,
      kind: r.kind,
      description: r.description,
      amountCents: r.amountCents,
      dueDate: r.dueDate,
      status: r.status,
      paidAt: r.paidAt ?? null,
      paymentMethod: r.paymentMethod ?? null,
      invoiceUrl: r.invoiceUrl ?? null,
      nfseNumber: r.nfseNumber ?? null,
      nfseUrl: r.nfseUrl ?? null,
    }));
  },
});

// ── previewCheckout (prévia do preço antes de assinar) ──────────────────────

/**
 * Prévia do que o `startCheckout` vai cobrar: roda EXATAMENTE a mesma `evaluateCheckout` com o
 * billing real da org (plano, canais extras, trava). `settings:view`. Sem relógio: `now` (do
 * cliente, arredondado) só decide se a trava já venceu, como em `getUsageSummary`; ausente = a
 * trava vale. Devolve `refusal` (Empresa, plano ativo, add-on inválido) em vez de lançar.
 */
export const previewCheckout = query({
  args: {
    organizationId: v.id("organizations"),
    plan: planKeyValidator,
    cycle: v.union(v.literal("monthly"), v.literal("yearly")),
    groupsAddon: v.optional(v.boolean()),
    now: v.optional(v.number()),
  },
  returns: v.object({
    chargeBrl: v.union(v.number(), v.null()),
    listBrl: v.union(v.number(), v.null()),
    monthlyBrl: v.union(v.number(), v.null()),
    priceSource: v.union(v.literal("price_lock"), v.literal("table"), v.null()),
    lines: v.array(v.object({ id: v.string(), label: v.string(), amountBrl: v.number() })),
    cycleMonths: v.number(),
    refusal: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    const now = args.now ?? 0;
    const groupsAddon = args.groupsAddon === true;
    const evaluation = evaluateCheckout({
      plan: args.plan,
      cycle: args.cycle,
      groupsAddon,
      org: {
        status: org.billing?.status ?? null,
        plan: org.billing?.plan ?? null,
        extraChannels: org.billing?.extraChannels ?? 0,
        priceLock: org.billing?.priceLock ?? null,
      },
      now,
    });
    const cycleMonths = args.cycle === "yearly" ? 10 : 1;
    if (!evaluation.ok) {
      return { chargeBrl: null, listBrl: null, monthlyBrl: null, priceSource: null, lines: [], cycleMonths, refusal: evaluation.refusal };
    }
    const { price } = evaluation;
    // Linhas mensais (a cobrança do ciclo é `monthly × cycleMonths`): plano, canais extras, add-on e
    // o ajuste da trava (valor combinado ou desconto) como diferença para a tabela.
    const est = estimateInvoice({
      plan: args.plan,
      extraChannels: org.billing?.extraChannels,
      groupsAddon,
      now,
    });
    const lines: Array<{ id: string; label: string; amountBrl: number }> = [
      { id: "plan", label: `Plano ${PLANS[args.plan].label}`, amountBrl: est.planBrl },
    ];
    if (est.extraChannelsBrl > 0) lines.push({ id: "extra_channels", label: "Canais extras", amountBrl: est.extraChannelsBrl });
    if (est.groupsAddonBrl > 0) lines.push({ id: "groups_addon", label: "Add-on Grupos", amountBrl: est.groupsAddonBrl });
    const adjustment = Math.round((price.monthlyBrl - est.listBrl) * 100) / 100;
    if (adjustment !== 0) lines.push({ id: "price_lock", label: adjustment < 0 ? "Desconto combinado" : "Preço combinado", amountBrl: adjustment });
    return {
      chargeBrl: price.chargeBrl,
      listBrl: Math.round(price.listMonthlyBrl * cycleMonths * 100) / 100,
      monthlyBrl: price.monthlyBrl,
      priceSource: price.priceSource,
      lines,
      cycleMonths,
    };
  },
});

// ── getCheckoutPrefill (pré-preenche o formulário do checkout) ──────────────

/**
 * Dados de cobrança que a própria org já informou num checkout anterior (razão social, e-mail
 * financeiro, CPF/CNPJ), para o formulário vir preenchido. É dado de cobrança (PII): só
 * `settings:manage`. Quem não pode (ou não é membro) recebe `null`, sem erro: o front apenas não
 * pré-preenche. Nunca devolve ids do provedor.
 */
export const getCheckoutPrefill = query({
  args: { organizationId: v.id("organizations") },
  returns: v.union(
    v.null(),
    v.object({
      billingName: v.union(v.string(), v.null()),
      billingEmail: v.union(v.string(), v.null()),
      document: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const member = await getActiveMembership(ctx, args.organizationId, userId);
    if (!member) return null;
    const perms = resolvePermissions(member.role as Role, member.permissions as never);
    if (!hasPermission(perms, "settings", "manage")) return null;
    const sub = await loadSubscription(ctx, args.organizationId);
    if (!sub) return null;
    const out = {
      billingName: sub.billingName ?? null,
      billingEmail: sub.billingEmail ?? null,
      document: sub.billingDocument ?? null,
    };
    return out.billingName || out.billingEmail || out.document ? out : null;
  },
});
