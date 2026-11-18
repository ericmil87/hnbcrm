/**
 * Estado de plataforma do roteamento da transcrição (Groq × Whisper local):
 * orçamento/cooldown por modelo da Groq, falhas seguidas + alerta por e-mail,
 * e a fila estimada do Whisper local. Único escritor de
 * `transcriptionProviderState`. Lógica pura em `lib/groqTranscription.ts` e
 * `lib/transcriptionPolicy.ts`; quem chama é `transcription.ts` (action).
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import {
  GROQ_LIMITS,
  GroqAlertType,
  GroqFailure,
  billedSeconds,
  groqAlertFor,
  groqAlertInput,
  reserveGroqBudget,
  rollGroqWindows,
} from "./lib/groqTranscription";
import { WHISPER_MAX_TIMEOUT_MS } from "./lib/transcriptionPolicy";
import { platformAlert } from "./lib/platformAlert";

// Espelha `GROQ_MODELS` (lib/groqTranscription; o teste confere a paridade).
export const groqModelValidator = v.union(v.literal("whisper-large-v3-turbo"), v.literal("whisper-large-v3"));
export const GROQ_MODEL_LITERALS: readonly string[] = ["whisper-large-v3-turbo", "whisper-large-v3"];

const failureValidator = v.object({
  kind: v.union(
    v.literal("auth"),
    v.literal("quota"),
    v.literal("rate_limit"),
    v.literal("server"),
    v.literal("bad_request"),
    v.literal("network"),
    v.literal("timeout")
  ),
  status: v.optional(v.number()),
  cooldownMs: v.optional(v.number()),
  message: v.string(),
});

async function stateFor(ctx: QueryCtx | MutationCtx, key: string): Promise<Doc<"transcriptionProviderState"> | null> {
  return await ctx.db
    .query("transcriptionProviderState")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

async function upsert(
  ctx: MutationCtx,
  key: string,
  existing: Doc<"transcriptionProviderState"> | null,
  patch: Partial<Omit<Doc<"transcriptionProviderState">, "_id" | "_creationTime" | "key">>,
  now: number
): Promise<void> {
  if (existing) await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
  else await ctx.db.insert("transcriptionProviderState", { key, ...patch, updatedAt: now });
}

// ── Fila local (Whisper da VPS é serial: um áudio por vez) ──

const LOCAL_KEY = "local";
const LOCAL_IN_FLIGHT_CAP = 30;
/** Entrada mais velha que isto é de action que morreu: não conta na fila. */
const LOCAL_STALE_MS = WHISPER_MAX_TIMEOUT_MS + 60_000;

type InFlight = { messageId: Doc<"messages">["_id"]; startedAt: number; estMs: number };

function liveEntries(entries: readonly InFlight[] | undefined, now: number): InFlight[] {
  return (entries ?? []).filter((e) => now - e.startedAt < LOCAL_STALE_MS);
}

/** Espera estimada até o Whisper local ficar livre (serial: soma do que falta). */
export function localQueueWaitMs(entries: readonly InFlight[] | undefined, now: number): number {
  const live = liveEntries(entries, now);
  if (live.length === 0) return 0;
  const total = live.reduce((acc, e) => acc + e.estMs, 0);
  const oldest = Math.min(...live.map((e) => e.startedAt));
  return Math.max(0, total - (now - oldest));
}

export const internalRoutingSnapshot = internalQuery({
  args: { now: v.number() },
  returns: v.object({ localQueueWaitMs: v.number() }),
  handler: async (ctx, args) => {
    const local = await stateFor(ctx, LOCAL_KEY);
    return { localQueueWaitMs: localQueueWaitMs(local?.localInFlight, args.now) };
  },
});

export const internalLocalStart = internalMutation({
  args: { messageId: v.id("messages"), estMs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const local = await stateFor(ctx, LOCAL_KEY);
    const live = liveEntries(local?.localInFlight, now).filter((e) => e.messageId !== args.messageId);
    live.push({ messageId: args.messageId, startedAt: now, estMs: Math.max(0, Math.min(args.estMs, LOCAL_STALE_MS)) });
    await upsert(ctx, LOCAL_KEY, local, { localInFlight: live.slice(-LOCAL_IN_FLIGHT_CAP) }, now);
    return null;
  },
});

export const internalLocalFinish = internalMutation({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const local = await stateFor(ctx, LOCAL_KEY);
    if (!local) return null;
    const live = liveEntries(local.localInFlight, now).filter((e) => e.messageId !== args.messageId);
    await upsert(ctx, LOCAL_KEY, local, { localInFlight: live }, now);
    return null;
  },
});

// ── Groq: orçamento por modelo ──

export const internalReserveGroq = internalMutation({
  args: { model: groqModelValidator, audioSec: v.number() },
  returns: v.object({ ok: v.boolean(), reason: v.optional(v.string()), billedSec: v.optional(v.number()) }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const key = `groq:${args.model}`;
    const state = await stateFor(ctx, key);
    const verdict = reserveGroqBudget(state ?? {}, now, args.audioSec, GROQ_LIMITS[args.model]);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    const { cooldownUntil: _c, ...windows } = verdict.next;
    await upsert(ctx, key, state, windows, now);
    return { ok: true, billedSec: verdict.billedSec };
  },
});

const GROQ_KEY = "groq";

/**
 * Resultado de UMA chamada à Groq. Sucesso: ajusta os segundos reservados ao
 * cobrado de fato e zera as falhas seguidas. Falha: devolve os segundos (não
 * houve processamento), aplica cooldown no modelo (retry-after / chave / cota),
 * soma falha seguida e, quando é caso de alerta, manda 1 e-mail por tipo a cada
 * 6 h para `PLATFORM_ALERT_EMAIL` (ausente = não envia) pela porta única.
 */
export const internalRecordGroqResult = internalMutation({
  args: {
    model: groqModelValidator,
    reservedSec: v.number(),
    ok: v.boolean(),
    actualSec: v.optional(v.number()),
    failure: v.optional(failureValidator),
    /** Sucesso com pouca folga nos headers da Groq: pausa preventiva do modelo. */
    cooldownMs: v.optional(v.number()),
  },
  returns: v.object({ alerted: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const key = `groq:${args.model}`;
    const state = await stateFor(ctx, key);
    const rolled = rollGroqWindows(state ?? {}, now);
    const global = await stateFor(ctx, GROQ_KEY);
    // O ajuste só vale na MESMA janela da reserva: se a hora/dia virou entre a
    // reserva e o resultado, a janela nova não deve pagar a diferença.
    const sameHour = state?.hourStart === rolled.hourStart;
    const sameDay = state?.dayStart === rolled.dayStart;
    const adjust = (delta: number) => ({
      hourAudioSec: Math.max(0, rolled.hourAudioSec + (sameHour ? delta : 0)),
      dayAudioSec: Math.max(0, rolled.dayAudioSec + (sameDay ? delta : 0)),
      hourStart: rolled.hourStart,
      dayStart: rolled.dayStart,
    });

    if (args.ok) {
      const billed = args.actualSec !== undefined ? billedSeconds(args.actualSec) : args.reservedSec;
      await upsert(
        ctx,
        key,
        state,
        {
          ...adjust(billed - args.reservedSec),
          ...(args.cooldownMs ? { cooldownUntil: Math.max(state?.cooldownUntil ?? 0, now + Math.min(args.cooldownMs, 24 * 3_600_000)) } : {}),
        },
        now
      );
      if (global && (global.consecutiveFailures ?? 0) > 0) {
        await upsert(ctx, GROQ_KEY, global, { consecutiveFailures: 0 }, now);
      }
      return {};
    }

    const failure = args.failure as GroqFailure | undefined;
    const cooldownMs = failure?.cooldownMs;
    await upsert(
      ctx,
      key,
      state,
      {
        ...adjust(-args.reservedSec),
        ...(cooldownMs ? { cooldownUntil: Math.max(state?.cooldownUntil ?? 0, now + cooldownMs) } : {}),
      },
      now
    );
    // Falha sem chamada à Groq (ex.: blob ausente) não conta como falha da Groq.
    if (!failure) return {};

    const consecutive = (global?.consecutiveFailures ?? 0) + 1;
    await upsert(
      ctx,
      GROQ_KEY,
      global,
      { consecutiveFailures: consecutive, lastErrorKind: failure.kind, lastErrorAt: now },
      now
    );
    // Log sem chave e sem dado de cliente: só modelo, tipo e código.
    console.warn(`[transcription] groq ${args.model} falhou: ${failure.kind} ${failure.status ?? ""}`.trim());

    const limits = GROQ_LIMITS[args.model];
    const dayExhausted = rolled.dayRequests >= limits.rpd * 0.85 || rolled.dayAudioSec >= limits.asd * 0.85;
    const alertType: GroqAlertType | null = groqAlertFor(failure, consecutive, dayExhausted);
    if (alertType === null) return {};
    const result = await platformAlert(ctx, groqAlertInput(alertType, failure.status));
    return result.sent || result.reason === "send_failed" ? { alerted: alertType } : {};
  },
});
