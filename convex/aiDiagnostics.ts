/**
 * Diagnóstico de conectividade LLM — ferramenta de OPS (interna, nunca exposta
 * a clientes nem como tool de IA). Roda uma inferência mínima com tool-call na
 * cadeia da plataforma a partir DO DEPLOYMENT (valida env key + fetch + parse
 * no runtime real do Convex). Executar via CLI/MCP:
 *   npx convex run aiDiagnostics:pingProvider '{"model":"deepseek-v4-flash"}'
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { chatWithFallback, resolvePlatformChain } from "./lib/llm";
import { DEFAULT_MODELS } from "./lib/llm/registry";
import { sanitizeLlmError } from "./lib/llm/sanitize";

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

    try {
      const resp = await chatWithFallback(routes, {
        messages: args.continuation === true ? continuationMessages : baseMessages,
        tools: [
          {
            type: "function",
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
        toolChoice: "auto",
        temperature: 0,
        maxTokens: 100,
      });
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
