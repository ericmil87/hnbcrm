"use node";
/**
 * Resposta em áudio do atendente (onboarding v2, P4.1) — a ÚNICA chamada de TTS.
 *
 * texto falável (já aprovado pelo output guard e pelas regras de `lib/tts.ts`)
 *   → OpenRouter `POST /api/v1/audio/speech` (chave da PLATAFORMA, PCM 24 kHz)
 *   → duração + waveform de 64 amostras calculadas do PCM (aqui, sem ffmpeg)
 *   → WAV (cabeçalho RIFF) → conversor ogg/opus da VPS (porta
 *     `lib/voiceNoteConvert.ts`; a VPS não muda)
 *   → ogg no storage + linha de `files` sem `messageId`.
 *
 * Não lança por falha de rede/provedor/armazenamento: devolve `{ok:false, reason}`
 * e o atendente manda a resposta em TEXTO (o runtime ainda envolve a chamada em
 * try/catch para erro de plataforma). Org com `strictZdr` não chega aqui
 * (`zdr_nao_validado` no runtime). Custo: run `kind:"tts"` + `aiUsageMonthly` pela porta
 * `agentRuns.internalFinishRun` → `recordRunUsage`; o teto em R$ e o modo
 * leitura são checados ANTES de pagar (`internalSpendGate`).
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  TTS_CONVERT_TIMEOUT_MS,
  TTS_TIMEOUT_MS,
  VOICE_REPLY_MAX_SECONDS,
  estimateTtsCost,
  getTtsConfig,
  parsePcmContentType,
  pcmDurationSeconds,
  pcmWaveform,
  ttsProviderBody,
  voiceNoteSeconds,
  wrapPcmAsWav,
  type VoiceTextReason,
} from "./lib/tts";
import { convertVoiceNoteToOggOpus, voiceNoteConverterConfigured } from "./lib/voiceNoteConvert";
import { monthKeyUtc } from "./lib/aiSpend";

export const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";

const resultValidator = v.union(
  v.object({
    ok: v.literal(true),
    fileId: v.id("files"),
    seconds: v.number(),
    waveform: v.array(v.number()),
    costUsd: v.number(),
  }),
  v.object({ ok: v.literal(false), reason: v.string() })
);

type SynthResult =
  | { ok: true; fileId: Id<"files">; seconds: number; waveform: number[]; costUsd: number }
  | { ok: false; reason: VoiceTextReason };

export const internalSynthesizeVoiceNote = internalAction({
  args: {
    organizationId: v.id("organizations"),
    conversationId: v.id("conversations"),
    agentMemberId: v.id("teamMembers"),
    leadId: v.optional(v.id("leads")),
    /** Texto falável (`planVoiceReply().speakable`), nunca o bruto do modelo. */
    text: v.string(),
    voice: v.string(),
    strictZdr: v.boolean(),
    /** `platformTtsAllowed(providerConfig)` (BYO / `opencode-only` = false). */
    routingAllowed: v.boolean(),
  },
  returns: resultValidator,
  handler: async (ctx, args): Promise<SynthResult> => {
    if (!args.routingAllowed) return { ok: false, reason: "rota_sem_openrouter" };
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return { ok: false, reason: "sem_chave" };
    // Sem conversor não há voice note: nem paga o TTS.
    if (!voiceNoteConverterConfigured()) return { ok: false, reason: "sem_conversor" };

    const now = Date.now();
    const gate = await ctx.runQuery(internal.aiSpend.internalSpendGate, {
      organizationId: args.organizationId,
      month: monthKeyUtc(now),
      now,
    });
    if (gate.blocked) return { ok: false, reason: "teto_de_gastos" };

    const { model } = getTtsConfig("attendant");
    const runId = await ctx.runMutation(internal.agentRuns.internalStartRun, {
      organizationId: args.organizationId,
      memberId: args.agentMemberId,
      kind: "tts",
      conversationId: args.conversationId,
      ...(args.leadId ? { leadId: args.leadId } : {}),
      provider: "openrouter",
      model,
    });

    let pcm: Uint8Array;
    let sampleRate: number;
    try {
      const response = await fetch(OPENROUTER_SPEECH_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input: args.text,
          voice: args.voice,
          response_format: "pcm",
          ...ttsProviderBody(args.strictZdr),
        }),
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      });
      if (!response.ok) {
        // Erro do provedor não é cobrado (502 etc.); a run fica com o status, sem texto.
        await ctx.runMutation(internal.agentRuns.internalFinishRun, {
          runId,
          status: "error",
          requestCount: 1,
          error: `tts_http_${response.status}`,
        });
        return { ok: false, reason: "falha_tts" };
      }
      const format = parsePcmContentType(response.headers.get("content-type"));
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!format || bytes.byteLength < 2) {
        await ctx.runMutation(internal.agentRuns.internalFinishRun, {
          runId,
          status: "error",
          requestCount: 1,
          error: "tts_formato_inesperado",
        });
        return { ok: false, reason: "formato_tts" };
      }
      pcm = bytes;
      sampleRate = format.sampleRate;
    } catch (e) {
      const kind = e instanceof Error && e.name === "TimeoutError" ? "tts_timeout" : "tts_rede";
      await ctx.runMutation(internal.agentRuns.internalFinishRun, {
        runId,
        status: "error",
        requestCount: 1,
        error: kind,
      });
      return { ok: false, reason: "falha_tts" };
    }

    const duration = pcmDurationSeconds(pcm.byteLength, sampleRate);
    // O áudio foi gerado: entra no medidor mesmo se a conversão falhar depois.
    const cost = estimateTtsCost(model, { chars: args.text.length, seconds: duration });
    const tooLong = duration > VOICE_REPLY_MAX_SECONDS;
    await ctx.runMutation(internal.agentRuns.internalFinishRun, {
      runId,
      status: tooLong ? "error" : "done",
      provider: "openrouter",
      model,
      requestCount: 1,
      promptTokens: cost.promptTokens,
      completionTokens: cost.completionTokens,
      costUsdEstimate: cost.costUsd,
      ...(cost.estimated ? { costEstimated: true } : {}),
      ...(tooLong ? { error: "tts_audio_longo" } : {}),
    });
    if (tooLong || duration <= 0) return { ok: false, reason: tooLong ? "audio_longo" : "formato_tts" };

    const ogg = await convertVoiceNoteToOggOpus(wrapPcmAsWav(pcm, sampleRate), "audio/wav", {
      timeoutMs: TTS_CONVERT_TIMEOUT_MS,
    });
    if (!ogg) return { ok: false, reason: "falha_conversao" };

    let storageId: Id<"_storage">;
    try {
      storageId = await ctx.storage.store(new Blob([ogg as BlobPart], { type: "audio/ogg" }));
    } catch {
      return { ok: false, reason: "falha_armazenamento" };
    }
    let fileId: Id<"files">;
    try {
      fileId = await ctx.runMutation(internal.voiceReply.internalInsertVoiceNoteFile, {
        organizationId: args.organizationId,
        agentMemberId: args.agentMemberId,
        storageId,
        size: ogg.byteLength,
      });
    } catch {
      // Sem linha de `files` ninguém mais acha o blob: apaga aqui.
      try {
        await ctx.storage.delete(storageId);
      } catch {
        // best-effort
      }
      return { ok: false, reason: "falha_armazenamento" };
    }
    return {
      ok: true,
      fileId,
      seconds: voiceNoteSeconds(duration),
      waveform: pcmWaveform(pcm),
      costUsd: cost.costUsd,
    };
  },
});
