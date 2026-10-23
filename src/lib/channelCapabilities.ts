import { ALLOWED_MIME_TYPES, getMaxFileSize } from "../../convex/lib/fileValidation";

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
  // Instagram aceita só o coração; Messenger sobrescreve para false.
  reactionsSend: true,
  replyQuote: true,
  forward: true,
  voiceRecorder: false,
  serviceWindow: true,
  templates: false,
  newConversation: false,
  aiAttendant: true,
  typingIndicator: true,
  // F2: envio de anexo por Instagram/Messenger.
  mediaSend: true,
};

const MESSENGER: Row = {
  ...INSTAGRAM,
  deliveryTicks: "full",
  replyQuote: false,
  // Messenger não tem API de reação: só chips locais com a nota do backend.
  reactionsSend: false,
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

export const MEDIA_BLOCKED_HINT = "Este canal ainda não aceita anexos";

/** Emojis que o picker oferece neste canal; null = todos (WhatsApp). Vazio = sem envio. */
export function allowedReactionEmojis(
  channel: string | null | undefined,
  transport?: string | null
): string[] | null {
  if (!channelSupports(channel, transport, "reactionsSend")) return [];
  if (channel === "instagram") return ["❤️"];
  return null;
}

export const INSTAGRAM_REACTION_HINT = "O Instagram aceita só ❤️";

const MB = 1024 * 1024;

// O upload passa por `files.saveFile` (convex/lib/fileValidation.ts): vale a
// INTERSEÇÃO entre a allowlist humana e o que a Meta aceita, com o MENOR teto.
const HUMAN_MIMES: string[] = [
  ...Object.keys(ALLOWED_MIME_TYPES.images),
  ...Object.keys(ALLOWED_MIME_TYPES.documents),
  ...Object.keys(ALLOWED_MIME_TYPES.text),
  ...Object.keys(ALLOWED_MIME_TYPES.audio),
  ...Object.keys(ALLOWED_MIME_TYPES.video),
];

// Instagram: imagem png/jpeg, áudio aac/m4a/wav/mp4, vídeo mp4/mov/webm/avi/ogg, PDF.
const INSTAGRAM_META_MIMES = [
  "image/png",
  "image/jpeg",
  "audio/aac",
  "audio/x-m4a",
  "audio/m4a",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/avi",
  "video/ogg",
  "application/pdf",
];

function baseMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

/** Mimes que o canal aceita no anexo; null = sem filtro próprio (lista padrão do botão). */
export function acceptedUploadMimes(
  channel: string | null | undefined,
  _transport?: string | null
): string[] | null {
  if (channel === "instagram") return INSTAGRAM_META_MIMES.filter((m) => HUMAN_MIMES.includes(m));
  // Messenger aceita imagem, áudio, vídeo e arquivo: vale a allowlist humana.
  if (channel === "messenger") return HUMAN_MIMES;
  return null;
}

/** Limite de bytes do anexo neste canal, ou null quando não há limite próprio. */
export function maxUploadBytes(
  channel: string | null | undefined,
  _transport: string | null | undefined,
  mime: string
): number | null {
  const metaCap = channel === "instagram" ? (isImage(mime) ? 8 * MB : 25 * MB) : channel === "messenger" ? 25 * MB : null;
  if (metaCap === null) return null;
  const human = getMaxFileSize(mime);
  return human === null ? metaCap : Math.min(metaCap, human);
}

function isImage(mime: string): boolean {
  return baseMime(mime).startsWith("image/");
}

export const UPLOAD_RULES_HINT: Record<string, string> = {
  instagram: "Instagram: PNG/JPEG até 8 MB, áudio MP4/WAV até 10 MB, vídeo MP4 até 16 MB, PDF até 20 MB",
  messenger: "Messenger: imagem, áudio, vídeo e arquivo nos formatos do CRM, com os mesmos tetos (10 a 20 MB, vídeo 16 MB)",
};

/** Valida um arquivo contra as regras do canal. Retorna a mensagem de erro (PT-BR) ou null. */
export function validateUpload(
  channel: string | null | undefined,
  transport: string | null | undefined,
  file: { name: string; type: string; size: number }
): string | null {
  const accepted = acceptedUploadMimes(channel, transport);
  const hint = UPLOAD_RULES_HINT[channel ?? ""] ?? "";
  if (accepted && !accepted.includes(baseMime(file.type))) {
    return `${file.name}: formato não aceito. ${hint}`;
  }
  const max = maxUploadBytes(channel, transport, file.type);
  if (max !== null && file.size > max) {
    return `${file.name}: passa do limite de ${Math.round(max / MB)} MB. ${hint}`;
  }
  return null;
}

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
