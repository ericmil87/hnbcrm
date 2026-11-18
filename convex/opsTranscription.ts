/**
 * Ops da transcrição (18/11/2026): ping/teste da Groq e disparo controlado do
 * alerta de plataforma. Tudo `internal*` com `dryRun` (default true), rodado
 * com `npx convex run`. NUNCA usar com áudio de cliente: o teste de
 * transcrição é para arquivos de teste enviados pelo próprio operador
 * (`internalCreateUploadUrl` → POST do arquivo → `storageId`).
 */
import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  GROQ_MODELS,
  GROQ_TIMEOUT_MS,
  GROQ_TRANSCRIPTIONS_URL,
  buildGroqForm,
  classifyGroqFailure,
  parseGroqTranscription,
} from "./lib/groqTranscription";
import { estimateVoiceNoteSeconds } from "./lib/transcriptionPolicy";
import { platformAlert } from "./lib/platformAlert";
import { groqModelValidator } from "./transcriptionRouting";
import { isStorageReferenced } from "./lib/fileRefs";

/** URL de upload do storage para um arquivo de TESTE (o operador faz o POST). */
export const internalCreateUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/**
 * Apaga o arquivo de teste depois do probe. Recusa blob referenciado por
 * `files` (anexo real de mensagem): só apaga blob solto, como o do upload de teste.
 */
export const internalDeleteTestFile = internalMutation({
  args: { storageId: v.id("_storage"), dryRun: v.optional(v.boolean()) },
  returns: v.object({ deleted: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    if (await isStorageReferenced(ctx, args.storageId)) return { deleted: false, reason: "referenciado_por_files" };
    if (args.dryRun !== false) return { deleted: false, reason: "dry_run" };
    await ctx.storage.delete(args.storageId);
    return { deleted: true };
  },
});

/**
 * Sem `storageId`: ping (`GET /openai/v1/models`) — confirma a chave e os
 * modelos, sem enviar dado nenhum. Com `storageId` e `dryRun:false`: transcreve
 * o arquivo de TESTE pela Groq (passa pelo orçamento como qualquer chamada) e
 * devolve tempo, duração e o começo do texto. Nunca devolve a chave.
 */
export const internalGroqProbe = internalAction({
  args: {
    storageId: v.optional(v.id("_storage")),
    model: v.optional(groqModelValidator),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const key = process.env.GROQ_API_KEY?.trim();
    if (!key) return { configured: false };

    if (!args.storageId) {
      const t0 = Date.now();
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      });
      const ms = Date.now() - t0;
      if (!res.ok) return { configured: true, ok: false, status: res.status, ms };
      const body = (await res.json()) as { data?: { id?: string }[] };
      const ids = new Set((body.data ?? []).map((m) => m.id));
      return { configured: true, ok: true, ms, models: GROQ_MODELS.map((m) => ({ model: m, available: ids.has(m) })) };
    }

    const blob = await ctx.storage.get(args.storageId);
    if (!blob) return { configured: true, ok: false, error: "arquivo não encontrado" };
    const size = blob.size;
    const model = args.model ?? GROQ_MODELS[0];
    const estimatedSeconds = estimateVoiceNoteSeconds(size);
    if (args.dryRun !== false) return { configured: true, dryRun: true, size, estimatedSeconds, model };
    const reservation: { ok: boolean; reason?: string; billedSec?: number } = await ctx.runMutation(internal.transcriptionRouting.internalReserveGroq, {
      model,
      audioSec: estimatedSeconds,
    });
    if (!reservation.ok) return { configured: true, ok: false, error: `orçamento: ${reservation.reason}` };
    const t0 = Date.now();
    const res = await fetch(GROQ_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: buildGroqForm(blob, blob.type || "audio/ogg", model),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const failure = classifyGroqFailure(res.status, await res.text().catch(() => ""), res.headers);
      await ctx.runMutation(internal.transcriptionRouting.internalRecordGroqResult, {
        model,
        reservedSec: reservation.billedSec ?? 0,
        ok: false,
        failure: { kind: failure.kind, message: failure.message, ...(failure.status !== undefined ? { status: failure.status } : {}), ...(failure.cooldownMs !== undefined ? { cooldownMs: failure.cooldownMs } : {}) },
      });
      return { configured: true, ok: false, status: res.status, kind: failure.kind, ms };
    }
    const parsed = parseGroqTranscription(await res.json());
    await ctx.runMutation(internal.transcriptionRouting.internalRecordGroqResult, {
      model,
      reservedSec: reservation.billedSec ?? 0,
      ok: true,
      ...(parsed.durationSec !== undefined ? { actualSec: parsed.durationSec } : {}),
    });
    return {
      configured: true,
      ok: true,
      model,
      ms,
      size,
      durationSec: parsed.durationSec,
      language: parsed.language,
      chars: parsed.text.length,
      textHead: parsed.text.slice(0, 400),
      textTail: parsed.text.slice(-200),
    };
  },
});

/**
 * Disparo controlado do alerta de plataforma (valida env + envio real). Kind
 * próprio (`platform_alert_test`, janela de 1 min) para não consumir o dedupe
 * dos alertas reais.
 */
export const internalPlatformAlertTest = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({ recipientConfigured: v.boolean(), sent: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const recipientConfigured = !!process.env.PLATFORM_ALERT_EMAIL?.trim();
    if (args.dryRun !== false) return { recipientConfigured, sent: false, reason: "dry_run" };
    const r = await platformAlert(ctx, {
      kind: "platform_alert_test",
      severity: "warning",
      title: "Teste do alerta de plataforma",
      detail: "Este é um disparo de teste do canal de alertas de plataforma do HNBCRM. Nenhuma ação é necessária.",
      howToFix: "Se este e-mail chegou, o canal de alertas está funcionando.",
      throttleMs: 60_000,
    });
    return { recipientConfigured, sent: r.sent, ...(r.reason ? { reason: r.reason } : {}) };
  },
});
