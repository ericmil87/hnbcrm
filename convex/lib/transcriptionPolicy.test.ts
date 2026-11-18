import { describe, expect, test } from "vitest";
import {
  WHISPER_BASE_TIMEOUT_MS,
  WHISPER_MAX_TIMEOUT_MS,
  isTransientTranscriptionError,
  nextTranscriptionRetryDelayMs,
  transcriptionPendingStaleAfterMs,
  whisperTimeoutMsForSize,
} from "./transcriptionPolicy";

describe("whisperTimeoutMsForSize", () => {
  test("áudio curto mantém os 120 s de antes", () => {
    expect(whisperTimeoutMsForSize(0)).toBe(WHISPER_BASE_TIMEOUT_MS);
    expect(whisperTimeoutMsForSize(24_774)).toBe(WHISPER_BASE_TIMEOUT_MS);
    expect(whisperTimeoutMsForSize(Number.NaN)).toBe(WHISPER_BASE_TIMEOUT_MS);
    expect(whisperTimeoutMsForSize(-5)).toBe(WHISPER_BASE_TIMEOUT_MS);
  });
  test("áudio de ~2,7 min (410 KB, os que falharam em PROD) ganha folga acima da duração", () => {
    const ms = whisperTimeoutMsForSize(418_206);
    expect(ms).toBeGreaterThan(250_000);
    expect(ms).toBeLessThanOrEqual(WHISPER_MAX_TIMEOUT_MS);
  });
  test("teto máximo abaixo do limite de 10 min da action", () => {
    expect(whisperTimeoutMsForSize(25 * 1024 * 1024)).toBe(WHISPER_MAX_TIMEOUT_MS);
    expect(WHISPER_MAX_TIMEOUT_MS).toBeLessThan(600_000);
  });
  test("pending em voo vale até o teto + 90 s (cobre a Groq antes do local)", () => {
    expect(transcriptionPendingStaleAfterMs(0)).toBe(210_000);
  });
});

describe("isTransientTranscriptionError", () => {
  test("transitórios", () => {
    expect(isTransientTranscriptionError("fetch failed: ECONNRESET")).toBe(true);
    expect(isTransientTranscriptionError("fetch failed")).toBe(true);
    expect(
      isTransientTranscriptionError(
        "Falha ao baixar áudio da URL: HTTPSConnectionPool(host='x', port=443): Max retries exceeded ([Errno 101] Network is unreachable)",
        400
      )
    ).toBe(true);
    expect(isTransientTranscriptionError("Whisper service error (HTTP 502)", 502)).toBe(true);
    expect(isTransientTranscriptionError("rate limited", 429)).toBe(true);
  });
  test("permanentes", () => {
    expect(isTransientTranscriptionError("Formato de áudio inválido", 400)).toBe(false);
    expect(isTransientTranscriptionError("Unauthorized", 401)).toBe(false);
    expect(isTransientTranscriptionError("Áudio maior que 25MB — não transcrito")).toBe(false);
    expect(isTransientTranscriptionError("WHISPER_SERVICE_URL não configurado no Convex")).toBe(false);
  });
});

describe("nextTranscriptionRetryDelayMs", () => {
  test("60 s, 5 min, depois para; permanente nunca re-tenta", () => {
    expect(nextTranscriptionRetryDelayMs(0, true)).toBe(60_000);
    expect(nextTranscriptionRetryDelayMs(1, true)).toBe(300_000);
    expect(nextTranscriptionRetryDelayMs(2, true)).toBeNull();
    expect(nextTranscriptionRetryDelayMs(0, false)).toBeNull();
  });
});
