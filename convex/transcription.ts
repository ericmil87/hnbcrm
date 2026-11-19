// Local (self-hosted) voice-note transcription for the WhatsApp channel.
//
// Talks to a Whisper microservice (faster-whisper, deployed alongside the
// wuzapi gateway — see docs/whatsmeow/deploy/whisper/) instead of a paid
// cloud STT API. No "use node" needed: fetch is available in plain actions.
//
// Contract stored on messages.metadata.transcription:
//   { status: "pending" | "done" | "failed", text?, language?, durationSec?,
//     engine: "faster-whisper", error?, at }
//
// Two entry points:
//   - `transcribe`      — public action, user-triggered (permission-checked).
//   - `autoTranscribe`  — internalAction, scheduled through the single port
//     `scheduleAudioTranscription` (lib/mediaEnrichment) right after an audio
//     message is saved — customer audio (ingest) AND team audio (inbox send,
//     REST/MCP send, forward, phone app via the bridge). It is a no-op
//     unless the message's channel config has autoTranscribeAudio set OR the
//     org's AI attendant is active (it needs the transcript to answer what was
//     said). Internal notes, messages deleted by the customer and bridge
//     history imports are never auto-transcribed.

import { v } from "convex/values";
import { isOffBusiness } from "./lib/contactRelation";
import { withMessageSearchPatch } from "./lib/messageSearch";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { orgAiActive } from "./lib/agentSecurity";
import { IMPORTED_FROM_HISTORY_KEY, shouldTranscribeAudio } from "./lib/mediaEnrichment";
import { scheduleMessageTranslation } from "./lib/translationOps";
import {
  WHISPER_BASE_TIMEOUT_MS,
  estimateVoiceNoteSeconds,
  isTransientTranscriptionError,
  localProcessingEstimateMs,
  nextTranscriptionRetryDelayMs,
  planTranscriptionRoute,
  transcriptionPendingStaleAfterMs,
  whisperLocalRtf,
  whisperTimeoutMsForSize,
} from "./lib/transcriptionPolicy";
import {
  GROQ_MODELS,
  GROQ_TIMEOUT_MS,
  GROQ_TRANSCRIPTIONS_URL,
  GroqFailure,
  LOCAL_BUSY_MAX_WAIT_MS,
  buildGroqForm,
  classifyGroqFailure,
  groqHeaderCooldownMs,
  groqLongAudioSeconds,
  parseGroqTranscription,
} from "./lib/groqTranscription";

const ENGINE = "faster-whisper";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // mirrors the Whisper service's own limit
// Teto do POST /transcribe (download + inferência + leitura do corpo). Sem ele,
// um Whisper travado segura a action até o limite de 10 min do Convex — e com
// os áudios do time e do celular também transcritos, isso empilha. 120 s é o
// MÍNIMO: o teto cresce com o tamanho do áudio (`whisperTimeoutMsForSize`,
// lib/transcriptionPolicy — o Whisper da VPS roda perto do tempo real e áudio
// de 2+ min estourava os 120 s fixos).
export const WHISPER_TIMEOUT_MS = WHISPER_BASE_TIMEOUT_MS;

type TranscriptionMeta = {
  status: "pending" | "done" | "failed";
  text?: string;
  language?: string;
  durationSec?: number;
  engine: string;
  error?: string;
  at: number;
  /** Falha transitória com nova tentativa automática agendada para este instante. */
  retryAt?: number;
  /** Nº da tentativa automática que gravou este estado (0 = a primeira). */
  attempt?: number;
};

type AudioMessageForTranscription = {
  messageId: Id<"messages">;
  organizationId: Id<"organizations">;
  metadata: Record<string, unknown> | undefined;
  storageId: string;
  mimeType: string;
  size: number;
  /** Org com IA ativa + aceite LGPD: o áudio pode ir à Groq (ZDR). Ausente = só local. */
  externalAllowed?: boolean;
};

const transcribeResultValidator = v.object({
  status: v.union(v.literal("done"), v.literal("pending"), v.literal("failed"), v.literal("skipped")),
  text: v.optional(v.string()),
  language: v.optional(v.string()),
  durationSec: v.optional(v.number()),
  error: v.optional(v.string()),
});

type TranscribeResult = {
  status: "done" | "pending" | "failed" | "skipped";
  text?: string;
  language?: string;
  durationSec?: number;
  error?: string;
};

// ── Public: user-triggered transcription (e.g. a "Transcrever" button in the inbox) ──
export const transcribe = action({
  args: {
    organizationId: v.id("organizations"),
    messageId: v.id("messages"),
  },
  returns: transcribeResultValidator,
  handler: async (ctx, args): Promise<TranscribeResult> => {
    const message = await ctx.runQuery(internal.transcription.internalGetAudioMessageForMember, {
      organizationId: args.organizationId,
      messageId: args.messageId,
    });
    return await runTranscription(ctx, message);
  },
});

// ── Internal: auto-transcribe, meant to be scheduled right after ingest. Silently
// skips (status "skipped") when the message isn't audio or the org hasn't opted in. ──
//
// Re-tentativa: falha TRANSITÓRIA (timeout, rede, 5xx, VPS sem conseguir baixar
// o áudio) reagenda ESTA action com `attempt + 1` (60 s, depois 5 min —
// `TRANSCRIPTION_RETRY_DELAYS_MS`). É continuação do mesmo job, não um
// agendamento novo: a porta única `scheduleAudioTranscription` continua sendo
// a única que INICIA a transcrição. Cada tentativa relê a elegibilidade.
export const autoTranscribe = internalAction({
  args: { messageId: v.id("messages"), attempt: v.optional(v.number()) },
  returns: transcribeResultValidator,
  handler: async (ctx, args): Promise<TranscribeResult> => {
    const message = await ctx.runQuery(internal.transcription.internalGetAudioMessageIfEligible, {
      messageId: args.messageId,
    });
    if (!message) return { status: "skipped" };
    const attempt = Number.isFinite(args.attempt) ? Math.max(0, Math.floor(args.attempt!)) : 0;
    return await runTranscription(ctx, message, { attempt });
  },
});

function isAbortError(e: unknown): boolean {
  // DOMException nem sempre é `instanceof Error` em todo runtime: olha o nome.
  const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}

// Shared idempotent transcription flow used by both entry points above.
async function runTranscription(
  ctx: ActionCtx,
  message: AudioMessageForTranscription,
  // `auto` presente = caminho automático (re-tenta falha transitória);
  // ausente = clique do usuário (sem re-tentativa: ele vê o erro e decide).
  auto?: { attempt: number }
): Promise<TranscribeResult> {
  const existing = message.metadata?.transcription as TranscriptionMeta | undefined;
  if (existing?.status === "done") {
    return {
      status: "done",
      text: existing.text,
      language: existing.language,
      durationSec: existing.durationSec,
    };
  }
  if (
    existing?.status === "pending" &&
    Date.now() - existing.at < transcriptionPendingStaleAfterMs(message.size)
  ) {
    return { status: "pending" };
  }

  if (message.size > MAX_AUDIO_BYTES) {
    const error = "Áudio maior que 25MB — não transcrito";
    await ctx.runMutation(internal.transcription.internalSetTranscriptionResult, {
      messageId: message.messageId,
      status: "failed",
      error,
    });
    return { status: "failed", error };
  }

  const serviceUrl = process.env.WHISPER_SERVICE_URL;
  const serviceToken = process.env.WHISPER_SERVICE_TOKEN;
  const groqKey = process.env.GROQ_API_KEY?.trim();
  const groqAllowed = !!groqKey && message.externalAllowed === true;
  if (!serviceUrl && !groqAllowed) {
    const error = "WHISPER_SERVICE_URL não configurado no Convex";
    await ctx.runMutation(internal.transcription.internalSetTranscriptionResult, {
      messageId: message.messageId,
      status: "failed",
      error,
    });
    return { status: "failed", error };
  }

  await ctx.runMutation(internal.transcription.internalSetTranscriptionPending, {
    messageId: message.messageId,
  });

  const audioUrl = await ctx.storage.getUrl(message.storageId as Id<"_storage">);
  if (!audioUrl) {
    const error = "URL do áudio não encontrada no storage";
    await ctx.runMutation(internal.transcription.internalSetTranscriptionResult, {
      messageId: message.messageId,
      status: "failed",
      error,
    });
    return { status: "failed", error };
  }

  const startedAt = Date.now();
  const estimatedSeconds = estimateVoiceNoteSeconds(message.size);
  const snapshot: { localQueueWaitMs: number } = serviceUrl
    ? await ctx.runQuery(internal.transcriptionRouting.internalRoutingSnapshot, { now: startedAt })
    : { localQueueWaitMs: Number.POSITIVE_INFINITY };
  const route = serviceUrl
    ? planTranscriptionRoute({
        estimatedSeconds,
        groqAvailable: groqAllowed,
        localQueueWaitMs: snapshot.localQueueWaitMs,
        longAudioSeconds: groqLongAudioSeconds(process.env.GROQ_LONG_AUDIO_SECONDS),
        busyMaxWaitMs: LOCAL_BUSY_MAX_WAIT_MS,
      })
    : (["groq"] as const);

  let lastFailure: { error: string; transient: boolean } | null = null;
  for (const engine of route) {
    if (engine === "groq") {
      // Groq depois do local: só se ainda couber na action (2 modelos × 60 s + folga).
      if (Date.now() - startedAt > ACTION_BUDGET_MS - 2 * GROQ_TIMEOUT_MS - 15_000) continue;
      const groq = await transcribeWithGroq(ctx, message, estimatedSeconds, groqKey!);
      if (groq.status === "done") {
        await ctx.runMutation(internal.transcription.internalSetTranscriptionResult, {
          messageId: message.messageId,
          status: "done",
          text: groq.text,
          language: groq.language,
          durationSec: groq.durationSec,
          engine: `groq:${groq.model}`,
        });
        return { status: "done", text: groq.text, language: groq.language, durationSec: groq.durationSec };
      }
      if (groq.status === "failed") lastFailure = { error: groq.error, transient: groq.transient };
      continue; // "skipped" (orçamento/cooldown) ou falha → próximo motor
    }

    // Whisper local (serial na VPS): registra na fila estimada, com teto que
    // cabe no que sobra dos 10 min da action.
    const remainingMs = ACTION_BUDGET_MS - (Date.now() - startedAt);
    const timeoutMs = Math.min(whisperTimeoutMsForSize(message.size), remainingMs);
    if (timeoutMs < 30_000) break;
    await ctx.runMutation(internal.transcriptionRouting.internalLocalStart, {
      messageId: message.messageId,
      estMs: localProcessingEstimateMs(message.size, whisperLocalRtf(process.env.WHISPER_LOCAL_RTF)),
    });
    let result: Awaited<ReturnType<typeof callWhisper>>;
    try {
      result = await callWhisper(serviceUrl!, serviceToken, audioUrl, { timeoutMs });
    } finally {
      await ctx.runMutation(internal.transcriptionRouting.internalLocalFinish, { messageId: message.messageId });
    }
    if (result.status === "done") {
      await ctx.runMutation(internal.transcription.internalSetTranscriptionResult, {
        messageId: message.messageId,
        status: "done",
        text: result.text,
        language: result.language,
        durationSec: result.durationSec,
      });
      return result;
    }
    lastFailure = { error: result.error, transient: result.transient };
  }

  const failure = lastFailure ?? { error: "Nenhum motor de transcrição disponível agora", transient: true };
  const retryDelay = auto ? nextTranscriptionRetryDelayMs(auto.attempt, failure.transient) : null;
  const retryAt = retryDelay !== null ? Date.now() + retryDelay : undefined;
  await ctx.runMutation(internal.transcription.internalSetTranscriptionResult, {
    messageId: message.messageId,
    status: "failed",
    error: failure.error,
    ...(retryAt !== undefined ? { retryAt } : {}),
    ...(auto ? { attempt: auto.attempt } : {}),
  });
  if (retryDelay !== null && auto) {
    await ctx.scheduler.runAfter(retryDelay, internal.transcription.autoTranscribe, {
      messageId: message.messageId,
      attempt: auto.attempt + 1,
    });
  }
  return { status: "failed", error: failure.error };
}

/** Folga de 30 s abaixo do limite de 10 min de uma action do Convex. */
const ACTION_BUDGET_MS = 570_000;

/**
 * Groq (OpenAI-compatível): tenta os modelos em ordem (turbo → v3), cada um
 * só se o orçamento da janela couber (`internalReserveGroq`, 85% dos limites
 * oficiais, respeita cooldown/retry-after). Chave recusada ou sem crédito
 * param a cadeia (vale para a conta toda); 429 de um modelo passa ao próximo.
 * Cada chamada registra o resultado (orçamento, falhas seguidas, alerta).
 */
async function transcribeWithGroq(
  ctx: ActionCtx,
  message: AudioMessageForTranscription,
  estimatedSeconds: number,
  apiKey: string
): Promise<
  | { status: "done"; text: string; language?: string; durationSec?: number; model: string }
  | { status: "failed"; error: string; transient: boolean }
  | { status: "skipped" }
> {
  let blob: Blob | null = null;
  let lastError: { error: string; transient: boolean } | null = null;
  for (const model of GROQ_MODELS) {
    const reservation = await ctx.runMutation(internal.transcriptionRouting.internalReserveGroq, {
      model,
      audioSec: estimatedSeconds,
    });
    if (!reservation.ok) continue;
    const reservedSec = reservation.billedSec ?? 0;
    blob = blob ?? (await ctx.storage.get(message.storageId as Id<"_storage">));
    if (!blob) {
      await ctx.runMutation(internal.transcriptionRouting.internalRecordGroqResult, {
        model,
        reservedSec,
        ok: false,
      });
      return { status: "failed", error: "Áudio não encontrado no storage", transient: false };
    }
    let failure: GroqFailure;
    try {
      const response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: buildGroqForm(blob, message.mimeType, model),
        signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
      });
      if (response.ok) {
        const parsed = parseGroqTranscription(await response.json());
        const headerCooldownMs = groqHeaderCooldownMs(response.headers);
        await ctx.runMutation(internal.transcriptionRouting.internalRecordGroqResult, {
          model,
          reservedSec,
          ok: true,
          ...(parsed.durationSec !== undefined ? { actualSec: parsed.durationSec } : {}),
          ...(headerCooldownMs !== null ? { cooldownMs: headerCooldownMs } : {}),
        });
        return { status: "done", text: parsed.text, language: parsed.language, durationSec: parsed.durationSec, model };
      }
      const bodyText = await response.text().catch(() => "");
      failure = classifyGroqFailure(response.status, bodyText, response.headers);
    } catch (e) {
      failure = isAbortError(e)
        ? { kind: "timeout", message: `Groq não respondeu em ${GROQ_TIMEOUT_MS / 1000}s` }
        : { kind: "network", cooldownMs: 15_000, message: "Falha de rede ao chamar a Groq" };
    }
    await ctx.runMutation(internal.transcriptionRouting.internalRecordGroqResult, {
      model,
      reservedSec,
      ok: false,
      failure: {
        kind: failure.kind,
        message: failure.message.slice(0, 200),
        ...(failure.status !== undefined ? { status: failure.status } : {}),
        ...(failure.cooldownMs !== undefined ? { cooldownMs: failure.cooldownMs } : {}),
      },
    });
    lastError = {
      error: `Groq: ${failure.message}`.slice(0, 240),
      transient: failure.kind !== "bad_request",
    };
    // Chave/cota valem para a conta toda; request inválido, timeout e rede não
    // melhoram trocando de modelo. Só 429/5xx de um modelo passam ao próximo.
    if (failure.kind !== "rate_limit" && failure.kind !== "server") break;
  }
  return lastError ? { status: "failed", ...lastError } : { status: "skipped" };
}

/**
 * The Whisper service call (POST `{url}` → `{text, language, duration_sec}`),
 * shared by the message transcription above and the Telegram voice note
 * (F3, `internalTranscribeStoredAudio`). Never throws.
 */
/** v0.78.1: vocabulary hint (Whisper `initial_prompt`), clipped; only the member's voice to the bot sends one. */
export const WHISPER_PROMPT_MAX_CHARS = 400;

async function callWhisper(
  serviceUrl: string,
  serviceToken: string | undefined,
  audioUrl: string,
  opts: { prompt?: string; timeoutMs?: number } = {}
): Promise<
  | { status: "done"; text: string; language?: string; durationSec?: number }
  | { status: "failed"; error: string; transient: boolean }
> {
  const timeoutMs = opts.timeoutMs ?? WHISPER_TIMEOUT_MS;
  try {
    const response = await fetch(`${serviceUrl.replace(/\/$/, "")}/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
      },
      body: JSON.stringify({
        url: audioUrl,
        ...(opts.prompt ? { prompt: opts.prompt.slice(0, WHISPER_PROMPT_MAX_CHARS) } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // O timeout também cobre a leitura do corpo: esse abort NÃO pode virar
    // `{}` (gravaria "done" com texto vazio) — sobe para o catch de falha.
    const body: any = await response.json().catch((e) => {
      if (isAbortError(e)) throw e;
      return {};
    });
    if (!response.ok) {
      const error = String(body?.detail ?? body?.error ?? `Whisper service error (HTTP ${response.status})`);
      return { status: "failed", error, transient: isTransientTranscriptionError(error, response.status) };
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const language = typeof body.language === "string" ? body.language : undefined;
    const durationSec = typeof body.duration_sec === "number" ? body.duration_sec : undefined;
    return { status: "done", text, language, durationSec };
  } catch (e) {
    const error = isAbortError(e)
      ? `Serviço Whisper não respondeu em ${Math.round(timeoutMs / 1000)}s`
      : e instanceof Error
        ? e.message
        : "Falha ao chamar o serviço Whisper";
    // Exceção de rede = transitória; o NOSSO timeout não (o job continua
    // rodando no Whisper — re-enviar só dobraria a fila).
    return { status: "failed", error, transient: !isAbortError(e) };
  }
}

/**
 * Telegram F3 (D21): transcribes an audio file already in storage (a voice
 * note downloaded from Telegram) without a `messages` row. The caller deletes
 * the blob afterwards. Same service, same timeout, same 25 MB cap.
 */
export const internalTranscribeStoredAudio = internalAction({
  args: {
    storageId: v.id("_storage"),
    size: v.number(),
    /** Vocabulary hint for the member's own voice (Telegram); never set for customer audio. */
    prompt: v.optional(v.string()),
  },
  returns: v.object({ status: v.union(v.literal("done"), v.literal("failed")), text: v.optional(v.string()), error: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    if (args.size > MAX_AUDIO_BYTES) return { status: "failed" as const, error: "Áudio maior que 25MB" };
    const serviceUrl = process.env.WHISPER_SERVICE_URL;
    if (!serviceUrl) return { status: "failed" as const, error: "WHISPER_SERVICE_URL não configurado no Convex" };
    const audioUrl = await ctx.storage.getUrl(args.storageId);
    if (!audioUrl) return { status: "failed" as const, error: "URL do áudio não encontrada no storage" };
    const result = await callWhisper(serviceUrl, process.env.WHISPER_SERVICE_TOKEN, audioUrl, args.prompt ? { prompt: args.prompt } : {});
    return result.status === "done" ? { status: "done" as const, text: result.text } : { status: "failed" as const, error: result.error };
  },
});

// ── Internal queries ──

const audioMessageResultValidator = v.object({
  messageId: v.id("messages"),
  organizationId: v.id("organizations"),
  metadata: v.optional(v.record(v.string(), v.any())),
  storageId: v.string(),
  mimeType: v.string(),
  size: v.number(),
  externalAllowed: v.optional(v.boolean()),
});

// Permission-checked lookup for the user-triggered `transcribe` action.
export const internalGetAudioMessageForMember = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    messageId: v.id("messages"),
  },
  returns: audioMessageResultValidator,
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "inbox", "view_own");

    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Mensagem não encontrada");
    if (message.organizationId !== args.organizationId) {
      throw new Error("Mensagem não pertence a esta organização");
    }
    if (message.contentType !== "audio") {
      throw new Error("Mensagem não é uma nota de voz");
    }
    const fileId = message.attachments?.[0];
    if (!fileId) throw new Error("Mensagem de áudio sem anexo");
    const file = await ctx.db.get(fileId);
    if (!file) throw new Error("Arquivo de áudio não encontrado");

    return {
      messageId: message._id,
      organizationId: message.organizationId,
      metadata: message.metadata,
      storageId: file.storageId,
      mimeType: file.mimeType,
      size: file.size,
      externalAllowed: orgAiActive(await ctx.db.get(message.organizationId)),
    };
  },
});

// Unauthenticated lookup for the ingest pipeline's `autoTranscribe`. Returns
// null (a clean skip) unless the message is audio AND either the channel config
// has autoTranscribeAudio enabled OR the org's AI attendant needs to hear it —
// so it's safe to call unconditionally.
export const internalGetAudioMessageIfEligible = internalQuery({
  args: { messageId: v.id("messages") },
  returns: v.union(audioMessageResultValidator, v.null()),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.contentType !== "audio") return null;
    // Nota interna com áudio não vai ao Whisper; apagada pelo cliente também
    // não; e áudio velho importado do histórico do aparelho nunca é
    // transcrito em lote (o botão "Transcrever" continua disponível).
    if (message.direction === "internal" || message.isInternal) return null;
    if (message.metadata?.deletedByCustomer === true) return null;
    if (message.metadata?.[IMPORTED_FROM_HISTORY_KEY] === true) return null;

    const fileId = message.attachments?.[0];
    if (!fileId) return null;
    const file = await ctx.db.get(fileId);
    if (!file) return null;

    const conversation = await ctx.db.get(message.conversationId);
    const config = conversation?.channelConfigId
      ? await ctx.db.get(conversation.channelConfigId)
      : null;
    // Gate compartilhado com o passe de visão (lib/mediaEnrichment): o
    // atendente IA tem ouvidos próprios (D2 do plano de áudio) — org com IA
    // ativa e atendente não desligado transcreve mesmo sem o toggle de
    // conveniência do inbox, senão ele responderia "não consigo ouvir áudio".
    const org = await ctx.db.get(message.organizationId);
    if (!shouldTranscribeAudio(org, config)) return null;
    // PR1: contato fora do comercial nunca é transcrito automaticamente (a
    // porta `scheduleAudioTranscription` já barra; isto cobre a re-tentativa).
    if (isOffBusiness(conversation?.contactRelation)) return null;

    return {
      messageId: message._id,
      organizationId: message.organizationId,
      metadata: message.metadata,
      storageId: file.storageId,
      mimeType: file.mimeType,
      size: file.size,
      // Groq (externa) só com IA ativa + aceite LGPD da org — o toggle de
      // transcrição do canal sozinho continua 100% local.
      externalAllowed: orgAiActive(org),
    };
  },
});

// ── Internal mutations: persist transcription state onto messages.metadata ──

export const internalSetTranscriptionPending = internalMutation({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.metadata?.deletedByCustomer === true) return null;
    const transcription: TranscriptionMeta = { status: "pending", engine: ENGINE, at: Date.now() };
    await ctx.db.patch(args.messageId, {
      metadata: { ...(message.metadata ?? {}), transcription },
    });
    return null;
  },
});

export const internalSetTranscriptionResult = internalMutation({
  args: {
    messageId: v.id("messages"),
    status: v.union(v.literal("done"), v.literal("failed")),
    text: v.optional(v.string()),
    language: v.optional(v.string()),
    durationSec: v.optional(v.number()),
    error: v.optional(v.string()),
    retryAt: v.optional(v.number()),
    attempt: v.optional(v.number()),
    /** Motor que transcreveu ("groq:<modelo>"); ausente = Whisper local. */
    engine: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Apagada pelo cliente (Meta Messaging F2): resultado tardio é descartado.
    const message = await ctx.db.get(args.messageId);
    if (!message || message.metadata?.deletedByCustomer === true) return null;
    const transcription: TranscriptionMeta = {
      status: args.status,
      engine: args.engine ?? ENGINE,
      at: Date.now(),
      ...(args.text !== undefined ? { text: args.text } : {}),
      ...(args.language !== undefined ? { language: args.language } : {}),
      ...(args.durationSec !== undefined ? { durationSec: args.durationSec } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(args.retryAt !== undefined ? { retryAt: args.retryAt } : {}),
      ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
    };
    await ctx.db.patch(
      args.messageId,
      withMessageSearchPatch(message, {
        metadata: { ...(message.metadata ?? {}), transcription },
        // Espelha o texto num campo de topo para o search index (busca do inbox).
        ...(args.status === "done" && args.text ? { transcriptText: args.text } : {}),
      })
    );
    // Tradução automática (F1): a transcrição de um áudio do CLIENTE é
    // traduzida para a equipe, com o idioma do Whisper como dica. No-op sem o
    // módulo (o gate fica na porta).
    if (args.status === "done" && args.text && message.direction === "inbound") {
      await scheduleMessageTranslation(ctx, {
        messageId: args.messageId,
        role: "inbound",
        text: args.text,
        ...(args.language ? { hintLang: args.language } : {}),
      });
    }
    return null;
  },
});

// Backfill único: espelha transcrições já concluídas (metadata.transcription.text)
// para o campo pesquisável transcriptText. Idempotente — pode rodar mais de uma vez.
export const internalBackfillTranscriptText = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const messages = await ctx.db.query("messages").collect();
    let patched = 0;
    for (const message of messages) {
      const transcription = message.metadata?.transcription as TranscriptionMeta | undefined;
      if (
        transcription?.status === "done" &&
        transcription.text &&
        message.transcriptText !== transcription.text
      ) {
        await ctx.db.patch(
          message._id,
          withMessageSearchPatch(message, { transcriptText: transcription.text })
        );
        patched++;
      }
    }
    return patched;
  },
});
