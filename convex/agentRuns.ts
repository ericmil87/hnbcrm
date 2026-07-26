/**
 * Registro de operações de IA (agentRuns) — SEM transcrições/PII (LGPD art. 37
 * sem duplicar art. 18): só tokens, custo estimado, nomes de tools e ponteiros.
 * Compartilhado por copiloto, atendente e simulador.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { sanitizeLlmError } from "./lib/llm/sanitize";

export const internalStartRun = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"),
    kind: v.union(v.literal("copilot"), v.literal("attendant"), v.literal("simulator")),
    conversationId: v.optional(v.id("conversations")),
    leadId: v.optional(v.id("leads")),
    triggerMessageId: v.optional(v.id("messages")),
    threadId: v.optional(v.id("copilotThreads")),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
  },
  returns: v.id("agentRuns"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("agentRuns", {
      organizationId: args.organizationId,
      memberId: args.memberId,
      kind: args.kind,
      status: "running",
      conversationId: args.conversationId,
      leadId: args.leadId,
      triggerMessageId: args.triggerMessageId,
      threadId: args.threadId,
      provider: args.provider,
      model: args.model,
      requestCount: 0,
      startedAt: Date.now(),
    });
  },
});

export const internalFinishRun = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    status: v.union(v.literal("done"), v.literal("error"), v.literal("aborted")),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    requestCount: v.optional(v.number()),
    toolCallNames: v.optional(v.array(v.string())),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    cachedPromptTokens: v.optional(v.number()),
    costUsdEstimate: v.optional(v.number()),
    confidence: v.optional(v.number()),
    error: v.optional(v.string()),
    resultMessageId: v.optional(v.id("messages")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { runId, error, ...rest } = args;
    const clean = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined)
    );
    await ctx.db.patch(runId, {
      ...clean,
      // Cinto e suspensório: sanitiza de novo mesmo que o chamador já o faça.
      ...(error !== undefined ? { error: sanitizeLlmError(error) } : {}),
      finishedAt: Date.now(),
    });
    return null;
  },
});

// Medidor de uso: conversas atendidas no mês corrente (kill-switch de budget).
export const internalCountMonthlyAttendantRuns = internalQuery({
  args: { organizationId: v.id("organizations"), monthStart: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_organization_and_kind_and_started", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("kind", "attendant")
          .gte("startedAt", args.monthStart)
      )
      .collect();
    // Conta CONVERSAS distintas, não runs — o medidor amigável fala em conversas.
    const conversations = new Set(runs.map((r) => r.conversationId).filter(Boolean));
    return conversations.size;
  },
});
