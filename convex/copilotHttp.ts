/**
 * Streaming do copiloto — httpAction SSE AUTENTICADO (v2 §3.4).
 *
 * O copiloto age como o usuário: o request traz o JWT do Convex auth no header
 * Authorization; internalResolveSession valida sessão + membership + gate de
 * ativação da IA ANTES de qualquer tool. Estado durável em copilotThreads/
 * copilotMessages (persistência incremental em fronteiras de sentença — reload
 * e multi-viewer leem do DB; o SSE é só o caminho rápido).
 *
 * Eventos SSE (linhas `data: {...}`):
 *   {type:"thread", threadId}         — thread resolvida (criada se preciso)
 *   {type:"delta", text}              — fragmento de texto do assistant
 *   {type:"tool", name}               — tool executada (só o nome; sem args)
 *   {type:"done"}                     — turno completo
 *   {type:"error", message}           — erro sanitizado
 */
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  ChatMessage,
  ChatToolCall,
  StreamToolCallDelta,
} from "./lib/llm/types";
import {
  streamChat,
  accumulateToolCallDeltas,
  isRetriable,
} from "./lib/llm/openaiCompatible";
import { ResolvedRoute } from "./lib/llm";
import { resolveOrgRoutes, OrgProviderConfig } from "./lib/agentRoutes";
import { DEFAULT_MODELS } from "./lib/llm/registry";
import { sanitizeLlmError } from "./lib/llm/sanitize";
import {
  toChatTools,
  toolSpecByName,
  COPILOT_READ_TOOLS,
  COPILOT_WRITE_TOOLS,
} from "./lib/agentTools";
import { ENVELOPE_SYSTEM_NOTICE, wrapUntrustedJson } from "./lib/promptEnvelope";

const MAX_TOOL_CALLS_PER_TURN = 12;
const WALL_CLOCK_BUDGET_MS = 8 * 60 * 1000; // aborta antes do teto de 10 min da action
const HISTORY_MESSAGE_CAP = 60;

type StoredMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
};

// Prefixo ESTÁVEL primeiro (system + tools) para o cache automático de prefixo
// dos providers; o que varia (histórico) vem depois.
function buildSystemPrompt(session: {
  member: { name: string };
  org: { name: string; currency: string; timezone: string; industry: string | null };
}): string {
  return [
    "Você é o Copiloto do HNBCRM, um CRM brasileiro multi-canal. Você opera o",
    `CRM EM NOME do usuário logado (${session.member.name}) — toda ação sua é`,
    "atribuída a ele e limitada às permissões dele, enforçadas no servidor.",
    "Responda SEMPRE em português do Brasil, de forma curta e prática.",
    "Use as ferramentas para consultar dados reais antes de afirmar qualquer",
    "número; nunca invente dados. Se uma ferramenta falhar ou faltar permissão,",
    "diga isso claramente.",
    "ESCRITAS: antes de criar/mover/atualizar algo, diga em 1 frase o que vai",
    "fazer. Para várias mudanças de uma vez, mostre um resumo do efeito antes",
    "de executar. Exclusões NUNCA acontecem direto: a ferramenta gera uma",
    "confirmação que o usuário aprova na interface — avise-o disso.",
    "ONBOARDING: se o usuário quiser montar o CRM do zero ('me conte seu negócio'),",
    "entreviste-o brevemente (ramo, etapas de venda, campos que importam) e",
    "proponha um plano (board + estágios + campos + respostas rápidas) ANTES de",
    "criar qualquer coisa; crie só após o OK dele, passo a passo.",
    "FORMATO: sua resposta é renderizada como Markdown num painel lateral",
    "estreito. Use **negrito** em nomes e números, listas com \"-\" para",
    "enumerar e tabela (cabeçalho + linha de separação com |---|) SÓ para dados",
    "tabulares de até 4 colunas com células curtas; com mais colunas ou frases",
    "longas, prefira lista. Não use títulos de nível 1 ou 2 (# / ##). Bloco de",
    "código só para código/JSON de verdade.",
    ENVELOPE_SYSTEM_NOTICE,
    `Contexto da organização: nome "${session.org.name}", moeda ${session.org.currency},`,
    `fuso ${session.org.timezone}${session.org.industry ? `, setor ${session.org.industry}` : ""}.`,
  ].join(" ");
}

function toChatHistory(stored: StoredMessage[]): ChatMessage[] {
  // Cap do histórico cortado em fronteira de mensagem `user` para nunca separar
  // um assistant(tool_calls) das suas respostas role:"tool".
  let start = Math.max(0, stored.length - HISTORY_MESSAGE_CAP);
  while (start > 0 && stored[start].role !== "user") start++;
  if (start >= stored.length) start = Math.max(0, stored.length - HISTORY_MESSAGE_CAP);

  return stored.slice(start).map((m): ChatMessage => {
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map(
                (tc): ChatToolCall => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: tc.arguments },
                })
              ),
            }
          : {}),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    }
    return { role: "user", content: m.content };
  });
}

function sseEncode(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export const copilotStream = httpAction(async (ctx, request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  let body: { organizationId?: string; threadId?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "JSON inválido" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
  const organizationId = body.organizationId as Id<"organizations"> | undefined;
  const userText = (body.message ?? "").trim();
  if (!organizationId || !userText) {
    return new Response(JSON.stringify({ error: "organizationId e message são obrigatórios" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Autenticação + gate de ativação — a auth do request propaga pro runQuery.
  let session: {
    member: { _id: Id<"teamMembers">; name: string; role: string };
    org: { name: string; currency: string; timezone: string; industry: string | null };
    providerConfig: {
      strictZdr?: boolean;
      models?: { copilot?: string };
    } | null;
  };
  try {
    session = await ctx.runQuery(internal.copilot.internalResolveSession, { organizationId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Não autenticado";
    const status = /não está ativada/i.test(message) ? 403 : 401;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Rotas da org: platform chain OU BYO; strictZdr filtra rotas não-ZDR.
  const canonicalModel = session.providerConfig?.models?.copilot ?? DEFAULT_MODELS.copilot;
  let routes: ResolvedRoute[];
  try {
    routes = await resolveOrgRoutes(
      ctx,
      organizationId,
      session.providerConfig as OrgProviderConfig | null,
      canonicalModel,
      "copilot"
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Falha ao resolver o provider" }),
      { status: 503, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
  if (routes.length === 0) {
    return new Response(
      JSON.stringify({ error: "Nenhum provider de IA configurado no deployment" }),
      { status: 503, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  const threadId: Id<"copilotThreads"> = await ctx.runMutation(
    internal.copilot.internalGetOrCreateThread,
    {
      organizationId,
      memberId: session.member._id,
      threadId: body.threadId as Id<"copilotThreads"> | undefined,
    }
  );

  await ctx.runMutation(internal.copilot.internalAppendMessage, {
    threadId,
    organizationId,
    role: "user",
    content: userText,
  });

  const runId = await ctx.runMutation(internal.agentRuns.internalStartRun, {
    organizationId,
    memberId: session.member._id,
    kind: "copilot",
    threadId,
    model: canonicalModel,
  });

  const loaded = await ctx.runQuery(internal.copilot.internalGetThreadForRun, {
    threadId,
    memberId: session.member._id,
  });
  const stored: StoredMessage[] = (loaded?.messages ?? []).map(
    (m: {
      role: "user" | "assistant" | "tool";
      content: string;
      toolCalls?: { id: string; name: string; arguments: string }[];
      toolCallId?: string;
    }) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
    })
  );
  // Título lazy da thread a partir da 1ª mensagem do usuário.
  if (!loaded?.thread?.title) {
    await ctx.runMutation(internal.copilot.internalSetThreadTitle, {
      threadId,
      title: userText.slice(0, 60),
    });
  }

  const systemPrompt = buildSystemPrompt(session);
  const tools = toChatTools([...COPILOT_READ_TOOLS, ...COPILOT_WRITE_TOOLS]);
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const send = (payload: Record<string, unknown>) =>
        controller.enqueue(sseEncode(payload));

      let requestCount = 0;
      const toolCallNames: string[] = [];
      let promptTokens = 0;
      let completionTokens = 0;
      let cachedPromptTokens = 0;
      let usedProvider: string | undefined;

      send({ type: "thread", threadId });

      try {
        const messages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          ...toChatHistory(stored),
        ];

        let turnDone = false;
        while (!turnDone) {
          if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) {
            throw new Error("Tempo esgotado para esta resposta — tente de novo");
          }
          if (toolCallNames.length >= MAX_TOOL_CALLS_PER_TURN) {
            throw new Error("Limite de ferramentas por turno atingido");
          }

          // Streaming com fallback de rota: falha ANTES do 1º delta → tenta a
          // próxima rota; falha no meio do stream → erro pro cliente.
          let contentBuffer = "";
          let lastPersistedLength = 0;
          const rawToolDeltas: StreamToolCallDelta[] = [];
          let finish: string | undefined;
          let assistantMessageId: Id<"copilotMessages"> | null = null;

          const persistPartial = async (force: boolean) => {
            if (!contentBuffer) return;
            const boundary =
              force ||
              /[.!?\n]\s*$/.test(contentBuffer) ||
              contentBuffer.length - lastPersistedLength > 400;
            if (!boundary || contentBuffer.length === lastPersistedLength) return;
            if (assistantMessageId === null) {
              assistantMessageId = await ctx.runMutation(
                internal.copilot.internalAppendMessage,
                {
                  threadId,
                  organizationId,
                  role: "assistant",
                  content: contentBuffer,
                  status: "streaming",
                  agentRunId: runId,
                }
              );
            } else {
              await ctx.runMutation(internal.copilot.internalPatchMessage, {
                messageId: assistantMessageId,
                content: contentBuffer,
              });
            }
            lastPersistedLength = contentBuffer.length;
          };

          // Streaming com retry POR ROTA (o OpenCode Go solta 400 "Upstream
          // request failed" transitório — E2E provou intermitência com bytes
          // idênticos) e fallback ENTRE rotas. Retry/fallback só valem antes do
          // 1º delta; depois disso, recomeçar duplicaria conteúdo no cliente.
          const STREAM_ATTEMPTS_PER_ROUTE = 3;
          let streamed = false;
          let lastRouteError: unknown;
          routeLoop: for (const route of routes) {
            for (let attempt = 0; attempt < STREAM_ATTEMPTS_PER_ROUTE; attempt++) {
              try {
                requestCount += 1;
                const generator = streamChat(route.endpoint, {
                  model: route.model,
                  messages,
                  tools,
                  toolChoice: "auto",
                  temperature: 0.4,
                  maxTokens: 2000,
                  extraBody: route.extraBody,
                });
                for await (const delta of generator) {
                  streamed = true;
                  usedProvider = route.providerId;
                  if (delta.contentDelta) {
                    contentBuffer += delta.contentDelta;
                    send({ type: "delta", text: delta.contentDelta });
                    await persistPartial(false);
                  }
                  if (delta.toolCallDeltas) rawToolDeltas.push(...delta.toolCallDeltas);
                  if (delta.finishReason) finish = delta.finishReason;
                  if (delta.usage) {
                    promptTokens += delta.usage.promptTokens;
                    completionTokens += delta.usage.completionTokens;
                    cachedPromptTokens += delta.usage.cachedPromptTokens ?? 0;
                  }
                }
                break routeLoop; // stream completou nesta rota
              } catch (e) {
                lastRouteError = e;
                // Já emitiu conteúdo? Não dá pra recomeçar sem duplicar.
                if (streamed) throw e;
                if (attempt < STREAM_ATTEMPTS_PER_ROUTE - 1 && isRetriable(e)) {
                  await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
                  continue; // retry na MESMA rota
                }
                break; // esgotou os retries → próxima rota da cadeia
              }
            }
          }
          if (!streamed && lastRouteError) throw lastRouteError;

          const toolCalls = accumulateToolCallDeltas(rawToolDeltas);

          if (finish === "content_filter") {
            throw new Error("A resposta foi bloqueada pelo filtro de conteúdo do provider");
          }

          if (toolCalls.length === 0) {
            // Turno terminou em texto puro.
            await persistPartial(true);
            if (assistantMessageId !== null) {
              await ctx.runMutation(internal.copilot.internalPatchMessage, {
                messageId: assistantMessageId,
                status: "done",
              });
            } else if (contentBuffer) {
              await ctx.runMutation(internal.copilot.internalAppendMessage, {
                threadId,
                organizationId,
                role: "assistant",
                content: contentBuffer,
                status: "done",
                agentRunId: runId,
              });
            }
            turnDone = true;
            break;
          }

          // Turno pediu tools: persiste o assistant com tool_calls e executa.
          const storedToolCalls = toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }));
          if (assistantMessageId === null) {
            assistantMessageId = await ctx.runMutation(internal.copilot.internalAppendMessage, {
              threadId,
              organizationId,
              role: "assistant",
              content: contentBuffer,
              toolCalls: storedToolCalls,
              status: "done",
              agentRunId: runId,
            });
          } else {
            await ctx.runMutation(internal.copilot.internalPatchMessage, {
              messageId: assistantMessageId,
              content: contentBuffer,
              status: "done",
              toolCalls: storedToolCalls,
            });
          }
          messages.push({
            role: "assistant",
            content: contentBuffer || null,
            tool_calls: toolCalls,
          });

          for (const tc of toolCalls) {
            toolCallNames.push(tc.function.name);
            send({ type: "tool", name: tc.function.name });

            // Leitura roda como query; escrita como mutation (com attribution
            // via:"copilot" e two-phase p/ destrutivo). Ambos os executores
            // validam nome/permissão e projetam a saída pela whitelist.
            const spec = toolSpecByName(tc.function.name);
            let result: Record<string, unknown>;
            try {
              result =
                spec && spec.effect !== "read"
                  ? await ctx.runMutation(internal.copilot.internalRunCopilotWriteTool, {
                      name: tc.function.name,
                      argsJson: tc.function.arguments,
                      organizationId,
                      memberId: session.member._id,
                      threadId,
                    })
                  : await ctx.runQuery(internal.copilot.internalRunCopilotReadTool, {
                      name: tc.function.name,
                      argsJson: tc.function.arguments,
                      organizationId,
                      memberId: session.member._id,
                    });
            } catch (toolError) {
              // Permissão negada / falha da tool volta ao MODELO como dado —
              // ele explica ao usuário; o stream não morre.
              result = {
                error: sanitizeLlmError(
                  toolError instanceof Error ? toolError.message : "Falha na ferramenta"
                ),
              };
            }

            // Camada 4: resultado entra como DADO delimitado não-confiável.
            const toolContent = wrapUntrustedJson(`resultado de ${tc.function.name}`, result);
            await ctx.runMutation(internal.copilot.internalAppendMessage, {
              threadId,
              organizationId,
              role: "tool",
              content: toolContent,
              toolCallId: tc.id,
            });
            messages.push({ role: "tool", content: toolContent, tool_call_id: tc.id });
          }
          // volta ao loop para a próxima rodada de inferência
        }

        await ctx.runMutation(internal.agentRuns.internalFinishRun, {
          runId,
          status: "done",
          provider: usedProvider,
          requestCount,
          toolCallNames,
          promptTokens,
          completionTokens,
          cachedPromptTokens,
        });
        send({ type: "done" });
      } catch (e) {
        const message = sanitizeLlmError(e instanceof Error ? e.message : "Erro inesperado");
        await ctx.runMutation(internal.agentRuns.internalFinishRun, {
          runId,
          status: "error",
          provider: usedProvider,
          requestCount,
          toolCallNames,
          promptTokens,
          completionTokens,
          cachedPromptTokens,
          error: message,
        });
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders,
    },
  });
});
