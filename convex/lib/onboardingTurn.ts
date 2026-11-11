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
  buildBlocks,
  onboardingBlockValidator,
  type OnboardingBlock,
  type OnboardingBlockKind,
  type UploadOutcome,
} from "./onboardingBlocks";
import {
  INTERVIEWER_FALLBACK_REPLY,
  INTERVIEWER_RETRY_NUDGE,
  USER_TEXT_MAX,
  buildInterviewerMessages,
  buildReaderMessages,
  fallbackChips,
  maskThirdPartyEmails,
  mergeDraftPatch,
  mergeReaderProposal,
  parseInterviewerOutput,
  parseReaderOutput,
  templateStartDraft,
  type HistoryItem,
  type InterviewerOutput,
  type MaterialKind,
  type NextStage,
} from "./onboardingInterviewer";
import type { ChatMessage } from "./llm/types";
import { segmentTemplate } from "./onboardingTemplates";

export type SpendRole = "interviewer" | "reader" | "vision" | "transcription";

// Estimativas por chamada (micro-US$) segurando saldo na reserva. A transcrição
// roda no Whisper próprio (custo de LLM zero), mas passa pela reserva para que
// orçamento/limites cortem ANTES de ocupar o serviço compartilhado.
export const ESTIMATE_USD_MICROS: Record<SpendRole, number> = {
  interviewer: 20_000,
  reader: 10_000,
  vision: 5_000,
  transcription: 2_000,
};
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

export const turnInputValidator = {
  organizationId: v.id("organizations"),
  /** Ausente = sessão mais recente da org (criada se não houver). */
  sessionId: v.optional(v.id("onboardingSessions")),
  /** Texto do usuário (até 4.000). Pode faltar quando há material. */
  text: v.optional(v.string()),
  /** No máximo um material por turno. Exige e-mail confirmado (D2) e a ciência do aviso. */
  attachment: v.optional(turnAttachmentValidator),
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
    estimateUsdMicros: ESTIMATE_USD_MICROS[role],
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
    estimateUsdMicros: ESTIMATE_USD_MICROS[role],
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

/** Etapa final: aplicada só a aplicação marca; depois de aplicada, só test/next_steps. */
function resolveStage(current: string, proposed: NextStage | undefined): NextStage | undefined {
  if (!proposed) return undefined;
  if (current === "applied" || current === "test" || current === "next_steps") {
    return proposed === "test" || proposed === "next_steps" ? proposed : undefined;
  }
  return proposed;
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
};

export async function runOnboardingTurn(ctx: ActionCtx, input: TurnInput, events: TurnEvents): Promise<TurnResult> {
  const fail = (code: TurnErrorCode, message: string, sessionId: Id<"onboardingSessions"> | null = null): TurnResult => ({
    ok: false,
    code,
    message,
    sessionId,
  });
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
  const messages = buildInterviewerMessages({
    draft,
    summary: prep.summary,
    history: prep.history,
    userText,
    userTextIsTranscript: transcribed,
    emailVerified: prep.emailVerified,
    aiActive: prep.aiActive,
    stage: prep.stage,
    turnIndex: Math.floor(prep.messageCount / 2),
    ...(materialNote ? { materialNote } : {}),
  }) as ChatMessage[];
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
    const parsed = parseInterviewerOutput(call.content, { stage: prep.stage, segment });
    if (parsed.ok) output = parsed.value;
    else console.log(JSON.stringify({ event: "onboardingInterviewerDiscarded", reason: parsed.reason, detail: parsed.detail }));
  }
  const usedFallback = !output;
  const out: InterviewerOutput = output ?? {
    reply: INTERVIEWER_FALLBACK_REPLY,
    chips: fallbackChips(prep.stage, segment),
    blocks: [],
    askForMaterials: false,
  };

  // draftPatch → rascunho (nunca configuração).
  if (out.draftPatch) {
    const merged = normalizeDraft(mergeDraftPatch(draft, out.draftPatch));
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

  // 6. Estado final + blocos do servidor.
  const final = await getSession();
  const finalDraft = final?.draft ?? draft;
  const forced: OnboardingBlockKind[] = [];
  if (upload) forced.push("uploadProgresso");
  if (prep.messageCount === 0) forced.push("funilPreview");
  if (out.askForMaterials && !prep.emailVerified) forced.push("cartaoConta");
  if (out.askForMaterials && prep.emailVerified && !prep.materialsNoticeAck) forced.push("avisoMateriais");
  const blocks = buildBlocks(
    out.blocks,
    {
      draft: finalDraft,
      draftHash: final?.draftHash ?? null,
      draftVersion: final?.draftVersion ?? version,
      appliedDraftHash: final?.appliedDraftHash ?? prep.appliedDraftHash,
      emailVerified: prep.emailVerified,
      aiActive: prep.aiActive,
      materialsNoticeAck: prep.materialsNoticeAck,
      ...(upload ? { upload } : {}),
    },
    { forced, chips: out.chips },
  );
  const nextStage = resolveStage(final?.stage ?? prep.stage, out.nextStage);
  await ctx.runMutation(internal.onboardingSessions.internalUpdateSummary, {
    organizationId: input.organizationId,
    sessionId,
    messageCountDelta: 2,
    ...(out.summary && !usedFallback ? { summary: maskFreeText(out.summary) } : {}),
    ...(nextStage ? { stage: nextStage } : {}),
  });
  await ctx.runMutation(internal.onboardingChat.internalAppendMessage, {
    organizationId: input.organizationId,
    sessionId,
    role: "assistant",
    text: out.reply,
    blocks,
    chips: out.chips,
    draftVersion: final?.draftVersion ?? version,
  });

  for (const piece of chunksOf(out.reply)) await events.onDelta?.(piece);
  for (const block of blocks) await events.onBlock?.(block);
  await events.onChips?.(out.chips);
  const draftInfo = final?.draftHash ? { version: final.draftVersion, hash: final.draftHash } : null;
  if (draftInfo) await events.onDraft?.(draftInfo);

  return {
    ok: true,
    sessionId,
    reply: out.reply,
    chips: out.chips,
    blocks,
    draft: draftInfo,
    nextStage: nextStage ?? final?.stage ?? null,
    askForMaterials: out.askForMaterials && prep.emailVerified,
  };
}
