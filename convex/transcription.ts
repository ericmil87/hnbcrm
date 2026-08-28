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
//   - `autoTranscribe`  — internalAction, meant to be scheduled by the ingest
//     pipeline right after an inbound audio attachment is saved. It is a no-op
//     unless the message's channel config has autoTranscribeAudio set OR the
//     org's AI attendant is active (it needs the transcript to answer what was
//     said). Called from the ingest with
//     `ctx.scheduler.runAfter(0, internal.transcription.autoTranscribe, { messageId })`
//     once an audio message + its file are persisted.

import { v } from "convex/values";
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
import { shouldTranscribeAudio } from "./lib/mediaEnrichment";

const ENGINE = "faster-whisper";
const PENDING_RETRY_AFTER_MS = 2 * 60 * 1000; // don't duplicate an in-flight transcription
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // mirrors the Whisper service's own limit

type TranscriptionMeta = {
  status: "pending" | "done" | "failed";
  text?: string;
  language?: string;
  durationSec?: number;
  engine: string;
  error?: string;
  at: number;
};

type AudioMessageForTranscription = {
  messageId: Id<"messages">;
  organizationId: Id<"organizations">;
  metadata: Record<string, unknown> | undefined;
  storageId: string;
  mimeType: string;
  size: number;
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
export const autoTranscribe = internalAction({
  args: { messageId: v.id("messages") },
  returns: transcribeResultValidator,
  handler: async (ctx, args): Promise<TranscribeResult> => {
    const message = await ctx.runQuery(internal.transcription.internalGetAudioMessageIfEligible, {
      messageId: args.messageId,
    });
    if (!message) return { status: "skipped" };
    return await runTranscription(ctx, message);
  },
});

// Shared idempotent transcription flow used by both entry points above.
async function runTranscription(
  ctx: ActionCtx,
  message: AudioMessageForTranscription
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
  if (existing?.status === "pending" && Date.now() - existing.at < PENDING_RETRY_AFTER_MS) {
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
  if (!serviceUrl) {
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

  try {
    const response = await fetch(`${serviceUrl.replace(/\/$/, "")}/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
      },
      body: JSON.stringify({ url: audioUrl }),
    });

    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = body?.detail ?? body?.error ?? `Whisper service error (HTTP ${response.status})`;
      await ctx.runMutation(internal.transcription.internalSetTranscriptionResult, {
        messageId: message.messageId,
        status: "failed",
        error: String(error),
      });
      return { status: "failed", error: String(error) };
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    const language = typeof body.language === "string" ? body.language : undefined;
    const durationSec = typeof body.duration_sec === "number" ? body.duration_sec : undefined;

    await ctx.runMutation(internal.transcription.internalSetTranscriptionResult, {
      messageId: message.messageId,
      status: "done",
      text,
      language,
      durationSec,
    });
    return { status: "done", text, language, durationSec };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Falha ao chamar o serviço Whisper";
    await ctx.runMutation(internal.transcription.internalSetTranscriptionResult, {
      messageId: message.messageId,
      status: "failed",
      error,
    });
    return { status: "failed", error };
  }
}

// ── Internal queries ──

const audioMessageResultValidator = v.object({
  messageId: v.id("messages"),
  organizationId: v.id("organizations"),
  metadata: v.optional(v.record(v.string(), v.any())),
  storageId: v.string(),
  mimeType: v.string(),
  size: v.number(),
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

    return {
      messageId: message._id,
      organizationId: message.organizationId,
      metadata: message.metadata,
      storageId: file.storageId,
      mimeType: file.mimeType,
      size: file.size,
    };
  },
});

// ── Internal mutations: persist transcription state onto messages.metadata ──

export const internalSetTranscriptionPending = internalMutation({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return null;
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return null;
    const transcription: TranscriptionMeta = {
      status: args.status,
      engine: ENGINE,
      at: Date.now(),
      ...(args.text !== undefined ? { text: args.text } : {}),
      ...(args.language !== undefined ? { language: args.language } : {}),
      ...(args.durationSec !== undefined ? { durationSec: args.durationSec } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
    };
    await ctx.db.patch(args.messageId, {
      metadata: { ...(message.metadata ?? {}), transcription },
      // Espelha o texto num campo de topo para o search index (busca do inbox).
      ...(args.status === "done" && args.text ? { transcriptText: args.text } : {}),
    });
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
        await ctx.db.patch(message._id, { transcriptText: transcription.text });
        patched++;
      }
    }
    return patched;
  },
});
