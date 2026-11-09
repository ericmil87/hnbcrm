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
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireAccountWithEmail, requireAuth, requirePermission } from "./lib/auth";
import { hasPermission, resolvePermissions, type Role } from "./lib/permissions";
import { applySubscriptionChange } from "./lib/entitlementsOps";
import { attendanceBillingValidator } from "./schema";
import { isValidMonthKey, monthStartUtcMs, nextMonthStartUtcMs } from "./lib/aiSpend";
import { totalAttendances } from "./lib/attendanceLedger";

import { buildMyEntitlements, initialsOf, isValidOverageCap, resolvePlanView } from "./lib/billingViews";
import { estimateInvoice } from "./lib/billingMath";

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
const byKindValidator = v.record(v.string(), v.object({ runs: v.number(), costUsdMicros: v.number() }));
const MAX_PAGE = 100;
const SCAN_CAP = 1000;

// ── getMyEntitlements ───────────────────────────────────────────────────────

export const getMyEntitlements = query({
  args: { organizationId: v.id("organizations") },
  returns: v.object({
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
    pricing: v.optional(
      v.object({
        listMonthlyBrl: v.union(v.number(), v.null()),
        priceLock: v.union(priceLockValidator, v.null()),
      })
    ),
  }),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const perms = resolvePermissions(member.role as Role, member.permissions as never);
    const org = await ctx.db.get(args.organizationId);
    return buildMyEntitlements(org, hasPermission(perms, "settings", "view"));
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
          .withIndex("by_organization_and_month_and_contact", (q) =>
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
          if (lead && lead.organizationId === args.organizationId) name = lead.title;
        }
        return {
          id: row._id,
          contactLabel: canSeeNames ? (name ?? "Contato") : initialsOf(name),
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
    // Teste, legacy, sem plano e só leitura/cancelada não ligam excedente.
    if (!billing || !billing.plan || (billing.status !== "active" && billing.status !== "past_due")) {
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
