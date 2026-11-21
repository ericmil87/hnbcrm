import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requirePermission } from "./lib/auth";
import { chatWithFallback, withoutReasoning } from "./lib/llm";
import { DEFAULT_MODELS } from "./lib/llm/registry";
import { sanitizeLlmError } from "./lib/llm/sanitize";
import { type OrgProviderConfig, resolveOrgRoutes } from "./lib/agentRoutes";
import { addUsage, finishRunCostFields, monthKeyUtc, newUsageTotals } from "./lib/aiSpend";
import { assertModule } from "./lib/orgModules";
import {
  acceptSuggestionCore,
  decideInterpretation,
  dismissSuggestionCore,
  type ClassifierContext,
  listOpenSuggestionsOfConversation,
  loadClassifierContext,
  startInterpretation,
  undoHumanConfirmCore,
  undoRateOfOrg,
} from "./lib/schedInterpretOps";
import { type LlmVerdict, validateClassifierReply } from "./lib/schedInterpretPure";
import { isSchedulingOn, resolveAgendaReader } from "./lib/schedRead";

/**
 * Agenda v2 (C1): interpretar a confirmação que o HUMANO manda pelo WhatsApp. Finas: a regra mora em
 * `lib/schedInterpretOps.ts` (decisão) e `lib/schedInterpretPure.ts` (proposta, serviço, pedido/validação do LLM).
 * Este arquivo só escreve na tabela de interpretações por lá (guard `schedulingPort.test.ts`: nada de patch aqui).
 *
 * Fluxo: o gancho (`maybeScheduleConfirmationInterpretation`, em `conversations.ts`) agenda `internalStart` só depois
 * do pré-filtro positivo; `internalStart` decide o que dá sem LLM e, só se TODAS as outras condições do §8.1 passam
 * e a org tem IA ligada, agenda `internalClassify` (action); `internalDecide` cria pela porta ou grava a proposta.
 */

// ---------------------------------------------------------------------------
// Validators (exportados: o teste compara as chaves devolvidas com eles)
// ---------------------------------------------------------------------------

const actV = v.union(v.literal("confirmou"), v.literal("propos"), v.literal("remarcou"), v.literal("cancelou"), v.literal("informativo"), v.literal("nenhum"));

export const llmVerdictValidator = v.union(
  v.object({ status: v.literal("ok"), ato: actV, dia: v.string(), hora: v.string(), servicoId: v.union(v.string(), v.null()) }),
  v.object({ status: v.literal("unavailable") }),
  v.object({ status: v.literal("invalid") }),
  v.object({ status: v.literal("bad_evidence") })
);

export const startResultValidator = v.object({
  status: v.union(v.literal("skipped"), v.literal("duplicate"), v.literal("final"), v.literal("pending")),
  reason: v.optional(v.string()),
});

export const decideResultValidator = v.object({
  decision: v.string(),
  reason: v.optional(v.string()),
  appointmentId: v.optional(v.id("schedAppointments")),
});

const parsedV = v.object({ localDate: v.optional(v.string()), timeMin: v.optional(v.number()), serviceId: v.optional(v.id("schedServices")) });

export const openSuggestionValidator = v.object({
  _id: v.id("schedInterpretations"),
  conversationId: v.id("conversations"),
  messageId: v.id("messages"),
  act: v.string(),
  parsed: parsedV,
  /** Nome do serviço sugerido (se houver). */
  serviceName: v.optional(v.string()),
  /** Por que não marcou sozinho (código curto: `sem_ia`, `sem_proposta_coincidente`, `servico_ambiguo`, `regra:OUTSIDE_HOURS`…). */
  reason: v.optional(v.string()),
  /** Remarcar/cancelar: o agendamento-alvo, quando único. */
  appointmentId: v.optional(v.id("schedAppointments")),
  createdAt: v.number(),
});

export const undoRateValidator = v.object({
  created: v.number(),
  undone: v.number(),
  rate: v.union(v.number(), v.null()),
  suggested: v.number(),
  accepted: v.number(),
  dismissed: v.number(),
  sample: v.number(),
});

const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// internal*: início, segunda leitura, decisão
// ---------------------------------------------------------------------------

/** Idempotente por mensagem (`schedInterpretations.by_message`). Só chega aqui o que passou no pré-filtro do gancho. */
export const internalStart = internalMutation({
  args: { messageId: v.id("messages") },
  returns: startResultValidator,
  handler: async (ctx, args) => {
    return await startInterpretation(ctx, args.messageId);
  },
});

/** Contexto mínimo da segunda leitura. Query (não lê o relógio): o chamador passa `now`. */
export const internalClassifierContext = internalQuery({
  args: { messageId: v.id("messages"), now: v.number() },
  returns: v.any(),
  handler: async (ctx, args): Promise<ClassifierContext> => {
    return await loadClassifierContext(ctx, args.messageId, args.now);
  },
});

const CLASSIFY_TIMEOUT_MS = 15_000;
/** Folga para o modelo que raciocina mesmo com o raciocínio desligado (ver `translationMaxTokens`). */
const CLASSIFY_MAX_TOKENS = 1024;

/**
 * Segunda leitura (só com IA ligada na org): classificador com SCHEMA FECHADO pelo caminho padrão do repo (`chatWithFallback`,
 * rota e chaves da org, modelo `aiConfig.providerConfig.models.classify`, raciocínio desligado), texto de terceiros dentro do
 * envelope, run em `agentRuns` sem transcrição. Falha, tempo esgotado ou resposta que não valida = "não concorda":
 * a mensagem vira proposta de 1 toque. Nunca lança.
 */
async function runClassifier(ctx: ActionCtx, data: Extract<ClassifierContext, { ok: true }>): Promise<LlmVerdict> {
  const unavailable: LlmVerdict = { status: "unavailable" };
  try {
    const gate = await ctx.runQuery(internal.aiSpend.internalSpendGate, { organizationId: data.organizationId, month: monthKeyUtc(Date.now()), now: Date.now() });
    if (gate.blocked) return unavailable;
    const providerConfig = (data.providerConfig ?? null) as OrgProviderConfig | null;
    const model = (data.providerConfig as { models?: { classify?: string } } | null)?.models?.classify ?? DEFAULT_MODELS.classify;
    const routes = withoutReasoning(await resolveOrgRoutes(ctx, data.organizationId, providerConfig, model));
    if (routes.length === 0) return unavailable;
    const runId = await ctx.runMutation(internal.agentRuns.internalStartRun, {
      organizationId: data.organizationId,
      kind: "sched_interpret" as const,
      conversationId: data.conversationId,
      triggerMessageId: data.messageId,
      model,
    });
    const usage = newUsageTotals();
    let provider: string | undefined;
    let usedModel: string | undefined;
    try {
      const res = await chatWithFallback(
        routes,
        {
          messages: [
            { role: "system", content: data.prompt.system },
            { role: "user", content: data.prompt.user },
          ],
          temperature: 0,
          maxTokens: CLASSIFY_MAX_TOKENS,
          responseFormat: { type: "json_object" },
        },
        { timeoutMs: CLASSIFY_TIMEOUT_MS }
      );
      addUsage(usage, res.usage, res.usedRoute, model, { inputChars: data.prompt.system.length + data.prompt.user.length, outputChars: JSON.stringify(res.message).length });
      provider = res.usedRoute.providerId;
      usedModel = res.usedRoute.canonicalModel;
      const raw = typeof res.message.content === "string" ? res.message.content : "";
      // Resposta cortada nunca é aceita (o JSON pode ter fechado sozinho no meio).
      const verdict: LlmVerdict = res.finishReason === "length" ? { status: "invalid" } : validateClassifierReply(raw, { messageText: data.messageText, days: data.days, services: data.services });
      await ctx.runMutation(internal.agentRuns.internalFinishRun, { runId, status: "done", provider, model: usedModel, requestCount: 1, ...finishRunCostFields(usage) });
      return verdict;
    } catch (e) {
      await ctx.runMutation(internal.agentRuns.internalFinishRun, {
        runId,
        status: "error",
        ...(provider ? { provider } : {}),
        ...(usedModel ? { model: usedModel } : {}),
        requestCount: 1,
        ...finishRunCostFields(usage),
        error: sanitizeLlmError(e instanceof Error ? e.message : "falha ao chamar a IA"),
      });
      return unavailable;
    }
  } catch {
    return unavailable;
  }
}

export const internalClassify = internalAction({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const data: ClassifierContext = await ctx.runQuery(internal.schedulingInterpret.internalClassifierContext, { messageId: args.messageId, now: Date.now() });
    // Já decidida (rede de segurança) ou IA desligada no meio do caminho: nada a gastar.
    if (!data.ok) return null;
    const verdict = await runClassifier(ctx, data);
    await ctx.runMutation(internal.schedulingInterpret.internalDecide, { messageId: args.messageId, llm: verdict });
    return null;
  },
});

/**
 * Decide: com as condições do §8.1 cria pela porta (ator sistema `human_message`, `scheduled`, `conflictToQueue`);
 * senão grava a PROPOSTA de 1 toque com o motivo. `llm` ausente = "não concorda". Idempotente: linha que já não está
 * `pending` (outra via decidiu) não faz nada.
 */
export const internalDecide = internalMutation({
  args: { messageId: v.id("messages"), llm: v.optional(llmVerdictValidator) },
  returns: decideResultValidator,
  handler: async (ctx, args) => {
    return await decideInterpretation(ctx, args.messageId, args.llm);
  },
});

/** Taxa de "desfeito" da org (para a tela sugerir "Só sugerir"). */
export const internalUndoRate = internalQuery({
  args: { organizationId: v.id("organizations"), limit: v.optional(v.number()) },
  returns: undoRateValidator,
  handler: async (ctx, args) => {
    return await undoRateOfOrg(ctx, { organizationId: args.organizationId, limit: args.limit ?? 200 });
  },
});

// ---------------------------------------------------------------------------
// Equipe (agenda:edit)
// ---------------------------------------------------------------------------

/**
 * Responde à sugestão de 1 toque. `accept: true` marca (ou remarca/cancela, nos atos de mudança) pelas portas, com as
 * regras normais: aviso de regra volta como `sched_rules` e o cliente reenvia com `force`. `accept: false` fecha a sugestão.
 */
export const answerSuggestion = mutation({
  args: {
    organizationId: v.id("organizations"),
    interpretationId: v.id("schedInterpretations"),
    accept: v.boolean(),
    edits: v.optional(
      v.object({
        localDate: v.optional(v.string()),
        timeMin: v.optional(v.number()),
        serviceId: v.optional(v.id("schedServices")),
        appointmentId: v.optional(v.id("schedAppointments")),
      })
    ),
    force: v.optional(v.array(v.string())),
  },
  returns: v.object({ appointmentId: v.optional(v.id("schedAppointments")) }),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "agenda", "edit");
    await assertModule(ctx, args.organizationId, "scheduling");
    const now = Date.now();
    if (!args.accept) {
      await dismissSuggestionCore(ctx, { organizationId: args.organizationId, interpretationId: args.interpretationId, member, now });
      return {};
    }
    return await acceptSuggestionCore(ctx, { organizationId: args.organizationId, interpretationId: args.interpretationId, member, edits: args.edits, force: args.force, now });
  },
});

/**
 * Desfaz o agendamento que o sistema criou sozinho a partir da confirmação do humano (24 h; `agenda:edit`; cancela como
 * `system`, sem cancelamento tardio, sem aviso ao cliente, `appointment.undone`). Marca a interpretação como `undone`.
 */
export const undoHumanConfirmBooking = mutation({
  args: { organizationId: v.id("organizations"), appointmentId: v.id("schedAppointments") },
  returns: v.object({ appointmentId: v.id("schedAppointments") }),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "agenda", "edit");
    await assertModule(ctx, args.organizationId, "scheduling");
    return await undoHumanConfirmCore(ctx, { organizationId: args.organizationId, appointmentId: args.appointmentId, member, now: Date.now() });
  },
});

/**
 * Sugestões abertas (e ainda dentro das 48 h) de UMA conversa, para o cartão da conversa. `agenda: view_all`+ (a lista
 * geral é `scheduling.listPending.suggestions`). Vazio sem permissão, módulo desligado ou conversa de outra org.
 * `now`: passe ARREDONDADO À HORA (o servidor também arredonda).
 */
export const listOpenForConversation = query({
  args: { organizationId: v.id("organizations"), conversationId: v.id("conversations"), now: v.number() },
  returns: v.array(openSuggestionValidator),
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.now)) throw new ConvexError("Horário de referência inválido.");
    const reader = await resolveAgendaReader(ctx, args.organizationId, "view_all");
    if (!reader || !(await isSchedulingOn(ctx, args.organizationId))) return [];
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.organizationId !== args.organizationId) return [];
    const rows = await listOpenSuggestionsOfConversation(ctx, {
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      now: Math.floor(args.now / HOUR_MS) * HOUR_MS,
    });
    const out = [];
    for (const r of rows) {
      const service = r.parsed.serviceId ? await ctx.db.get(r.parsed.serviceId as Id<"schedServices">) : null;
      out.push({
        _id: r._id,
        conversationId: r.conversationId,
        messageId: r.messageId,
        act: r.act,
        parsed: r.parsed,
        ...(service && service.organizationId === args.organizationId ? { serviceName: service.name } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.appointmentId ? { appointmentId: r.appointmentId } : {}),
        createdAt: r.createdAt,
      });
    }
    return out;
  },
});
