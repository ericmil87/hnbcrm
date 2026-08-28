/**
 * Diagnóstico de conectividade LLM — ferramenta de OPS (interna, nunca exposta
 * a clientes nem como tool de IA). Roda uma inferência mínima com tool-call na
 * cadeia da plataforma a partir DO DEPLOYMENT (valida env key + fetch + parse
 * no runtime real do Convex). Executar via CLI/MCP:
 *   npx convex run aiDiagnostics:pingProvider '{"model":"deepseek-v4-flash"}'
 */
import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { chatWithFallback, resolvePlatformChain, ResolvedRoute } from "./lib/llm";
import { resolveOrgRoutes, OrgProviderConfig } from "./lib/agentRoutes";
import { DEFAULT_MODELS } from "./lib/llm/registry";
import { sanitizeLlmError } from "./lib/llm/sanitize";

type HopResult = {
  provider: string;
  model: string;
  ok: boolean;
  toolCallWorked: boolean;
  error: string | null;
};

const hopResultValidator = v.object({
  provider: v.string(),
  model: v.string(),
  ok: v.boolean(),
  toolCallWorked: v.boolean(),
  error: v.union(v.string(), v.null()),
});

// Pinga cada rota isoladamente (sem fallback) — expõe o erro de cada hop.
async function pingRoutes(routes: ResolvedRoute[]): Promise<HopResult[]> {
  const results: HopResult[] = [];
  for (const route of routes) {
    try {
      const resp = await chatWithFallback([route], buildPingRequest(false));
      results.push({
        provider: route.providerId,
        model: route.model,
        ok: true,
        toolCallWorked: (resp.message.tool_calls?.length ?? 0) > 0,
        error: null,
      });
    } catch (e) {
      results.push({
        provider: route.providerId,
        model: route.model,
        ok: false,
        toolCallWorked: false,
        error: sanitizeLlmError(e instanceof Error ? e.message : "Falha desconhecida"),
      });
    }
  }
  return results;
}

// Teste de conexão da UI (Configurações → IA): pinga cada rota EFETIVA da org
// (respeita mode platform/byo, platformOrder e strictZdr). settings/manage.
export const testOrgConnection = action({
  args: {
    organizationId: v.id("organizations"),
    role: v.optional(v.union(v.literal("attendant"), v.literal("copilot"))),
  },
  returns: v.array(hopResultValidator),
  handler: async (ctx, args): Promise<HopResult[]> => {
    await ctx.runQuery(internal.channelConfigs.internalRequireSettingsManage, {
      organizationId: args.organizationId,
    });
    const providerConfig = (await ctx.runQuery(internal.aiSettings.internalGetProviderConfig, {
      organizationId: args.organizationId,
    })) as (OrgProviderConfig & { models?: Record<string, string> }) | null;
    const role = args.role ?? "attendant";
    const model = providerConfig?.models?.[role] ?? DEFAULT_MODELS[role];

    let routes: ResolvedRoute[];
    try {
      routes = await resolveOrgRoutes(ctx, args.organizationId, providerConfig, model, role);
    } catch (e) {
      return [
        {
          provider: "config",
          model,
          ok: false,
          toolCallWorked: false,
          error: sanitizeLlmError(e instanceof Error ? e.message : "Configuração inválida"),
        },
      ];
    }
    if (routes.length === 0) {
      return [
        {
          provider: "nenhum",
          model,
          ok: false,
          toolCallWorked: false,
          error:
            "Nenhuma rota disponível — verifique as keys da plataforma ou o filtro ZDR estrito",
        },
      ];
    }
    return await pingRoutes(routes);
  },
});

// Requisição mínima de ping (com tool-call) compartilhada pelos diagnósticos.
function buildPingRequest(continuation: boolean) {
  const baseMessages: import("./lib/llm/types").ChatMessage[] = [
    { role: "system", content: "Você é um teste de conectividade. Responda em português." },
    {
      role: "user",
      content: "Chame a ferramenta ping com status 'ok' para confirmar a conectividade.",
    },
  ];
  const continuationMessages: import("./lib/llm/types").ChatMessage[] = [
    ...baseMessages,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_diag_1",
          type: "function",
          function: { name: "ping", arguments: '{"status":"ok"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_diag_1", content: '{"status":"ok"}' },
  ];
  return {
    messages: continuation ? continuationMessages : baseMessages,
    tools: [
      {
        type: "function" as const,
        function: {
          name: "ping",
          description: "Confirma conectividade",
          parameters: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
            additionalProperties: false,
          },
        },
      },
    ],
    toolChoice: "auto" as const,
    temperature: 0,
    maxTokens: 100,
  };
}

// Diagnóstico POR HOP: pinga cada rota da cadeia da plataforma isoladamente.
// O pingProvider normal usa o fallback — se o 1º hop falha e o 2º responde, o
// resultado esconde qual hop quebrou e por quê. Este expõe o erro de cada um.
//   npx convex run aiDiagnostics:pingChain '{}'
export const pingChain = internalAction({
  args: { model: v.optional(v.string()) },
  returns: v.array(hopResultValidator),
  handler: async (ctx, args) => {
    const model = args.model ?? DEFAULT_MODELS.attendant;
    const routes = resolvePlatformChain(model, {
      opencodeGoKey: process.env.OPENCODE_GO_API,
      openrouterKey: process.env.OPENROUTER_API_KEY,
    });
    return await pingRoutes(routes);
  },
});

export const pingProvider = internalAction({
  args: {
    model: v.optional(v.string()),
    // continuation:true reproduz o cenário de 2ª chamada (assistant tool_calls +
    // tool result) que o OpenCode Go às vezes 400a com "Upstream request failed"
    // — valida o retry/fallover da camada LLM contra o caso real.
    continuation: v.optional(v.boolean()),
  },
  returns: v.object({
    ok: v.boolean(),
    provider: v.union(v.string(), v.null()),
    model: v.union(v.string(), v.null()),
    toolCallWorked: v.boolean(),
    promptTokens: v.union(v.number(), v.null()),
    completionTokens: v.union(v.number(), v.null()),
    error: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const model = args.model ?? DEFAULT_MODELS.attendant;
    const routes = resolvePlatformChain(model, {
      opencodeGoKey: process.env.OPENCODE_GO_API,
      openrouterKey: process.env.OPENROUTER_API_KEY,
    });
    if (routes.length === 0) {
      return {
        ok: false,
        provider: null,
        model: null,
        toolCallWorked: false,
        promptTokens: null,
        completionTokens: null,
        error: "Nenhuma key de provider configurada no deployment",
      };
    }
    try {
      const resp = await chatWithFallback(routes, buildPingRequest(args.continuation === true));
      return {
        ok: true,
        provider: resp.usedRoute.providerId,
        model: resp.usedRoute.model,
        toolCallWorked: (resp.message.tool_calls?.length ?? 0) > 0,
        promptTokens: resp.usage?.promptTokens ?? null,
        completionTokens: resp.usage?.completionTokens ?? null,
        error: null,
      };
    } catch (e) {
      return {
        ok: false,
        provider: null,
        model: null,
        toolCallWorked: false,
        promptTokens: null,
        completionTokens: null,
        error: sanitizeLlmError(e instanceof Error ? e.message : "Falha desconhecida"),
      };
    }
  },
});
