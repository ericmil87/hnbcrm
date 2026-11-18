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
 * meio de um áudio longo dispararia uma 2ª inferência no mesmo Whisper.
 */
export function transcriptionPendingStaleAfterMs(sizeBytes: number): number {
  return whisperTimeoutMsForSize(sizeBytes) + 30_000;
}

/** Atrasos das re-tentativas automáticas (1ª, 2ª). Só no caminho automático. */
export const TRANSCRIPTION_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000];

/**
 * Falha que vale tentar de novo: timeout, rede (nossa ou da VPS baixando o
 * áudio), HTTP 5xx/429. Formato inválido, áudio grande demais, serviço não
 * configurado e blob ausente NÃO são transitórios.
 */
export function isTransientTranscriptionError(error: string, httpStatus?: number): boolean {
  if (httpStatus !== undefined && (httpStatus >= 500 || httpStatus === 429)) return true;
  if (httpStatus !== undefined && httpStatus >= 400) {
    // O serviço devolve 4xx também quando não conseguiu BAIXAR o áudio.
    return /falha ao baixar|unreachable|connectionpool|timed out|temporarily/i.test(error);
  }
  return /não respondeu em|falha ao baixar|unreachable|connectionpool|timed out|timeout|fetch failed|network|econn|socket|temporarily/i.test(
    error
  );
}

/** Próximo atraso de re-tentativa, ou `null` quando acabaram as tentativas. */
export function nextTranscriptionRetryDelayMs(attempt: number, transient: boolean): number | null {
  if (!transient) return null;
  const delay = TRANSCRIPTION_RETRY_DELAYS_MS[attempt];
  return delay === undefined ? null : delay;
}
