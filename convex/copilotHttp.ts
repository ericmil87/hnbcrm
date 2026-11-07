/**
 * Streaming do copiloto — httpAction SSE AUTENTICADO (v2 §3.4).
 *
 * O copiloto age como o usuário: o request traz o JWT do Convex auth no header
 * Authorization; internalResolveSession valida sessão + membership + gate de
 * ativação da IA ANTES de qualquer tool. Estado durável em copilotThreads/
 * copilotMessages (persistência incremental em fronteiras de sentença — reload
 * e multi-viewer leem do DB; o SSE é só o caminho rápido).
 *
 * Desde a v0.76 (F3 do Copiloto no Telegram) este arquivo é só o ADAPTADOR:
 * o loop vive em `lib/copilotTurn.ts` (`runCopilotTurn`) e recebe callbacks
 * que viram eventos SSE. O Telegram chama o mesmo loop de uma internalAction.
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
import { ResolvedRoute } from "./lib/llm";
import { buildSetupContextBlock } from "./lib/onboardingSetupContext";
// Custo por modelo + teto de gastos em R$ (v0.69, T04).
import { SPEND_CAP_BLOCKED_MESSAGE, monthKeyUtc } from "./lib/aiSpend";
import {
  CopilotSession,
  resolveCopilotRoutes,
  runCopilotTurn,
} from "./lib/copilotTurn";

// Re-export para quem importava daqui (testes do prompt) — a fonte é lib/copilotTurn.ts.
export { buildSystemPrompt } from "./lib/copilotTurn";

function sseEncode(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export const copilotStream = httpAction(async (ctx, request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  let body: { organizationId?: string; threadId?: string; message?: string; purpose?: unknown };
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

  // `purpose`: só "setup" é reconhecido; qualquer outro valor = sem purpose.
  const isSetup = body.purpose === "setup";

  // Autenticação + gate de ativação — a auth do request propaga pro runQuery.
  let session: CopilotSession;
  try {
    session = await ctx.runQuery(internal.copilot.internalResolveSession, { organizationId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Não autenticado";
    // "IA não está ativada" e "Copiloto está desativado" são gates da org
    // (403); o resto é sessão inválida (401).
    const gate = /não está ativada|desativad/i.test(message);
    const status = gate ? 403 : 401;
    const hint =
      isSetup && /não está ativada/i.test(message)
        ? " Marque 'Quero que a IA me ajude' no passo 1."
        : "";
    return new Response(JSON.stringify({ error: message + hint }), {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Thread guardada no navegador por outra conta (ou apagada): 409 com código
  // para o cliente descartar a thread e reenviar numa nova.
  if (body.threadId) {
    // Sem catch: falha real vira 5xx (o dono não pode perder a thread por erro transitório).
    const owned = await ctx.runQuery(internal.copilot.internalThreadOwnedBy, {
      threadId: String(body.threadId),
      organizationId,
      memberId: session.member._id,
    });
    if (!owned) {
      return new Response(
        JSON.stringify({
          error: "Essa conversa não pertence a esta conta.",
          code: "thread_not_owned",
        }),
        { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
  }

  // Teto de gastos em R$ em `block` (v0.69): copiloto suspenso até virar o mês,
  // com o motivo na tela (403 legível — nunca silêncio).
  const spendGate = await ctx.runQuery(internal.aiSpend.internalSpendGate, {
    organizationId,
    month: monthKeyUtc(Date.now()),
  });
  if (spendGate.blocked) {
    return new Response(JSON.stringify({ error: SPEND_CAP_BLOCKED_MESSAGE }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Rotas da org: platform chain OU BYO; strictZdr filtra rotas não-ZDR.
  let routes: ResolvedRoute[];
  let canonicalModel: string;
  try {
    ({ routes, canonicalModel } = await resolveCopilotRoutes(
      ctx,
      organizationId,
      session.providerConfig,
      "copilot"
    ));
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Falha ao resolver o provider" }),
      { status: 503, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  // Contexto do modo setup: montado AQUI, de dados da org da sessão. O cliente
  // só manda `purpose`; nunca texto de contexto.
  let contextBlock: string | undefined;
  if (isSetup) {
    const setup = await ctx.runQuery(internal.onboarding.internalGetSetupContext, {
      organizationId,
    });
    if (setup) contextBlock = buildSetupContextBlock(setup);
  }

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const send = (payload: Record<string, unknown>) =>
        controller.enqueue(sseEncode(payload));
      try {
        const result = await runCopilotTurn(ctx, {
          organizationId,
          session,
          routes,
          canonicalModel,
          threadId: body.threadId as Id<"copilotThreads"> | undefined,
          text: userText,
          kind: "copilot",
          ...(isSetup ? { contextBlock, threadTitle: "Configuração guiada" } : {}),
          onThread: (threadId) => send({ type: "thread", threadId }),
          onDelta: (text) => send({ type: "delta", text }),
          onTool: (name) => send({ type: "tool", name }),
        });
        if (result.status === "done") send({ type: "done" });
        else send({ type: "error", message: result.error ?? "Erro inesperado" });
      } catch (e) {
        // runCopilotTurn já trata os erros do turno; isto cobre só falha antes
        // de abrir o run (ex.: thread de outro usuário).
        send({ type: "error", message: e instanceof Error ? e.message : "Erro inesperado" });
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
