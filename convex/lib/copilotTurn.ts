/**
 * Loop de um turno do Copiloto — independente de transporte (v0.76, F3 do
 * Copiloto no Telegram).
 *
 * Até a v0.75 o loop (inferência em streaming + tool_calls + persistência
 * incremental + custo) vivia inteiro dentro do `ReadableStream.start` do
 * httpAction SSE (`copilotHttp.ts`), amarrado à sessão de navegador. Aqui ele
 * vira `runCopilotTurn(ctx, opts)`: o SSE é um adaptador que passa callbacks
 * (`onThread`/`onDelta`/`onTool`) e o Telegram chama o mesmo loop de uma
 * `internalAction` com `kind:"telegram_copilot"`, um bloco de contexto da
 * conversa em foco e um filtro de ferramentas. Dois loops divergiriam (D9).
 *
 * Invariantes preservadas do loop original: prefixo estável do system prompt
 * (cache de prefixo), retry ×3 por rota e fallback entre rotas só ANTES do 1º
 * delta, persistência em fronteira de sentença, resultado de tool entra como
 * dado não-confiável (`wrapUntrustedJson`), erro de tool volta ao modelo como
 * dado, teto de 12 tools e 8 min por turno, custo no `agentRuns`.
 */
import { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { ChatMessage, ChatToolCall, StreamToolCallDelta } from "./llm/types";
import { streamChat, accumulateToolCallDeltas, isRetriable } from "./llm/openaiCompatible";
import { ResolvedRoute } from "./llm";
import {
  resolveOrgRoutes,
  resolveProductRoutes,
  OrgProviderConfig,
  AiProduct,
} from "./agentRoutes";
import { DEFAULT_MODELS } from "./llm/registry";
import { sanitizeLlmError } from "./llm/sanitize";
import {
  toChatTools,
  toolSpecByName,
  COPILOT_READ_TOOLS,
  COPILOT_WRITE_TOOLS,
  AgentToolSpec,
} from "./agentTools";
import { ENVELOPE_SYSTEM_NOTICE, wrapUntrustedJson } from "./promptEnvelope";
import { buildCurrentDateTimeBlock } from "./promptDateTime";
import { addUsage, finishRunCostFields, newUsageTotals } from "./aiSpend";

export const MAX_TOOL_CALLS_PER_TURN = 12;
export const WALL_CLOCK_BUDGET_MS = 8 * 60 * 1000; // aborta antes do teto de 10 min da action
export const HISTORY_MESSAGE_CAP = 60;
const STREAM_ATTEMPTS_PER_ROUTE = 3;

export type CopilotSession = {
  member: { _id: Id<"teamMembers">; name: string; role: string };
  org: { name: string; currency: string; timezone: string; industry: string | null };
  providerConfig: OrgProviderConfig | null;
};

export type CopilotTurnKind = "copilot" | "telegram_copilot";
export type CopilotProduct = Extract<AiProduct, "copilot" | "telegramCopilot">;

type StoredMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
};

// ── Prompt ──────────────────────────────────────────────────────────────────

// Prefixo ESTÁVEL primeiro (system + tools) para o cache automático de prefixo
// dos providers; o que varia (histórico) vem depois. A variante "telegram"
// troca só o parágrafo FORMATO e acrescenta a persona executiva — cada
// variante tem o seu prefixo cacheado.
const FORMAT_WEB = [
  "FORMATO: sua resposta é renderizada como Markdown num painel lateral",
  "estreito. Use **negrito** em nomes e números, listas com \"-\" para",
  "enumerar e tabela (cabeçalho + linha de separação com |---|) SÓ para dados",
  "tabulares de até 4 colunas com células curtas; com mais colunas ou frases",
  "longas, prefira lista. Não use títulos de nível 1 ou 2 (# / ##). Bloco de",
  "código só para código/JSON de verdade.",
].join(" ");

const FORMAT_TELEGRAM = [
  "FORMATO: sua resposta vai para o Telegram. Sem tabelas, sem títulos (#),",
  "listas curtas com \"-\", **negrito** só em nomes e valores, no máximo",
  "1500 caracteres por resposta; quando houver muito, resuma e ofereça detalhar.",
  "Você também é o assistente executivo no Telegram: quando o usuário fala sobre",
  "a conversa em foco, prefira acionar o Atendente de IA com uma instrução clara",
  "a responder você mesmo ao cliente; explique em uma linha o que fez.",
  "CONFIRMAÇÕES: quando uma ferramenta devolver confirmacao_necessaria, o Telegram",
  "mostra um cartão com os botões ✅ Confirmar e ✖ Cancelar logo abaixo da sua",
  "resposta. Diga só \"toque em ✅ Confirmar no cartão\". Confirmação por texto NÃO",
  "existe: nunca peça \"pode ir\", \"me diga sim\" nem \"aprove na tela\".",
].join(" ");

/** Exportado (como os demais construtores de prompt do produto) para teste. */
export function buildSystemPrompt(
  session: {
    member: { name: string };
    org: { name: string; currency: string; timezone: string; industry: string | null };
  },
  now: number,
  opts?: { variant?: "web" | "telegram" }
): string {
  const format = opts?.variant === "telegram" ? FORMAT_TELEGRAM : FORMAT_WEB;
  return [
    "Você é o Copiloto do HNBCRM, um CRM brasileiro multi-canal. Você opera o",
    `CRM EM NOME do usuário logado (${session.member.name}) — toda ação sua é`,
    "atribuída a ele e limitada às permissões dele, enforçadas no servidor.",
    "Responda SEMPRE em português do Brasil, de forma curta e prática.",
    "Use as ferramentas para consultar dados reais antes de afirmar qualquer",
    "número; nunca invente dados. Se uma ferramenta falhar ou faltar permissão,",
    "diga isso claramente.",
    "Para perguntas por período ('hoje', 'esta semana') use os filtros createdAfter/createdBefore",
    "das ferramentas; as datas vêm no fuso da organização.",
    "ESCRITAS: antes de criar/mover/atualizar algo, diga em 1 frase o que vai",
    "fazer. Para várias mudanças de uma vez, mostre um resumo do efeito antes",
    "de executar. Exclusões NUNCA acontecem direto: a ferramenta gera uma",
    "confirmação que o usuário aprova na interface — avise-o disso.",
    "ONBOARDING: se o usuário quiser montar o CRM do zero ('me conte seu negócio'),",
    "entreviste-o brevemente (ramo, etapas de venda, campos que importam) e",
    "proponha um plano (board + estágios + campos + respostas rápidas) ANTES de",
    "criar qualquer coisa; crie só após o OK dele, passo a passo.",
    "ATENDENTE IA: você pode ler a configuração (getAttendantConfig, getAttendantSetupGuide)",
    "e PROPOR mudanças de persona, conhecimento, horário, repasse, follow-up e recursos",
    "(áudio/imagem). Toda mudança gera um cartão de confirmação; diga ao usuário para",
    'conferir "Antes/Depois". Você NUNCA liga a IA, nunca aceita termos (LGPD, risco do',
    "WhatsApp não oficial, autopilot antecipado) e nunca mexe em modelos ou custos:",
    "explique o que a pessoa precisa marcar e onde. Uma mudança por vez.",
    "CAMPANHAS (disparo em massa de WhatsApp): você pode listar, ver relatório,",
    "estimar público e criar RASCUNHOS (createCampaignDraft), pausar e retomar.",
    "Você NUNCA lança uma campanha — o lançamento exige aceites humanos",
    "(consentimento LGPD e risco do bridge) na tela de Campanhas; diga isso e",
    "aponte o link. Cancelar gera confirmação. Sugira 2+ variantes de texto,",
    "{{nome}} para personalizar e nunca proponha subir limites acima do modo seguro.",
    format,
    ENVELOPE_SYSTEM_NOTICE,
    `Contexto da organização: nome "${session.org.name}", moeda ${session.org.currency},`,
    `fuso ${session.org.timezone}${session.org.industry ? `, setor ${session.org.industry}` : ""}.`,
    // Data/hora por ÚLTIMO: é o único trecho que muda a cada minuto, e no fim
    // preserva o prefixo estável que o provider cacheia. Aqui não há
    // agentProfile (quem fala é o usuário logado), então é sempre ligado —
    // "tarefas de hoje" e "vencidas" dependem de saber a data.
    `\n${buildCurrentDateTimeBlock(now, session.org.timezone)}`,
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

// ── Rotas ───────────────────────────────────────────────────────────────────

/**
 * Modelo canônico + cadeia de rotas do produto. Lança `Error` com mensagem em
 * PT-BR quando não há rota (o adaptador HTTP responde 503; o Telegram manda o
 * aviso de §4.10). Modelo do produto: `providerConfig.models.<produto>` →
 * `DEFAULT_MODELS.<produto>`; sem o default do produto cai no do copiloto.
 */
export async function resolveCopilotRoutes(
  ctx: ActionCtx,
  organizationId: Id<"organizations">,
  providerConfig: OrgProviderConfig | null,
  product: CopilotProduct
): Promise<{ routes: ResolvedRoute[]; canonicalModel: string }> {
  // Telegram: `resolveProductRoutes` (lib/agentRoutes.ts) aplica o modelo do
  // produto, a ordem openrouter-first e o fallback para o modelo do copiloto
  // quando o alias do OpenRouter não tem rota no deployment. Web: caminho
  // original (modelo do copiloto + cadeia da org).
  const { routes, canonicalModel } =
    product === "telegramCopilot"
      ? await resolveProductRoutes(ctx, organizationId, providerConfig, product)
      : await (async () => {
          const model = providerConfig?.models?.copilot ?? DEFAULT_MODELS.copilot;
          return {
            routes: await resolveOrgRoutes(ctx, organizationId, providerConfig, model, "copilot"),
            canonicalModel: model,
          };
        })();
  if (routes.length === 0) {
    throw new Error("Nenhum provider de IA configurado no deployment");
  }
  return { routes, canonicalModel };
}

// ── Turno ───────────────────────────────────────────────────────────────────

export type CopilotTurnOptions = {
  organizationId: Id<"organizations">;
  session: CopilotSession;
  routes: ResolvedRoute[];
  canonicalModel: string;
  threadId?: Id<"copilotThreads">;
  text: string;
  /** `agentRuns.kind` (default "copilot"). */
  kind?: CopilotTurnKind;
  /** Default `buildSystemPrompt(session, now)`. */
  systemPrompt?: string;
  /** D17: bloco de contexto da conversa em foco — 2ª mensagem system, não persiste na thread. */
  contextBlock?: string;
  /** Título forçado da thread nova (ex.: "Configuração guiada"); default = 1ª mensagem. */
  threadTitle?: string;
  /** D22: restringe a lista de ferramentas deste turno (nunca amplia). */
  toolFilter?: (spec: AgentToolSpec) => boolean;
  /** Injetado nos executores (ex.: conversa em foco); o modelo nunca o vê. */
  focusConversationId?: Id<"conversations">;
  /** D22: origem das escritas deste turno (auditoria `metadata.via`); default do executor = "copilot". */
  toolVia?: "telegram_auto";
  /** Telegram (0.77.2): the member's effective assistant mode; absent on the web. */
  assistantMode?: "suggest" | "auto";
  onThread?: (threadId: Id<"copilotThreads">) => void | Promise<void>;
  onDelta?: (text: string) => void | Promise<void>;
  onTool?: (name: string) => void | Promise<void>;
  /** Checado entre rodadas e a cada delta; `true` encerra o turno como "canceled". */
  shouldCancel?: () => boolean | Promise<boolean>;
};

export type CopilotTurnResult = {
  threadId: Id<"copilotThreads">;
  finalText: string;
  pendingActionIds: Id<"pendingActions">[];
  status: "done" | "error" | "canceled";
  error?: string;
  toolCallNames: string[];
  usedProvider?: string;
  /** `agentRuns` id of this turn (keys the D22 undo steps). */
  agentRunId?: Id<"agentRuns">;
};

class TurnCanceled extends Error {
  constructor() {
    super("Resposta interrompida");
    this.name = "TurnCanceled";
  }
}

export async function runCopilotTurn(
  ctx: ActionCtx,
  opts: CopilotTurnOptions
): Promise<CopilotTurnResult> {
  const { organizationId, session, routes, canonicalModel } = opts;
  const kind: CopilotTurnKind = opts.kind ?? "copilot";
  const userText = opts.text;

  const threadId: Id<"copilotThreads"> = await ctx.runMutation(
    internal.copilot.internalGetOrCreateThread,
    { organizationId, memberId: session.member._id, threadId: opts.threadId }
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
    kind,
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
      title: opts.threadTitle ?? userText.slice(0, 60),
    });
  }

  const startedAt = Date.now();
  const systemPrompt = opts.systemPrompt ?? buildSystemPrompt(session, startedAt);
  const allSpecs = [...COPILOT_READ_TOOLS, ...COPILOT_WRITE_TOOLS];
  const specs = opts.toolFilter ? allSpecs.filter(opts.toolFilter) : allSpecs;
  const allowedToolNames = new Set(specs.map((s) => s.name));
  const tools = toChatTools(specs);

  let requestCount = 0;
  const toolCallNames: string[] = [];
  const pendingActionIds: Id<"pendingActions">[] = [];
  // Tokens + custo (por modelo da rota que de fato respondeu). O copiloto
  // nunca gravava custo — o painel de uso mostrava US$ 0 (v0.69).
  const usage = newUsageTotals();
  let usedProvider: string | undefined;
  let finalText = "";

  await opts.onThread?.(threadId);

  const checkCancel = async () => {
    if (opts.shouldCancel && (await opts.shouldCancel())) throw new TurnCanceled();
  };

  try {
    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
    if (opts.contextBlock) messages.push({ role: "system", content: opts.contextBlock });
    messages.push(...toChatHistory(stored));

    let turnDone = false;
    while (!turnDone) {
      await checkCancel();
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
          assistantMessageId = await ctx.runMutation(internal.copilot.internalAppendMessage, {
            threadId,
            organizationId,
            role: "assistant",
            content: contentBuffer,
            status: "streaming",
            agentRunId: runId,
          });
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
                await opts.onDelta?.(delta.contentDelta);
                await persistPartial(false);
                await checkCancel();
              }
              if (delta.toolCallDeltas) rawToolDeltas.push(...delta.toolCallDeltas);
              if (delta.finishReason) finish = delta.finishReason;
              if (delta.usage) addUsage(usage, delta.usage, route, canonicalModel);
            }
            break routeLoop; // stream completou nesta rota
          } catch (e) {
            if (e instanceof TurnCanceled) throw e;
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
        finalText = contentBuffer;
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
        await opts.onTool?.(tc.function.name);

        // Leitura roda como query; escrita como mutation (com attribution
        // via:"copilot" e two-phase p/ destrutivo). Ambos os executores
        // validam nome/permissão e projetam a saída pela whitelist. Uma tool
        // fora do filtro deste turno (D22) nem chega ao executor.
        const spec = toolSpecByName(tc.function.name);
        let result: Record<string, unknown>;
        try {
          if (!allowedToolNames.has(tc.function.name)) {
            throw new Error("Ferramenta indisponível neste turno");
          }
          result =
            spec && spec.effect !== "read"
              ? await ctx.runMutation(internal.copilot.internalRunCopilotWriteTool, {
                  name: tc.function.name,
                  argsJson: tc.function.arguments,
                  organizationId,
                  memberId: session.member._id,
                  threadId,
                  focusConversationId: opts.focusConversationId,
                  via: opts.toolVia,
                  ...(opts.toolVia ? { agentRunId: runId } : {}),
                  ...(opts.assistantMode ? { assistantMode: opts.assistantMode } : {}),
                  // Ordinal rule: numbers resolve against the list as of the turn start.
                  turnStartedAt: startedAt,
                })
              : await ctx.runQuery(internal.copilot.internalRunCopilotReadTool, {
                  name: tc.function.name,
                  argsJson: tc.function.arguments,
                  organizationId,
                  memberId: session.member._id,
                  now: Date.now(),
                  focusConversationId: opts.focusConversationId,
                  via: opts.toolVia,
                  turnStartedAt: startedAt,
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
        const pendingId = (result as { pendingActionId?: unknown }).pendingActionId;
        if (typeof pendingId === "string" && pendingId) {
          pendingActionIds.push(pendingId as Id<"pendingActions">);
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
      model: canonicalModel,
      requestCount,
      toolCallNames,
      ...finishRunCostFields(usage),
    });
    return { threadId, finalText, pendingActionIds, status: "done", toolCallNames, usedProvider, agentRunId: runId };
  } catch (e) {
    const canceled = e instanceof TurnCanceled;
    const message = canceled
      ? "Resposta interrompida"
      : sanitizeLlmError(e instanceof Error ? e.message : "Erro inesperado");
    await ctx.runMutation(internal.agentRuns.internalFinishRun, {
      runId,
      status: "error",
      provider: usedProvider,
      requestCount,
      toolCallNames,
      ...finishRunCostFields(usage),
      error: message,
    });
    return {
      threadId,
      finalText,
      pendingActionIds,
      status: canceled ? "canceled" : "error",
      error: message,
      toolCallNames,
      usedProvider,
      agentRunId: runId,
    };
  }
}
