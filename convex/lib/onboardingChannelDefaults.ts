/**
 * Pacote recomendado da conversa de configuração (`/comecar`) aplicado ao
 * PRIMEIRO número conectado depois dela.
 *
 * A transcrição de áudio é por número (`channelConfigs.autoTranscribeAudio`).
 * Quando o rascunho foi aplicado sem número conectado, a aplicação registra
 * `transcription: "no_channel"` e nada fica gravado; o atendente ativo já faz a
 * transcrição acontecer (`shouldTranscribeAudio`), mas o interruptor do número
 * aparecia desligado, contradizendo a promessa "IA com os recursos ligados".
 * Esta regra liga o interruptor do primeiro número, pela porta de sempre
 * (`patchChannelTranscriptionCore`, `via:"onboarding"`, auditada).
 *
 * Só vale quando TUDO se cumpre: org com a IA ativa (aceite LGPD dado por
 * clique), sessão da conversa aplicada com a transcrição marcada no pacote,
 * nenhum outro número de WhatsApp na org e a infraestrutura de transcrição
 * existente no deployment (`WHISPER_SERVICE_URL`). Org sem conversa aplicada,
 * ou que já tinha número, não muda em nada.
 */
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { orgAiActive } from "./agentSecurity";
import { patchChannelTranscriptionCore } from "./attendantConfigOps";

const SCAN = 25;

export function transcriptionInfraAvailable(): boolean {
  return !!process.env.WHISPER_SERVICE_URL?.trim();
}

/** Liga a transcrição do número recém-criado se a regra acima vale. Devolve se ligou. */
export async function applyOnboardingDefaultsToNewChannel(
  ctx: MutationCtx,
  params: { config: Doc<"channelConfigs">; member: Doc<"teamMembers"> },
): Promise<boolean> {
  const { config, member } = params;
  if (config.channel !== "whatsapp" || config.autoTranscribeAudio === true) return false;
  if (!transcriptionInfraAvailable()) return false;
  const org = await ctx.db.get(config.organizationId);
  if (!org || !orgAiActive(org)) return false;

  const channels = await ctx.db
    .query("channelConfigs")
    .withIndex("by_organization", (q) => q.eq("organizationId", config.organizationId))
    .take(SCAN);
  if (channels.some((c) => c._id !== config._id && c.channel === "whatsapp")) return false;

  const sessions = await ctx.db
    .query("onboardingSessions")
    .withIndex("by_organization", (q) => q.eq("organizationId", config.organizationId))
    .order("desc")
    .take(SCAN);
  // A aplicação mais recente decide (um recomeço pode ter desmarcado o recurso).
  const lastApplied = sessions.find((s) => s.appliedAt !== undefined);
  if (lastApplied?.draft?.features.transcription !== true) return false;

  await patchChannelTranscriptionCore(ctx, { config, member, enabled: true, via: "onboarding" });
  return true;
}
