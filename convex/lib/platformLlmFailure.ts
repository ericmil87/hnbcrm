/**
 * Gancho das falhas REAIS de IA com a chave da plataforma: os pontos onde um
 * erro de run é gravado (`agentRuns.internalFinishRun`,
 * `attendant.internalRecordQueueFailure`) chamam isto; se o erro traz o
 * marcador de `tagPlatformLlmFailure` (OpenRouter da plataforma recusou por
 * chave ou crédito), agenda o alerta. Agendado (e não inline) para o commit do
 * chamador não disputar a linha de dedupe de `platformAlerts` (OCC).
 */
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { parsePlatformLlmFailure } from "./platformSentinel";

export async function notePlatformLlmFailure(ctx: MutationCtx, error: string | undefined): Promise<void> {
  const status = parsePlatformLlmFailure(error);
  if (status === null) return;
  await ctx.scheduler.runAfter(0, internal.platformSentinel.internalNoteLlmFailure, { status });
}
