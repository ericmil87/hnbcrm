/**
 * Política PURA da transcrição automática de nota de voz (convex/transcription.ts):
 * teto do POST ao Whisper proporcional ao tamanho do áudio e re-tentativa de
 * falhas TRANSITÓRIAS.
 *
 * Medido em PROD (org cliente, 10–13/11/2026, 404 áudios transcritos): o
 * Whisper da VPS roda perto do tempo real (128 s de áudio levaram 119 s), e as
 * notas de voz chegam a ~2,5 KB/s de ogg/opus. Com o teto fixo de 120 s, todo
 * áudio acima de ~2 min falhava ("Serviço Whisper não respondeu em 120s" — 3
 * de 4 falhas, todos ~410 KB ≈ 2,7 min). A 4ª foi a VPS sem rede para baixar o
 * áudio do storage ("Network is unreachable"), que não tinha 2ª tentativa.
 */

/** Teto mínimo (e o de antes): áudio curto continua com 120 s. */
export const WHISPER_BASE_TIMEOUT_MS = 120_000;
/** Teto máximo: abaixo do limite de 10 min de uma action do Convex, com folga. */
export const WHISPER_MAX_TIMEOUT_MS = 540_000;
/** Bytes por segundo de uma nota de voz ogg/opus do WhatsApp (medido: ~2,5 KB/s). */
const VOICE_NOTE_BYTES_PER_SEC = 2_500;
/** Margem fixa (download do storage + fila do serviço) e fator sobre a duração. */
const TIMEOUT_FIXED_MS = 60_000;
const TIMEOUT_PER_AUDIO_SEC_MS = 1_500;

/** Teto do POST /transcribe para um áudio deste tamanho. */
export function whisperTimeoutMsForSize(sizeBytes: number): number {
  const size = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;
  const estimatedSec = size / VOICE_NOTE_BYTES_PER_SEC;
  const wanted = TIMEOUT_FIXED_MS + estimatedSec * TIMEOUT_PER_AUDIO_SEC_MS;
  return Math.round(Math.min(WHISPER_MAX_TIMEOUT_MS, Math.max(WHISPER_BASE_TIMEOUT_MS, wanted)));
}

/**
 * Até quando um `pending` é considerado em voo (não duplica a chamada). Antes
 * era 2 min fixos — com o teto proporcional, um clique em "Transcrever" no
 * meio de um áudio longo dispararia uma 2ª inferência no mesmo Whisper. A
 * folga de 90 s cobre uma tentativa na Groq (60 s) antes do local.
 */
export function transcriptionPendingStaleAfterMs(sizeBytes: number): number {
  return whisperTimeoutMsForSize(sizeBytes) + 90_000;
}

/** Atrasos das re-tentativas automáticas (1ª, 2ª). Só no caminho automático. */
export const TRANSCRIPTION_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000];

/**
 * Falha que vale tentar de novo: rede (nossa ou da VPS baixando o áudio),
 * HTTP 5xx/429. NÃO re-tenta: o NOSSO timeout ("não respondeu em") — o abort
 * do cliente não cancela o job no Whisper (serial), e mandar o mesmo áudio de
 * novo só aumentaria a fila justamente quando ela está cheia (review de
 * 17/11/2026) —, formato inválido, áudio grande demais, serviço não
 * configurado e blob ausente.
 */
export function isTransientTranscriptionError(error: string, httpStatus?: number): boolean {
  if (/não respondeu em/i.test(error)) return false;
  if (httpStatus !== undefined && (httpStatus >= 500 || httpStatus === 429)) return true;
  if (httpStatus !== undefined && httpStatus >= 400) {
    // O serviço devolve 4xx também quando não conseguiu BAIXAR o áudio.
    return /falha ao baixar|unreachable|connectionpool|temporarily/i.test(error);
  }
  return /falha ao baixar|unreachable|connectionpool|fetch failed|network|econn|socket|temporarily/i.test(error);
}

/** Duração estimada (s) de uma nota de voz a partir do tamanho do arquivo. */
export function estimateVoiceNoteSeconds(sizeBytes: number): number {
  return Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes / VOICE_NOTE_BYTES_PER_SEC : 0;
}

/** Abaixo disto (≈ 90 s de áudio) o teto padrão de 60 s do atendente basta. */
export const LONG_AUDIO_MIN_SECONDS = 90;
/** Teto absoluto da espera do atendente por um áudio longo, contado do áudio. */
export const LONG_AUDIO_MAX_WAIT_MS = 11 * 60_000;

/**
 * Quanto o atendente pode esperar pela transcrição DESTE áudio, contado a
 * partir da chegada dele — ou `null` para áudio curto (vale o teto padrão de
 * 60 s do claim). Antes o teto era 60 s para tudo: num áudio de 3–10 min a IA
 * respondia "transcrição indisponível" antes de o texto existir. Cobre o teto
 * do POST + a 1ª re-tentativa (60 s) + folga, até `LONG_AUDIO_MAX_WAIT_MS`.
 */
export function longAudioWaitMs(sizeBytes: number): number | null {
  if (estimateVoiceNoteSeconds(sizeBytes) <= LONG_AUDIO_MIN_SECONDS) return null;
  const wanted = whisperTimeoutMsForSize(sizeBytes) + TRANSCRIPTION_RETRY_DELAYS_MS[0]! + 15_000;
  return Math.min(LONG_AUDIO_MAX_WAIT_MS, wanted);
}

/**
 * RTF do Whisper local (tempo de processamento ÷ duração do áudio), medido na
 * VPS em 17/11/2026 com `small` beam 5: 0,79. Usado só para estimar a fila
 * local (env `WHISPER_LOCAL_RTF` sobrescreve se a VPS mudar de modelo/config).
 */
export const DEFAULT_WHISPER_LOCAL_RTF = 0.8;

export function whisperLocalRtf(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 5 ? n : DEFAULT_WHISPER_LOCAL_RTF;
}

/** Tempo estimado de processamento local deste áudio (ms). */
export function localProcessingEstimateMs(sizeBytes: number, rtf: number): number {
  return Math.round(estimateVoiceNoteSeconds(sizeBytes) * rtf * 1000) + 5_000;
}

export type TranscriptionEngine = "groq" | "local";

/**
 * Ordem dos motores para ESTE áudio (porta única da decisão):
 * - Groq indisponível (sem chave, org sem IA/LGPD, orçamento/cooldown) → só local;
 * - áudio estimado ≥ `longAudioSeconds` → Groq primeiro, local de reserva;
 * - fila local estimada > `busyMaxWaitMs` → Groq primeiro;
 * - senão → local primeiro, Groq de reserva (falha/timeout local).
 */
export function planTranscriptionRoute(input: {
  estimatedSeconds: number;
  groqAvailable: boolean;
  localQueueWaitMs: number;
  longAudioSeconds: number;
  busyMaxWaitMs: number;
}): TranscriptionEngine[] {
  if (!input.groqAvailable) return ["local"];
  if (input.estimatedSeconds >= input.longAudioSeconds) return ["groq", "local"];
  if (input.localQueueWaitMs > input.busyMaxWaitMs) return ["groq", "local"];
  return ["local", "groq"];
}

/** Próximo atraso de re-tentativa, ou `null` quando acabaram as tentativas. */
export function nextTranscriptionRetryDelayMs(attempt: number, transient: boolean): number | null {
  if (!transient) return null;
  const delay = TRANSCRIPTION_RETRY_DELAYS_MS[attempt];
  return delay === undefined ? null : delay;
}
