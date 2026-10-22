/**
 * Matriz de capacidades por canal/transporte (Meta Messaging, plano §8).
 * Pura: substitui o antigo `channelIsWhatsapp` espalhado pelo inbox.
 */

export type CapabilityFeature =
  | "deliveryTicks"
  | "reactionsReceive"
  | "reactionsSend"
  | "replyQuote"
  | "forward"
  | "voiceRecorder"
  | "serviceWindow"
  | "templates"
  | "newConversation"
  | "aiAttendant"
  | "typingIndicator"
  | "mediaSend";

export type TicksMode = "full" | "read" | false;

export interface TextCounter {
  unit: "bytes" | "chars";
  max: number;
  /** Tamanho de cada parte quando o backend divide (Messenger: 1900, igual ao backend). */
  part: number;
}

type Row = Record<CapabilityFeature, boolean | TicksMode>;

const NONE: Row = {
  deliveryTicks: false,
  reactionsReceive: false,
  reactionsSend: false,
  replyQuote: false,
  forward: false,
  voiceRecorder: false,
  serviceWindow: false,
  templates: false,
  newConversation: false,
  aiAttendant: false,
  typingIndicator: false,
  mediaSend: false,
};

const WHATSAPP_BRIDGE: Row = {
  deliveryTicks: "full",
  reactionsReceive: true,
  reactionsSend: true,
  replyQuote: true,
  forward: true,
  voiceRecorder: true,
  serviceWindow: false,
  templates: true,
  newConversation: true,
  aiAttendant: true,
  typingIndicator: true,
  mediaSend: true,
};

const WHATSAPP_META: Row = {
  ...WHATSAPP_BRIDGE,
  serviceWindow: true,
  // O backend (`sendTypingState`) já é no-op fora do bridge; manter o envio
  // preserva o comportamento atual do WhatsApp.
  typingIndicator: true,
};

const INSTAGRAM: Row = {
  deliveryTicks: "read",
  reactionsReceive: true,
  reactionsSend: false,
  replyQuote: true,
  forward: true,
  voiceRecorder: false,
  serviceWindow: true,
  templates: false,
  newConversation: false,
  // F3: o atendente de IA ainda não responde por Instagram/Messenger.
  aiAttendant: false,
  typingIndicator: false,
  // F2: envio de anexo por Instagram/Messenger.
  mediaSend: false,
};

const MESSENGER: Row = {
  ...INSTAGRAM,
  deliveryTicks: "full",
  replyQuote: false,
};

function rowFor(channel: string | null | undefined, transport?: string | null): Row {
  switch (channel) {
    case "whatsapp":
      // Transporte desconhecido/ausente cai no comportamento histórico (sem
      // janela, com digitando), que é o que `channelIsWhatsapp` fazia.
      return transport === "meta" ? WHATSAPP_META : WHATSAPP_BRIDGE;
    case "instagram":
      return INSTAGRAM;
    case "messenger":
      return MESSENGER;
    default:
      return NONE;
  }
}

/** A feature existe neste canal? (`deliveryTicks` "read"/"full" contam como sim.) */
export function channelSupports(
  channel: string | null | undefined,
  transport: string | null | undefined,
  feature: CapabilityFeature
): boolean {
  return !!rowFor(channel, transport)[feature];
}

/**
 * Anexo desligado só onde o canal é conhecido e ainda não envia mídia (F2:
 * Instagram/Messenger). Canais fora da matriz mantêm o comportamento de antes.
 */
export function mediaSendBlocked(
  channel: string | null | undefined,
  transport?: string | null
): boolean {
  return (channel === "instagram" || channel === "messenger") && !channelSupports(channel, transport, "mediaSend");
}

export const MEDIA_BLOCKED_HINT = "Anexos por Instagram/Messenger chegam na próxima versão";

export function deliveryTicksMode(
  channel: string | null | undefined,
  transport?: string | null
): TicksMode {
  return rowFor(channel, transport).deliveryTicks as TicksMode;
}

/** Limite de texto do canal, ou null quando não há contador. */
export function textLimitFor(
  channel: string | null | undefined,
  _transport?: string | null
): TextCounter | null {
  if (channel === "instagram") return { unit: "bytes", max: 1000, part: 1000 };
  if (channel === "messenger") return { unit: "chars", max: 2000, part: 1900 };
  return null;
}

/** Tamanho do texto na unidade do limite. Bytes = UTF-8. */
export function measureText(text: string, unit: TextCounter["unit"]): number {
  return unit === "bytes" ? new TextEncoder().encode(text).length : Array.from(text).length;
}

/** Quantas partes o backend vai enviar (>= 1). */
export function textPartsCount(text: string, limit: TextCounter): number {
  const size = measureText(text, limit.unit);
  return Math.max(1, Math.ceil(size / limit.part));
}

/** O texto passa do tamanho de uma parte (avisa a partir daí: 1900 chars / 1000 bytes). */
export function textNeedsSplit(text: string, limit: TextCounter): boolean {
  return measureText(text, limit.unit) > limit.part;
}

/** "812 / 1000 bytes" ou "1.230 / 2000". */
export function formatTextCounter(size: number, limit: TextCounter): string {
  const n = size.toLocaleString("pt-BR");
  const max = String(limit.max);
  return limit.unit === "bytes" ? `${n} / ${max} bytes` : `${n} / ${max}`;
}
