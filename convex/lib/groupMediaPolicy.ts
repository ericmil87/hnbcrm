/**
 * Política de download de mídia em grupos de WhatsApp (v0.62) — núcleo PURO.
 *
 * Um grupo local de compra e venda manda dezenas de fotos por hora. Baixar
 * todas enchia o File Storage da org e ainda agendava transcrição/visão (custo
 * de LLM) de cada uma. Agora cada tipo de mídia tem um modo, decidido ANTES do
 * download:
 *
 *  - `all`      — baixa sempre (o comportamento da v0.57);
 *  - `mentions` — DEFAULT: baixa só o que é "com a gente" (menção ao nosso
 *                 número, resposta a mensagem nossa, palavra-chave da IA do
 *                 grupo, ou mensagem que NÓS mandamos pelo celular);
 *  - `off`      — nunca baixa sozinho.
 *
 * O que não é baixado fica disponível sob demanda por 14 dias
 * (`deferredGroupMedia`). Figurinha nunca baixa automático — é ruído puro de
 * alto volume — mas pode ser baixada sob demanda.
 *
 * Sem `ctx`, sem banco: o front importa daqui para mostrar o default igual ao
 * servidor, e os testes exercitam cada combinação sem convex-test.
 */

import { shouldTriggerGroupAgent } from "./groupAgentCore";

export type GroupMediaMode = "all" | "mentions" | "off";
export type GroupMediaKind = "image" | "audio" | "video" | "document";
export type GroupMediaOverrideMode = "inherit" | GroupMediaMode;

export const GROUP_MEDIA_KINDS: readonly GroupMediaKind[] = ["image", "audio", "video", "document"];
export const GROUP_MEDIA_MODES: readonly GroupMediaMode[] = ["all", "mentions", "off"];
export const GROUP_MEDIA_DEFAULT_MODE: GroupMediaMode = "mentions";

/**
 * Quanto tempo a mídia não baixada continua disponível sob demanda. A CDN do
 * WhatsApp não guarda o blob para sempre; depois disso o descriptor cifrado é
 * apagado e a mensagem passa a dizer "não está mais disponível".
 */
export const GROUP_MEDIA_DEFERRED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Padrão do NÚMERO (`channelConfigs.bridgeGroupMedia`) — campo ausente = default. */
export type GroupMediaDefaults = Partial<Record<GroupMediaKind, GroupMediaMode>>;
/** Override do GRUPO (`groupChats.mediaPolicy`) — campo ausente = "inherit". */
export type GroupMediaOverride = Partial<Record<GroupMediaKind, GroupMediaOverrideMode>>;

export function isGroupMediaMode(value: unknown): value is GroupMediaMode {
  return typeof value === "string" && (GROUP_MEDIA_MODES as readonly string[]).includes(value);
}

/** Modo efetivo de UM tipo: override do grupo > padrão do número > default. */
export function resolveGroupMediaMode(
  kind: GroupMediaKind,
  numberDefault?: GroupMediaDefaults | null,
  groupOverride?: GroupMediaOverride | null
): GroupMediaMode {
  const override = groupOverride?.[kind];
  if (isGroupMediaMode(override)) return override;
  const fromNumber = numberDefault?.[kind];
  if (isGroupMediaMode(fromNumber)) return fromNumber;
  return GROUP_MEDIA_DEFAULT_MODE;
}

/** Os quatro modos do NÚMERO, com o default aplicado. */
export function resolveNumberGroupMedia(
  numberDefault?: GroupMediaDefaults | null
): Record<GroupMediaKind, GroupMediaMode> {
  return {
    image: resolveGroupMediaMode("image", numberDefault),
    audio: resolveGroupMediaMode("audio", numberDefault),
    video: resolveGroupMediaMode("video", numberDefault),
    document: resolveGroupMediaMode("document", numberDefault),
  };
}

/** Os quatro modos efetivos de um GRUPO (override resolvido contra o número). */
export function resolveEffectiveGroupMedia(
  numberDefault?: GroupMediaDefaults | null,
  groupOverride?: GroupMediaOverride | null
): Record<GroupMediaKind, GroupMediaMode> {
  return {
    image: resolveGroupMediaMode("image", numberDefault, groupOverride),
    audio: resolveGroupMediaMode("audio", numberDefault, groupOverride),
    video: resolveGroupMediaMode("video", numberDefault, groupOverride),
    document: resolveGroupMediaMode("document", numberDefault, groupOverride),
  };
}

/** O override do grupo com o sentinela `"inherit"` preenchido (forma da UI). */
export function fillGroupMediaOverride(
  groupOverride?: GroupMediaOverride | null
): Record<GroupMediaKind, GroupMediaOverrideMode> {
  const pick = (kind: GroupMediaKind): GroupMediaOverrideMode => {
    const value = groupOverride?.[kind];
    return isGroupMediaMode(value) ? value : "inherit";
  };
  return { image: pick("image"), audio: pick("audio"), video: pick("video"), document: pick("document") };
}

/**
 * Tipo da política a partir do `media.kind` do parser (`lib/bridgeParse.ts`:
 * image | sticker | audio | video | document) com fallback no `contentType`
 * da mensagem. Nota de voz (ptt) é `audio`. `null` = mensagem sem mídia.
 */
export function groupMediaKindOf(
  mediaKind: string | undefined,
  contentType?: "text" | "image" | "file" | "audio"
): GroupMediaKind | "sticker" | null {
  switch (mediaKind) {
    case "sticker":
      return "sticker";
    case "image":
      return "image";
    case "audio":
    case "ptt":
      return "audio";
    case "video":
      return "video";
    case "document":
      return "document";
  }
  if (contentType === "image") return "image";
  if (contentType === "audio") return "audio";
  if (contentType === "file") return "document";
  return mediaKind ? "document" : null;
}

export type GroupDirectedInput = {
  /** Mensagem que saiu do NOSSO número (app do celular). */
  fromMe: boolean;
  content: string;
  mentions?: string[];
  quotedParticipantJid?: string;
  ourLid?: string;
  ourPhone?: string;
  /** `groupChats.ai.mode` — palavra-chave só conta com a IA do grupo ligada. */
  aiMode?: "off" | "mention";
  aiKeywords?: string[];
};

/**
 * A mensagem é "com a gente"? Reusa o gatilho do agente de grupo — menção
 * formal, resposta a mensagem nossa, nosso número digitado e palavra-chave —
 * para as duas regras nunca divergirem: se a IA foi chamada, ela precisa
 * conseguir ler a mídia. Palavra-chave só vale com a IA do grupo ligada
 * (é gatilho do agente, não alerta).
 */
export function isGroupMessageDirectedToUs(input: GroupDirectedInput): boolean {
  if (input.fromMe) return true;
  const trigger = shouldTriggerGroupAgent({
    mode: "mention",
    keywords: input.aiMode !== "off" ? input.aiKeywords : undefined,
    content: input.content,
    mentions: input.mentions,
    quotedParticipantJid: input.quotedParticipantJid,
    ourLid: input.ourLid,
    ourPhone: input.ourPhone,
  });
  return trigger.trigger;
}

export type GroupMediaDecisionReason = "all" | "directed" | "not_directed" | "off" | "sticker";

export type GroupMediaDecision = {
  download: boolean;
  reason: GroupMediaDecisionReason;
  /** Tipo resolvido (útil para o `metadata.mediaDeferred.kind`). */
  kind: GroupMediaKind | "sticker";
};

/** Baixar AGORA esta mídia de grupo? Decisão tomada antes de qualquer byte. */
export function shouldAutoDownloadGroupMedia(
  input: GroupDirectedInput & {
    mediaKind: string | undefined;
    contentType?: "text" | "image" | "file" | "audio";
    numberDefault?: GroupMediaDefaults | null;
    groupOverride?: GroupMediaOverride | null;
  }
): GroupMediaDecision {
  const kind = groupMediaKindOf(input.mediaKind, input.contentType) ?? "document";
  if (kind === "sticker") return { download: false, reason: "sticker", kind };
  const mode = resolveGroupMediaMode(kind, input.numberDefault, input.groupOverride);
  if (mode === "all") return { download: true, reason: "all", kind };
  if (mode === "off") return { download: false, reason: "off", kind };
  return isGroupMessageDirectedToUs(input)
    ? { download: true, reason: "directed", kind }
    : { download: false, reason: "not_directed", kind };
}
