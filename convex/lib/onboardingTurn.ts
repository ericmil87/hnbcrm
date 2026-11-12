/**
 * Loop de UM turno do onboarding conversacional v2 (P2.3), independente de
 * transporte: o SSE (`onboardingHttp.ts`) e a interna `onboardingChat.internalSendTurn`
 * chamam o mesmo `runOnboardingTurn` (callbacks viram eventos SSE).
 *
 * Ordem do turno (limites SEMPRE antes de gastar):
 *  1. abertura com auth (`internalPrepareTurn`): D1, D2, aviso de materiais,
 *     posse/tamanho do arquivo, sessão;
 *  2. rate limit de usuário + org consumido UMA vez por turno, antes de
 *     qualquer material ou LLM (turno que falha depois também conta);
 *  3. rascunho inicial pelo template do segmento (1º turno);
 *  4. material, se houver — orçamento reservado ANTES de buscar/ler:
 *     - URL: reserva do leitor → página reservada no contador do servidor →
 *       `internalFetchAndExtract`;
 *     - PDF: reserva do leitor → `internalFetchAndExtract` (storageId da org);
 *     - imagem: reservas do leitor e da visão → `vision.internalDescribeImageForOnboarding`;
 *     - áudio: reserva de transcrição → Whisper (serviço compartilhado com os
 *       clientes reais) → vira MENSAGEM DO USUÁRIO (não vai ao leitor), sempre
 *       envelopada como dado no prompt;
 *     → LEITOR em quarentena (sem tools, só JSON de conteúdo) → mescla →
 *       `internalSaveDraft` com `sourceTexts` (o texto bruto NÃO é persistido);
 *  5. reserva do ENTREVISTADOR; só com ela aprovada a mensagem do usuário é
 *     gravada no histórico; entrevistador (sem tools; vê o rascunho validado,
 *     com itens marcados substituídos por marcador) → `draftPatch` gravado por
 *     `internalSaveDraft` (versão esperada);
 *  6. blocos montados pelo SERVIDOR a partir do rascunho gravado; mensagem gravada.
 *  7. (P4.2b) turno com áudio do usuário transcrito: a resposta aprovada é
 *     falada pela porta única de TTS (`speakReply`: regras de `lib/tts.ts`,
 *     strictZdr → texto, reserva `tts` antes, registro depois) e sai como
 *     evento `audio` depois do texto. Falha = só texto, o turno não falha.
 *
 * Cada chamada de LLM: reserva antes (recusa = sem chamada, mensagem PT-BR) e
 * `internalRecordOnboardingSpend` depois, também em erro ou quando a busca do
 * material falha (solta a reserva). Até 4 chamadas por turno com imagem
 * (visão, leitor, entrevistador e uma retentativa do entrevistador). O texto
 * da resposta só sai depois do guard de saída (por isso o `delta` vem depois
 * da validação, não token a token). Rotas: chave da PLATAFORMA, respeitando
 * `strictZdr` e `platformOrder` da org (nunca BYO).
 */
import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { chatWithFallback } from "./llm";
import { resolveOrgRoutes, type OrgProviderConfig, type PlatformOrder } from "./agentRoutes";
import { getOnboardingModel } from "./onboardingModels";
import { addUsage, finishRunCostFields, newUsageTotals } from "./aiSpend";
import { sanitizeLlmError } from "./llm/sanitize";
import { cleanDraftText, normalizeDraft, DRAFT_LIMITS, type OnboardingDraft } from "./onboardingDraft";
import { maskFreeText } from "./onboardingSetupContext";
import {
  ACTION_BLOCK_KINDS,
  buildBlock,
  buildBlocks,
  onboardingBlockValidator,
  type BlockContext,
  type BlockRequest,
  type OnboardingBlock,
  type OnboardingBlockKind,
  type UploadOutcome,
} from "./onboardingBlocks";
import {
  CARD_SECTION,
  actionCardSignature,
  cardSignature,
  coherentChips,
  materialPendingMessage,
  nextTask,
  planTurnCards,
  replyMentionsUi,
  stepMessage,
  taskCard,
  taskChips,
  taskStepIndex,
  isDraftCardKind,
  sectionSignature,
  type ApprovalSection,
  type RoadmapFacts,
  type RoadmapNotice,
  type RoadmapTask,
  type TaskCardKind,
} from "./onboardingRoadmap";
import {
  CHIPS_MIN,
  INTERVIEWER_RETRY_NUDGE,
  USER_TEXT_MAX,
  buildInterviewerMessages,
  buildReaderMessages,
  maskThirdPartyEmails,
  mergeDraftPatch,
  mergeReaderProposal,
  parseInterviewerOutput,
  parseReaderOutput,
  templateStartDraft,
  type HistoryItem,
  type InterviewerOutput,
  type MaterialKind,
} from "./onboardingInterviewer";
import type { ChatMessage } from "./llm/types";
import { segmentTemplate } from "./onboardingTemplates";
import { platformTtsAllowed } from "./agentRoutes";
import { detectLanguage } from "./languageDetect";
import {
  VOICE_REPLY_MAX_CHARS,
  VOICE_REPLY_MAX_SECONDS,
  estimateTtsCost,
  getTtsConfig,
  planOnboardingVoiceReply,
  type VoiceTextReason,
} from "./tts";

export type SpendRole = "interviewer" | "reader" | "vision" | "transcription" | "tts";

// Estimativas por chamada (micro-US$) segurando saldo na reserva. A transcrição
// roda no Whisper próprio (custo de LLM zero), mas passa pela reserva para que
// orçamento/limites cortem ANTES de ocupar o serviço compartilhado.
export const ESTIMATE_USD_MICROS: Record<Exclude<SpendRole, "tts">, number> = {
  interviewer: 20_000,
  reader: 10_000,
  vision: 5_000,
  transcription: 2_000,
};

/**
 * Reserva da fala (P4.2b): o pior caso da porta (`VOICE_REPLY_MAX_CHARS`
 * caracteres e `VOICE_REPLY_MAX_SECONDS` segundos) no modelo de TTS do
 * onboarding (env), pelo mesmo cálculo do custo real (`estimateTtsCost`).
 * No modelo padrão: ~10.200 micro-US$.
 */
export function onboardingTtsEstimateUsdMicros(): number {
  const { model } = getTtsConfig("onboarding");
  const { costUsd } = estimateTtsCost(model, { chars: VOICE_REPLY_MAX_CHARS, seconds: VOICE_REPLY_MAX_SECONDS });
  return Math.ceil(costUsd * 1_000_000);
}

function estimateFor(role: SpendRole): number {
  return role === "tts" ? onboardingTtsEstimateUsdMicros() : ESTIMATE_USD_MICROS[role];
}
const LLM_TIMEOUT_MS = 45_000;
const MAX_TOKENS: Record<"interviewer" | "reader", number> = { interviewer: 1800, reader: 2500 };
/** Fonte guardada só durante o turno, para a conferência de link/telefone (`sourceTexts`). */
const SOURCE_TEXT_FOR_SCAN_MAX = 50_000;

// ── Contrato ────────────────────────────────────────────────────────────────

export const turnAttachmentValidator = v.union(
  v.object({ kind: v.literal("url"), url: v.string() }),
  v.object({ kind: v.literal("pdf"), storageId: v.id("_storage") }),
  v.object({ kind: v.literal("image"), storageId: v.id("_storage") }),
  v.object({ kind: v.literal("audio"), storageId: v.id("_storage") }),
);

/**
 * Evento estruturado do roteiro (SEM LLM): a tela avisa que a pessoa fez uma
 * ação de cartão; o servidor CONFERE o fato e responde com o próximo passo.
 * Mutuamente exclusivo com `text`/`attachment`.
 */
export const turnEventValidator = v.union(
  v.object({
    kind: v.literal("approve"),
    section: v.union(v.literal("funnel"), v.literal("persona"), v.literal("knowledge")),
    /** Assinatura do cartão que a pessoa viu (`sig` do bloco); diferente da atual = o cartão mudou. */
    sig: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("notify"),
    what: v.union(
      v.literal("email_verified"),
      v.literal("activated"),
      v.literal("tested"),
      v.literal("connected"),
      v.literal("skip_connect"),
    ),
  }),
  v.object({ kind: v.literal("next") }),
  v.object({ kind: v.literal("process_pending") }),
);
export type TurnEvent =
  | { kind: "approve"; section: ApprovalSection; sig?: string }
  | { kind: "notify"; what: "email_verified" | "activated" | "tested" | "connected" | "skip_connect" }
  | { kind: "next" }
  | { kind: "process_pending" };

export const turnInputValidator = {
  organizationId: v.id("organizations"),
  /** Ausente = sessão mais recente da org (criada se não houver). */
  sessionId: v.optional(v.id("onboardingSessions")),
  /** Texto do usuário (até 4.000). Pode faltar quando há material. */
  text: v.optional(v.string()),
  /** No máximo um material por turno. Exige e-mail confirmado (D2) e a ciência do aviso. */
  attachment: v.optional(turnAttachmentValidator),
  /** Evento do roteiro (sem texto nem anexo; não chama o modelo). */
  event: v.optional(turnEventValidator),
};

export const TURN_ERROR_CODES = [
  "invalid_input",
  "forbidden",
  "email_unverified",
  "notice_required",
  "rate_limited",
  "budget",
  "material_failed",
  "error",
] as const;
export type TurnErrorCode = (typeof TURN_ERROR_CODES)[number];

/** Evento SSE `audio` e campo do resultado: URL do storage (gerada com o RBAC da sessão). */
export const replyAudioValidator = v.object({ url: v.string(), durationSec: v.number(), mimeType: v.string() });
export type ReplyAudio = { url: string; durationSec: number; mimeType: string };

export const turnResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    sessionId: v.id("onboardingSessions"),
    reply: v.string(),
    chips: v.array(v.string()),
    blocks: v.array(onboardingBlockValidator),
    draft: v.union(v.null(), v.object({ version: v.number(), hash: v.string() })),
    nextStage: v.union(v.string(), v.null()),
    askForMaterials: v.boolean(),
    /** P4.2b: resposta em áudio (o usuário mandou áudio e a fala saiu). */
    audio: v.optional(replyAudioValidator),
    /** P4.2b: o usuário mandou áudio, mas a resposta ficou só em texto (motivo). */
    audioSkipReason: v.optional(v.string()),
  }),
  v.object({
    ok: v.literal(false),
    code: v.union(...TURN_ERROR_CODES.map((c) => v.literal(c))),
    message: v.string(),
    sessionId: v.union(v.id("onboardingSessions"), v.null()),
  }),
);

export type TurnAttachment =
  | { kind: "url"; url: string }
  | { kind: "pdf" | "image" | "audio"; storageId: Id<"_storage"> };

export type TurnInput = {
  organizationId: Id<"organizations">;
  sessionId?: Id<"onboardingSessions">;
  text?: string;
  attachment?: TurnAttachment;
  event?: TurnEvent;
};

export type TurnResult =
  | {
      ok: true;
      sessionId: Id<"onboardingSessions">;
      reply: string;
      chips: string[];
      blocks: OnboardingBlock[];
      draft: { version: number; hash: string } | null;
      nextStage: string | null;
      askForMaterials: boolean;
      audio?: ReplyAudio;
      audioSkipReason?: string;
    }
  | { ok: false; code: TurnErrorCode; message: string; sessionId: Id<"onboardingSessions"> | null };

export type TurnEvents = {
  onSession?: (sessionId: Id<"onboardingSessions">) => void | Promise<void>;
  /** Progresso legível ("Lendo o site…"). */
  onStatus?: (text: string) => void | Promise<void>;
  onDelta?: (text: string) => void | Promise<void>;
  onBlock?: (block: OnboardingBlock) => void | Promise<void>;
  onChips?: (chips: string[]) => void | Promise<void>;
  onDraft?: (draft: { version: number; hash: string }) => void | Promise<void>;
  /**
   * Turno concluído (texto, blocos, chips e rascunho já enviados). Vem ANTES da
   * síntese da voz: o cliente destrava a entrada sem esperar o TTS.
   */
  onDone?: (done: { nextStage: string | null; askForMaterials: boolean }) => void | Promise<void>;
  /** P4.2b: resposta em áudio, DEPOIS de `done` (o texto já está na tela). */
  onAudio?: (audio: ReplyAudio) => void | Promise<void>;
};

// ── Roteamento ──────────────────────────────────────────────────────────────

export type OnboardingRouting = { strictZdr: boolean; platformOrder?: PlatformOrder };

/**
 * Config de rota do onboarding: SEMPRE a cadeia da plataforma (nunca BYO: é
 * custo de aquisição), mas respeitando o ZDR estrito e a ordem de provedores
 * escolhidos pela org.
 */
export function onboardingProviderConfig(routing: OnboardingRouting): OrgProviderConfig {
  return {
    mode: "platform",
    ...(routing.strictZdr ? { strictZdr: true } : {}),
    ...(routing.platformOrder ? { platformOrder: routing.platformOrder } : {}),
  };
}

// ── Chamada de LLM com orçamento ────────────────────────────────────────────

type BudgetCtx = {
  organizationId: Id<"organizations">;
  sessionId: Id<"onboardingSessions">;
  memberId: Id<"teamMembers">;
  turnId: string;
  routing: OnboardingRouting;
  calls: number;
};

type ModelCall =
  | { ok: true; content: string; finishReason: string }
  | { ok: false; refused: true; message: string }
  | { ok: false; refused: false; message: string };

/** Reserva de orçamento (o rate limit deste turno já foi consumido no começo). */
async function reserve(ctx: ActionCtx, b: BudgetCtx, role: SpendRole) {
  return await ctx.runMutation(internal.onboardingBudget.internalReserveOnboardingSpend, {
    organizationId: b.organizationId,
    sessionId: b.sessionId,
    estimateUsdMicros: estimateFor(role),
    rateLimitConsumed: true,
  });
}

type RecordFields = {
  status: "done" | "error";
  provider?: string;
  model?: string;
  requestCount?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  costUsdEstimate: number;
  costEstimated?: boolean;
};

async function record(ctx: ActionCtx, b: BudgetCtx, role: SpendRole, fields: RecordFields) {
  b.calls += 1;
  await ctx.runMutation(internal.onboardingBudget.internalRecordOnboardingSpend, {
    organizationId: b.organizationId,
    sessionId: b.sessionId,
    memberId: b.memberId,
    role,
    ...fields,
    estimateUsdMicros: estimateFor(role),
    requestId: `${b.turnId}:${role}:${b.calls}`,
  });
}

/** Solta uma reserva cuja chamada não aconteceu (material falhou antes do LLM). */
async function release(ctx: ActionCtx, b: BudgetCtx, role: SpendRole) {
  await record(ctx, b, role, { status: "error", requestCount: 0, costUsdEstimate: 0 });
}

/**
 * Uma chamada JSON SEM tools (o corpo nunca leva `tools`/`tool_choice`).
 * Reserva antes (salvo `preReserved`); registra depois, também em erro.
 */
async function callJsonModel(
  ctx: ActionCtx,
  b: BudgetCtx,
  role: "interviewer" | "reader",
  messages: ChatMessage[],
  opts: { preReserved?: boolean } = {},
): Promise<ModelCall> {
  if (!opts.preReserved) {
    const decision = await reserve(ctx, b, role);
    if (!decision.ok) return { ok: false, refused: true, message: decision.message ?? "Limite de uso atingido." };
  }
  const model = getOnboardingModel(role);
  const usage = newUsageTotals();
  let provider: string | undefined;
  try {
    const routes = await resolveOrgRoutes(
      ctx,
      b.organizationId,
      onboardingProviderConfig(b.routing),
      model,
      role === "interviewer" ? "copilot" : "attendant",
    );
    if (routes.length === 0) throw new Error("Nenhum provider de IA disponível para esta organização");
    const resp = await chatWithFallback(
      routes,
      {
        messages,
        temperature: role === "reader" ? 0 : 0.4,
        maxTokens: MAX_TOKENS[role],
        responseFormat: { type: "json_object" },
      },
      { timeoutMs: LLM_TIMEOUT_MS },
    );
    provider = resp.usedRoute.providerId;
    addUsage(usage, resp.usage, resp.usedRoute, model, {
      inputChars: JSON.stringify(messages).length,
      outputChars: JSON.stringify(resp.message).length,
    });
    await record(ctx, b, role, { status: "done", provider, model, requestCount: 1, ...finishRunCostFields(usage) });
    if (resp.finishReason === "length") {
      // Resposta cortada: JSON incompleto não é aproveitado.
      return { ok: false, refused: false, message: "A resposta da IA veio cortada." };
    }
    return { ok: true, content: typeof resp.message.content === "string" ? resp.message.content : "", finishReason: resp.finishReason };
  } catch (e) {
    const message = sanitizeLlmError(e instanceof Error ? e.message : "Erro inesperado");
    await record(ctx, b, role, { status: "error", provider, model, requestCount: 1, ...finishRunCostFields(usage) });
    return { ok: false, refused: false, message };
  }
}

// ── Erros ───────────────────────────────────────────────────────────────────

function unquote(raw: string): unknown {
  const t = raw.trim().replace(/^Uncaught ConvexError:\s*/, "");
  if (!/^["{]/.test(t)) return raw;
  try {
    return JSON.parse(t);
  } catch {
    return raw;
  }
}

/** Recusa da abertura → `{code, message}`. ConvexError pode chegar com `data` serializado. */
export function turnErrorOf(e: unknown): { code: TurnErrorCode; message: string } {
  let data: unknown = e && typeof e === "object" && "data" in e ? (e as { data: unknown }).data : undefined;
  if (typeof data === "string") data = unquote(data);
  if (data && typeof data === "object") {
    const d = data as { code?: unknown; message?: unknown };
    if (typeof d.message === "string") {
      const code = (TURN_ERROR_CODES as readonly string[]).includes(String(d.code)) ? (d.code as TurnErrorCode) : "forbidden";
      return { code, message: d.message };
    }
  }
  if (typeof data === "string") return { code: "forbidden", message: data };
  const raw = e instanceof Error ? e.message : String(e);
  if (/Not authenticated/i.test(raw)) return { code: "forbidden", message: "Entre na sua conta para continuar." };
  if (/Not authorized|Permissão insuficiente/i.test(raw)) {
    return { code: "forbidden", message: "Você não tem permissão para configurar esta organização." };
  }
  if (/ArgumentValidationError|Validator error|Found ID/i.test(raw)) return { code: "invalid_input", message: "Pedido inválido." };
  return { code: "error", message: sanitizeLlmError(raw) };
}

function shortReason(e: unknown): string {
  return sanitizeLlmError(e instanceof Error ? e.message : String(e)).slice(0, 120);
}

function chunksOf(text: string): string[] {
  const parts = text.match(/[^.!?\n]+[.!?\n]*\s*/g) ?? [text];
  return parts.filter((p) => p.length > 0);
}

/**
 * Etapa gravada (compatibilidade; a tela usa o roteiro): deriva da TAREFA.
 * describe_business → interview; approve_*, activate → draft; test → test;
 * connect/done → next_steps. Nunca `materials`; `applied` só a aplicação marca.
 * Uma sessão já aplicada/testada não volta atrás por este caminho.
 */
export function stageForTask(current: string, task: RoadmapTask): "interview" | "draft" | "test" | "next_steps" | undefined {
  const mapped =
    task === "describe_business"
      ? "interview"
      : task === "test"
        ? "test"
        : task === "connect" || task === "done"
          ? "next_steps"
          : "draft";
  if (current === "applied" && (mapped === "interview" || mapped === "draft")) return undefined;
  if ((current === "test" || current === "next_steps") && (mapped === "interview" || mapped === "draft")) return undefined;
  return mapped;
}

const refLabel = (s: string) => cleanDraftText(s).slice(0, DRAFT_LIMITS.originReference);

// ── Turno ───────────────────────────────────────────────────────────────────

type Prep = {
  sessionId: Id<"onboardingSessions">;
  memberId: Id<"teamMembers">;
  userId: Id<"users">;
  stage: string;
  draft: OnboardingDraft | null;
  draftVersion: number;
  appliedDraftHash: string | null;
  summary: string | null;
  messageCount: number;
  emailVerified: boolean;
  aiActive: boolean;
  orgName: string;
  orgSegment: string | null;
  history: HistoryItem[];
  routing: OnboardingRouting;
  file: { size: number; mimeType: string; label: string } | null;
  siteKey: string | null;
  materialsNoticeAck: boolean;
  deferMaterial: boolean;
  approvals: Partial<Record<ApprovalSection, string>>;
  shownCards: Record<string, string>;
  reachedStep: number;
  tested: boolean;
  connected: boolean;
  pendingCount: number;
  maskedEmail: string | null;
  lastEvent: string | null;
};

type FlowState = {
  draft: OnboardingDraft | null;
  approvals: Partial<Record<ApprovalSection, string>>;
  applied: boolean;
  appliedDraftHash: string | null;
  draftHash: string | null;
  draftVersion: number;
  tested: boolean;
  connected: boolean;
  reachedStep: number;
  pendingCount: number;
};

function factsOf(f: FlowState, p: { aiActive: boolean; emailVerified: boolean }): RoadmapFacts {
  return {
    draft: f.draft,
    approvals: f.approvals,
    aiActive: p.aiActive,
    applied: f.applied,
    tested: f.tested,
    connected: f.connected,
    emailVerified: p.emailVerified,
    reachedStep: f.reachedStep,
  };
}

function flowFromPrep(prep: Prep, draft: OnboardingDraft | null): FlowState {
  return {
    draft,
    approvals: prep.approvals,
    applied: prep.appliedDraftHash !== null,
    appliedDraftHash: prep.appliedDraftHash,
    draftHash: null,
    draftVersion: prep.draftVersion,
    tested: prep.tested,
    connected: prep.connected,
    reachedStep: prep.reachedStep,
    pendingCount: prep.pendingCount,
  };
}

/** Estado atual da sessão (gravado) por cima do que a abertura do turno viu. */
async function flowNow(ctx: ActionCtx, input: { organizationId: Id<"organizations"> }, prep: Prep): Promise<FlowState> {
  const view = await ctx.runQuery(internal.onboardingSessions.internalGetSession, {
    organizationId: input.organizationId,
    sessionId: prep.sessionId,
  });
  if (!view) return flowFromPrep(prep, prep.draft);
  return {
    draft: view.draft,
    approvals: view.approvals,
    applied: view.appliedDraftHash !== null,
    appliedDraftHash: view.appliedDraftHash,
    draftHash: view.draftHash,
    draftVersion: view.draftVersion,
    tested: view.tested,
    connected: view.connected,
    reachedStep: view.reachedStep,
    pendingCount: view.pendingMaterialsCount,
  };
}

function blockCtxOf(f: FlowState, prep: Prep, extra: { upload?: UploadOutcome } = {}): BlockContext {
  return {
    draft: f.draft,
    draftHash: f.draftHash,
    draftVersion: f.draftVersion,
    appliedDraftHash: f.appliedDraftHash,
    emailVerified: prep.emailVerified,
    aiActive: prep.aiActive,
    materialsNoticeAck: prep.materialsNoticeAck,
    approvals: f.approvals,
    ...(prep.maskedEmail ? { maskedEmail: prep.maskedEmail } : {}),
    pendingMaterials: f.pendingCount,
    tested: f.tested,
    connected: f.connected,
    ...(extra.upload ? { upload: extra.upload } : {}),
  };
}

function cardSigOf(kind: TaskCardKind, f: FlowState, facts: RoadmapFacts): string {
  return kind === "ativarIa" || kind === "operacaoPronta"
    ? actionCardSignature(kind, {
        draftHash: f.draftHash,
        appliedDraftHash: f.appliedDraftHash,
        aiActive: facts.aiActive,
        tested: facts.tested,
        connected: facts.connected,
      })
    : cardSignature(f.draft, kind);
}

/** Completa as sugestões com as da tarefa (só as coerentes). Aceita menos de `CHIPS_MIN` quando não houver. */
function finalChips(modelChips: readonly string[], facts: RoadmapFacts, task: RoadmapTask): string[] {
  const chips = coherentChips(modelChips, facts);
  for (const c of coherentChips(taskChips(task), facts)) {
    if (chips.length >= CHIPS_MIN) break;
    if (!chips.some((x) => x.toLowerCase() === c.toLowerCase())) chips.push(c);
  }
  return chips;
}

export async function runOnboardingTurn(ctx: ActionCtx, input: TurnInput, events: TurnEvents): Promise<TurnResult> {
  const fail = (code: TurnErrorCode, message: string, sessionId: Id<"onboardingSessions"> | null = null): TurnResult => ({
    ok: false,
    code,
    message,
    sessionId,
  });
  if (input.event) {
    if ((input.text ?? "").trim() || input.attachment) {
      return fail("invalid_input", "Um evento não leva texto nem material.");
    }
    return await runOnboardingEvent(ctx, { ...input, event: input.event }, events);
  }
  let userText = (input.text ?? "").trim();
  if (userText.length > USER_TEXT_MAX) return fail("invalid_input", `Mensagem longa demais (máximo ${USER_TEXT_MAX} caracteres).`);
  if (!userText && !input.attachment) return fail("invalid_input", "Escreva uma mensagem ou envie um material.");

  // 1. Abertura com auth (D1/D2/aviso/RBAC/arquivo). Nada de LLM antes disto.
  let prep: Prep;
  try {
    prep = await ctx.runMutation(internal.onboardingChat.internalPrepareTurn, {
      organizationId: input.organizationId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.attachment ? { attachment: input.attachment } : {}),
    });
  } catch (e) {
    const err = turnErrorOf(e);
    return fail(err.code, err.message);
  }
  const { sessionId } = prep;
  await events.onSession?.(sessionId);

  // 2. Rate limit do turno (usuário + org), antes de material e de LLM.
  const rate = await ctx.runMutation(internal.onboardingBudget.internalCheckOnboardingRateLimit, {
    organizationId: input.organizationId,
    userId: prep.userId,
  });
  if (!rate.ok) return fail("rate_limited", rate.message ?? "Muitas mensagens seguidas. Aguarde um pouco.", sessionId);

  const b: BudgetCtx = {
    organizationId: input.organizationId,
    sessionId,
    memberId: prep.memberId,
    turnId: crypto.randomUUID(),
    routing: prep.routing,
    calls: 0,
  };
  const getSession = async () =>
    await ctx.runQuery(internal.onboardingSessions.internalGetSession, { organizationId: input.organizationId, sessionId });
  let version = prep.draftVersion;
  let draft = prep.draft;

  // 3. Primeiro resultado visual: o rascunho nasce do template do segmento.
  if (!draft) {
    const start = templateStartDraft(prep.orgSegment, prep.orgName);
    const saved = await ctx.runMutation(internal.onboardingSessions.internalSaveDraft, {
      organizationId: input.organizationId,
      sessionId,
      draft: start,
      expectedVersion: version,
    });
    version = saved.draftVersion;
    draft = (await getSession())?.draft ?? start;
  }

  // 3b. Link antes da confirmação do e-mail: só guarda (nenhuma busca, nenhum LLM, nenhuma reserva).
  if (prep.deferMaterial && input.attachment?.kind === "url") {
    return await deferMaterialTurn(ctx, input, prep, draft, version, userText, events);
  }

  // 4. Material.
  let upload: UploadOutcome | undefined;
  let materialNote: string | undefined;
  let transcribed = false;
  let attachmentRef: { kind: "site" | "pdf" | "imagem" | "audio"; label: string; storageId?: Id<"_storage"> } | undefined;
  const att = input.attachment;
  const logMaterial = async (kind: "site" | "pdf" | "imagem" | "audio", status: "lido" | "falhou", code?: string) =>
    await ctx.runMutation(internal.onboardingChat.internalLogMaterialRead, {
      organizationId: input.organizationId,
      sessionId,
      memberId: prep.memberId,
      kind,
      status,
      ...(code ? { code } : {}),
      itemsAdded: upload?.itemsAdded ?? 0,
      flagged: upload?.flagged ?? 0,
    });

  if (att?.kind === "audio") {
    // Áudio do USUÁRIO: orçamento antes do Whisper (compartilhado com os clientes reais).
    attachmentRef = { kind: "audio", label: prep.file?.label ?? "áudio", storageId: att.storageId };
    const decision = await reserve(ctx, b, "transcription");
    if (!decision.ok) return fail("budget", decision.message ?? "Limite de uso atingido.", sessionId);
    await events.onStatus?.("Ouvindo o áudio…");
    let text: string | undefined;
    try {
      const r = await ctx.runAction(internal.transcription.internalTranscribeStoredAudio, {
        storageId: att.storageId,
        size: prep.file!.size,
      });
      await record(ctx, b, "transcription", { status: r.status === "done" ? "done" : "error", model: "whisper", requestCount: 1, costUsdEstimate: 0 });
      if (r.status === "done") text = r.text?.trim();
    } catch {
      await record(ctx, b, "transcription", { status: "error", model: "whisper", requestCount: 1, costUsdEstimate: 0 });
    }
    if (text) {
      userText = [userText, text.slice(0, USER_TEXT_MAX)].filter(Boolean).join("\n").slice(0, USER_TEXT_MAX);
      transcribed = true;
      await logMaterial("audio", "lido");
    } else {
      await logMaterial("audio", "falhou", "TRANSCRIPTION_FAILED");
      const message = "Não consegui ouvir esse áudio. Pode escrever ou mandar de novo?";
      if (!userText) return fail("material_failed", message, sessionId);
      upload = { sourceKind: "audio", label: attachmentRef.label, status: "falhou", itemsAdded: 0, flagged: 0, message };
      materialNote = `áudio não transcrito (${message})`;
    }
  } else if (att) {
    let sourceText: string | null = null;
    let sourceKind: MaterialKind | null = null;
    let label = "";
    let ownHost: string | null = null;
    let failure: { code: string; message: string } | null = null;

    // Orçamento do leitor ANTES de buscar/ler (busca e PDF custam CPU/rede mesmo sem LLM).
    const readerDecision = await reserve(ctx, b, "reader");
    if (!readerDecision.ok) return fail("budget", readerDecision.message ?? "Limite de uso atingido.", sessionId);

    if (att.kind === "url") {
      label = att.url.slice(0, 200);
      attachmentRef = { kind: "site", label };
      await events.onStatus?.("Lendo o site…");
      const claim = await ctx.runMutation(internal.onboardingChat.internalClaimSitePage, {
        organizationId: input.organizationId,
        sessionId,
        siteKey: prep.siteKey!,
      });
      if (!claim.ok) {
        failure = { code: "SITE_PAGE_LIMIT", message: "Já li 5 páginas deste site nesta conversa." };
      } else {
        const r = await ctx.runAction(internal.onboardingExtract.internalFetchAndExtract, {
          organizationId: input.organizationId,
          kind: "auto",
          url: att.url,
          pagesReadForSite: claim.pagesBefore,
        });
        if (!r.ok) failure = { code: r.code, message: r.message };
        else {
          sourceKind = r.source.kind === "pdf" ? "pdf" : "site";
          attachmentRef = { kind: sourceKind === "pdf" ? "pdf" : "site", label };
          ownHost = r.source.siteKey ?? prep.siteKey;
          sourceText = [r.title, r.description, r.text].filter(Boolean).join("\n");
        }
      }
    } else if (att.kind === "pdf") {
      label = prep.file?.label ?? "PDF";
      attachmentRef = { kind: "pdf", label, storageId: att.storageId };
      await events.onStatus?.("Lendo o PDF…");
      const r = await ctx.runAction(internal.onboardingExtract.internalFetchAndExtract, {
        organizationId: input.organizationId,
        kind: "pdf",
        storageId: att.storageId,
      });
      if (!r.ok) failure = { code: r.code, message: r.message };
      else if (r.scanned || !r.text.trim()) {
        failure = { code: "SCANNED", message: "Esse PDF só tem imagem. Envie prints das páginas que eu leio pela imagem." };
      } else {
        sourceKind = "pdf";
        sourceText = r.text;
      }
    } else {
      label = prep.file?.label ?? "imagem";
      attachmentRef = { kind: "imagem", label, storageId: att.storageId };
      const visionDecision = await reserve(ctx, b, "vision");
      if (!visionDecision.ok) {
        await release(ctx, b, "reader");
        return fail("budget", visionDecision.message ?? "Limite de uso atingido.", sessionId);
      }
      await events.onStatus?.("Olhando a imagem…");
      try {
        const r = await ctx.runAction(internal.vision.internalDescribeImageForOnboarding, {
          organizationId: input.organizationId,
          storageId: att.storageId,
          mimeType: prep.file!.mimeType,
          size: prep.file!.size,
          strictZdr: b.routing.strictZdr,
          ...(b.routing.platformOrder ? { platformOrder: b.routing.platformOrder } : {}),
        });
        await record(ctx, b, "vision", {
          status: r.status === "done" ? "done" : "error",
          provider: r.provider,
          model: r.model,
          requestCount: r.requestCount,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          cachedPromptTokens: r.cachedPromptTokens,
          costUsdEstimate: r.costUsdEstimate,
          ...(r.costEstimated ? { costEstimated: true } : {}),
        });
        if (r.status === "done" && r.text) {
          sourceKind = "imagem";
          sourceText = r.text;
        } else failure = { code: "VISION_FAILED", message: "Não consegui ler essa imagem." };
      } catch {
        await record(ctx, b, "vision", { status: "error", costUsdEstimate: 0 });
        failure = { code: "VISION_FAILED", message: "Não consegui ler essa imagem." };
      }
    }

    // Leitor em quarentena (site/PDF/imagem), com a reserva feita antes da busca.
    let suggestedSegment: string | undefined;
    if (!failure && sourceText && sourceKind) {
      const masked = maskThirdPartyEmails(sourceText, ownHost);
      await events.onStatus?.("Organizando o que encontrei…");
      const call = await callJsonModel(ctx, b, "reader", buildReaderMessages({ kind: sourceKind, label, text: masked }), {
        preReserved: true,
      });
      const proposal = call.ok ? parseReaderOutput(call.content) : null;
      if (!proposal) {
        upload = { sourceKind, label, status: "lido", itemsAdded: 0, flagged: 0, message: "Não consegui extrair informações úteis desse material." };
      } else {
        const merged = mergeReaderProposal(draft, proposal, { kind: sourceKind, reference: label });
        suggestedSegment = merged.suggestedSegment;
        const check = normalizeDraft(merged.draft);
        if (merged.itemsAdded > 0 && check.ok) {
          try {
            const saved = await ctx.runMutation(internal.onboardingSessions.internalSaveDraft, {
              organizationId: input.organizationId,
              sessionId,
              draft: check.draft,
              expectedVersion: version,
              // Só em memória neste turno: conferência de link/telefone vistos na fonte.
              sourceTexts: [{ reference: label, text: masked.slice(0, SOURCE_TEXT_FOR_SCAN_MAX) }],
            });
            version = saved.draftVersion;
            draft = (await getSession())?.draft ?? draft;
          } catch (e) {
            console.log(JSON.stringify({ event: "onboardingReaderSaveFailed", reason: shortReason(e) }));
          }
        }
        const ref = refLabel(label);
        const flagged = draft.knowledge.filter((k) => refLabel(k.origin.reference ?? "") === ref && k.suspicious).length;
        upload = { sourceKind, label, status: "lido", itemsAdded: merged.itemsAdded, flagged };
      }
      materialNote =
        `${sourceKind} lido; ${upload.itemsAdded} informação(ões) nova(s) no rascunho, ${upload.flagged} marcada(s) para revisão` +
        (suggestedSegment ? `; o material sugere o segmento "${segmentTemplate(suggestedSegment).label}" (pergunte antes de trocar)` : "");
    } else {
      // Sem chamada do leitor (busca/leitura falhou, ou o material veio sem
      // texto): solta a reserva feita antes da busca.
      await release(ctx, b, "reader");
      if (!failure) failure = { code: "EMPTY", message: "Não encontrei texto nesse material." };
    }
    if (failure) {
      const k = attachmentRef?.kind ?? "site";
      upload = { sourceKind: k, label, status: "falhou", itemsAdded: 0, flagged: 0, message: failure.message };
      materialNote = `${k} não lido (${failure.message})`;
    }
    await logMaterial(attachmentRef?.kind ?? "site", failure ? "falhou" : "lido", failure?.code);
  }

  // 5. Entrevistador: reserva primeiro; a mensagem do usuário só é gravada com ela aprovada.
  const interviewerDecision = await reserve(ctx, b, "interviewer");
  if (!interviewerDecision.ok) return fail("budget", interviewerDecision.message ?? "Limite de uso atingido.", sessionId);
  await ctx.runMutation(internal.onboardingChat.internalAppendMessage, {
    organizationId: input.organizationId,
    sessionId,
    role: "user",
    text: userText,
    ...(attachmentRef ? { attachment: attachmentRef } : {}),
    ...(transcribed ? { transcribed: true } : {}),
  });

  const segment = draft.business.segment;
  const factsBefore = factsOf({ ...flowFromPrep(prep, draft) }, prep);
  const messages = buildInterviewerMessages({
    draft,
    summary: prep.summary,
    history: prep.history,
    userText,
    userTextIsTranscript: transcribed,
    facts: factsBefore,
    turnIndex: Math.floor(prep.messageCount / 2),
    ...(materialNote ? { materialNote } : {}),
  }) as ChatMessage[];
  // Texto DIGITADO pelo próprio usuário (turno + histórico): a trava da resposta
  // não acusa chave/telefone que ele mesmo escreveu. Transcrição de áudio fica
  // de fora (pode ser áudio repassado de terceiros: é dado não confiável).
  const typedNow = transcribed ? (input.text ?? "").trim() : userText;
  const userTexts = [typedNow, ...prep.history.filter((h) => h.role === "user" && !h.transcribed).map((h) => h.text)];
  let output: InterviewerOutput | null = null;
  for (let attempt = 0; attempt < 2 && !output; attempt++) {
    const call = await callJsonModel(
      ctx,
      b,
      "interviewer",
      attempt === 0 ? messages : [...messages, { role: "user", content: INTERVIEWER_RETRY_NUDGE }],
      { preReserved: attempt === 0 },
    );
    if (!call.ok && call.refused) break; // sem orçamento para a retentativa: resposta de reserva
    if (!call.ok) continue;
    const parsed = parseInterviewerOutput(call.content, { segment, userTexts, facts: factsBefore });
    if (parsed.ok) output = parsed.value;
    else console.log(JSON.stringify({ event: "onboardingInterviewerDiscarded", reason: parsed.reason, detail: parsed.detail }));
  }
  const usedFallback = !output;
  // Falha do modelo: a pessoa sempre tem o próximo passo (fala fixa do roteiro + cartão do passo + sugestões da tarefa).
  const fallbackTask = nextTask(factsBefore);
  const out: InterviewerOutput = output ?? {
    reply: stepMessage("next", fallbackTask),
    chips: taskChips(fallbackTask),
    blocks: [],
    askForMaterials: false,
  };

  // draftPatch → rascunho (nunca configuração).
  if (out.draftPatch) {
    const merged = normalizeDraft(mergeDraftPatch(draft, out.draftPatch, { fromAudio: transcribed }));
    if (merged.ok) {
      try {
        const saved = await ctx.runMutation(internal.onboardingSessions.internalSaveDraft, {
          organizationId: input.organizationId,
          sessionId,
          draft: merged.draft,
          expectedVersion: version,
        });
        version = saved.draftVersion;
      } catch (e) {
        console.log(JSON.stringify({ event: "onboardingPatchSaveFailed", reason: shortReason(e) }));
      }
    } else {
      console.log(JSON.stringify({ event: "onboardingPatchInvalid", errors: merged.errors.length }));
    }
  }

  // 6. Estado final + cartões decididos pelo ESTADO (roteiro), montados pelo servidor.
  const flow = await flowNow(ctx, input, prep);
  const facts = factsOf(flow, prep);
  const task = nextTask(facts);
  const planned = planTurnCards({
    facts,
    shown: prep.shownCards,
    requested: usedFallback ? [] : out.blocks.map((r) => r.kind).filter((k) => !ACTION_BLOCK_KINDS.includes(k)),
    actionState: { draftHash: flow.draftHash, appliedDraftHash: flow.appliedDraftHash },
    mentionsUi: usedFallback || replyMentionsUi(out.reply),
  });
  const forced: OnboardingBlockKind[] = [];
  if (upload) forced.push("uploadProgresso");
  if (out.askForMaterials && !prep.emailVerified) forced.push("cartaoConta");
  if (out.askForMaterials && prep.emailVerified && !prep.materialsNoticeAck) forced.push("avisoMateriais");
  // A nota do modelo só vai nos cartões do rascunho.
  const requests: BlockRequest[] = planned.map((c) => {
    const note = isDraftCardKind(c.kind) ? out.blocks.find((r) => r.kind === c.kind)?.note : undefined;
    return { kind: c.kind, ...(note ? { note } : {}) };
  });
  const blocks = buildBlocks(requests, blockCtxOf(flow, prep, { ...(upload ? { upload } : {}) }), { forced });
  const shownUpdate: Record<string, string> = {};
  for (const c of planned) if (blocks.some((x) => x.kind === c.kind)) shownUpdate[c.kind] = c.sig;
  const chips = finalChips(out.chips, facts, task);
  const nextStage = stageForTask(prep.stage, task);
  await ctx.runMutation(internal.onboardingSessions.internalUpdateSummary, {
    organizationId: input.organizationId,
    sessionId,
    messageCountDelta: 2,
    ...(out.summary && !usedFallback ? { summary: maskFreeText(out.summary) } : {}),
    ...(nextStage ? { stage: nextStage } : {}),
    ...(Object.keys(shownUpdate).length > 0 ? { shownCards: shownUpdate } : {}),
    reachedStep: taskStepIndex(task),
  });
  const assistantMessageId = await ctx.runMutation(internal.onboardingChat.internalAppendMessage, {
    organizationId: input.organizationId,
    sessionId,
    role: "assistant",
    text: out.reply,
    blocks,
    chips,
    draftVersion: flow.draftVersion,
  });

  for (const piece of chunksOf(out.reply)) await events.onDelta?.(piece);
  for (const block of blocks) await events.onBlock?.(block);
  await events.onChips?.(chips);
  const draftInfo = flow.draftHash ? { version: flow.draftVersion, hash: flow.draftHash } : null;
  if (draftInfo) await events.onDraft?.(draftInfo);

  const doneInfo = { nextStage: nextStage ?? prep.stage, askForMaterials: out.askForMaterials && prep.emailVerified };
  await events.onDone?.(doneInfo);

  // 7. Resposta em áudio (só quando o usuário mandou áudio), DEPOIS do `done`. Nunca derruba o turno.
  const voice = transcribed
    ? await speakReply(ctx, b, { reply: out.reply, messageId: assistantMessageId, routing: prep.routing })
    : null;
  if (voice?.kind === "audio") await events.onAudio?.(voice.audio);

  return {
    ok: true,
    sessionId,
    reply: out.reply,
    chips,
    blocks,
    draft: draftInfo,
    nextStage: doneInfo.nextStage,
    askForMaterials: doneInfo.askForMaterials,
    ...(voice?.kind === "audio" ? { audio: voice.audio } : {}),
    ...(voice?.kind === "text" ? { audioSkipReason: voice.reason } : {}),
  };
}

// ── Link antes da confirmação do e-mail ─────────────────────────────────────

/**
 * Turno determinístico: o LINK fica guardado (`pendingMaterials`, até 3) e a
 * leitura só acontece depois da confirmação do e-mail e da ciência do aviso
 * (`process_pending`). Sem rede, sem LLM, sem reserva de orçamento (o rate
 * limit do turno já foi consumido). O texto digitado junto do anexo não é
 * processado aqui (o envio de material não leva texto).
 */
async function deferMaterialTurn(
  ctx: ActionCtx,
  input: TurnInput,
  prep: Prep,
  draft: OnboardingDraft,
  version: number,
  userText: string,
  events: TurnEvents,
): Promise<TurnResult> {
  const att = input.attachment as { kind: "url"; url: string };
  const url = att.url.trim();
  const host = prep.siteKey ?? "link";
  const label = url.slice(0, 200);
  const pending = await ctx.runMutation(internal.onboardingChat.internalAddPendingMaterial, {
    organizationId: input.organizationId,
    sessionId: prep.sessionId,
    url,
    label: host,
  });
  await ctx.runMutation(internal.onboardingChat.internalAppendMessage, {
    organizationId: input.organizationId,
    sessionId: prep.sessionId,
    role: "user",
    text: userText,
    attachment: { kind: "site", label },
  });
  const flow = { ...(await flowNow(ctx, input, prep)), pendingCount: pending.count };
  const facts = factsOf(flow, prep);
  const task = nextTask(facts);
  const reply = materialPendingMessage({ label: `o link de ${host}`, maskedEmail: prep.maskedEmail, stored: pending.stored });
  const kinds: OnboardingBlockKind[] = ["cartaoConta"];
  if (!prep.materialsNoticeAck) kinds.push("avisoMateriais");
  const bctx = blockCtxOf(flow, prep);
  const blocks = kinds.map((kind) => buildBlock({ kind }, bctx)).filter((x): x is OnboardingBlock => x !== null);
  const chips = coherentChips(taskChips(task), facts);
  await ctx.runMutation(internal.onboardingSessions.internalUpdateSummary, {
    organizationId: input.organizationId,
    sessionId: prep.sessionId,
    messageCountDelta: 2,
  });
  await ctx.runMutation(internal.onboardingChat.internalAppendMessage, {
    organizationId: input.organizationId,
    sessionId: prep.sessionId,
    role: "assistant",
    text: reply,
    blocks,
    chips,
    draftVersion: flow.draftVersion || version,
  });
  void draft;
  return await emitStep(events, { sessionId: prep.sessionId, reply, blocks, chips, flow, stage: prep.stage });
}

/** Emite os mesmos eventos de um turno (delta, block, chips, draft, done) e monta o resultado. */
async function emitStep(
  events: TurnEvents,
  r: { sessionId: Id<"onboardingSessions">; reply: string; blocks: OnboardingBlock[]; chips: string[]; flow: FlowState; stage: string },
): Promise<TurnResult> {
  for (const piece of chunksOf(r.reply)) await events.onDelta?.(piece);
  for (const block of r.blocks) await events.onBlock?.(block);
  if (r.reply || r.chips.length > 0) await events.onChips?.(r.chips);
  const draftInfo = r.flow.draftHash ? { version: r.flow.draftVersion, hash: r.flow.draftHash } : null;
  if (draftInfo) await events.onDraft?.(draftInfo);
  await events.onDone?.({ nextStage: r.stage, askForMaterials: false });
  return {
    ok: true,
    sessionId: r.sessionId,
    reply: r.reply,
    chips: r.chips,
    blocks: r.blocks,
    draft: draftInfo,
    nextStage: r.stage,
    askForMaterials: false,
  };
}

// ── Eventos estruturados (sem LLM) ──────────────────────────────────────────

const SECTION_CARD: Record<ApprovalSection, "funilPreview" | "personaCard" | "conhecimentoLista"> = {
  funnel: "funilPreview",
  persona: "personaCard",
  knowledge: "conhecimentoLista",
};

/**
 * Evento do roteiro: mesma abertura com auth do turno (conta com e-mail +
 * `settings:manage`, sessão da org), mas SEM rate limit de LLM, SEM orçamento e
 * SEM modelo (nunca falha por limite de uso). O servidor confere o fato antes
 * de reconhecer; fato não confirmado = responde com o passo atual (como `next`),
 * nunca erro. Uma mensagem `assistant` com a chave do evento; nenhuma mensagem
 * `user`. Repetido (a última mensagem já tem a mesma chave) = só `done`.
 */
export async function runOnboardingEvent(
  ctx: ActionCtx,
  input: TurnInput & { event: TurnEvent },
  events: TurnEvents,
): Promise<TurnResult> {
  const event = input.event;
  let prep: Prep;
  try {
    prep = await ctx.runMutation(internal.onboardingChat.internalPrepareTurn, {
      organizationId: input.organizationId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
  } catch (e) {
    const err = turnErrorOf(e);
    return { ok: false, code: err.code, message: err.message, sessionId: null };
  }
  const { sessionId } = prep;
  await events.onSession?.(sessionId);

  if (event.kind === "process_pending") return await processPending(ctx, input, prep, events);

  let notice: RoadmapNotice = "next";
  let staleSection: ApprovalSection | null = null;
  let target = "-";
  if (event.kind === "approve") {
    target = event.section;
    const r = await ctx.runMutation(internal.onboardingSessions.internalApproveSection, {
      organizationId: input.organizationId,
      sessionId,
      memberId: prep.memberId,
      section: event.section,
      ...(event.sig !== undefined ? { sig: event.sig } : {}),
    });
    if (r.status === "stale") staleSection = event.section;
    else if (r.status === "approved" || r.status === "unchanged") notice = "approved";
  } else if (event.kind === "notify") {
    target = event.what;
    const r = await ctx.runMutation(internal.onboardingChat.internalApplyNotify, {
      organizationId: input.organizationId,
      sessionId,
      userId: prep.userId,
      what: event.what,
    });
    if (r.acknowledged) notice = event.what;
  }

  const flow = await flowNow(ctx, input, prep);
  const facts = factsOf(flow, prep);
  const task = nextTask(facts);
  const cardKind: TaskCardKind | "funilPreview" | "personaCard" | "conhecimentoLista" | null = staleSection
    ? SECTION_CARD[staleSection]
    : taskCard(task);
  const bctx = blockCtxOf(flow, prep);
  const blocks: OnboardingBlock[] = [];
  if (event.kind === "notify" && event.what === "email_verified" && notice === "email_verified" && flow.pendingCount > 0 && !prep.materialsNoticeAck) {
    const aviso = buildBlock({ kind: "avisoMateriais" }, bctx);
    if (aviso) blocks.push(aviso);
  }
  const card = cardKind ? buildBlock({ kind: cardKind }, bctx) : null;
  if (card) blocks.push(card);
  const sig = cardKind
    ? cardKind === "ativarIa" || cardKind === "operacaoPronta"
      ? cardSigOf(cardKind, flow, facts)
      : cardSignature(flow.draft, cardKind)
    : "";
  const key = `${event.kind}:${target}:${task}:${staleSection ? "stale" : "ok"}:${sig}`;
  const stage = stageForTask(prep.stage, task) ?? prep.stage;
  if (prep.lastEvent === key) {
    // Mesmo evento, mesmo resultado: não grava de novo.
    await events.onDone?.({ nextStage: stage, askForMaterials: false });
    return { ok: true, sessionId, reply: "", chips: [], blocks: [], draft: flow.draftHash ? { version: flow.draftVersion, hash: flow.draftHash } : null, nextStage: stage, askForMaterials: false };
  }

  const reply = staleSection
    ? "Esse item mudou enquanto você olhava. Confira de novo e me diga se está bom."
    : stepMessage(notice, task, { pendingMaterials: flow.pendingCount });
  const chips = finalChips([], facts, task);
  const shown: Record<string, string> = {};
  if (card && cardKind && sig) shown[cardKind] = sig;
  const nextStage = stageForTask(prep.stage, task);
  await ctx.runMutation(internal.onboardingChat.internalAppendMessage, {
    organizationId: input.organizationId,
    sessionId,
    role: "assistant",
    text: reply,
    blocks,
    chips,
    draftVersion: flow.draftVersion,
    event: key,
  });
  await ctx.runMutation(internal.onboardingSessions.internalUpdateSummary, {
    organizationId: input.organizationId,
    sessionId,
    messageCountDelta: 1,
    ...(nextStage ? { stage: nextStage } : {}),
    ...(Object.keys(shown).length > 0 ? { shownCards: shown } : {}),
    reachedStep: taskStepIndex(task),
  });
  return await emitStep(events, { sessionId, reply, blocks, chips, flow, stage });
}

/** `process_pending`: lê o primeiro link guardado pelo turno NORMAL de material (todos os gates continuam). */
async function processPending(ctx: ActionCtx, input: TurnInput, prep: Prep, events: TurnEvents): Promise<TurnResult> {
  const { sessionId } = prep;
  const flow = await flowNow(ctx, input, prep);
  const facts = factsOf(flow, prep);
  const task = nextTask(facts);
  const stage = stageForTask(prep.stage, task) ?? prep.stage;
  if (flow.pendingCount === 0) {
    await events.onDone?.({ nextStage: stage, askForMaterials: false });
    return { ok: true, sessionId, reply: "", chips: [], blocks: [], draft: flow.draftHash ? { version: flow.draftVersion, hash: flow.draftHash } : null, nextStage: stage, askForMaterials: false };
  }
  if (prep.emailVerified && prep.materialsNoticeAck) {
    const item = await ctx.runMutation(internal.onboardingChat.internalTakePendingMaterial, {
      organizationId: input.organizationId,
      sessionId,
    });
    if (!item) {
      await events.onDone?.({ nextStage: stage, askForMaterials: false });
      return { ok: true, sessionId, reply: "", chips: [], blocks: [], draft: null, nextStage: stage, askForMaterials: false };
    }
    const result = await runOnboardingTurn(
      ctx,
      { organizationId: input.organizationId, sessionId, attachment: { kind: "url", url: item.url } },
      { ...events, onSession: undefined },
    );
    if (!result.ok) {
      // Não foi lido (limite, orçamento…): volta para a frente da fila.
      await ctx.runMutation(internal.onboardingChat.internalAddPendingMaterial, {
        organizationId: input.organizationId,
        sessionId,
        url: item.url,
        label: item.label,
        front: true,
      });
    }
    return result;
  }
  // E-mail ou ciência ainda faltam: fala fixa + o cartão que resolve.
  const needsEmail = !prep.emailVerified;
  const key = `process_pending:${needsEmail ? "email" : "notice"}:${flow.pendingCount}`;
  if (prep.lastEvent === key) {
    await events.onDone?.({ nextStage: stage, askForMaterials: false });
    return { ok: true, sessionId, reply: "", chips: [], blocks: [], draft: flow.draftHash ? { version: flow.draftVersion, hash: flow.draftHash } : null, nextStage: stage, askForMaterials: false };
  }
  const bctx = blockCtxOf(flow, prep);
  const block = buildBlock({ kind: needsEmail ? "cartaoConta" : "avisoMateriais" }, bctx);
  const blocks = block ? [block] : [];
  const reply = needsEmail
    ? materialPendingMessage({ label: "o que você mandou", maskedEmail: prep.maskedEmail, stored: true })
    : "Antes de eu ler o que você mandou, confirme que leu o aviso sobre como o material é lido.";
  const chips = coherentChips(taskChips(task), facts);
  await ctx.runMutation(internal.onboardingChat.internalAppendMessage, {
    organizationId: input.organizationId,
    sessionId,
    role: "assistant",
    text: reply,
    blocks,
    chips,
    draftVersion: flow.draftVersion,
    event: key,
  });
  await ctx.runMutation(internal.onboardingSessions.internalUpdateSummary, { organizationId: input.organizationId, sessionId, messageCountDelta: 1 });
  return await emitStep(events, { sessionId, reply, blocks, chips, flow, stage });
}

// ── Resposta em áudio (P4.2b) ───────────────────────────────────────────────

type VoiceOutcome = { kind: "audio"; audio: ReplyAudio } | { kind: "text"; reason: VoiceTextReason };

/**
 * Fala a resposta JÁ aprovada pelo guard (`parseInterviewerOutput`), pela porta
 * única de TTS (`voiceReplyNode.internalSynthesizeWebAudio`). Ordem: regras
 * puras (`planOnboardingVoiceReply`: idioma, dado, tamanho) → strictZdr da org
 * (`zdr_nao_validado`, como no atendente) → rota da plataforma → reserva do
 * orçamento (`tts`) → síntese → registro do custo (também em falha) → vínculo
 * na mensagem. Qualquer falha = só texto (motivo em `audioSkipReason`).
 */
async function speakReply(
  ctx: ActionCtx,
  b: BudgetCtx,
  input: { reply: string; messageId: Id<"onboardingMessages">; routing: OnboardingRouting },
): Promise<VoiceOutcome> {
  const skip = async (reason: VoiceTextReason): Promise<VoiceOutcome> => {
    try {
      await ctx.runMutation(internal.onboardingChat.internalRecordReplyAudio, {
        organizationId: b.organizationId,
        sessionId: b.sessionId,
        messageId: input.messageId,
        skipReason: reason,
      });
    } catch {
      // diagnóstico apenas
    }
    console.log(JSON.stringify({ event: "onboardingVoiceReply", mode: "text", reason }));
    return { kind: "text", reason };
  };
  // Estado fora dos try: o catch de fora descarta o WAV órfão e solta a reserva presa.
  const requestId = `${b.turnId}:tts`;
  const since = Date.now();
  let reserved = false;
  let settled = false; // reserva resolvida (registrada ou solta)
  let fileId: Id<"files"> | null = null;
  let linked = false;
  let actionThrew = false;

  /** Registro de custo em try/catch próprio: falha de medição não impede o vínculo. */
  const safeRecord = async (fields: RecordFields): Promise<void> => {
    try {
      await record(ctx, b, "tts", fields);
      settled = true;
    } catch (e) {
      console.log(JSON.stringify({ event: "onboardingVoiceRecordFailed", reason: shortReason(e) }));
    }
  };
  /** Reserva que o registro não soltou: solta sem custo (senão segura o orçamento por 10 min). */
  const releaseIfStuck = async () => {
    if (!reserved || settled) return;
    try {
      await ctx.runMutation(internal.onboardingBudget.internalReleaseOnboardingReservation, {
        organizationId: b.organizationId,
        sessionId: b.sessionId,
        estimateUsdMicros: estimateFor("tts"),
      });
      settled = true;
    } catch {
      // vence sozinha pelo TTL da reserva
    }
  };
  const discardOrphan = async () => {
    if (linked) return;
    try {
      if (fileId) {
        await ctx.runMutation(internal.voiceReply.internalDiscardWebAudioFile, { organizationId: b.organizationId, fileId });
      } else if (actionThrew) {
        await ctx.runMutation(internal.voiceReply.internalDiscardWebAudioByRequest, {
          organizationId: b.organizationId,
          requestId,
          since,
        });
      }
    } catch {
      // best-effort
    }
  };

  try {
    const plan = planOnboardingVoiceReply({
      userSentAudio: true,
      text: input.reply,
      language: detectLanguage(input.reply)?.lang ?? null,
    });
    if (plan.kind === "text") return await skip(plan.reason);
    // Trava `provider` no endpoint de áudio não validada ao vivo (ver ai-attendant.md).
    if (input.routing.strictZdr) return await skip("zdr_nao_validado");
    if (!platformTtsAllowed(onboardingProviderConfig(input.routing))) return await skip("rota_sem_openrouter");

    const decision = await reserve(ctx, b, "tts");
    if (!decision.ok) return await skip("orcamento_onboarding");
    reserved = true;
    let synth;
    try {
      synth = await ctx.runAction(internal.voiceReplyNode.internalSynthesizeWebAudio, {
        organizationId: b.organizationId,
        memberId: b.memberId,
        text: plan.speakable,
        strictZdr: input.routing.strictZdr,
        routingAllowed: true,
        requestId,
      });
    } catch {
      // A action "nunca lança"; se lançou (erro de plataforma), não sabemos se o
      // provedor chegou a cobrar. Registra com custo 0 (subestima no máximo UMA
      // síntese por turno, limitada pelo rate limit) só para soltar a reserva e
      // deixar a falha na run; o WAV que ela possa ter gravado é achado pelo requestId.
      actionThrew = true;
      await safeRecord({ status: "error", requestCount: 1, costUsdEstimate: 0 });
      await discardOrphan();
      await releaseIfStuck();
      return await skip("falha_tts");
    }
    if (synth.ok) fileId = synth.fileId;
    const cost = synth.cost;
    await safeRecord({
      status: synth.ok ? "done" : "error",
      provider: "openrouter",
      model: synth.model,
      requestCount: synth.ok ? 1 : synth.requestCount,
      ...(cost ? { promptTokens: cost.promptTokens, completionTokens: cost.completionTokens } : {}),
      costUsdEstimate: cost?.costUsd ?? 0,
      ...(cost?.estimated ? { costEstimated: true } : {}),
    });
    await releaseIfStuck();
    if (!synth.ok) return await skip(synth.reason as VoiceTextReason);

    let url: string | null = null;
    try {
      ({ url } = await ctx.runMutation(internal.onboardingChat.internalRecordReplyAudio, {
        organizationId: b.organizationId,
        sessionId: b.sessionId,
        messageId: input.messageId,
        audio: { fileId: synth.fileId, storageId: synth.storageId, durationSec: synth.durationSec, mimeType: synth.mimeType },
      }));
    } catch {
      url = null;
    }
    if (!url) {
      await discardOrphan();
      return await skip("falha_armazenamento");
    }
    linked = true;
    console.log(JSON.stringify({ event: "onboardingVoiceReply", mode: "audio", seconds: synth.durationSec }));
    return { kind: "audio", audio: { url, durationSec: synth.durationSec, mimeType: synth.mimeType } };
  } catch (e) {
    console.log(JSON.stringify({ event: "onboardingVoiceReplyError", reason: shortReason(e) }));
    await discardOrphan();
    await releaseIfStuck();
    return { kind: "text", reason: "falha_tts" };
  }
}
