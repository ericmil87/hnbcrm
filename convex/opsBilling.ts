/**
 * Ops de billing (B1). Tudo `internal*`, `dryRun` default true; quem roda é o
 * operador (`npx convex run --prod opsBilling:...` só depois de um dry run).
 * A escrita de `organizations.billing` passa pela porta
 * `lib/entitlementsOps.applySubscriptionChange`. Saída sem e-mail/telefone.
 * Ordem de migração: docs do plano de precificação (§4).
 */
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { orgBillingValidator } from "./schema";
import { applySubscriptionChange, validateBillingChange, type OrgBillingInput } from "./lib/entitlementsOps";
import { resolveEntitlements } from "./lib/entitlements";
import { MODULE_GATE, type GatedModule } from "./lib/plans";
import { monthKeyUtc } from "./lib/aiSpend";
import { maskDigitRuns } from "./lib/telegramFormat";

const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_NOTICE_DAYS = 60;

const planValidator = orgBillingValidator.fields.plan;
const statusValidator = orgBillingValidator.fields.status;

function assertInt(name: string, n: number, min: number, max: number) {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new ConvexError(`${name} deve ser um inteiro entre ${min} e ${max}`);
  }
}

const OVERRIDE_MAX = 10_000_000;
const PRICE_LOCK_MAX_BRL = 1_000_000;

/** Módulos ligados na org que ficariam fora do plano (avisa; NUNCA desliga). */
function modulesOutsidePlan(org: Doc<"organizations">, next: OrgBillingInput, now: number): string[] {
  // Compara pelo plano, ignorando o bloqueio de status (read_only zera tudo).
  const probe = resolveEntitlements(
    { settings: org.settings, billing: { ...next, status: next.status === "legacy" ? "legacy" : "active", updatedAt: now } },
    now
  );
  const enabled = org.settings.modules ?? {};
  const out: string[] = [];
  for (const [key, gate] of Object.entries(MODULE_GATE) as [keyof typeof enabled, GatedModule][]) {
    if (enabled[key] === true && !probe.modules[gate]) out.push(String(key));
  }
  return out;
}

export const internalSetOrgPlan = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    plan: planValidator,
    status: statusValidator,
    units: v.optional(v.number()),
    extraChannels: v.optional(v.number()),
    addons: v.optional(v.object({ groups: v.optional(v.boolean()) })),
    overrides: orgBillingValidator.fields.overrides,
    priceLock: orgBillingValidator.fields.priceLock,
    trialEndsAt: v.optional(v.number()),
    /** Permite `trialEndsAt` no passado (teste vencido de propósito). */
    force: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    applied: v.boolean(),
    before: v.union(orgBillingValidator, v.null()),
    after: orgBillingValidator,
    outOfPlanModules: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    const now = Date.now();

    if (args.plan === "empresa") {
      const units = args.units ?? org.billing?.units;
      if (units === undefined) throw new ConvexError("Empresa exige units (>= 1)");
      assertInt("units", units, 1, 1000);
    } else if (args.units !== undefined) {
      throw new ConvexError("units só vale para o plano Empresa");
    }
    if (args.extraChannels !== undefined) assertInt("extraChannels", args.extraChannels, 0, 1000);
    if (args.addons?.groups === true && args.plan !== "essencial") {
      throw new ConvexError("O add-on Grupos só existe no Essencial");
    }
    if (args.status === "trial") {
      const trialEndsAt = args.trialEndsAt ?? org.billing?.trialEndsAt;
      if (trialEndsAt === undefined) throw new ConvexError("Status trial exige trialEndsAt");
      if (trialEndsAt <= now && args.force !== true) {
        throw new ConvexError("trialEndsAt deve estar no futuro (use force para um teste já vencido)");
      }
    }
    const ov = args.overrides;
    if (ov) {
      if (ov.aiAttendances !== undefined) assertInt("overrides.aiAttendances", ov.aiAttendances, 0, OVERRIDE_MAX);
      if (ov.campaignSends !== undefined) assertInt("overrides.campaignSends", ov.campaignSends, 0, OVERRIDE_MAX);
      if (ov.channels !== undefined) assertInt("overrides.channels", ov.channels, 0, 1000);
      if (ov.groupsWithAi !== undefined) assertInt("overrides.groupsWithAi", ov.groupsWithAi, 0, 1000);
    }
    if (args.priceLock) {
      if (args.priceLock.monthlyBrl !== undefined) {
        assertInt("priceLock.monthlyBrl", args.priceLock.monthlyBrl, 0, PRICE_LOCK_MAX_BRL);
      }
      if (args.priceLock.discountPct !== undefined) {
        if (!(args.priceLock.discountPct >= 0 && args.priceLock.discountPct <= 100)) {
          throw new ConvexError("discountPct deve estar entre 0 e 100");
        }
      }
    }

    const { updatedAt: _u, ...current } = org.billing ?? ({ updatedAt: 0 } as { updatedAt: number });
    void _u;
    const next = {
      ...current,
      plan: args.plan,
      status: args.status,
      ...(args.plan === "empresa" ? { units: args.units ?? org.billing?.units } : {}),
      ...(args.extraChannels !== undefined ? { extraChannels: args.extraChannels } : {}),
      ...(args.addons !== undefined ? { addons: args.addons } : {}),
      ...(args.overrides !== undefined ? { overrides: args.overrides } : {}),
      ...(args.priceLock !== undefined ? { priceLock: args.priceLock } : {}),
      ...(args.trialEndsAt !== undefined ? { trialEndsAt: args.trialEndsAt } : {}),
    } as OrgBillingInput;
    if (args.plan !== "empresa") delete next.units;
    if (args.plan !== "essencial" && next.addons) next.addons = { ...next.addons, groups: undefined };

    // A MESMA validação da porta, antes do dry run: ele não aprova o que a porta recusa.
    validateBillingChange(org.billing ?? null, next, "ops");

    const outOfPlanModules = modulesOutsidePlan(org, next, now);
    if (dryRun) {
      return {
        dryRun,
        applied: false,
        before: org.billing ?? null,
        after: { ...next, updatedAt: now },
        outOfPlanModules,
      };
    }
    const res = await applySubscriptionChange(ctx, {
      organizationId: args.organizationId,
      patch: { billing: next },
      source: "ops",
      reason: "internalSetOrgPlan",
    });
    return { dryRun, applied: true, before: res.before, after: res.after!, outOfPlanModules };
  },
});

export const internalGrantCredits = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    attendances: v.number(),
    months: v.optional(v.number()),
    source: v.union(v.literal("pack"), v.literal("courtesy"), v.literal("migration")),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    granted: v.number(),
    expiresAt: v.number(),
    creditId: v.union(v.id("usageCredits"), v.null()),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    assertInt("attendances", args.attendances, 1, 1_000_000);
    const months = args.months ?? 12;
    assertInt("months", months, 1, 36);
    const now = Date.now();
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() + months);
    const expiresAt = d.getTime();
    if (dryRun) return { dryRun, granted: args.attendances, expiresAt, creditId: null };
    const creditId = await ctx.db.insert("usageCredits", {
      organizationId: args.organizationId,
      kind: "ai_attendances",
      granted: args.attendances,
      consumed: 0,
      expiresAt,
      source: args.source,
      createdAt: now,
      createdBy: "ops",
    });
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "create",
      actorType: "system",
      metadata: { kind: "usage_credit", creditId, attendances: args.attendances, months, source: args.source },
      description: "Pacote de atendimentos IA creditado",
      severity: "medium",
      createdAt: now,
    });
    return { dryRun, granted: args.attendances, expiresAt, creditId };
  },
});

/**
 * Orgs sem `billing` viram `legacy` (sem plano). `legacyNoticeAt`/`legacyUntil` só são
 * gravados com `noticeAt` EXPLÍCITO; sem ele fica só `{status:"legacy"}`. Com `noticeAt`, orgs que já
 * são `legacy` mas sem `legacyNoticeAt` (as criadas pelo cadastro novo) também recebem
 * a data do aviso. SEM audit por org (`audit:"none"` na porta): o Histórico de cada org
 * não pode mostrar uma linha de billing antes do aviso; a contagem sai no retorno.
 */
export const internalBackfillLegacy = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    /** Data do aviso dos 60 dias (epoch ms). Padrão: agora, fixado na 1ª página. */
    noticeAt: v.optional(v.number()),
    /** Uso interno do reagendamento: preencher o aviso em orgs legacy sem data. */
    fillNotice: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    changed: v.number(),
    noticeFilled: v.number(),
    skipped: v.number(),
    noticeAt: v.number(),
    legacyUntil: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const pageSize = Math.min(Math.max(Math.floor(args.pageSize ?? 100), 1), 150);
    const fillNotice = args.fillNotice ?? args.noticeAt !== undefined;
    const noticeAt = args.noticeAt ?? Date.now();
    assertInt("noticeAt", noticeAt, 0, 8_640_000_000_000_000);
    const legacyUntil = noticeAt + LEGACY_NOTICE_DAYS * DAY_MS;
    const page = await ctx.db.query("organizations").paginate({ numItems: pageSize, cursor: args.cursor ?? null });
    let changed = 0;
    let noticeFilled = 0;
    let skipped = 0;
    for (const org of page.page) {
      const current = org.billing;
      const needsLegacy = !current;
      const needsNotice = fillNotice && current?.status === "legacy" && current.legacyNoticeAt === undefined;
      if (!needsLegacy && !needsNotice) {
        skipped++;
        continue;
      }
      if (needsLegacy) changed++;
      else noticeFilled++;
      if (dryRun) continue;
      const { updatedAt: _u, ...base } = current ?? { updatedAt: 0 };
      void _u;
      await applySubscriptionChange(ctx, {
        organizationId: org._id,
        // Sem `noticeAt` explícito grava só `{status:"legacy"}`: o aviso dos 60 dias é uma
        // decisão de data do operador, nunca um padrão "agora".
        patch: {
          billing: fillNotice
            ? { ...base, status: "legacy", legacyNoticeAt: noticeAt, legacyUntil }
            : { ...base, status: "legacy" },
        },
        source: "ops",
        reason: "internalBackfillLegacy",
        audit: "none",
      });
    }
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.opsBilling.internalBackfillLegacy, {
        cursor: page.continueCursor,
        pageSize,
        noticeAt,
        fillNotice,
        dryRun: false,
      });
    }
    return {
      dryRun,
      scanned: page.page.length,
      changed,
      noticeFilled,
      skipped,
      noticeAt,
      legacyUntil,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** Só leitura: o "painel do operador" até existir cobrança. Sem e-mail/telefone. */
export const internalBillingReport = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    /** Obrigatório: query não lê o relógio. Quem roda passa `Date.now()`. */
    now: v.number(),
  },
  returns: v.object({
    month: v.string(),
    rows: v.array(
      v.object({
        organizationId: v.id("organizations"),
        name: v.string(),
        status: v.string(),
        plan: v.union(v.string(), v.null()),
        units: v.union(v.number(), v.null()),
        extraChannels: v.number(),
        activeChannels: v.number(),
        aiConversationsThisMonth: v.number(),
        aiAttendancesLimit: v.union(v.number(), v.null()),
        trialEndsInDays: v.union(v.number(), v.null()),
        trialEndingSoon: v.boolean(),
        legacyUntil: v.union(v.number(), v.null()),
      })
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const now = args.now;
    const month = monthKeyUtc(now);
    const pageSize = Math.min(Math.max(Math.floor(args.pageSize ?? 50), 1), 100);
    const page = await ctx.db.query("organizations").paginate({ numItems: pageSize, cursor: args.cursor ?? null });
    const rows = [];
    for (const org of page.page) {
      const ent = resolveEntitlements(org, now);
      const usage = await ctx.db
        .query("aiUsageMonthly")
        .withIndex("by_organization_and_month", (q) => q.eq("organizationId", org._id).eq("month", month))
        .unique();
      // Itera o índice (sem `take` + filtro, que subconta org com muitos canais);
      // o teto é só uma trava de segurança de leitura.
      let activeChannels = 0;
      let seen = 0;
      for await (const c of ctx.db
        .query("channelConfigs")
        .withIndex("by_organization", (q) => q.eq("organizationId", org._id))) {
        if (c.status !== "disabled") activeChannels++;
        if (++seen >= 500) break;
      }
      const trialEndsAt = org.billing?.status === "trial" ? org.billing.trialEndsAt : undefined;
      const days = trialEndsAt === undefined ? null : Math.ceil((trialEndsAt - now) / DAY_MS);
      rows.push({
        organizationId: org._id,
        name: maskDigitRuns(org.name),
        status: ent.status,
        plan: org.billing?.plan ?? null,
        units: org.billing?.units ?? null,
        extraChannels: org.billing?.extraChannels ?? 0,
        activeChannels,
        aiConversationsThisMonth: usage?.conversations ?? 0,
        aiAttendancesLimit: Number.isFinite(ent.limits.aiAttendances) ? ent.limits.aiAttendances : null,
        trialEndsInDays: days,
        trialEndingSoon: days !== null && days <= 7,
        legacyUntil: org.billing?.legacyUntil ?? null,
      });
    }
    return { month, rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
