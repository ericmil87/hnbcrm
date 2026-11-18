/**
 * Síntese de TESTE da resposta em áudio (amostra de voz e simulador com voz):
 * uma função só, chamada pela action pública `voiceReply.previewVoiceSample` e
 * pelo `attendant.simulateAttendant` com `voice:true`.
 *
 *   internalBeginVoicePreview (auth, IA ativa, teto, cache, limite por usuário/org)
 *     → cache: devolve a URL do WAV de antes, sem pagar
 *       (org com `strictZdr` ou chave própria: recusa com o motivo do runtime)
 *     → `voiceReplyNode.internalSynthesizePreviewAudio` (a porta de TTS)
 *
 * Nunca lança por falha de provedor: devolve `{ok:false, message, reason?}` em PT-BR.
 */
import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { monthKeyUtc } from "./aiSpend";
import { voiceTextReasonLabel } from "./voicePreview";

export const voicePreviewResultValidator = v.union(
  v.object({ ok: v.literal(true), url: v.string(), durationSec: v.number(), cached: v.boolean() }),
  v.object({ ok: v.literal(false), message: v.string(), reason: v.optional(v.string()) })
);

export type VoicePreviewResult =
  | { ok: true; url: string; durationSec: number; cached: boolean }
  | { ok: false; message: string; reason?: string };

export async function synthesizeVoicePreview(
  ctx: ActionCtx,
  input: { organizationId: Id<"organizations">; voice: string; text: string }
): Promise<VoicePreviewResult> {
  const now = Date.now();
  const begin = await ctx.runMutation(internal.voiceReply.internalBeginVoicePreview, {
    organizationId: input.organizationId,
    voice: input.voice,
    text: input.text,
    now,
    month: monthKeyUtc(now),
  });
  if (begin.status === "refused") {
    return { ok: false, message: begin.message, ...(begin.reason ? { reason: begin.reason } : {}) };
  }
  if (begin.status === "cached") return { ok: true, url: begin.url, durationSec: begin.durationSec, cached: true };
  let synth;
  try {
    synth = await ctx.runAction(internal.voiceReplyNode.internalSynthesizePreviewAudio, {
      organizationId: input.organizationId,
      memberId: begin.memberId,
      text: input.text,
      voice: input.voice,
      // `strictZdr` e BYO/`opencode-only` já foram recusados no begin (texto,
      // como no runtime), na mesma transação que leu a configuração.
      strictZdr: false,
      routingAllowed: true,
      cacheKey: begin.cacheKey,
    });
  } catch {
    return { ok: false, reason: "falha_tts", message: voiceTextReasonLabel("falha_tts") };
  }
  if (!synth.ok) return { ok: false, reason: synth.reason, message: voiceTextReasonLabel(synth.reason) };
  const url = await ctx.storage.getUrl(synth.storageId);
  if (!url) return { ok: false, reason: "falha_armazenamento", message: voiceTextReasonLabel("falha_armazenamento") };
  return { ok: true, url, durationSec: synth.durationSec, cached: false };
}
