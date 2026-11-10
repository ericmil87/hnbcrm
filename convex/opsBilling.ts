/**
 * Ops de billing (B1). Tudo `internal*`, `dryRun` default true; quem roda é o
 * operador (`npx convex run --prod opsBilling:...` só depois de um dry run).
 * A escrita de `organizations.billing` passa pela porta
 * `lib/entitlementsOps.applySubscriptionChange`. Saída sem e-mail/telefone.
 * Ordem de migração: docs do plano de precificação (§4).
 */
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { orgBillingValidator } from "./schema";
import { applySubscriptionChange, validateBillingChange, type OrgBillingInput } from "./lib/entitlementsOps";
import { resolveEntitlements } from "./lib/entitlements";
import { MODULE_GATE, PLANS, type GatedModule } from "./lib/plans";
import { isValidMonthKey, monthKeyUtc, monthStartUtcMs, nextMonthStartUtcMs } from "./lib/aiSpend";
import { contactKeyOf, getOrgUsageMonthly, recordAttendance, totalAttendances } from "./lib/attendanceLedger";
import { agentRunsRetentionCutoff } from "./retention";
import { rearmScheduledMessagesForOrg } from "./billingCron";
import {
  ASAAS_WEBHOOK_EVENTS,
  asaasConfig,
  asaasWebhookToken,
  AsaasError,
  createWebhook,
  getAccountName,
  getPayment,
  isAsaasEnabled,
  listWebhooks,
} from "./lib/asaasApi";
import { isValidCpfCnpj, maskCpfCnpj } from "./lib/brDocument";
import { dayToMs, invoiceStatusOf } from "./lib/billingInvoices";
import { resolvePeriod } from "./lib/billingPeriod";
import { isDeliverableEmail } from "./lib/emailAddress";
import { firstDueDate, priceCheckout } from "./lib/checkoutPricing";
import { runAsaasCheckout } from "./lib/asaasCheckout";
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
    /** Silencia todos os avisos de plano da org (`billing.quiet`). */
    quiet: v.optional(v.boolean()),
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
    // Teto de canais extra do plano (vale também ao trocar de plano mantendo os extras gravados).
    const effectiveExtra = args.extraChannels ?? org.billing?.extraChannels ?? 0;
    const maxExtra = args.plan !== undefined ? PLANS[args.plan].maxExtraChannels : null;
    if (args.plan !== undefined && maxExtra !== null && effectiveExtra > maxExtra) {
      throw new ConvexError(
        `O plano ${PLANS[args.plan].label} aceita até ${maxExtra} canais extras (pedido: ${effectiveExtra}). Escolha um plano maior.`
      );
    }
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
      ...(args.quiet !== undefined ? { quiet: args.quiet } : {}),
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
    const wasBlocked = !resolveEntitlements(org, now).outboundAllowed;
    const res = await applySubscriptionChange(ctx, {
      organizationId: args.organizationId,
      patch: { billing: next },
      source: "ops",
      reason: "internalSetOrgPlan",
    });
    // Saiu do modo leitura: as mensagens agendadas (que ficaram pending) são re-armadas.
    // Campanhas pausadas com `plan_read_only` NÃO são retomadas: o cliente retoma.
    if (wasBlocked && res.after && resolveEntitlements({ settings: org.settings, billing: res.after }, now).outboundAllowed) {
      await rearmScheduledMessagesForOrg(ctx, args.organizationId);
    }
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
        /** Trava CONGELADA vencida: não reprecifica sozinha; avisar o cliente e o Eric decide. */
        frozenLockExpired: v.boolean(),
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
        aiConversationsThisMonth: totalAttendances(usage, await getOrgUsageMonthly(ctx, org._id, month)),
        aiAttendancesLimit: Number.isFinite(ent.limits.aiAttendances) ? ent.limits.aiAttendances : null,
        trialEndsInDays: days,
        trialEndingSoon: days !== null && days <= 7,
        frozenLockExpired:
          org.billing?.priceLock?.kind === "frozen" &&
          org.billing.priceLock.until !== undefined &&
          org.billing.priceLock.until <= now,
        legacyUntil: org.billing?.legacyUntil ?? null,
      });
    }
    return { month, rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

const BACKFILL_ORG_SCAN = 1000;
const COST_AUDIT_SCAN = 2000;

/**
 * Percorre runs `attendant` TERMINADAS COM SUCESSO e conta (ou grava, com `record`) o
 * contato distinto de cada uma que ainda não tem linha no mês. Run com erro/abortada não
 * vira atendimento (B4).
 */
async function scanAttendantRuns(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; month: string; runs: Doc<"agentRuns">[]; record: boolean }
): Promise<{ newContacts: number; inserted: number }> {
  let newContacts = 0;
  let inserted = 0;
  const seen = new Set<string>();
  for (const run of args.runs) {
    if (run.kind !== "attendant" || run.status !== "done" || !run.conversationId || !run.leadId) continue;
    const lead = await ctx.db.get(run.leadId);
    if (!lead || lead.organizationId !== args.organizationId) continue;
    const contactKey = contactKeyOf(lead);
    if (seen.has(contactKey)) continue;
    seen.add(contactKey);
    const existing = await ctx.db
      .query("aiAttendances")
      .withIndex("by_organization_and_month_and_contact", (q) =>
        q.eq("organizationId", args.organizationId).eq("month", args.month).eq("contactKey", contactKey)
      )
      .first();
    if (existing) continue;
    newContacts++;
    if (!args.record) continue;
    const res = await recordAttendance(ctx, {
      organizationId: args.organizationId,
      month: args.month,
      contactKey,
      conversationId: run.conversationId,
      firstAt: run.startedAt,
      billing: "legacy",
      mode: "backfill",
    });
    if (res.inserted) inserted++;
  }
  return { newContacts, inserted };
}

/**
 * Recria o livro `aiAttendances` de um mês a partir de `agentRuns` (kind `attendant`
 * que TERMINARAM bem: run com erro/abortada não vira atendimento, B4). Modo `backfill`:
 * insere a linha com classe `legacy` e NÃO incrementa o contador (A1: ele já foi
 * alimentado pelo claim antigo/`internalBackfillMonthlyUsage`). Idempotente.
 *
 * Aproximação: uma run `done` que decidiu "nada a enviar" (follow-up) também vira linha;
 * o livro só é cobrado a partir do B6, e o dry run mostra os números antes.
 *
 * Sem `organizationId`: pagina as ORGS por `cursor`/`pageSize`. O dry run devolve
 * `perOrg` (contatos novos por org, lendo até ${BACKFILL_ORG_SCAN} runs de cada; `truncated`
 * avisa quando passou disso); a run real agenda uma execução por org da página e a
 * próxima página de orgs.
 */
export const internalBackfillAttendances = internalMutation({
  args: {
    month: v.string(),
    organizationId: v.optional(v.id("organizations")),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    month: v.string(),
    organizationId: v.union(v.id("organizations"), v.null()),
    scannedRuns: v.number(),
    newContacts: v.number(),
    inserted: v.number(),
    scheduled: v.number(),
    perOrg: v.array(
      v.object({ organizationId: v.id("organizations"), newContacts: v.number(), truncated: v.boolean() })
    ),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
    warning: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    if (!isValidMonthKey(args.month)) throw new ConvexError("Mês inválido (use AAAA-MM)");
    const start = monthStartUtcMs(args.month);
    const end = nextMonthStartUtcMs(args.month);
    const cutoff = agentRunsRetentionCutoff(Date.now());
    const warning =
      start < cutoff
        ? `As runs de ${args.month} podem já ter sido apagadas pela retenção de agentRuns: o livro sairia incompleto.`
        : null;
    if (warning && !dryRun) throw new ConvexError(`Backfill recusado: ${warning}`);

    if (!args.organizationId) {
      const pageSize = Math.min(Math.max(Math.floor(args.pageSize ?? 20), 1), 50);
      const orgPage = await ctx.db.query("organizations").paginate({ numItems: pageSize, cursor: args.cursor ?? null });
      const perOrg: { organizationId: Id<"organizations">; newContacts: number; truncated: boolean }[] = [];
      let totalNew = 0;
      for (const org of orgPage.page) {
        if (dryRun) {
          const runs = await ctx.db
            .query("agentRuns")
            .withIndex("by_organization_and_started", (q) =>
              q.eq("organizationId", org._id).gte("startedAt", start).lt("startedAt", end)
            )
            .take(BACKFILL_ORG_SCAN + 1);
          const truncated = runs.length > BACKFILL_ORG_SCAN;
          const { newContacts } = await scanAttendantRuns(ctx, {
            organizationId: org._id,
            month: args.month,
            runs: truncated ? runs.slice(0, BACKFILL_ORG_SCAN) : runs,
            record: false,
          });
          totalNew += newContacts;
          perOrg.push({ organizationId: org._id, newContacts, truncated });
        } else {
          await ctx.scheduler.runAfter(0, internal.opsBilling.internalBackfillAttendances, {
            month: args.month,
            organizationId: org._id,
            dryRun: false,
          });
        }
      }
      if (!dryRun && !orgPage.isDone) {
        await ctx.scheduler.runAfter(0, internal.opsBilling.internalBackfillAttendances, {
          month: args.month,
          cursor: orgPage.continueCursor,
          pageSize,
          dryRun: false,
        });
      }
      return {
        dryRun,
        month: args.month,
        organizationId: null,
        scannedRuns: 0,
        newContacts: totalNew,
        inserted: 0,
        scheduled: dryRun ? 0 : orgPage.page.length,
        perOrg,
        isDone: orgPage.isDone,
        continueCursor: orgPage.isDone ? null : orgPage.continueCursor,
        warning,
      };
    }

    const organizationId = args.organizationId;
    const pageSize = Math.min(Math.max(Math.floor(args.pageSize ?? 150), 1), 200);
    const page = await ctx.db
      .query("agentRuns")
      .withIndex("by_organization_and_started", (q) =>
        q.eq("organizationId", organizationId).gte("startedAt", start).lt("startedAt", end)
      )
      .paginate({ numItems: pageSize, cursor: args.cursor ?? null });
    const { newContacts, inserted } = await scanAttendantRuns(ctx, {
      organizationId,
      month: args.month,
      runs: page.page,
      record: !dryRun,
    });
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.opsBilling.internalBackfillAttendances, {
        month: args.month,
        organizationId,
        cursor: page.continueCursor,
        pageSize,
        dryRun: false,
      });
    }
    return {
      dryRun,
      month: args.month,
      organizationId,
      scannedRuns: page.page.length,
      newContacts,
      inserted,
      scheduled: 0,
      perOrg: [],
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
      warning,
    };
  },
});

/**
 * Só leitura: runs concluídas com custo 0 ou ausente, por tipo e provedor, nos últimos
 * `sinceDays` (≤ 30). Mostra onde o custo some (ex.: provedor que não manda `usage` no
 * stream). Pagina por org; sem texto, e-mail ou telefone na saída.
 */
export const internalCostAudit = internalQuery({
  args: {
    sinceDays: v.optional(v.number()),
    /** Obrigatório: query não lê o relógio. */
    now: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  returns: v.object({
    sinceDays: v.number(),
    rows: v.array(
      v.object({
        kind: v.string(),
        provider: v.string(),
        finishedRuns: v.number(),
        zeroCostRuns: v.number(),
        noTokensRuns: v.number(),
      })
    ),
    /** Orgs desta página com mais runs que o teto de leitura (a contagem delas está cortada). */
    truncatedOrgs: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const sinceDays = args.sinceDays ?? 30;
    assertInt("sinceDays", sinceDays, 1, 30);
    const since = args.now - sinceDays * DAY_MS;
    const pageSize = Math.min(Math.max(Math.floor(args.pageSize ?? 25), 1), 50);
    const page = await ctx.db.query("organizations").paginate({ numItems: pageSize, cursor: args.cursor ?? null });
    const agg = new Map<string, { kind: string; provider: string; finishedRuns: number; zeroCostRuns: number; noTokensRuns: number }>();
    let truncatedOrgs = 0;
    for (const org of page.page) {
      const runs = await ctx.db
        .query("agentRuns")
        .withIndex("by_organization_and_started", (q) => q.eq("organizationId", org._id).gte("startedAt", since))
        .take(COST_AUDIT_SCAN + 1);
      if (runs.length > COST_AUDIT_SCAN) {
        truncatedOrgs++;
        runs.length = COST_AUDIT_SCAN;
      }
      for (const run of runs) {
        if (run.finishedAt === undefined || run.status === "running") continue;
        const provider = run.provider ?? "desconhecido";
        const key = `${run.kind}|${provider}`;
        const row = agg.get(key) ?? { kind: run.kind, provider, finishedRuns: 0, zeroCostRuns: 0, noTokensRuns: 0 };
        row.finishedRuns++;
        if (!run.costUsdEstimate) row.zeroCostRuns++;
        if (!run.promptTokens && !run.completionTokens) row.noTokensRuns++;
        agg.set(key, row);
      }
    }
    return { sinceDays, rows: [...agg.values()], truncatedOrgs, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

const ACTIVITY_DAYS = 30;
const ACTIVITY_SCAN_CAP = 1000;

/**
 * Só leitura: atividade dos últimos 30 dias por org, para reconferir as `canceled` ANTES do
 * deploy do B7 (que transforma `canceled` em corte real de IA e envio) e devolver a `legacy`
 * quem voltou a usar. Sem e-mail, telefone nem texto de mensagem; o nome da org sai mascarado.
 * Contagens são limitadas (`capped`) para não estourar leitura.
 */
export const internalOrgActivityReport = internalQuery({
  args: {
    /** Obrigatório: query não lê o relógio. */
    now: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  returns: v.object({
    since: v.number(),
    rows: v.array(
      v.object({
        organizationId: v.id("organizations"),
        name: v.string(),
        status: v.string(),
        plan: v.union(v.string(), v.null()),
        createdAt: v.number(),
        humanMembers: v.number(),
        activeChannels: v.number(),
        conversationsActive30d: v.number(),
        inboundConversations30d: v.number(),
        lastMessageAt: v.union(v.number(), v.null()),
        leadsCreated30d: v.number(),
        aiRuns30d: v.number(),
        capped: v.boolean(),
        /** Conta `canceled` com sinal de uso: candidata a voltar para `legacy` antes do corte. */
        looksActive: v.boolean(),
      })
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const since = args.now - ACTIVITY_DAYS * DAY_MS;
    const pageSize = Math.min(Math.max(Math.floor(args.pageSize ?? 25), 1), 50);
    const page = await ctx.db.query("organizations").paginate({ numItems: pageSize, cursor: args.cursor ?? null });
    const rows = [];
    for (const org of page.page) {
      let capped = false;
      const members = await ctx.db
        .query("teamMembers")
        .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
        .take(ACTIVITY_SCAN_CAP + 1);
      if (members.length > ACTIVITY_SCAN_CAP) capped = true;
      const humanMembers = members.filter((m) => m.type === "human" && m.removedAt === undefined && m.status !== "inactive").length;

      let activeChannels = 0;
      let seenChannels = 0;
      for await (const c of ctx.db
        .query("channelConfigs")
        .withIndex("by_organization", (q) => q.eq("organizationId", org._id))) {
        if (c.status === "active") activeChannels++;
        if (++seenChannels >= 500) {
          capped = true;
          break;
        }
      }

      const convs = await ctx.db
        .query("conversations")
        .withIndex("by_organization_and_last_message", (q) => q.eq("organizationId", org._id).gte("lastMessageAt", since))
        .order("desc")
        .take(ACTIVITY_SCAN_CAP + 1);
      if (convs.length > ACTIVITY_SCAN_CAP) capped = true;
      const counted = convs.slice(0, ACTIVITY_SCAN_CAP);
      const inboundConversations30d = counted.filter((c) => (c.lastInboundAt ?? 0) >= since).length;

      const leads = await ctx.db
        .query("leads")
        .withIndex("by_organization_and_created", (q) => q.eq("organizationId", org._id).gte("createdAt", since))
        .take(ACTIVITY_SCAN_CAP + 1);
      if (leads.length > ACTIVITY_SCAN_CAP) capped = true;
      const runs = await ctx.db
        .query("agentRuns")
        .withIndex("by_organization_and_started", (q) => q.eq("organizationId", org._id).gte("startedAt", since))
        .take(ACTIVITY_SCAN_CAP + 1);
      if (runs.length > ACTIVITY_SCAN_CAP) capped = true;

      const leadsCreated30d = Math.min(leads.length, ACTIVITY_SCAN_CAP);
      const aiRuns30d = Math.min(runs.length, ACTIVITY_SCAN_CAP);
      const status = org.billing ? org.billing.status : "none";
      rows.push({
        organizationId: org._id,
        name: maskDigitRuns(org.name),
        status,
        plan: org.billing?.plan ?? null,
        createdAt: org.createdAt,
        humanMembers,
        activeChannels,
        conversationsActive30d: counted.length,
        inboundConversations30d,
        lastMessageAt: counted[0]?.lastMessageAt ?? null,
        leadsCreated30d,
        aiRuns30d,
        capped,
        looksActive:
          status === "canceled" &&
          (activeChannels > 0 || counted.length > 0 || leadsCreated30d > 0 || aiRuns30d > 0),
      });
    }
    return { since, rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

// ── Asaas (cobrança): ops ───────────────────────────────────────────────────
// Actions (fetch) em `internal*`, `dryRun` padrão true. Só `lib/asaasApi.ts` fala com o Asaas.

/** "Acme Comércio Ltda" -> "Acm•••" (confirma a conta certa sem expor o nome inteiro). */
function maskName(name: string | null): string | null {
  if (!name) return null;
  const clean = maskDigitRuns(name).trim();
  return `${clean.slice(0, 3)}•••`;
}

/** Confirma a chave e o ambiente (sandbox x produção) e devolve o nome da conta mascarado. */
export const internalAsaasPing = internalAction({
  args: {},
  returns: v.object({
    enabled: v.boolean(),
    env: v.union(v.literal("production"), v.literal("sandbox"), v.null()),
    ok: v.boolean(),
    accountName: v.union(v.string(), v.null()),
    webhookTokenConfigured: v.boolean(),
  }),
  handler: async () => {
    const cfg = asaasConfig();
    const webhookTokenConfigured = (asaasWebhookToken()?.length ?? 0) >= 32;
    if (!cfg) return { enabled: false, env: null, ok: false, accountName: null, webhookTokenConfigured };
    try {
      return { enabled: true, env: cfg.env, ok: true, accountName: maskName(await getAccountName()), webhookTokenConfigured };
    } catch {
      return { enabled: true, env: cfg.env, ok: false, accountName: null, webhookTokenConfigured };
    }
  },
});

/**
 * Cria o webhook no Asaas (`${CONVEX_SITE_URL}/webhooks/asaas`, token = `ASAAS_WEBHOOK_TOKEN`,
 * eventos de pagamento e de assinatura). Idempotente: se já existe um webhook com a mesma URL, não
 * duplica. `email`: caixa que o Asaas avisa se a fila do webhook parar (obrigatório no Asaas).
 */
export const internalAsaasConfigureWebhook = internalAction({
  args: { dryRun: v.optional(v.boolean()), email: v.optional(v.string()) },
  returns: v.object({
    dryRun: v.boolean(),
    action: v.union(v.literal("exists"), v.literal("would_create"), v.literal("created")),
    url: v.string(),
    events: v.array(v.string()),
  }),
  handler: async (_ctx, args) => {
    const dryRun = args.dryRun !== false;
    if (!isAsaasEnabled()) throw new ConvexError("Chave da API do Asaas não configurada neste deployment");
    const token = asaasWebhookToken();
    if (!token || token.length < 32) throw new ConvexError("Token do webhook do Asaas ausente ou com menos de 32 caracteres");
    const site = process.env.CONVEX_SITE_URL?.trim();
    if (!site) throw new ConvexError("CONVEX_SITE_URL ausente neste deployment");
    const url = `${site.replace(/\/+$/, "")}/webhooks/asaas`;
    const existing = (await listWebhooks()).find((w) => w.url === url);
    if (existing) return { dryRun, action: "exists" as const, url, events: [...ASAAS_WEBHOOK_EVENTS] };
    if (dryRun) return { dryRun, action: "would_create" as const, url, events: [...ASAAS_WEBHOOK_EVENTS] };
    const email = args.email?.trim().toLowerCase();
    if (!email || !isDeliverableEmail(email)) throw new ConvexError("Informe `email` (caixa de avisos do webhook) para criar de verdade");
    await createWebhook({ name: "HNBCRM", url, email, authToken: token });
    return { dryRun, action: "created" as const, url, events: [...ASAAS_WEBHOOK_EVENTS] };
  },
});

/**
 * Venda manual: cria cliente + assinatura no Asaas para uma org, com preço NEGOCIADO opcional
 * (`valueBrl` = valor de CADA cobrança, mensal ou anual; fundador, preço travado, Empresa). Sem
 * `valueBrl` usa o catálogo (+ `priceLock` da org). O status/plano da org NÃO muda: só o pagamento
 * confirmado (webhook) libera o plano. Saída sem documento nem e-mail.
 */
export const internalAsaasCreateSubscriptionForOrg = internalAction({
  args: {
    organizationId: v.id("organizations"),
    plan: v.union(v.literal("essencial"), v.literal("profissional"), v.literal("escala"), v.literal("empresa")),
    cycle: v.union(v.literal("monthly"), v.literal("yearly")),
    valueBrl: v.optional(v.number()),
    groupsAddon: v.optional(v.boolean()),
    billingName: v.string(),
    document: v.string(),
    billingEmail: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    plan: v.string(),
    cycle: v.string(),
    chargeBrl: v.number(),
    monthlyBrl: v.number(),
    nextDueDate: v.string(),
    document: v.string(),
    invoiceUrl: v.union(v.string(), v.null()),
    created: v.boolean(),
  }),
  handler: async (ctx, args): Promise<{
    dryRun: boolean;
    plan: string;
    cycle: string;
    chargeBrl: number;
    monthlyBrl: number;
    nextDueDate: string;
    document: string;
    invoiceUrl: string | null;
    created: boolean;
  }> => {
    const dryRun = args.dryRun !== false;
    if (!dryRun && !isAsaasEnabled()) throw new ConvexError("Chave da API do Asaas não configurada neste deployment");
    if (!isValidCpfCnpj(args.document)) throw new ConvexError("CPF/CNPJ inválido");
    const billingEmail = args.billingEmail.trim().toLowerCase();
    if (!isDeliverableEmail(billingEmail)) throw new ConvexError("E-mail financeiro inválido");
    const billingName = args.billingName.trim();
    if (billingName.length < 2 || billingName.length > 120) throw new ConvexError("billingName deve ter 2 a 120 caracteres");
    if (args.valueBrl !== undefined && !(Number.isFinite(args.valueBrl) && args.valueBrl > 0 && args.valueBrl <= 1_000_000)) {
      throw new ConvexError("valueBrl deve estar entre 0 e 1.000.000");
    }
    if (args.plan === "empresa" && args.valueBrl === undefined) {
      throw new ConvexError("Empresa não tem preço de tabela: informe valueBrl (valor de cada cobrança)");
    }
    const info = await ctx.runQuery(internal.billingAsaas.internalCheckoutContextOps, { organizationId: args.organizationId });
    if ((info.status === "active" || info.status === "past_due") && info.providerSubscriptionId) {
      throw new ConvexError("A org já tem assinatura no Asaas (evita cobrança em duplicidade)");
    }
    const now = Date.now();
    let chargeBrl: number;
    let monthlyBrl: number;
    if (args.valueBrl !== undefined) {
      chargeBrl = Math.round(args.valueBrl * 100) / 100;
      monthlyBrl = Math.round((args.cycle === "yearly" ? chargeBrl / 10 : chargeBrl) * 100) / 100;
    } else {
      const priced = priceCheckout({
        plan: args.plan,
        cycle: args.cycle,
        groupsAddon: args.groupsAddon === true,
        billing: { plan: info.plan ?? undefined, extraChannels: info.extraChannels, priceLock: info.priceLock ?? undefined },
        now,
      });
      if (!priced.ok) throw new ConvexError("Plano ou add-on inválido para o preço de tabela");
      chargeBrl = priced.price.chargeBrl;
      monthlyBrl = priced.price.monthlyBrl;
    }
    const trialValid = info.status === "trial" && info.trialEndsAt !== null && info.trialEndsAt > now;
    const nextDueDate = firstDueDate(now, trialValid ? (info.trialEndsAt ?? undefined) : undefined);
    const summary = {
      dryRun,
      plan: args.plan,
      cycle: args.cycle,
      chargeBrl,
      monthlyBrl,
      nextDueDate,
      document: maskCpfCnpj(args.document),
    };
    if (dryRun) return { ...summary, invoiceUrl: null, created: false };
    const out = await runAsaasCheckout(ctx, {
      organizationId: args.organizationId,
      plan: args.plan,
      cycle: args.cycle,
      groupsAddon: args.groupsAddon === true,
      extraChannels: info.extraChannels,
      billingName,
      document: args.document,
      billingEmail,
      monthlyBrl,
      chargeBrl,
      nextDueDate,
      quiet: info.quiet,
      previousSubscriptionId: info.providerSubscriptionId,
      viaOps: true,
    });
    return { ...summary, invoiceUrl: out.invoiceUrl, created: true };
  },
});

/**
 * Relê no Asaas as faturas ABERTAS (pending/overdue) e corrige o status local (cancelada, paga,
 * estornada, vencida). Conserta fatura que ficou "Aguardando pagamento" depois de assinatura
 * cancelada. Corrige SÓ a fatura: uma que o Asaas diz PAGA e o app não processou vem em
 * `paidNotProcessed` (o estado da org é decisão do operador). `dryRun` padrão true; pagina por
 * `cursor`/`pageSize` (rode de novo com o `continueCursor` até `isDone`). Saída sem PII.
 */
export const internalReconcileInvoices = internalAction({
  args: {
    organizationId: v.optional(v.id("organizations")),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    unchanged: v.number(),
    changes: v.array(
      v.object({ invoiceId: v.id("billingInvoices"), from: v.string(), to: v.string(), applied: v.boolean() })
    ),
    paidNotProcessed: v.array(v.id("billingInvoices")),
    errors: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    if (!isAsaasEnabled()) throw new ConvexError("Chave da API do Asaas não configurada neste deployment");
    const page: {
      items: Array<{ invoiceId: Id<"billingInvoices">; organizationId: Id<"organizations">; providerPaymentId: string; status: string }>;
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(internal.billingAsaas.internalOpenInvoicesPage, {
      organizationId: args.organizationId,
      cursor: args.cursor,
      pageSize: args.pageSize,
    });
    const changes: Array<{ invoiceId: Id<"billingInvoices">; from: string; to: string; applied: boolean }> = [];
    const paidNotProcessed: Id<"billingInvoices">[] = [];
    let unchanged = 0;
    let errors = 0;
    for (const item of page.items) {
      let next: "pending" | "paid" | "overdue" | "canceled" | "refunded";
      let paidAt: number | undefined;
      try {
        const payment = await getPayment(item.providerPaymentId);
        next = invoiceStatusOf({ status: payment.status, deleted: payment.deleted });
        paidAt = dayToMs(payment.paymentDate ?? payment.confirmedDate ?? undefined);
      } catch (e) {
        if (e instanceof AsaasError && e.status === 404) next = "canceled";
        else {
          errors++;
          continue;
        }
      }
      if (next === item.status) {
        unchanged++;
        continue;
      }
      if (next === "paid") {
        paidNotProcessed.push(item.invoiceId);
        if (!dryRun) {
          await ctx.runMutation(internal.billingAsaas.internalSetInvoiceStatus, { invoiceId: item.invoiceId, status: "paid", paidAt });
        }
        changes.push({ invoiceId: item.invoiceId, from: item.status, to: next, applied: !dryRun });
        continue;
      }
      if (!dryRun) await ctx.runMutation(internal.billingAsaas.internalSetInvoiceStatus, { invoiceId: item.invoiceId, status: next });
      changes.push({ invoiceId: item.invoiceId, from: item.status, to: next, applied: !dryRun });
    }
    return {
      dryRun,
      scanned: page.items.length,
      unchanged,
      changes,
      paidNotProcessed,
      errors,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * Preenche `orgSubscriptions.currentPeriodStart/End` das orgs `active`/`past_due` com assinatura Asaas
 * que pagaram ANTES de o app gravar o fim do ciclo. Mesma regra do app: vencimento da última fatura de
 * assinatura paga da assinatura atual (início) + 1 ciclo (fim). Sem fatura paga: pula (nada a inferir).
 * `dryRun` padrão true; pagina por `cursor`/`pageSize` (a execução real se reagenda sozinha). Sem audit
 * por org (`audit:"none"`, como `internalBackfillLegacy`); a saída traz só ids de org e datas, sem PII.
 */
export const internalBackfillPeriodEnd = internalMutation({
  args: {
    organizationId: v.optional(v.id("organizations")),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    skipped: v.number(),
    noPaidInvoice: v.number(),
    changes: v.array(
      v.object({ organizationId: v.id("organizations"), periodStart: v.number(), periodEnd: v.number(), applied: v.boolean() })
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const pageSize = Math.min(Math.max(Math.floor(args.pageSize ?? 50), 1), 100);
    let rows: Doc<"orgSubscriptions">[];
    let isDone = true;
    let continueCursor = "";
    if (args.organizationId) {
      const orgId = args.organizationId;
      const one = await ctx.db.query("orgSubscriptions").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).first();
      rows = one ? [one] : [];
    } else {
      const page = await ctx.db.query("orgSubscriptions").paginate({ numItems: pageSize, cursor: args.cursor ?? null });
      rows = page.page;
      isDone = page.isDone;
      continueCursor = page.continueCursor;
    }
    let skipped = 0;
    let noPaidInvoice = 0;
    const changes: Array<{ organizationId: Id<"organizations">; periodStart: number; periodEnd: number; applied: boolean }> = [];
    for (const sub of rows) {
      if (sub.billingProvider !== "asaas" || !sub.providerSubscriptionId || sub.currentPeriodEnd !== undefined) {
        skipped++;
        continue;
      }
      const org = await ctx.db.get(sub.organizationId);
      if (!org?.billing || (org.billing.status !== "active" && org.billing.status !== "past_due")) {
        skipped++;
        continue;
      }
      const invoices = await ctx.db
        .query("billingInvoices")
        .withIndex("by_organization_and_due_date", (q) => q.eq("organizationId", sub.organizationId))
        .order("desc")
        .take(200);
      const period = resolvePeriod({ cycle: sub.billingCycle, invoices, subscriptionIds: [sub.providerSubscriptionId] });
      if (period.periodStart === null || period.periodEnd === null) {
        noPaidInvoice++;
        continue;
      }
      changes.push({ organizationId: sub.organizationId, periodStart: period.periodStart, periodEnd: period.periodEnd, applied: !dryRun });
      if (dryRun) continue;
      await applySubscriptionChange(ctx, {
        organizationId: sub.organizationId,
        patch: {
          subscription: {
            currentPeriodEnd: period.periodEnd,
            ...(sub.currentPeriodStart === undefined ? { currentPeriodStart: period.periodStart } : {}),
          },
        },
        source: "ops",
        reason: "internalBackfillPeriodEnd",
        audit: "none",
      });
    }
    if (!dryRun && !isDone) {
      await ctx.scheduler.runAfter(0, internal.opsBilling.internalBackfillPeriodEnd, { cursor: continueCursor, pageSize, dryRun: false });
    }
    return { dryRun, scanned: rows.length, skipped, noPaidInvoice, changes, isDone, continueCursor };
  },
});
