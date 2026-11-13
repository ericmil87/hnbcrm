/**
 * Gates COMPARTILHADOS dos dois pipelines de enriquecimento de mídia inbound:
 * transcrição de nota de voz (convex/transcription.ts) e passe de visão
 * (convex/vision.ts). Funções puras sobre os docs — sem ctx, sem db — para
 * ficarem testáveis e para os dois pipelines não divergirem.
 *
 * Os dois gates são assimétricos de propósito:
 *
 * - **Áudio** é uma DISJUNÇÃO: o Whisper é self-hosted e grátis, então basta o
 *   toggle do canal OU o atendente estar ativo (sem transcrição ele responderia
 *   "não consigo ouvir áudio").
 * - **Visão** é UM interruptor só: `aiConfig.visionEnabled`. A v0.51 exigia
 *   também um toggle por canal, num AND — dois interruptores em telas
 *   diferentes para ligar a mesma coisa. Confundia mais do que a flexibilidade
 *   valia, então a v0.52 deixou só o da organização. Ele continua sendo opt-in
 *   explícito (default false), porque cada imagem custa uma chamada paga e a
 *   imagem do cliente — que pode ser RG/CNH — sai da nossa infra.
 *
 * Exceção à regra "sem ctx": `scheduleAudioTranscription` (fim do arquivo) é o
 * PONTO ÚNICO que agenda a transcrição de nota de voz, em qualquer direção.
 * A decisão continua pura (`shouldScheduleAudioTranscription`).
 */

import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { orgAiActive } from "./agentSecurity";
import { isPdfCandidate, PDF_READ_MAX_BYTES, pdfLabelName } from "./pdfRead";

type OrgDoc = Doc<"organizations"> | null;
type ChannelConfigDoc = Doc<"channelConfigs"> | null;

/**
 * O atendente da org está de fato no ar? (IA ligada + aceite LGPD + toggle do
 * atendente não desligado). `attendantEnabled === undefined` significa LIGADO —
 * compat com orgs que ativaram a IA antes de o toggle existir.
 */
export function attendantActive(org: OrgDoc): boolean {
  if (!orgAiActive(org)) return false;
  return org!.settings.aiConfig?.attendantEnabled !== false;
}

/**
 * Transcrever esta nota de voz? Disjunção: toggle do canal OU atendente ativo
 * (ele precisa ouvir para responder ao que foi dito).
 */
export function shouldTranscribeAudio(org: OrgDoc, channelConfig: ChannelConfigDoc): boolean {
  return channelConfig?.autoTranscribeAudio === true || attendantActive(org);
}

/**
 * A org tem o passe de visão ligado? É o gate INTEIRO da visão — o mesmo valor
 * decide se a imagem é descrita no ingest, se o CTA manual do inbox funciona, se
 * o claim do atendente espera pela descrição e se ela aparece no histórico.
 *
 * `visionEnabled` ausente = DESLIGADO (default do produto). Com ele off nenhuma
 * chamada é feita e o histórico do atendente volta a mostrar "[imagem]" cru —
 * comportamento byte-a-byte o de antes da visão existir.
 */
export function visionEnabledForOrg(org: OrgDoc): boolean {
  return orgAiActive(org) && org!.settings.aiConfig?.visionEnabled === true;
}

/** Alias explícito para o ponto de ingest — mesma decisão, nome que lê melhor lá. */
export function shouldDescribeImage(org: OrgDoc): boolean {
  return visionEnabledForOrg(org);
}

/**
 * Figurinha não é descrita (D11): colapsa em `contentType: "image"` mas é ruído
 * de alto volume — pagar visão por cada figurinha enviada seria absurdo. Os dois
 * transportes marcam o tipo original no metadata (bridgeParse / whatsappParse).
 */
export function isSticker(metadata: Record<string, unknown> | undefined): boolean {
  return (
    metadata?.bridgeType === "sticker" ||
    metadata?.whatsappType === "sticker" ||
    // Instagram/Messenger (F2): curtida e sticker nunca vão para a visão.
    metadata?.metaType === "like_heart" ||
    metadata?.metaType === "sticker"
  );
}

/** Marcador de mensagem vinda da importação de histórico do bridge. */
export const IMPORTED_FROM_HISTORY_KEY = "importedFromHistory";

/**
 * Agendar a transcrição desta mensagem? Só nota de voz com anexo, que não seja
 * nota interna nem mensagem importada do histórico do aparelho (dias de áudio
 * velho num lote só lotariam o Whisper sem servir ao atendente). Vale para o
 * áudio do CLIENTE e o do TIME (inbox, REST/MCP, celular pareado): o gate de
 * produto — toggle do canal OU atendente ativo — é decidido depois, dentro de
 * `transcription.autoTranscribe`, e cobre os dois sentidos.
 */
export function shouldScheduleAudioTranscription(args: {
  contentType: string | undefined;
  attachments: readonly unknown[] | undefined;
  isInternal?: boolean;
  metadata?: Record<string, unknown> | undefined;
}): boolean {
  if (args.contentType !== "audio") return false;
  if (!args.attachments || args.attachments.length === 0) return false;
  if (args.isInternal === true) return false;
  if (args.metadata?.[IMPORTED_FROM_HISTORY_KEY] === true) return false;
  return true;
}

/**
 * Ponto único de agendamento da transcrição automática. No-op quando
 * `shouldScheduleAudioTranscription` recusa; o gate de org/canal fica na action.
 */
export async function scheduleAudioTranscription(
  ctx: MutationCtx,
  args: {
    messageId: Id<"messages">;
    contentType: string | undefined;
    attachments: readonly unknown[] | undefined;
    isInternal?: boolean;
    metadata?: Record<string, unknown> | undefined;
  }
): Promise<boolean> {
  if (!shouldScheduleAudioTranscription(args)) return false;
  await ctx.scheduler.runAfter(0, internal.transcription.autoTranscribe, {
    messageId: args.messageId,
  });
  return true;
}

/**
 * Ponto único de agendamento da LEITURA DE PDF (texto, sem LLM): chamado pelos
 * ingests de mensagem com anexo, nos dois sentidos (a equipe mandar uma tabela
 * de preços também vale: a IA passa a saber o que foi enviado; nunca acorda a
 * IA). Gate de produto: `attendantActive(org)` — extrair texto não custa
 * modelo, então não depende de `visionEnabled` (opt-in pago); só o ramo do PDF
 * escaneado exige a visão, decidido na action. Só agenda para PDF por mime/nome
 * (os bytes `%PDF-` a action confere) e grava `metadata.docRead.status:"pending"`
 * NA MESMA transação, para o claim do atendente esperar a leitura (nunca
 * esperar por arquivo que não será lido). Arquivo acima do teto vira `failed`
 * `TOO_LARGE` direto, sem action.
 */
export async function schedulePdfRead(
  ctx: MutationCtx,
  args: {
    messageId: Id<"messages">;
    contentType: string | undefined;
    attachments: readonly Id<"files">[] | undefined;
    isInternal?: boolean;
    metadata?: Record<string, unknown> | undefined;
  }
): Promise<boolean> {
  if (args.contentType !== "file" || !args.attachments || args.attachments.length === 0) return false;
  if (args.isInternal === true) return false;
  if (args.metadata?.[IMPORTED_FROM_HISTORY_KEY] === true || args.metadata?.mediaDeferred) return false;
  const file = await ctx.db.get(args.attachments[0]);
  if (!file || !isPdfCandidate(file.mimeType, file.name)) return false;
  const org = await ctx.db.get(file.organizationId);
  if (!attendantActive(org)) return false;
  const message = await ctx.db.get(args.messageId);
  if (!message || message.organizationId !== file.organizationId) return false;
  if (message.metadata?.docRead) return false;
  const now = Date.now();
  const fileName = pdfLabelName(file.name);
  if (file.size > PDF_READ_MAX_BYTES) {
    await ctx.db.patch(message._id, {
      metadata: { ...(message.metadata ?? {}), docRead: { status: "failed", at: now, kind: "pdf", fileName, error: "TOO_LARGE" } },
    });
    return false;
  }
  await ctx.db.patch(message._id, {
    metadata: { ...(message.metadata ?? {}), docRead: { status: "pending", at: now, kind: "pdf", fileName } },
  });
  await ctx.scheduler.runAfter(0, internal.pdfRead.internalReadPdf, { messageId: message._id });
  return true;
}
