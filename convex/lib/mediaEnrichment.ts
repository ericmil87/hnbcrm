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
  return metadata?.bridgeType === "sticker" || metadata?.whatsappType === "sticker";
}
