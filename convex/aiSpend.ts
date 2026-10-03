/**
 * Medidor de custo de IA + teto em R$ (v0.69, T04) — a parte com `ctx`.
 *
 * A regra pura (preço, config, limiares) vive em `lib/aiSpend.ts`; aqui ficam:
 *  - `recordRunUsage`: chamado por `agentRuns.internalFinishRun` (ponto ÚNICO de
 *    escrita de custo) — incrementa `aiUsageMonthly` na MESMA transação e
 *    dispara os avisos de 80%/100% uma vez por mês;
 *  - os gates: `attendantBudgetGate` + `onAttendantRunStarted` (atendente 1 a
 *    1, chamados no claim) e `internalSpendGate` (demais produtos, nas actions);
 *  - o repasse `ai_budget` (nunca silêncio: estourou, uma pessoa é chamada);
 *  - a op de backfill do contador.
 *
 * `attendant.ts` só recebe as CHAMADAS (regra do plano): nada de lógica nova lá.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { createHandoffCore } from "./handoffs";
import { createNotification } from "./lib/notify";
import { isMembershipRevoked } from "./lib/auth";
import { hasPermission, resolvePermissions, type Role } from "./lib/permissions";
import {
  SPEND_CAP_BLOCKED_MESSAGE,
  SPEND_CAP_REASON,
  estimateRunCost,
  evaluateSpend,
  formatBrl,
  isValidMonthKey,
  monthKeyUtc,
  monthStartUtcMs,
  nextMonthStartUtcMs,
  resolveSpendCap,
  spendCrossings,
  usdToMicros,
  type SpendEvaluation,
} from "./lib/aiSpend";

type Db = QueryCtx["db"];

// ── Leitura do contador ─────────────────────────────────────────────────────

export async function getMonthlyUsageDoc(
  ctx: { db: Db },
  organizationId: Id<"organizations">,
  month: string
): Promise<Doc<"aiUsageMonthly"> | null> {
  return await ctx.db
    .query("aiUsageMonthly")
    .withIndex("by_organization_and_month", (q) =>
      q.eq("organizationId", organizationId).eq("month", month)
    )
    .unique();
}

/** Estado do teto em R$ da org no mês — 2 leituras (org já em mãos + 1 doc). */
export async function spendStatusFor(
  ctx: { db: Db },
  org: Doc<"organizations">,
  month: string
): Promise<SpendEvaluation & { costUsdMicros: number }> {
  const usage = await getMonthlyUsageDoc(ctx, org._id, month);
  const costUsdMicros = usage?.costUsdMicros ?? 0;
  const cap = resolveSpendCap(org.settings.aiConfig?.spendCap);
  return { ...evaluateSpend(costUsdMicros, cap), costUsdMicros };
}

// ── Escrita: incremento por run (chamado por internalFinishRun) ─────────────

/**
 * Soma a run ao contador do mês. IDEMPOTENTE por run: uma segunda chamada de
 * `internalFinishRun` para a mesma run (caminho de erro depois do "done", por
 * exemplo) só soma a DIFERENÇA de custo e não conta a run de novo.
 */
export async function recordRunUsage(
  ctx: MutationCtx,
  before: Doc<"agentRuns">,
  after: {
    costUsdEstimate?: number;
    costEstimated?: boolean;
    promptTokens?: number;
    completionTokens?: number;
    cachedPromptTokens?: number;
  },
  now: number
): Promise<void> {
  const firstFinish = before.finishedAt === undefined;
  const costDeltaMicros = Math.max(
    0,
    usdToMicros(after.costUsdEstimate ?? before.costUsdEstimate ?? 0) -
      usdToMicros(before.costUsdEstimate ?? 0)
  );
  const tokenDelta = (next: number | undefined, prev: number | undefined) =>
    Math.max(0, (next ?? prev ?? 0) - (prev ?? 0));
  const promptDelta = tokenDelta(after.promptTokens, before.promptTokens);
  const completionDelta = tokenDelta(after.completionTokens, before.completionTokens);
  const cachedDelta = tokenDelta(after.cachedPromptTokens, before.cachedPromptTokens);
  if (!firstFinish && costDeltaMicros === 0 && promptDelta + completionDelta === 0) return;

  const month = monthKeyUtc(now);
  const organizationId = before.organizationId;
  const existing = await getMonthlyUsageDoc(ctx, organizationId, month);
  const kindPrev = existing?.byKind[before.kind] ?? { runs: 0, costUsdMicros: 0 };
  const byKind = {
    ...(existing?.byKind ?? {}),
    [before.kind]: {
      runs: kindPrev.runs + (firstFinish ? 1 : 0),
      costUsdMicros: kindPrev.costUsdMicros + costDeltaMicros,
    },
  };
  const estimatedNow = after.costEstimated === true && before.costEstimated !== true;
  const next = {
    costUsdMicros: (existing?.costUsdMicros ?? 0) + costDeltaMicros,
    runs: (existing?.runs ?? 0) + (firstFinish ? 1 : 0),
    estimatedRuns: (existing?.estimatedRuns ?? 0) + (estimatedNow ? 1 : 0),
    promptTokens: (existing?.promptTokens ?? 0) + promptDelta,
    completionTokens: (existing?.completionTokens ?? 0) + completionDelta,
    cachedPromptTokens: (existing?.cachedPromptTokens ?? 0) + cachedDelta,
    byKind,
    updatedAt: now,
  };
  let docId: Id<"aiUsageMonthly">;
  if (existing) {
    docId = existing._id;
    await ctx.db.patch(existing._id, next);
  } else {
    docId = await ctx.db.insert("aiUsageMonthly", { organizationId, month, ...next });
  }
  if (costDeltaMicros > 0) {
    await maybeNotifySpend(ctx, {
      organizationId,
      month,
      docId,
      costUsdMicros: next.costUsdMicros,
      warnedAt: existing?.warnedAt,
      reachedAt: existing?.reachedAt,
      now,
    });
  }
}

/** Humanos ativos que administram a org (settings:manage). Cap 25. */
async function spendAlertRecipients(
  ctx: { db: Db },
  organizationId: Id<"organizations">
): Promise<Doc<"teamMembers">[]> {
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) =>
      q.eq("organizationId", organizationId).eq("type", "human")
    )
    .collect();
  return members
    .filter(
      (m) =>
        !isMembershipRevoked(m) &&
        hasPermission(
          resolvePermissions(m.role as Role, m.permissions ?? undefined),
          "settings",
          "manage"
        )
    )
    .slice(0, 25);
}

async function maybeNotifySpend(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    month: string;
    docId: Id<"aiUsageMonthly">;
    costUsdMicros: number;
    warnedAt?: number;
    reachedAt?: number;
    now: number;
  }
): Promise<void> {
  const org = await ctx.db.get(args.organizationId);
  if (!org) return;
  const cap = resolveSpendCap(org.settings.aiConfig?.spendCap);
  const crossing = spendCrossings({
    costUsdMicros: args.costUsdMicros,
    cap,
    warnedAt: args.warnedAt,
    reachedAt: args.reachedAt,
  });
  if (!crossing.warn && !crossing.reached) return;

  // Carimbo ANTES de notificar, na mesma transação: 1×/mês por limiar. Cruzar
  // 100% de uma vez marca o 80% também (o aviso de 80% ficaria redundante).
  await ctx.db.patch(args.docId, {
    ...(crossing.reached ? { reachedAt: args.now } : {}),
    ...(args.warnedAt === undefined ? { warnedAt: args.now } : {}),
  });

  const evaluation = evaluateSpend(args.costUsdMicros, cap);
  const pct = Math.round(evaluation.pct ?? 0);
  const costBrl = formatBrl((args.costUsdMicros / 1_000_000) * cap.usdBrlRate);
  const capBrl = formatBrl(cap.monthlyBrl ?? 0);
  const blockMode = cap.mode === "block";
  const type = crossing.reached ? ("ai_spend_reached" as const) : ("ai_spend_warning" as const);
  const title = crossing.reached
    ? blockMode
      ? "Teto de gastos de IA atingido — IA em modo rascunho"
      : "Teto de gastos de IA atingido"
    : `Gasto de IA em ${pct}% do teto do mês`;
  const body = crossing.reached
    ? blockMode
      ? `Gasto aproximado ${costBrl} de ${capBrl}. O atendente passa a deixar rascunhos (com repasse) e os demais recursos de IA ficam suspensos até o próximo mês.`
      : `Gasto aproximado ${costBrl} de ${capBrl}. A IA continua funcionando (modo avisar).`
    : `Gasto aproximado ${costBrl} de ${capBrl} em ${args.month}.`;

  for (const admin of await spendAlertRecipients(ctx, args.organizationId)) {
    await createNotification(ctx, {
      organizationId: args.organizationId,
      memberId: admin._id,
      type,
      title,
      body,
      data: { month: args.month, pct },
    });
    await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
      organizationId: args.organizationId,
      recipientMemberId: admin._id,
      eventType: "aiSpendAlert",
      templateData: {
        level: crossing.reached ? "reached" : "warn",
        orgName: org.name,
        month: args.month,
        costBrl,
        capBrl,
        pct,
        mode: blockMode ? "block" : "warn",
      },
    });
  }

  await ctx.db.insert("auditLogs", {
    organizationId: args.organizationId,
    entityType: "organization",
    entityId: args.organizationId,
    action: "update",
    actorType: "system",
    metadata: { month: args.month, pct, mode: cap.mode, costUsdMicros: args.costUsdMicros },
    description: crossing.reached
      ? `Gasto de IA atingiu o teto do mês (${costBrl} de ${capBrl})`
      : `Gasto de IA chegou a ${pct}% do teto do mês (${costBrl} de ${capBrl})`,
    severity: crossing.reached ? "high" : "medium",
    createdAt: args.now,
  });
}

// ── Gate do atendente 1 a 1 (claim) ─────────────────────────────────────────

export type AttendantBudgetGate = {
  /** Item encerrado (`budget_mensal`) — o repasse já foi aberto. */
  skipReason: string | null;
  /** Teto em R$ estourado em `block`: o turno sai como RASCUNHO. */
  forceSuggest: boolean;
  /** A conversa ainda não foi atendida neste mês (conta no contador). */
  countConversation: boolean;
  month: string;
};

/** Já houve run do atendente nesta conversa desde o início do mês? */
async function conversationServedThisMonth(
  ctx: { db: Db },
  conversationId: Id<"conversations">,
  monthStart: number,
  excludeRunId?: Id<"agentRuns">
): Promise<boolean> {
  const runs = ctx.db
    .query("agentRuns")
    .withIndex("by_conversation", (q) =>
      q.eq("conversationId", conversationId).gte("_creationTime", monthStart)
    );
  for await (const run of runs) {
    if (run.kind === "attendant" && run._id !== excludeRunId) return true;
  }
  return false;
}

const BUDGET_SUGGESTED_ACTIONS = [
  "Responder o cliente pela equipe",
  "Rever os limites de IA em Configurações → IA",
];

/**
 * Abre o repasse `ai_budget` (nunca silêncio). `onDuplicate:"skip"`: com
 * repasse pendente no lead não abre outro. `oncePerMonth` (teto em R$, que
 * continua gerando rascunhos) também não reabre depois que um humano já
 * resolveu um no mês — os rascunhos seguintes chegam pelo inbox.
 */
async function openBudgetHandoff(
  ctx: MutationCtx,
  args: {
    lead: Doc<"leads">;
    agent: Doc<"teamMembers">;
    conversationId: Id<"conversations">;
    reason: string;
    monthStart: number;
    oncePerMonth: boolean;
  }
): Promise<Id<"handoffs"> | null> {
  if (args.oncePerMonth) {
    const thisMonth = ctx.db
      .query("handoffs")
      .withIndex("by_lead", (q) => q.eq("leadId", args.lead._id).gte("_creationTime", args.monthStart));
    for await (const h of thisMonth) {
      if (h.origin === "ai_budget") return null;
    }
  }
  return await createHandoffCore(ctx, {
    leadId: args.lead._id,
    conversationId: args.conversationId,
    fromMemberId: args.agent._id,
    reason: args.reason,
    suggestedActions: BUDGET_SUGGESTED_ACTIONS,
    origin: "ai_budget",
    onDuplicate: "skip",
  });
}

/**
 * Tetos do mês para um item do atendente 1 a 1, ANTES de gastar pacing/lock:
 *  - `monthlyConversationBudget` (nº de conversas): conversa NOVA além do teto
 *    → item `budget_mensal` + repasse `ai_budget` (antes era skip mudo);
 *  - teto em R$ (`spendCap`) estourado em `block` → turno vira RASCUNHO (o
 *    repasse sai em `onAttendantRunStarted`, quando o turno de fato roda).
 * Lê 1 documento do contador — nunca varre `agentRuns` do mês.
 */
export async function attendantBudgetGate(
  ctx: MutationCtx,
  args: {
    item: Doc<"aiReplyQueue">;
    org: Doc<"organizations">;
    agent: Doc<"teamMembers">;
    lead: Doc<"leads"> | null;
    conversation: Doc<"conversations">;
    now: number;
  }
): Promise<AttendantBudgetGate> {
  const month = monthKeyUtc(args.now);
  const monthStart = monthStartUtcMs(month);
  const usage = await getMonthlyUsageDoc(ctx, args.org._id, month);
  const served = await conversationServedThisMonth(ctx, args.conversation._id, monthStart);

  const budget = args.org.settings.aiConfig?.monthlyConversationBudget;
  if (budget !== undefined && budget > 0 && !served && (usage?.conversations ?? 0) >= budget) {
    // Só o turno do CLIENTE chama gente: no coach/devolução o humano já está
    // ali, e o follow-up escala pela própria tarefa (`releaseFollowUpFromQueue`).
    if (args.item.origin === undefined && args.lead) {
      await openBudgetHandoff(ctx, {
        lead: args.lead,
        agent: args.agent,
        conversationId: args.conversation._id,
        reason: `Limite mensal de conversas da IA atingido (${budget}). Responda este cliente pela equipe.`,
        monthStart,
        oncePerMonth: false,
      });
    }
    return { skipReason: "budget_mensal", forceSuggest: false, countConversation: false, month };
  }

  const cap = resolveSpendCap(args.org.settings.aiConfig?.spendCap);
  const evaluation = evaluateSpend(usage?.costUsdMicros ?? 0, cap);
  return {
    skipReason: null,
    forceSuggest: evaluation.blocked,
    countConversation: !served,
    month,
  };
}

/**
 * Depois que o claim inseriu a run (ponto sem volta — sem defer de pacing/lock
 * no caminho): conta a conversa no mês e, com o teto em R$ estourado em
 * `block`, abre o repasse `ai_budget` (1×/mês por lead). Abrir antes do lock
 * faria o re-claim cair em `handoff_pendente` e o rascunho nunca sair.
 */
export async function onAttendantRunStarted(
  ctx: MutationCtx,
  args: {
    gate: AttendantBudgetGate;
    item: Doc<"aiReplyQueue">;
    org: Doc<"organizations">;
    agent: Doc<"teamMembers">;
    lead: Doc<"leads">;
    conversationId: Id<"conversations">;
    now: number;
  }
): Promise<void> {
  if (args.gate.countConversation) {
    const usage = await getMonthlyUsageDoc(ctx, args.org._id, args.gate.month);
    if (usage) {
      await ctx.db.patch(usage._id, {
        conversations: (usage.conversations ?? 0) + 1,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("aiUsageMonthly", {
        organizationId: args.org._id,
        month: args.gate.month,
        costUsdMicros: 0,
        runs: 0,
        conversations: 1,
        byKind: {},
        updatedAt: args.now,
      });
    }
  }
  if (args.gate.forceSuggest && args.item.origin === undefined) {
    await openBudgetHandoff(ctx, {
      lead: args.lead,
      agent: args.agent,
      conversationId: args.conversationId,
      reason:
        "Teto de gastos de IA do mês atingido: a IA deixou a resposta como rascunho para a equipe revisar e enviar.",
      monthStart: monthStartUtcMs(args.gate.month),
      oncePerMonth: true,
    });
  }
}

// ── Gate dos demais produtos (actions) ──────────────────────────────────────

/**
 * Gate do teto em R$ para quem roda em action (grupo, publicação, visão,
 * resumo, radar, copiloto). O mês vem do chamador (`monthKeyUtc(Date.now())`
 * na action) — query nunca lê o relógio.
 */
export const internalSpendGate = internalQuery({
  args: { organizationId: v.id("organizations"), month: v.string() },
  returns: v.object({ blocked: v.boolean(), reason: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org || !isValidMonthKey(args.month)) return { blocked: false, reason: null };
    const status = await spendStatusFor(ctx, org, args.month);
    return status.blocked
      ? { blocked: true, reason: SPEND_CAP_REASON }
      : { blocked: false, reason: null };
  },
});

export { SPEND_CAP_BLOCKED_MESSAGE, SPEND_CAP_REASON };

/** Teto em R$ estourado em `block`, lido dentro de uma mutation (agente de grupo). */
export async function spendBlockedNow(
  ctx: { db: Db },
  org: Doc<"organizations">,
  now: number
): Promise<boolean> {
  return (await spendStatusFor(ctx, org, monthKeyUtc(now))).blocked;
}

// ── Backfill do contador ────────────────────────────────────────────────────

const BACKFILL_MAX_RUNS = 8000;

/**
 * Recalcula `aiUsageMonthly` de um mês a partir de `agentRuns` (para o mês em
 * que o contador entrou no ar — antes dele as runs não incrementavam nada).
 * `dryRun` (default TRUE) só devolve os números.
 *
 * Custo de cada run = o MAIOR entre o gravado e a re-estimativa pelos tokens
 * com a tabela nova: runs antigas foram precificadas como `deepseek-v4-flash`
 * fixo e as do copiloto ficaram com 0 — conservador, nunca subconta.
 *
 * Sem `organizationId`: com dryRun lista as orgs; sem dryRun agenda uma
 * execução por org.
 */
export const internalBackfillMonthlyUsage = internalMutation({
  args: {
    organizationId: v.optional(v.id("organizations")),
    month: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    if (!isValidMonthKey(args.month)) throw new Error("Mês inválido (use AAAA-MM)");

    if (!args.organizationId) {
      const orgs = await ctx.db.query("organizations").collect();
      if (!dryRun) {
        for (const org of orgs) {
          await ctx.scheduler.runAfter(0, internal.aiSpend.internalBackfillMonthlyUsage, {
            organizationId: org._id,
            month: args.month,
            dryRun: false,
          });
        }
      }
      return { dryRun, month: args.month, scheduled: dryRun ? 0 : orgs.length, organizationIds: orgs.map((o) => o._id) };
    }

    const organizationId = args.organizationId;
    const start = monthStartUtcMs(args.month);
    const end = nextMonthStartUtcMs(args.month);
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_organization_and_started", (q) =>
        q.eq("organizationId", organizationId).gte("startedAt", start).lt("startedAt", end)
      )
      .take(BACKFILL_MAX_RUNS + 1);
    if (runs.length > BACKFILL_MAX_RUNS) {
      throw new Error(`Mais de ${BACKFILL_MAX_RUNS} runs no mês — backfill precisa de paginação`);
    }

    let costUsdMicros = 0;
    let finished = 0;
    let estimatedRuns = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedPromptTokens = 0;
    const byKind: Record<string, { runs: number; costUsdMicros: number }> = {};
    const conversations = new Set<string>();
    for (const run of runs) {
      if (run.kind === "attendant" && run.conversationId) conversations.add(run.conversationId);
      if (run.finishedAt === undefined) continue;
      const reestimate = estimateRunCost({
        model: run.model,
        provider: run.provider,
        usage: {
          promptTokens: run.promptTokens,
          completionTokens: run.completionTokens,
          cachedPromptTokens: run.cachedPromptTokens,
        },
      });
      const micros = Math.max(usdToMicros(run.costUsdEstimate ?? 0), usdToMicros(reestimate.costUsd));
      finished += 1;
      costUsdMicros += micros;
      if (reestimate.costEstimated || run.costEstimated) estimatedRuns += 1;
      promptTokens += run.promptTokens ?? 0;
      completionTokens += run.completionTokens ?? 0;
      cachedPromptTokens += run.cachedPromptTokens ?? 0;
      const k = byKind[run.kind] ?? { runs: 0, costUsdMicros: 0 };
      byKind[run.kind] = { runs: k.runs + 1, costUsdMicros: k.costUsdMicros + micros };
    }

    const existing = await getMonthlyUsageDoc(ctx, organizationId, args.month);
    const computed = {
      costUsdMicros,
      runs: finished,
      estimatedRuns,
      conversations: conversations.size,
      promptTokens,
      completionTokens,
      cachedPromptTokens,
      byKind,
    };
    if (!dryRun) {
      const now = Date.now();
      if (existing) {
        await ctx.db.patch(existing._id, { ...computed, updatedAt: now });
      } else {
        await ctx.db.insert("aiUsageMonthly", {
          organizationId,
          month: args.month,
          ...computed,
          updatedAt: now,
        });
      }
    }
    return {
      dryRun,
      organizationId,
      month: args.month,
      scannedRuns: runs.length,
      computed,
      existing: existing
        ? {
            costUsdMicros: existing.costUsdMicros,
            runs: existing.runs,
            conversations: existing.conversations ?? 0,
          }
        : null,
      written: !dryRun,
    };
  },
});
