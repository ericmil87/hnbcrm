/**
 * Ops: REENVIO de um corpo de requisição já montado ao MESMO caminho de LLM do
 * atendente (rotas da org, ZDR, fallbacks), sem tocar em conversa, lead nem
 * mensagem. Serve a um laboratório de prompt: o teste local (vitest) monta o
 * corpo exato que o runtime mandaria e este ops só o reenvia N vezes e devolve
 * as respostas, para medir uma variante de prompt SEM publicar a variante.
 *
 * Só função INTERNA (admin key via `npx convex run`), `dryRun` default TRUE
 * (devolve a cadeia de rotas e nada mais), tetos fixos (n ≤ 20, paralelismo 4),
 * nada é gravado e nada vai a cliente. O texto das respostas só volta ao
 * chamador; o log leva contagens e custo, nunca texto.
 *
 *   npx convex run --prod opsPromptReplay:internalReplayBody '{"organizationId":"…","agentMemberId":"…","messages":[…],"n":5,"dryRun":false}'
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { orgAiActive } from "./lib/agentSecurity";
import { chatWithFallback } from "./lib/llm";
import { resolveOrgRoutes } from "./lib/agentRoutes";
import { DEFAULT_MODELS } from "./lib/llm/registry";
import type { ChatMessage, ToolDefinition } from "./lib/llm/types";

const MAX_SAMPLES = 20;
const CONCURRENCY = 4;
const MAX_TOKENS_CEILING = 4000;

/** Mesma resolução de modelo/provider do runtime do atendente (attendant.ts). */
export const internalReplaySetup = internalQuery({
  args: { organizationId: v.id("organizations"), agentMemberId: v.id("teamMembers") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    const agent = await ctx.db.get(args.agentMemberId);
    if (!org || !agent || agent.organizationId !== args.organizationId) return null;
    if (!orgAiActive(org)) return { blockedReason: "IA da organização desligada" };
    const providerConfig = org.settings.aiConfig?.providerConfig ?? null;
    const profile = agent.agentProfile;
    return {
      providerConfig,
      model: profile?.model ?? providerConfig?.models.attendant ?? DEFAULT_MODELS.attendant,
      temperature: profile?.temperature ?? 0.3,
    };
  },
});

export const internalReplayBody = internalAction({
  args: {
    organizationId: v.id("organizations"),
    agentMemberId: v.id("teamMembers"),
    // Corpo montado pelo teste local: mensagens (system + user), tools e parâmetros.
    messages: v.array(v.any()),
    tools: v.optional(v.array(v.any())),
    toolChoice: v.optional(
      v.union(v.literal("auto"), v.literal("none"), v.literal("required"))
    ),
    temperature: v.optional(v.number()),
    maxTokens: v.optional(v.number()),
    n: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const n = Math.min(Math.max(Math.floor(args.n ?? 1), 1), MAX_SAMPLES);
    const setup: any = await ctx.runQuery(internal.opsPromptReplay.internalReplaySetup, {
      organizationId: args.organizationId,
      agentMemberId: args.agentMemberId,
    });
    if (!setup) return { error: "organização ou agente inválidos" };
    if (typeof setup.blockedReason === "string") return { error: setup.blockedReason };

    const routes = await resolveOrgRoutes(
      ctx,
      args.organizationId,
      setup.providerConfig,
      setup.model,
      "attendant"
    );
    if (routes.length === 0) return { error: "nenhum provider disponível" };
    if (dryRun) {
      return {
        dryRun: true,
        n,
        messages: args.messages.length,
        routes: routes.map((r) => ({ provider: r.endpoint.providerId, model: r.model })),
      };
    }

    const temperature = args.temperature ?? setup.temperature;
    const maxTokens = Math.min(args.maxTokens ?? 2000, MAX_TOKENS_CEILING);
    const request = {
      messages: args.messages as ChatMessage[],
      tools: args.tools as ToolDefinition[] | undefined,
      temperature,
      maxTokens,
    };

    const samples: unknown[] = new Array(n);
    let next = 0;
    let costUsd = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    const worker = async () => {
      while (next < n) {
        const i = next++;
        try {
          const resp = await chatWithFallback(routes, {
            ...request,
            toolChoice: args.toolChoice ?? "auto",
          });
          costUsd += resp.usage?.costUsd ?? 0;
          promptTokens += resp.usage?.promptTokens ?? 0;
          completionTokens += resp.usage?.completionTokens ?? 0;
          samples[i] = {
            text: resp.message.content,
            toolCalls: (resp.message.tool_calls ?? []).map((c) => ({
              name: c.function.name,
              arguments: c.function.arguments,
            })),
            finishReason: resp.finishReason,
            model: resp.usedRoute.model,
            provider: resp.usedRoute.endpoint.providerId,
            completionTokens: resp.usage?.completionTokens ?? null,
          };
        } catch (e) {
          samples[i] = { error: e instanceof Error ? e.message.slice(0, 300) : "falha" };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, n) }, worker));

    console.log(
      JSON.stringify({ event: "promptReplay", n, promptTokens, completionTokens, costUsd })
    );
    return { dryRun: false, n, costUsd, samples };
  },
});
