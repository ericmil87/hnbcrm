/**
 * Onboarding conversacional v2 (P2.4): orçamento de custo, rate limit e corte
 * diário do onboarding de IA. A regra pura mora em `lib/onboardingBudget.ts`.
 *
 * Fluxo para o P2.3 (cada chamada de LLM do onboarding):
 *   1. `internalReserveOnboardingSpend` ANTES da chamada. `ok:false` = não chame
 *      o LLM, mostre `message` (PT-BR) ao usuário.
 *   2. chamada de LLM.
 *   3. `internalRecordOnboardingSpend` DEPOIS, com o custo real (também em erro
 *      parcial: gasto é gasto).
 *
 * Respeita o que já existe: modo leitura do plano e `spendCap` da org
 * (`spendStatusFor`) valem para o onboarding; o gasto entra em `agentRuns`
 * (`kind:"onboarding"`) e em `aiUsageMonthly` pela MESMA porta das demais runs
 * (`recordRunUsage`), então o teto em R$ da org o enxerga.
 *
 * Alerta do corte global: grava `auditLogs` (severidade `critical`,
 * `metadata.action:"onboarding_global_daily_cap_reached"`, 1×/dia). Nenhum e-mail
 * nem mensagem externa é enviado; o ponto para plugar o aviso de ops é
 * `raiseGlobalCapAlert`.
 *
 * Rate limit por IP: as funções aceitam `ipKey`. O onboarding ainda não tem rota
 * HTTP; quando houver, a `httpAction` lê o IP do cabeçalho (`x-forwarded-for`) e
 * chama `internalCheckOnboardingRateLimit` (antes de criar sessão) e passa o
 * mesmo `ipKey` na reserva.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getMonthlyUsageDoc, recordRunUsage, spendStatusFor } from "./aiSpend";
import { monthKeyUtc, usdToMicros } from "./lib/aiSpend";
import { resolveEntitlements } from "./lib/entitlements";
import {
  ONBOARDING_RATE_LIMITS,
  ONBOARDING_REFUSAL_MESSAGES,
  clampEstimate,
  dayKeyUtc,
  evaluateFixedWindow,
  evaluateOnboardingBudget,
  getOnboardingBudgetConfig,
  normalizeIpKey,
  rateKey,
  retryAfterText,
  type OnboardingBudgetConfig,
  type OnboardingRefusalCode,
  type RateScope,
  type WindowState,
} from "./lib/onboardingBudget";

const refusalCodeValidator = v.union(
  v.literal("global_daily_cap"),
  v.literal("session_budget"),
  v.literal("org_budget"),
  v.literal("org_spend_cap"),
  v.literal("plan_read_only"),
  v.literal("rate_limited"),
);

const decisionValidator = v.object({
  ok: v.boolean(),
  code: v.union(refusalCodeValidator, v.null()),
  /** PT-BR, pronta para o usuário. */
  message: v.union(v.string(), v.null()),
  retryAfterMs: v.union(v.number(), v.null()),
});

type Decision = {
  ok: boolean;
  code: OnboardingRefusalCode | null;
  message: string | null;
  retryAfterMs: number | null;
};
const OK: Decision = { ok: true, code: null, message: null, retryAfterMs: null };
const refused = (code: OnboardingRefusalCode, retryAfterMs: number | null = null): Decision => ({
  ok: false,
  code,
  message: ONBOARDING_REFUSAL_MESSAGES[code],
  retryAfterMs,
});

// ── Rate limit ──────────────────────────────────────────────────────────────

type RateSubject = { scope: RateScope; id: string };

/** Duas fases: avalia todas as janelas e só grava se TODAS permitirem (recusa não consome nada). */
async function consumeRate(
  ctx: MutationCtx,
  now: number,
  subjects: RateSubject[],
): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
  const plan: Array<{ key: string; doc: Doc<"onboardingRateLimits"> | null; next: WindowState }> = [];
  for (const s of subjects) {
    for (const spec of ONBOARDING_RATE_LIMITS[s.scope]) {
      const key = rateKey(s.scope, s.id, spec.name);
      const doc = await ctx.db
        .query("onboardingRateLimits")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      const res = evaluateFixedWindow(doc ? { windowStart: doc.windowStart, count: doc.count } : null, now, spec);
      if (!res.allowed) return { allowed: false, retryAfterMs: res.retryAfterMs };
      plan.push({ key, doc, next: res.next });
    }
  }
  for (const p of plan) {
    if (p.doc) await ctx.db.patch(p.doc._id, p.next);
    else await ctx.db.insert("onboardingRateLimits", { key: p.key, ...p.next });
  }
  return { allowed: true };
}

function subjectsFor(args: {
  organizationId: Id<"organizations">;
  userId?: Id<"users">;
  ipKey?: string;
}): RateSubject[] {
  const subjects: RateSubject[] = [{ scope: "org", id: args.organizationId }];
  if (args.userId) subjects.push({ scope: "user", id: args.userId });
  const ip = normalizeIpKey(args.ipKey);
  if (ip) subjects.push({ scope: "ip", id: ip });
  return subjects;
}

/**
 * Só o rate limit (sem orçamento): para rotas HTTP que precisam barrar por IP
 * antes de existir sessão ou org. Consome 1 turno de cada escopo informado.
 */
export const internalCheckOnboardingRateLimit = internalMutation({
  args: {
    organizationId: v.optional(v.id("organizations")),
    userId: v.optional(v.id("users")),
    ipKey: v.optional(v.string()),
  },
  returns: decisionValidator,
  handler: async (ctx, args) => {
    const subjects: RateSubject[] = [];
    if (args.organizationId) subjects.push({ scope: "org", id: args.organizationId });
    if (args.userId) subjects.push({ scope: "user", id: args.userId });
    const ip = normalizeIpKey(args.ipKey);
    if (ip) subjects.push({ scope: "ip", id: ip });
    if (subjects.length === 0) return OK;
    const res = await consumeRate(ctx, Date.now(), subjects);
    return res.allowed ? OK : refused("rate_limited", res.retryAfterMs);
  },
});

// ── Gasto: leituras ─────────────────────────────────────────────────────────

async function globalDayDoc(ctx: MutationCtx, day: string) {
  return await ctx.db
    .query("onboardingSpendDaily")
    .withIndex("by_day", (q) => q.eq("day", day))
    .unique();
}

async function loadSessionOfOrg(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  sessionId: Id<"onboardingSessions">,
) {
  const session = await ctx.db.get(sessionId);
  if (!session || session.organizationId !== organizationId) {
    throw new ConvexError("Sessão de onboarding não encontrada");
  }
  return session;
}

/** Org paga e ativa não tem o orçamento de teste (vale só o `spendCap` dela). */
function orgBudgetApplies(org: Doc<"organizations">, now: number): boolean {
  const ent = resolveEntitlements(org, now);
  return !(ent.gated && (ent.status === "active" || ent.status === "past_due"));
}

/**
 * Alerta do corte global (1×/dia). Só REGISTRA (auditoria `critical`); nenhum
 * envio externo. Ponto para plugar o aviso de ops no futuro.
 */
async function raiseGlobalCapAlert(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    dayDoc: Doc<"onboardingSpendDaily">;
    config: OnboardingBudgetConfig;
    now: number;
  },
) {
  if (args.dayDoc.alertedAt !== undefined) return;
  await ctx.db.patch(args.dayDoc._id, { alertedAt: args.now });
  await ctx.db.insert("auditLogs", {
    organizationId: args.organizationId, // org que detectou o estouro
    entityType: "onboardingBudget",
    entityId: args.dayDoc.day,
    action: "update",
    actorType: "system",
    metadata: {
      action: "onboarding_global_daily_cap_reached",
      day: args.dayDoc.day,
      spentUsdMicros: args.dayDoc.costUsdMicros,
      capUsdMicros: args.config.globalDailyUsdMicros,
    },
    description: "Corte diário global do onboarding de IA atingido: o onboarding por conversa está pausado para todas as organizações até amanhã",
    severity: "critical",
    createdAt: args.now,
  });
}

// ── API para o pipeline de IA (P2.3) ────────────────────────────────────────

/**
 * ANTES da chamada de LLM. Ordem: modo leitura/teto da org → corte global →
 * orçamento da sessão → orçamento da org em teste → rate limit (por último,
 * para só gastar cota de quem seria atendido). `estimateUsdMicros` (padrão
 * US$ 0,02, máx. US$ 0,50) é o custo previsto da chamada: recusa se
 * gasto + estimativa estourar. Não retém saldo: chamadas simultâneas podem
 * passar juntas (limitado pelo rate limit).
 */
export const internalReserveOnboardingSpend = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    userId: v.optional(v.id("users")),
    ipKey: v.optional(v.string()),
    estimateUsdMicros: v.optional(v.number()),
  },
  returns: decisionValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    const session = await loadSessionOfOrg(ctx, args.organizationId, args.sessionId);
    const config = getOnboardingBudgetConfig();
    const estimate = clampEstimate(args.estimateUsdMicros);

    if (!resolveEntitlements(org, now).aiAllowed) return refused("plan_read_only");
    const spend = await spendStatusFor(ctx, org, monthKeyUtc(now));
    if (spend.blocked) return refused("org_spend_cap");

    const day = dayKeyUtc(now);
    const dayDoc = await globalDayDoc(ctx, day);
    const usage = await getMonthlyUsageDoc(ctx, org._id, monthKeyUtc(now));
    const decision = evaluateOnboardingBudget({
      estimateUsdMicros: estimate,
      sessionSpentUsdMicros: session.spentUsdMicros,
      orgMonthSpentUsdMicros: usage?.byKind.onboarding?.costUsdMicros ?? 0,
      globalDaySpentUsdMicros: dayDoc?.costUsdMicros ?? 0,
      orgBudgetApplies: orgBudgetApplies(org, now),
      config,
    });
    if (!decision.allowed) {
      if (decision.code === "global_daily_cap" && dayDoc) {
        await raiseGlobalCapAlert(ctx, { organizationId: org._id, dayDoc, config, now });
      }
      return refused(decision.code);
    }

    const rate = await consumeRate(ctx, now, subjectsFor(args));
    if (!rate.allowed) {
      return {
        ...refused("rate_limited", rate.retryAfterMs),
        message: `${ONBOARDING_REFUSAL_MESSAGES.rate_limited} ${retryAfterText(rate.retryAfterMs)}`,
      };
    }
    return OK;
  },
});

/**
 * DEPOIS da chamada de LLM (ou do conjunto de chamadas de um turno): grava o
 * custo REAL em `onboardingSessions.spentUsdMicros`, numa run `kind:"onboarding"`
 * e no medidor mensal da org (`aiUsageMonthly`, mesma porta das demais runs), e
 * soma ao corte global do dia. Devolve os totais para o chamador decidir a UI.
 */
export const internalRecordOnboardingSpend = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    /** Membro humano que conduz a sessão (opcional; padrão = quem abriu a sessão). */
    memberId: v.optional(v.id("teamMembers")),
    /** Papel (documental; o modelo usado vai em `model`). */
    role: v.union(v.literal("interviewer"), v.literal("reader"), v.literal("vision")),
    status: v.optional(v.union(v.literal("done"), v.literal("error"))),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    requestCount: v.optional(v.number()),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    cachedPromptTokens: v.optional(v.number()),
    /** Custo em US$ (como `finishRunCostFields().costUsdEstimate`). */
    costUsdEstimate: v.number(),
    costEstimated: v.optional(v.boolean()),
  },
  returns: v.object({
    sessionSpentUsdMicros: v.number(),
    orgMonthOnboardingUsdMicros: v.number(),
    globalDayUsdMicros: v.number(),
    globalCapReached: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const session = await loadSessionOfOrg(ctx, args.organizationId, args.sessionId);
    const config = getOnboardingBudgetConfig();
    const microsRaw = usdToMicros(args.costUsdEstimate);
    const finite = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined);

    // Run + medidor mensal pela porta única (`recordRunUsage`).
    const runId = await ctx.db.insert("agentRuns", {
      organizationId: args.organizationId,
      memberId: args.memberId ?? session.createdBy,
      kind: "onboarding",
      status: "running",
      requestCount: 0,
      startedAt: now,
    });
    const before = (await ctx.db.get(runId))!;
    const final = {
      status: args.status ?? "done",
      provider: args.provider,
      model: args.model,
      requestCount: finite(args.requestCount) ?? 1,
      promptTokens: finite(args.promptTokens),
      completionTokens: finite(args.completionTokens),
      cachedPromptTokens: finite(args.cachedPromptTokens),
      costUsdEstimate: microsRaw / 1_000_000,
      ...(args.costEstimated ? { costEstimated: true } : {}),
      finishedAt: now,
    };
    await ctx.db.patch(runId, Object.fromEntries(Object.entries(final).filter(([, x]) => x !== undefined)));
    await recordRunUsage(
      ctx,
      before,
      {
        costUsdEstimate: final.costUsdEstimate,
        costEstimated: args.costEstimated,
        promptTokens: final.promptTokens,
        completionTokens: final.completionTokens,
        cachedPromptTokens: final.cachedPromptTokens,
      },
      now,
    );

    // Sessão.
    const sessionSpent = session.spentUsdMicros + microsRaw;
    await ctx.db.patch(session._id, { spentUsdMicros: sessionSpent, updatedAt: now });

    // Corte global do dia.
    const day = dayKeyUtc(now);
    const existingDay = await globalDayDoc(ctx, day);
    if (existingDay) {
      await ctx.db.patch(existingDay._id, { costUsdMicros: existingDay.costUsdMicros + microsRaw, runs: existingDay.runs + 1 });
    } else {
      await ctx.db.insert("onboardingSpendDaily", { day, costUsdMicros: microsRaw, runs: 1 });
    }
    const dayAfter = (await globalDayDoc(ctx, day))!;
    const globalDay = dayAfter.costUsdMicros;
    const capReached = globalDay >= config.globalDailyUsdMicros;
    if (capReached) {
      await raiseGlobalCapAlert(ctx, { organizationId: args.organizationId, dayDoc: dayAfter, config, now });
    }

    const usage = await getMonthlyUsageDoc(ctx, args.organizationId, monthKeyUtc(now));
    return {
      sessionSpentUsdMicros: sessionSpent,
      orgMonthOnboardingUsdMicros: usage?.byKind.onboarding?.costUsdMicros ?? 0,
      globalDayUsdMicros: globalDay,
      globalCapReached: capReached,
    };
  },
});

/** Faxina de janelas de rate limit vencidas (> 2 dias). Lote pequeno; reagende até `done`. */
export const internalPruneOnboardingRateLimits = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({ deleted: v.number(), dryRun: v.boolean(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("onboardingRateLimits")
      .withIndex("by_windowStart", (q) => q.lt("windowStart", cutoff))
      .take(200);
    if (!dryRun) for (const r of rows) await ctx.db.delete(r._id);
    return { deleted: dryRun ? 0 : rows.length, dryRun, done: rows.length < 200 };
  },
});
