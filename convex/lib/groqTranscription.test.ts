import { describe, expect, test } from "vitest";
import {
  GROQ_LIMITS,
  billedSeconds,
  classifyGroqFailure,
  groqAlertFor,
  groqAlertInput,
  groqFilenameFor,
  groqHeaderCooldownMs,
  groqLongAudioSeconds,
  parseGroqDurationMs,
  parseGroqTranscription,
  reserveGroqBudget,
} from "./groqTranscription";
import { localProcessingEstimateMs, planTranscriptionRoute, whisperLocalRtf } from "./transcriptionPolicy";

const H = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
const T0 = Date.UTC(2026, 10, 18, 12, 30, 0);
const TURBO = GROQ_LIMITS["whisper-large-v3-turbo"];

describe("classifyGroqFailure", () => {
  test("401/403 = chave; 402 ou texto de cobrança = cota; 5xx = servidor", () => {
    expect(classifyGroqFailure(401, "Invalid API Key", H({})).kind).toBe("auth");
    expect(classifyGroqFailure(403, "", H({})).kind).toBe("auth");
    expect(classifyGroqFailure(402, "", H({})).kind).toBe("quota");
    expect(classifyGroqFailure(400, "organization has insufficient credit", H({})).kind).toBe("quota");
    expect(classifyGroqFailure(503, "", H({})).kind).toBe("server");
    expect(classifyGroqFailure(400, "invalid file format", H({})).kind).toBe("bad_request");
  });
  test("429 respeita retry-after e o reset quando remaining=0", () => {
    expect(classifyGroqFailure(429, "rate limit", H({ "retry-after": "30" }))).toMatchObject({ kind: "rate_limit", cooldownMs: 30_000 });
    expect(
      classifyGroqFailure(429, "", H({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "2m59.5s" })).cooldownMs
    ).toBe(179_500);
    expect(classifyGroqFailure(429, "", H({})).cooldownMs).toBe(60_000);
    expect(classifyGroqFailure(429, "insufficient credit balance", H({})).kind).toBe("quota");
  });
  test("mensagem nunca carrega mais que um trecho curto", () => {
    expect(classifyGroqFailure(400, "org_123 used 7000 of 7200 " + "x".repeat(5000), H({})).message).toBe("HTTP 400");
    expect(classifyGroqFailure(429, "org_123 used 7000 of 7200", H({})).message).toBe("HTTP 429");
  });
});

describe("groqHeaderCooldownMs (headers reais medidos em 18/11/2026)", () => {
  test("com folga: nada; com < 15% sobrando: pausa até o reset", () => {
    const ok = H({
      "x-ratelimit-limit-audio-seconds": "7200",
      "x-ratelimit-remaining-audio-seconds": "6577",
      "x-ratelimit-reset-audio-seconds": "5m11.5s",
      "x-ratelimit-limit-requests": "2000",
      "x-ratelimit-remaining-requests": "1998",
      "x-ratelimit-reset-requests": "1m26.4s",
    });
    expect(groqHeaderCooldownMs(ok)).toBeNull();
    const low = H({
      "x-ratelimit-limit-audio-seconds": "7200",
      "x-ratelimit-remaining-audio-seconds": "900",
      "x-ratelimit-reset-audio-seconds": "20m",
    });
    expect(groqHeaderCooldownMs(low)).toBe(20 * 60_000);
    expect(groqHeaderCooldownMs(H({}))).toBeNull();
  });
  test("429 com segundos de áudio esgotados usa o reset de áudio", () => {
    expect(
      classifyGroqFailure(429, "", H({ "x-ratelimit-remaining-audio-seconds": "0", "x-ratelimit-reset-audio-seconds": "12m" })).cooldownMs
    ).toBe(12 * 60_000);
  });
});

describe("parse", () => {
  test("durações da Groq", () => {
    expect(parseGroqDurationMs("1h2m3.5s")).toBe(3_723_500);
    expect(parseGroqDurationMs("250ms")).toBe(250);
    expect(parseGroqDurationMs("7")).toBe(7_000);
    expect(parseGroqDurationMs("")).toBeNull();
    expect(parseGroqDurationMs("abc")).toBeNull();
  });
  test("verbose_json → texto, duração, idioma em código", () => {
    expect(parseGroqTranscription({ text: " oi ", duration: 12.5, language: "portuguese" })).toEqual({
      text: "oi",
      durationSec: 12.5,
      language: "pt",
    });
    expect(parseGroqTranscription(null)).toEqual({ text: "" });
  });
  test("extensão pelo mime", () => {
    expect(groqFilenameFor("audio/ogg; codecs=opus")).toBe("audio.ogg");
    expect(groqFilenameFor("audio/webm;codecs=opus")).toBe("audio.webm");
    expect(groqFilenameFor("audio/mp4")).toBe("audio.m4a");
  });
  test("env do limiar de áudio longo", () => {
    expect(groqLongAudioSeconds(undefined)).toBe(120);
    expect(groqLongAudioSeconds("90")).toBe(90);
    expect(groqLongAudioSeconds("x")).toBe(120);
  });
});

describe("orçamento (85% dos limites oficiais)", () => {
  test("mínimo cobrado de 10 s", () => {
    expect(billedSeconds(3)).toBe(10);
    expect(billedSeconds(600.2)).toBe(601);
  });
  test("reserva soma request e segundos; janela nova zera", () => {
    const r = reserveGroqBudget({}, T0, 600, TURBO);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("x");
    expect(r.next).toMatchObject({ minuteRequests: 1, dayRequests: 1, hourAudioSec: 600, dayAudioSec: 600 });
    const nextHour = reserveGroqBudget(r.next, T0 + 3_600_000, 600, TURBO);
    if (!nextHour.ok) throw new Error("x");
    expect(nextHour.next.hourAudioSec).toBe(600);
    expect(nextHour.next.dayAudioSec).toBe(1200);
  });
  test("recusa perto dos limites e em cooldown", () => {
    const hourStart = Math.floor(T0 / 3_600_000) * 3_600_000;
    const dayStart = Math.floor(T0 / 86_400_000) * 86_400_000;
    const minuteStart = Math.floor(T0 / 60_000) * 60_000;
    expect(reserveGroqBudget({ hourStart, hourAudioSec: 7_200 * 0.85 - 5 }, T0, 60, TURBO)).toEqual({ ok: false, reason: "ash" });
    expect(reserveGroqBudget({ dayStart, dayAudioSec: 28_800 * 0.85 - 5 }, T0, 60, TURBO)).toEqual({ ok: false, reason: "asd" });
    expect(reserveGroqBudget({ minuteStart, minuteRequests: 17 }, T0, 60, TURBO)).toEqual({ ok: false, reason: "rpm" });
    expect(reserveGroqBudget({ dayStart, dayRequests: 1_700 }, T0, 60, TURBO)).toEqual({ ok: false, reason: "rpd" });
    expect(reserveGroqBudget({ cooldownUntil: T0 + 1 }, T0, 60, TURBO)).toEqual({ ok: false, reason: "cooldown" });
  });
});

describe("alertas", () => {
  test("tipos", () => {
    expect(groqAlertFor({ kind: "auth", message: "" }, 1, false)).toBe("auth");
    expect(groqAlertFor({ kind: "quota", message: "" }, 1, false)).toBe("quota");
    expect(groqAlertFor({ kind: "rate_limit", cooldownMs: 30_000, message: "" }, 1, false)).toBeNull();
    expect(groqAlertFor({ kind: "rate_limit", cooldownMs: 30_000, message: "" }, 1, true)).toBe("rate_limit");
    expect(groqAlertFor({ kind: "rate_limit", cooldownMs: 15 * 60_000, message: "" }, 1, false)).toBe("rate_limit");
    expect(groqAlertFor({ kind: "server", message: "" }, 4, false)).toBeNull();
    expect(groqAlertFor({ kind: "server", message: "" }, 5, false)).toBe("failures");
  });
  test("entrada do platformAlert: kind estável, PT-BR, fallback local, sem chave", () => {
    for (const type of ["auth", "quota", "rate_limit", "failures"] as const) {
      const a = groqAlertInput(type, 401);
      expect(a.kind).toBe(`groq_${type}`);
      expect(a.title).toMatch(/^Transcrição:/);
      expect(a.fallback).toMatch(/Whisper local/);
      expect(JSON.stringify(a)).not.toMatch(/gsk_/);
    }
    expect(groqAlertInput("auth", 401).severity).toBe("critical");
    expect(groqAlertInput("rate_limit", 429).severity).toBe("warning");
  });
  test("teto da env do limiar (cabe nos 10 min da action)", () => {
    expect(groqLongAudioSeconds("900")).toBe(200);
  });
});

describe("planTranscriptionRoute", () => {
  const base = { groqAvailable: true, localQueueWaitMs: 0, longAudioSeconds: 120, busyMaxWaitMs: 60_000 };
  test("longo → Groq primeiro; curto → local primeiro; ocupado → Groq; sem Groq → só local", () => {
    expect(planTranscriptionRoute({ ...base, estimatedSeconds: 600 })).toEqual(["groq", "local"]);
    expect(planTranscriptionRoute({ ...base, estimatedSeconds: 30 })).toEqual(["local", "groq"]);
    expect(planTranscriptionRoute({ ...base, estimatedSeconds: 30, localQueueWaitMs: 90_000 })).toEqual(["groq", "local"]);
    expect(planTranscriptionRoute({ ...base, estimatedSeconds: 600, groqAvailable: false })).toEqual(["local"]);
  });
  test("estimativa da fila local", () => {
    expect(whisperLocalRtf(undefined)).toBe(0.8);
    expect(whisperLocalRtf("0.43")).toBe(0.43);
    expect(whisperLocalRtf("0")).toBe(0.8);
    expect(localProcessingEstimateMs(250_000, 0.8)).toBe(85_000); // 100 s × 0,8 + 5 s
  });
});
