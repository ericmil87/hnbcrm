/**
 * Transcrição pela Groq (whisper-large-v3-turbo, depois whisper-large-v3) —
 * núcleo PURO: request, parse, classificação de falha, orçamento de uso e
 * decisão de alerta. Quem chama a rede é `convex/transcription.ts`; quem grava
 * o estado é `convex/transcriptionRouting.ts`.
 *
 * Por que existe (18/11/2026): clientes mandam notas de voz de ~10 min e o
 * Whisper local da VPS (CPU, ~tempo real) leva ~8 min nelas. A Groq faz o
 * mesmo áudio em segundos por US$ 0,04/h (turbo). Ligada só com a env
 * `GROQ_API_KEY`; sem ela tudo segue no Whisper local, como antes.
 *
 * Privacidade: só org com IA ativa + aceite LGPD (`orgAiActive`) manda áudio
 * para fora; ZDR precisa estar LIGADO no painel da Groq (Data Controls). O
 * request leva só o arquivo, o modelo, `language=pt`, o formato e a
 * temperatura — nenhum id, nome ou telefone.
 */

export const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
/** Ordem de tentativa: turbo (US$ 0,04/h) e, com a cota dele esgotada, o v3 (US$ 0,111/h). */
export const GROQ_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"] as const;
export type GroqModel = (typeof GROQ_MODELS)[number];
/** Teto do POST: o turbo faz 10 min em ~3 s; 60 s cobre upload de 25 MB + fila. */
export const GROQ_TIMEOUT_MS = 60_000;
/** A Groq cobra no mínimo 10 s por request. */
export const GROQ_MIN_BILLED_SECONDS = 10;

/** Limites oficiais do plano base (por modelo). Hora/dia em janelas fixas UTC aqui. */
export type GroqLimits = { rpm: number; rpd: number; ash: number; asd: number };
export const GROQ_LIMITS: Record<GroqModel, GroqLimits> = {
  "whisper-large-v3-turbo": { rpm: 20, rpd: 2_000, ash: 7_200, asd: 28_800 },
  "whisper-large-v3": { rpm: 20, rpd: 2_000, ash: 7_200, asd: 28_800 },
};
/** Para de mandar para a Groq ao chegar nesta fração de qualquer limite (folga para a janela móvel deles). */
export const GROQ_BUDGET_FRACTION = 0.85;

/** Áudio estimado acima disto vai DIRETO para a Groq (env `GROQ_LONG_AUDIO_SECONDS`). */
export const DEFAULT_GROQ_LONG_AUDIO_SECONDS = 120;
/** Teto da env: acima disto local (até 540 s) + Groq (2 × 60 s) passaria dos 10 min da action. */
export const MAX_GROQ_LONG_AUDIO_SECONDS = 200;
/** Fila local estimada acima disto: áudio curto também vai para a Groq. */
export const LOCAL_BUSY_MAX_WAIT_MS = 60_000;

export function groqLongAudioSeconds(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_GROQ_LONG_AUDIO_SECONDS) : DEFAULT_GROQ_LONG_AUDIO_SECONDS;
}

/** Nome de arquivo com a extensão que a Groq usa para detectar o formato. */
export function groqFilenameFor(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("webm")) return "audio.webm";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "audio.m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "audio.mp3";
  if (m.includes("wav")) return "audio.wav";
  if (m.includes("flac")) return "audio.flac";
  return "audio.ogg";
}

/** Corpo multipart: SÓ o necessário. */
export function buildGroqForm(file: Blob, mimeType: string, model: GroqModel): FormData {
  const form = new FormData();
  form.append("file", file, groqFilenameFor(mimeType));
  form.append("model", model);
  form.append("language", "pt");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  return form;
}

export function parseGroqTranscription(body: unknown): { text: string; durationSec?: number; language?: string } {
  const b = (body ?? {}) as { text?: unknown; duration?: unknown; language?: unknown };
  const text = typeof b.text === "string" ? b.text.trim() : "";
  const durationSec = typeof b.duration === "number" && Number.isFinite(b.duration) ? b.duration : undefined;
  // verbose_json devolve o nome do idioma ("portuguese"); o CRM usa código.
  const language = typeof b.language === "string" ? (/^portug/i.test(b.language) ? "pt" : b.language) : undefined;
  return { text, ...(durationSec !== undefined ? { durationSec } : {}), ...(language ? { language } : {}) };
}

/** "2m59.56s", "1h2m3s", "12.3s", "250ms", "7" (s) → ms. */
export function parseGroqDurationMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n;
  }
  return matched ? Math.round(total) : null;
}

export type GroqFailureKind = "auth" | "quota" | "rate_limit" | "server" | "bad_request" | "network" | "timeout";

export type GroqFailure = {
  kind: GroqFailureKind;
  status?: number;
  /** Quanto esperar antes de mandar de novo para ESTE modelo (retry-after / reset). */
  cooldownMs?: number;
  /** Mensagem curta e segura (nunca o corpo inteiro, nunca a chave). */
  message: string;
};

const QUOTA_RE = /quota|billing|credit|insufficient|payment|exceeded your|organization.*(restricted|disabled)/i;

/**
 * Classifica uma resposta não-OK da Groq. `headers.get` é o de `Response`.
 * 401/403 = chave inválida/revogada; 402 ou texto de cota/cobrança = recurso;
 * 429 = limite (respeita `retry-after`); 5xx = servidor; 4xx restante = request.
 */
export function classifyGroqFailure(
  status: number,
  bodyText: string,
  headers: { get(name: string): string | null }
): GroqFailure {
  if (status === 401 || status === 403) return { kind: "auth", status, cooldownMs: 30 * 60_000, message: `HTTP ${status}` };
  if (status === 402 || (status !== 429 && QUOTA_RE.test(bodyText))) {
    return { kind: "quota", status, cooldownMs: 60 * 60_000, message: `HTTP ${status}` };
  }
  if (status === 429) {
    const retryAfter = parseGroqDurationMs(headers.get("retry-after"));
    const resetReq = headers.get("x-ratelimit-remaining-requests") === "0"
      ? parseGroqDurationMs(headers.get("x-ratelimit-reset-requests"))
      : null;
    const resetAudio = headers.get("x-ratelimit-remaining-audio-seconds") === "0"
      ? parseGroqDurationMs(headers.get("x-ratelimit-reset-audio-seconds"))
      : null;
    const cooldownMs = Math.max(retryAfter ?? 0, resetReq ?? 0, resetAudio ?? 0) || 60_000;
    // 429 por falta de crédito é cota; o resto é limite de uso.
    const kind: GroqFailureKind = /credit|billing|payment|insufficient/i.test(bodyText) ? "quota" : "rate_limit";
    return { kind, status, cooldownMs, message: "HTTP 429" };
  }
  if (status >= 500) return { kind: "server", status, cooldownMs: 30_000, message: `HTTP ${status}` };
  return { kind: "bad_request", status, message: `HTTP ${status}` };
}

/**
 * Cooldown PREVENTIVO a partir dos headers de uma resposta OK (medido em
 * 18/11/2026: a Groq devolve `x-ratelimit-{limit,remaining,reset}-audio-seconds`
 * da janela de 1 h e `-requests` do dia). Com menos de 15% sobrando em
 * qualquer um, pausa o modelo até o reset — a contagem própria não vê o uso de
 * outros ambientes que compartilham a mesma chave/conta.
 */
export function groqHeaderCooldownMs(headers: { get(name: string): string | null }, minRemainingFraction = 0.15): number | null {
  let cooldown = 0;
  for (const kind of ["audio-seconds", "requests"] as const) {
    const limit = Number(headers.get(`x-ratelimit-limit-${kind}`));
    const remaining = Number(headers.get(`x-ratelimit-remaining-${kind}`));
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) continue;
    if (remaining <= limit * minRemainingFraction) {
      cooldown = Math.max(cooldown, parseGroqDurationMs(headers.get(`x-ratelimit-reset-${kind}`)) ?? 60_000);
    }
  }
  return cooldown > 0 ? cooldown : null;
}

// ── Orçamento (janelas fixas UTC, contagem própria em segundos de áudio) ──

export type GroqUsageState = {
  minuteStart?: number;
  minuteRequests?: number;
  hourStart?: number;
  hourAudioSec?: number;
  dayStart?: number;
  dayAudioSec?: number;
  dayRequests?: number;
  cooldownUntil?: number;
};

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function billedSeconds(audioSec: number): number {
  return Math.max(GROQ_MIN_BILLED_SECONDS, Math.ceil(Number.isFinite(audioSec) && audioSec > 0 ? audioSec : 0));
}

/** Estado com as janelas vencidas zeradas. */
export function rollGroqWindows(state: GroqUsageState, now: number): Required<Omit<GroqUsageState, "cooldownUntil">> & { cooldownUntil?: number } {
  const minuteStart = Math.floor(now / MIN) * MIN;
  const hourStart = Math.floor(now / HOUR) * HOUR;
  const dayStart = Math.floor(now / DAY) * DAY;
  return {
    minuteStart,
    minuteRequests: state.minuteStart === minuteStart ? state.minuteRequests ?? 0 : 0,
    hourStart,
    hourAudioSec: state.hourStart === hourStart ? state.hourAudioSec ?? 0 : 0,
    dayStart,
    dayAudioSec: state.dayStart === dayStart ? state.dayAudioSec ?? 0 : 0,
    dayRequests: state.dayStart === dayStart ? state.dayRequests ?? 0 : 0,
    ...(state.cooldownUntil !== undefined ? { cooldownUntil: state.cooldownUntil } : {}),
  };
}

export type GroqBudgetVerdict =
  | { ok: true; next: ReturnType<typeof rollGroqWindows>; billedSec: number }
  | { ok: false; reason: "cooldown" | "rpm" | "rpd" | "ash" | "asd" };

/** Cabe mais este áudio sem passar de 85% de nenhum limite? Devolve o estado já reservado. */
export function reserveGroqBudget(
  state: GroqUsageState,
  now: number,
  audioSec: number,
  limits: GroqLimits,
  fraction = GROQ_BUDGET_FRACTION
): GroqBudgetVerdict {
  if (state.cooldownUntil !== undefined && state.cooldownUntil > now) return { ok: false, reason: "cooldown" };
  const s = rollGroqWindows(state, now);
  const billed = billedSeconds(audioSec);
  if (s.minuteRequests + 1 > limits.rpm * fraction) return { ok: false, reason: "rpm" };
  if (s.dayRequests + 1 > limits.rpd * fraction) return { ok: false, reason: "rpd" };
  if (s.hourAudioSec + billed > limits.ash * fraction) return { ok: false, reason: "ash" };
  if (s.dayAudioSec + billed > limits.asd * fraction) return { ok: false, reason: "asd" };
  return {
    ok: true,
    billedSec: billed,
    next: {
      ...s,
      minuteRequests: s.minuteRequests + 1,
      dayRequests: s.dayRequests + 1,
      hourAudioSec: s.hourAudioSec + billed,
      dayAudioSec: s.dayAudioSec + billed,
    },
  };
}

// ── Alertas (enviados pela porta genérica `lib/platformAlert.ts`) ──

export type GroqAlertType = "auth" | "quota" | "rate_limit" | "failures";
/** Falhas seguidas (qualquer tipo) que viram alerta. */
export const GROQ_ALERT_CONSECUTIVE_FAILURES = 5;
/** 429 com espera longa = limite diário/horário de fato atingido. */
export const GROQ_SUSTAINED_RATE_LIMIT_MS = 10 * MIN;

export function groqAlertFor(failure: GroqFailure, consecutiveFailures: number, dayBudgetExhausted: boolean): GroqAlertType | null {
  if (failure.kind === "auth") return "auth";
  if (failure.kind === "quota") return "quota";
  if (
    failure.kind === "rate_limit" &&
    (dayBudgetExhausted || (failure.cooldownMs ?? 0) >= GROQ_SUSTAINED_RATE_LIMIT_MS || consecutiveFailures >= 3)
  ) {
    return "rate_limit";
  }
  if (consecutiveFailures >= GROQ_ALERT_CONSECUTIVE_FAILURES) return "failures";
  return null;
}

const FALLBACK_TEXT =
  "Enquanto isso, os áudios continuam sendo transcritos pelo Whisper local (mais lento em áudios longos). Nada se perde.";

/** Entrada do `platformAlert` para um problema da Groq. Sem chave, sem dado de cliente. */
export function groqAlertInput(
  type: GroqAlertType,
  status: number | undefined
): { kind: string; severity: "critical" | "warning"; title: string; detail: string; howToFix: string; fallback: string } {
  const code = status !== undefined ? ` (último código: HTTP ${status})` : "";
  switch (type) {
    case "auth":
      return {
        kind: "groq_auth",
        severity: "critical",
        title: "Transcrição: chave da Groq recusada",
        detail: `A Groq recusou a chave de API${code}: ela pode ter sido revogada, expirado ou estar errada.`,
        howToFix: "Gere uma chave nova em console.groq.com → API Keys e atualize a env GROQ_API_KEY no Convex (npx convex env set GROQ_API_KEY ...).",
        fallback: FALLBACK_TEXT,
      };
    case "quota":
      return {
        kind: "groq_quota",
        severity: "critical",
        title: "Transcrição: Groq sem crédito ou cota",
        detail: `A Groq recusou a transcrição por falta de crédito, cota ou restrição da conta${code}.`,
        howToFix: "Confira o plano e a cobrança em console.groq.com → Settings → Billing.",
        fallback: FALLBACK_TEXT,
      };
    case "rate_limit":
      return {
        kind: "groq_rate_limit",
        severity: "warning",
        title: "Transcrição: limite de uso da Groq atingido",
        detail: `A Groq está recusando por limite de uso de forma sustentada${code}: o teto por hora ou por dia de segundos de áudio/requests foi atingido.`,
        howToFix: "Nada urgente: o envio para a Groq volta sozinho quando a janela libera. Se acontecer todo dia, avalie subir o plano da Groq.",
        fallback: FALLBACK_TEXT,
      };
    case "failures":
      return {
        kind: "groq_failures",
        severity: "warning",
        title: "Transcrição: falhas seguidas na Groq",
        detail: `Várias transcrições seguidas falharam na Groq (servidor, rede ou request)${code}.`,
        howToFix: "Veja status.groq.com e os logs do Convex (transcription). Se persistir, remova a env GROQ_API_KEY para desligar a Groq.",
        fallback: FALLBACK_TEXT,
      };
  }
}
