/**
 * Gates COMPARTILHADOS dos dois pipelines de enriquecimento de mídia inbound:
 * transcrição de nota de voz (convex/transcription.ts) e passe de visão
 * (convex/vision.ts). Funções puras sobre os docs — sem ctx, sem db — para
 * ficarem testáveis e para os dois pipelines não divergirem.
 *
 * A assimetria entre os dois gates é DELIBERADA (D10 do plano de visão):
 *
 * - **Áudio** é uma DISJUNÇÃO: o Whisper é self-hosted e grátis, então basta o
 *   toggle do canal OU o atendente estar ativo (sem transcrição ele responderia
 *   "não consigo ouvir áudio").
 * - **Visão** é uma CONJUNÇÃO: cada imagem custa uma chamada paga a um provider
 *   externo e a imagem do cliente (que pode ser RG/CNH) sai da nossa infra.
 *   `aiConfig.visionEnabled === true` é obrigatório SEMPRE; o toggle do canal
 *   só serve para o humano querer a leitura no inbox com o atendente desligado.
 */

import { Doc } from "../_generated/dataModel";
import { orgAiActive } from "./agentSecurity";

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
 * Descrever esta imagem? Conjunção (D10):
 *
 *   orgAiActive && visionEnabled === true
 *   && ( autoDescribeImages === true || attendantEnabled !== false )
 *
 * `visionEnabled` ausente = DESLIGADO (default do produto). Com ele off nenhuma
 * chamada é feita, e o histórico do atendente volta a mostrar "[imagem]" cru —
 * comportamento byte-a-byte o de antes da visão existir.
 */
export function shouldDescribeImage(org: OrgDoc, channelConfig: ChannelConfigDoc): boolean {
  if (!orgAiActive(org)) return false;
  const aiConfig = org!.settings.aiConfig;
  if (aiConfig?.visionEnabled !== true) return false;
  return channelConfig?.autoDescribeImages === true || aiConfig.attendantEnabled !== false;
}

/**
 * A org tem o passe de visão ligado? Usado onde o canal não importa — o
 * formatador de histórico do atendente (que só decide COMO exibir o que já foi
 * gravado) e a espera do claim.
 */
export function visionEnabledForOrg(org: OrgDoc): boolean {
  return orgAiActive(org) && org!.settings.aiConfig?.visionEnabled === true;
}

/**
 * Figurinha não é descrita (D11): colapsa em `contentType: "image"` mas é ruído
 * de alto volume — pagar visão por cada figurinha enviada seria absurdo. Os dois
 * transportes marcam o tipo original no metadata (bridgeParse / whatsappParse).
 */
export function isSticker(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.bridgeType === "sticker" || metadata?.whatsappType === "sticker";
}
