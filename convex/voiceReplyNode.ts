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
 * Chat do onboarding (P4.2b): `internalSynthesizeWebAudio` usa a MESMA
 * requisição (`requestSpeechPcm`) e guarda um WAV (sem o conversor da VPS); o
 * custo vai ao orçamento do onboarding pelo chamador.
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

type SpeechPcm =
  | { ok: true; pcm: Uint8Array; sampleRate: number }
  | { ok: false; reason: "falha_tts" | "formato_tts"; error: string };

/**
 * A ÚNICA requisição ao `/audio/speech` (atendente e chat do onboarding):
 * chave da PLATAFORMA, PCM 24 kHz, trava de retenção no corpo
 * (`ttsProviderBody`), 30 s. Nunca lança: `error` é o código curto para a run
 * (sem texto do usuário). Provedor que recusou não cobra (custo 0 para quem chama).
 */
async function requestSpeechPcm(input: {
  apiKey: string;
  model: string;
  text: string;
  voice: string;
  strictZdr: boolean;
}): Promise<SpeechPcm> {
  try {
    const response = await fetch(OPENROUTER_SPEECH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        input: input.text,
        voice: input.voice,
        response_format: "pcm",
        ...ttsProviderBody(input.strictZdr),
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: "falha_tts", error: `tts_http_${response.status}` };
    const format = parsePcmContentType(response.headers.get("content-type"));
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!format || bytes.byteLength < 2) return { ok: false, reason: "formato_tts", error: "tts_formato_inesperado" };
    return { ok: true, pcm: bytes, sampleRate: format.sampleRate };
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "tts_timeout" : "tts_rede";
    return { ok: false, reason: "falha_tts", error: kind };
  }
}

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

    const speech = await requestSpeechPcm({ apiKey, model, text: args.text, voice: args.voice, strictZdr: args.strictZdr });
    if (!speech.ok) {
      // Erro do provedor não é cobrado (502 etc.); a run fica com o status, sem texto.
      await ctx.runMutation(internal.agentRuns.internalFinishRun, {
        runId,
        status: "error",
        requestCount: 1,
        error: speech.error,
      });
      return { ok: false, reason: speech.reason };
    }
    const { pcm, sampleRate } = speech;

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

// ── Chat do onboarding (P4.2b): WAV para o navegador ────────────────────────

/** Formato do áudio do chat do onboarding (WAV a partir do PCM; o navegador toca direto). */
const WEB_AUDIO_MIME = "audio/wav";

const ttsCostValidator = v.object({
  costUsd: v.number(),
  promptTokens: v.number(),
  completionTokens: v.number(),
  estimated: v.boolean(),
});

const webResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    fileId: v.id("files"),
    storageId: v.id("_storage"),
    durationSec: v.number(),
    mimeType: v.string(),
    model: v.string(),
    cost: ttsCostValidator,
  }),
  v.object({
    ok: v.literal(false),
    reason: v.string(),
    model: v.string(),
    /** Chamadas feitas ao provedor (0 = nem chamou; a reserva é solta com custo 0). */
    requestCount: v.number(),
    /** Áudio gerado e pago antes da falha (longo demais, storage): entra no orçamento. */
    cost: v.union(ttsCostValidator, v.null()),
  })
);

type TtsCostOut = { costUsd: number; promptTokens: number; completionTokens: number; estimated: boolean };
type WebSynthResult =
  | {
      ok: true;
      fileId: Id<"files">;
      storageId: Id<"_storage">;
      durationSec: number;
      mimeType: string;
      model: string;
      cost: TtsCostOut;
    }
  | { ok: false; reason: VoiceTextReason; model: string; requestCount: number; cost: TtsCostOut | null };

/**
 * Resposta em áudio do chat do onboarding (P4.2b): MESMA requisição de fala do
 * atendente (`requestSpeechPcm`), mas o PCM vira WAV (`wrapPcmAsWav`) e vai
 * direto para o storage da org — o navegador toca WAV, então NÃO passa pelo
 * conversor ogg da VPS. Os modelos aceitos pela porta só devolvem PCM
 * (`TTS_MODELS`), por isso não há mp3.
 *
 * Diferente do atendente, NÃO abre run `kind:"tts"` nem consulta o
 * `internalSpendGate`: quem chama é o turno do onboarding, que reserva antes
 * (`internalReserveOnboardingSpend`, que já confere modo leitura e `spendCap`)
 * e registra depois (`internalRecordOnboardingSpend`, papel `tts`) com o
 * `cost` devolvido aqui — inclusive em falha depois de o áudio ter sido gerado.
 * Nunca lança por rede/provedor/armazenamento.
 */
export const internalSynthesizeWebAudio = internalAction({
  args: {
    organizationId: v.id("organizations"),
    /** Membro humano que conduz a sessão (dono da linha de `files`). */
    memberId: v.id("teamMembers"),
    /** Texto falável (`planOnboardingVoiceReply().speakable`), nunca o bruto do modelo. */
    text: v.string(),
    strictZdr: v.boolean(),
    /** `platformTtsAllowed(...)` (`opencode-only` = false). */
    routingAllowed: v.boolean(),
  },
  returns: webResultValidator,
  handler: async (ctx, args): Promise<WebSynthResult> => {
    const { model, voice } = getTtsConfig("onboarding");
    const none = (reason: VoiceTextReason): WebSynthResult => ({ ok: false, reason, model, requestCount: 0, cost: null });
    if (!args.routingAllowed) return none("rota_sem_openrouter");
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return none("sem_chave");

    const speech = await requestSpeechPcm({ apiKey, model, text: args.text, voice, strictZdr: args.strictZdr });
    if (!speech.ok) {
      console.log(JSON.stringify({ event: "onboardingVoiceTtsFailed", error: speech.error }));
      return { ok: false, reason: speech.reason, model, requestCount: 1, cost: null };
    }
    const { pcm, sampleRate } = speech;
    const duration = pcmDurationSeconds(pcm.byteLength, sampleRate);
    const cost = estimateTtsCost(model, { chars: args.text.length, seconds: duration });
    const paid = (reason: VoiceTextReason): WebSynthResult => ({ ok: false, reason, model, requestCount: 1, cost });
    if (duration <= 0) return paid("formato_tts");
    if (duration > VOICE_REPLY_MAX_SECONDS) return paid("audio_longo");

    const wav = wrapPcmAsWav(pcm, sampleRate);
    let storageId: Id<"_storage">;
    try {
      storageId = await ctx.storage.store(new Blob([wav as BlobPart], { type: WEB_AUDIO_MIME }));
    } catch {
      return paid("falha_armazenamento");
    }
    let fileId: Id<"files">;
    try {
      fileId = await ctx.runMutation(internal.voiceReply.internalInsertWebAudioFile, {
        organizationId: args.organizationId,
        memberId: args.memberId,
        storageId,
        size: wav.byteLength,
      });
    } catch {
      try {
        await ctx.storage.delete(storageId);
      } catch {
        // best-effort
      }
      return paid("falha_armazenamento");
    }
    return {
      ok: true,
      fileId,
      storageId,
      durationSec: Math.round(duration * 10) / 10,
      mimeType: WEB_AUDIO_MIME,
      model,
      cost,
    };
  },
});
