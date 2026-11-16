/**
 * Jev — camada de decisão (`typesafe/jev-1.13` via OpenRouter). docs/architecture/jev.md.
 *
 * FASE 0: fundação SEM caller. Nada no atendente, no copiloto nem na UI chama
 * `internalDecide` ainda. Quando chamar (fase 1+), valem estas regras:
 *
 *  - Módulo `jev` da org DESLIGADO por padrão; com a flag off nada roda (nem run, nem rede).
 *  - Fail-open: `internalDecide` NUNCA lança — devolve `{ok:false, reason}` e o chamador
 *    segue o comportamento de hoje. Erro de classificador não derruba atendimento.
 *  - Chamada HTTP não cabe em mutation: o chamador roda isto NA ACTION do turno, antes do
 *    commit, e leva o veredito como argumento ao commit transacional (que revalida tudo).
 *  - Custo pelo caminho único: `agentRuns(kind:"jev")` → `internalFinishRun` →
 *    `recordRunUsage` (teto em R$, painel de uso, `costEstimated`).
 *  - Sem PII: o estado passa pela lista de campos permitidos (`lib/jev/state.ts`); em
 *    `agentRuns` e `jevDecisions` ficam só hash e respostas.
 *  - Guard determinístico (`llmOutputGuard`) segue obrigatório e vem ANTES do Jev; o Jev é
 *    camada extra, nunca substituto.
 *
 * Ops: `npx convex run jev:internalSetModule '{"organizationId":"…","enabled":true,"dryRun":false}'`
 * (dryRun é o padrão) e `npx convex run aiDiagnostics:internalPingJev '{}'`.
 */
import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { orgAiActive } from "./lib/agentSecurity";
import { resolveEntitlements } from "./lib/entitlements";
import { modulesOf } from "./lib/orgModules";
import { addUsage, finishRunCostFields, newUsageTotals, usdToMicros } from "./lib/aiSpend";
import { spendBlockedNow } from "./aiSpend";
import { sanitizeLlmError } from "./lib/llm/sanitize";
import { callJev } from "./lib/jev/client";
import { jevAnswerRowValidator, toAnswerRows, type JevAnswerRow } from "./lib/jev/answers";
import { prepareJevState } from "./lib/jev/state";
import { validateQuestions } from "./lib/jev/validate";
import { JEV_PRICE_ID, JevError, JevValidationError } from "./lib/jev/types";

// Tipos explícitos: a action chama `internal.jev.*` do PRÓPRIO arquivo; sem anotar o retorno o TS cai em
// referência circular e contamina o tipo de `internal` inteiro (centenas de erros em outros módulos).
type BeginReason = "module_off" | "ai_inactive" | "read_only" | "spend_blocked" | "scope_mismatch";
type BeginResult = { ok: true; runId: Id<"agentRuns"> } | { ok: false; reason: BeginReason };
export type JevDecideResult =
  | {
      ok: true;
      runId: Id<"agentRuns">;
      decisionId: Id<"jevDecisions"> | null;
      model: string;
      answers: JevAnswerRow[];
      costUsdMicros: number;
      costEstimated: boolean;
      latencyMs: number;
    }
  | { ok: false; reason: BeginReason | "invalid_input" | "no_key" | "error"; code?: string; detail?: string };

// Espelha `JEV_KINDS` (teste de paridade em jev.test.ts).
const kindValidator = v.union(
  v.literal("triage"),
  v.literal("output_guard"),
  v.literal("lead_score"),
  v.literal("routing"),
  v.literal("sentiment"),
  v.literal("stage")
);

const beginReasonValidator = v.union(
  v.literal("module_off"),
  v.literal("ai_inactive"),
  v.literal("read_only"),
  v.literal("spend_blocked"),
  v.literal("scope_mismatch")
);

// ── Início: gates + run ─────────────────────────────────────────────────────

export const internalBeginDecision = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    kind: kindValidator,
    conversationId: v.optional(v.id("conversations")),
    leadId: v.optional(v.id("leads")),
    triggerMessageId: v.optional(v.id("messages")),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), runId: v.id("agentRuns") }),
    v.object({ ok: v.literal(false), reason: beginReasonValidator })
  ),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org) return { ok: false as const, reason: "scope_mismatch" as const };
    // 1) Flag da org: com ela off, NADA acontece (nem run, nem rede, nem custo).
    if (!modulesOf(org).jev) return { ok: false as const, reason: "module_off" as const };
    // 2) IA ativa (LGPD ack): o Jev recebe texto de cliente — mesma porta de toda IA.
    if (!orgAiActive(org)) return { ok: false as const, reason: "ai_inactive" as const };
    // 3) Plano em modo leitura e teto em R$ em `block` (mesma régua do `internalSpendGate`).
    const now = Date.now();
    if (!resolveEntitlements(org, now).aiAllowed) return { ok: false as const, reason: "read_only" as const };
    if (await spendBlockedNow(ctx, org, now)) return { ok: false as const, reason: "spend_blocked" as const };
    // 4) Defesa em profundidade: os ponteiros são da MESMA org (a função é interna, mas o
    //    chamador monta ids a partir de dados de mais de um lugar).
    if (args.conversationId) {
      const c = await ctx.db.get(args.conversationId);
      if (!c || c.organizationId !== args.organizationId) return { ok: false as const, reason: "scope_mismatch" as const };
    }
    if (args.leadId) {
      const l = await ctx.db.get(args.leadId);
      if (!l || l.organizationId !== args.organizationId) return { ok: false as const, reason: "scope_mismatch" as const };
    }
    if (args.triggerMessageId) {
      const m = await ctx.db.get(args.triggerMessageId);
      if (!m || m.organizationId !== args.organizationId) return { ok: false as const, reason: "scope_mismatch" as const };
    }
    const runId: Id<"agentRuns"> = await ctx.runMutation(internal.agentRuns.internalStartRun, {
      organizationId: args.organizationId,
      kind: "jev",
      conversationId: args.conversationId,
      leadId: args.leadId,
      triggerMessageId: args.triggerMessageId,
      provider: "openrouter",
      model: JEV_PRICE_ID,
    });
    return { ok: true as const, runId };
  },
});

// ── Fim: decisão + custo na MESMA transação ─────────────────────────────────

/**
 * Grava a decisão e fecha a run (custo → `aiUsageMonthly`) numa transação só.
 * Idempotente: run que já não está `running` devolve `null` sem inserir nem somar.
 */
export const internalRecordDecision = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    organizationId: v.id("organizations"),
    kind: kindValidator,
    conversationId: v.optional(v.id("conversations")),
    leadId: v.optional(v.id("leads")),
    triggerMessageId: v.optional(v.id("messages")),
    model: v.string(),
    requestId: v.optional(v.string()),
    stateHash: v.string(),
    questionsVersion: v.string(),
    policiesVersion: v.string(),
    answers: v.array(jevAnswerRowValidator),
    promptTokens: v.number(),
    completionTokens: v.number(),
    costUsdEstimate: v.number(),
    costEstimated: v.boolean(),
    latencyMs: v.number(),
  },
  returns: v.union(v.id("jevDecisions"), v.null()),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.organizationId !== args.organizationId || run.kind !== "jev") return null;
    if (run.status !== "running") return null; // já fechada: idempotente
    const decisionId = await ctx.db.insert("jevDecisions", {
      organizationId: args.organizationId,
      kind: args.kind,
      agentRunId: args.runId,
      conversationId: args.conversationId,
      leadId: args.leadId,
      triggerMessageId: args.triggerMessageId,
      model: args.model,
      requestId: args.requestId,
      stateHash: args.stateHash,
      questionsVersion: args.questionsVersion,
      policiesVersion: args.policiesVersion,
      answers: args.answers,
      promptTokens: args.promptTokens,
      costUsdMicros: usdToMicros(args.costUsdEstimate),
      ...(args.costEstimated ? { costEstimated: true } : {}),
      latencyMs: args.latencyMs,
      createdAt: Date.now(),
    });
    await ctx.runMutation(internal.agentRuns.internalFinishRun, {
      runId: args.runId,
      status: "done",
      provider: "openrouter",
      model: JEV_PRICE_ID,
      requestCount: 1,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      costUsdEstimate: args.costUsdEstimate,
      ...(args.costEstimated ? { costEstimated: true } : {}),
    });
    return decisionId;
  },
});

/** Fecha a run com erro (sanitizado). Idempotente: run já fechada não é tocada. */
export const internalFailDecision = internalMutation({
  args: { runId: v.id("agentRuns"), organizationId: v.id("organizations"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.organizationId !== args.organizationId || run.kind !== "jev" || run.status !== "running") return null;
    await ctx.runMutation(internal.agentRuns.internalFinishRun, {
      runId: args.runId,
      status: "error",
      provider: "openrouter",
      model: JEV_PRICE_ID,
      requestCount: 1,
      error: sanitizeLlmError(args.error),
    });
    return null;
  },
});

// ── A única action que fala com o OpenRouter para decidir ───────────────────

const decideFailReason = v.union(
  beginReasonValidator,
  v.literal("invalid_input"),
  v.literal("no_key"),
  v.literal("error")
);

export const internalDecide = internalAction({
  args: {
    organizationId: v.id("organizations"),
    kind: kindValidator,
    conversationId: v.optional(v.id("conversations")),
    leadId: v.optional(v.id("leads")),
    triggerMessageId: v.optional(v.id("messages")),
    // `v.any()` NÃO é a validação: `state` passa pela lista de campos permitidos
    // (`sanitizeJevState`) e `questions` por `validateQuestions` antes de qualquer escrita.
    state: v.any(),
    questions: v.any(),
    questionsVersion: v.string(),
    policiesVersion: v.string(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      runId: v.id("agentRuns"),
      decisionId: v.union(v.id("jevDecisions"), v.null()),
      model: v.string(),
      answers: v.array(jevAnswerRowValidator),
      costUsdMicros: v.number(),
      costEstimated: v.boolean(),
      latencyMs: v.number(),
    }),
    v.object({ ok: v.literal(false), reason: decideFailReason, code: v.optional(v.string()), detail: v.optional(v.string()) })
  ),
  handler: async (ctx, args): Promise<JevDecideResult> => {
    // Fail-open: nada aqui lança para o chamador.
    let runId: Id<"agentRuns"> | null = null;
    try {
      // 1) Entrada local (pura, sem escrita): estado só com campos permitidos, perguntas válidas.
      let prepared: Awaited<ReturnType<typeof prepareJevState>>;
      let questions: ReturnType<typeof validateQuestions>;
      try {
        prepared = await prepareJevState(args.state);
        questions = validateQuestions(args.questions);
      } catch (e) {
        if (e instanceof JevValidationError) return { ok: false as const, reason: "invalid_input" as const, code: e.code, detail: e.message };
        throw e;
      }
      // 2) Gates + run.
      const begin: BeginResult = await ctx.runMutation(internal.jev.internalBeginDecision, {
        organizationId: args.organizationId,
        kind: args.kind,
        conversationId: args.conversationId,
        leadId: args.leadId,
        triggerMessageId: args.triggerMessageId,
      });
      if (!begin.ok) return { ok: false as const, reason: begin.reason };
      const thisRun: Id<"agentRuns"> = begin.runId;
      runId = thisRun;
      // 3) Chave da PLATAFORMA (o Jev não tem BYO nem fallback de provedor).
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        await ctx.runMutation(internal.jev.internalFailDecision, { runId: thisRun, organizationId: args.organizationId, error: "OPENROUTER_API_KEY ausente" });
        return { ok: false as const, reason: "no_key" as const };
      }
      // 4) Chamada.
      const result = await callJev({ apiKey, state: prepared.state, questions });
      // 5) Custo pela tabela única; sem `usage.cost` do provedor → `costEstimated` (nunca 0).
      const totals = addUsage(newUsageTotals(), result.usage, { canonicalModel: JEV_PRICE_ID, providerId: "openrouter" });
      if (result.costEstimated) totals.costEstimated = true;
      const fields = finishRunCostFields(totals);
      const decisionId: Id<"jevDecisions"> | null = await ctx.runMutation(internal.jev.internalRecordDecision, {
        runId: thisRun,
        organizationId: args.organizationId,
        kind: args.kind,
        conversationId: args.conversationId,
        leadId: args.leadId,
        triggerMessageId: args.triggerMessageId,
        model: result.model,
        requestId: result.requestId,
        stateHash: prepared.stateHash,
        questionsVersion: args.questionsVersion,
        policiesVersion: args.policiesVersion,
        answers: toAnswerRows(result.answers),
        promptTokens: fields.promptTokens,
        completionTokens: fields.completionTokens,
        costUsdEstimate: fields.costUsdEstimate,
        costEstimated: fields.costEstimated === true,
        latencyMs: result.latencyMs,
      });
      return {
        ok: true as const,
        runId: thisRun,
        decisionId,
        model: result.model,
        answers: toAnswerRows(result.answers),
        costUsdMicros: usdToMicros(fields.costUsdEstimate),
        costEstimated: fields.costEstimated === true,
        latencyMs: result.latencyMs,
      };
    } catch (e) {
      const code = e instanceof JevError ? e.code : "unexpected";
      const detail = sanitizeLlmError(e instanceof Error ? e.message : String(e));
      if (runId) {
        try {
          await ctx.runMutation(internal.jev.internalFailDecision, { runId, organizationId: args.organizationId, error: `${code}: ${detail}` });
        } catch {
          /* o chamador já vai seguir fail-open; o watchdog de retenção limpa runs órfãs */
        }
      }
      return { ok: false as const, reason: "error" as const, code, detail };
    }
  },
});

// ── Ops: liga/desliga o módulo da org ───────────────────────────────────────

/**
 * Fases 0–1: o módulo `jev` só liga por aqui (sem UI). `dryRun` é TRUE por padrão.
 * Liga exige IA ativa na org (o Jev recebe texto de cliente). Audit `high`.
 */
export const internalSetModule = internalMutation({
  args: { organizationId: v.id("organizations"), enabled: v.boolean(), dryRun: v.optional(v.boolean()) },
  returns: v.object({ dryRun: v.boolean(), before: v.boolean(), after: v.boolean() }),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");
    const before = modulesOf(org).jev;
    if (args.enabled && !orgAiActive(org)) throw new Error("A IA da organização precisa estar ativa (com o aceite LGPD) antes de ligar o Jev");
    if (args.dryRun !== false) return { dryRun: true, before, after: args.enabled };
    const now = Date.now();
    await ctx.db.patch(org._id, {
      settings: { ...org.settings, modules: { ...(org.settings.modules ?? {}), jev: args.enabled } },
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      organizationId: org._id,
      entityType: "organization",
      entityId: org._id,
      action: "update",
      actorType: "system",
      changes: { before: { jev: before }, after: { jev: args.enabled } },
      metadata: { modules: true, via: "ops" },
      description: `Ops ${args.enabled ? "ligou" : "desligou"} o módulo Decisões (Jev)`,
      severity: "high",
      createdAt: now,
    });
    return { dryRun: false, before, after: args.enabled };
  },
});
