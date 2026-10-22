/**
 * Entrada Meta Messaging (F2), pura: monta conteúdo/metadata de uma mensagem
 * com anexos, reações, edição e "apagada pelo cliente". Sem ctx, sem rede; o
 * download e as mutations vivem em `metaMessaging.ts`.
 *
 * D7: a mídia é baixada PRIMEIRO (as URLs da Meta expiram), mas a mensagem
 * nunca se perde: download que falha vira mensagem sem anexo com
 * `metadata.mediaUnavailable`.
 */
import type { MetaAttachment } from "./metaMessagingParse";

export const META_MEDIA_MAX_BYTES = 25 * 1024 * 1024; // mesmo teto do WhatsApp
export const META_MEDIA_TIMEOUT_MS = 15_000;
export const META_MAX_ATTACHMENTS = 10;
/** Códigos estáveis de `metadata.mediaUnavailable` (a frase humana vai em `mediaUnavailableDetail`). */
export type MediaUnavailableCode = "expired" | "too_large" | "mime" | "quota" | "error";
export const MEDIA_TOO_LARGE_DETAIL = "arquivo grande demais (limite de 25 MB)";
export const DELETED_BY_CUSTOMER_COPY = "Mensagem apagada pelo cliente";
export const EDIT_HISTORY_MAX = 5;
export const EDIT_PREVIOUS_MAX_CHARS = 2000;
export const EDIT_CONTENT_MAX_CHARS = 65536;

export const PLACEHOLDER_BY_TYPE: Record<MetaAttachment["type"], string> = {
  image: "[imagem]",
  video: "[vídeo]",
  audio: "[áudio]",
  file: "[arquivo]",
  story_mention: "[menção em story]",
  ig_post: "[post]",
  ig_reel: "[reel]",
  like_heart: "[curtiu]",
  sticker: "[sticker]",
  fallback: "[anexo]",
  other: "[anexo]",
};

const DOWNLOADABLE = new Set<MetaAttachment["type"]>(["image", "video", "audio", "file", "story_mention"]);

/** Baixa só mídia de verdade, por https (a assinatura do webhook já foi verificada). */
export function isDownloadable(att: MetaAttachment): boolean {
  if (!DOWNLOADABLE.has(att.type) || !att.url) return false;
  try {
    return new URL(att.url).protocol === "https:";
  } catch {
    return false;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4a: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
};
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
};

function baseMime(m: string | null | undefined): string {
  return (m ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Mime do arquivo baixado: cabeçalho `Content-Type`; se vier vazio ou genérico,
 * a extensão da URL; por último o tipo do anexo (imagem/áudio/vídeo). Arquivo
 * sem pista fica `application/octet-stream` e a allowlist o recusa.
 */
export function resolveMime(header: string | null | undefined, att: MetaAttachment): string {
  const h = baseMime(header);
  if (h && h !== "application/octet-stream" && h !== "binary/octet-stream") return h;
  try {
    const ext = new URL(att.url ?? "").pathname.split(".").pop()?.toLowerCase() ?? "";
    if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  } catch {
    // URL ruim: cai no tipo
  }
  if (att.type === "image" || att.type === "story_mention") return "image/jpeg";
  if (att.type === "audio") return "audio/mp4";
  if (att.type === "video") return "video/mp4";
  return "application/octet-stream";
}

export function fileNameFor(surface: string, att: MetaAttachment, mime: string, index: number): string {
  const ext = EXT_BY_MIME[baseMime(mime)] ?? "bin";
  return `${surface}-${att.type.replace("_", "-")}-${index + 1}.${ext}`;
}

export type MediaOutcome =
  | { kind: "saved"; fileId: string; mime: string }
  | { kind: "unavailable"; code: MediaUnavailableCode; detail?: string };

export type ComposedInbound = {
  content: string;
  contentType: "text" | "image" | "file" | "audio";
  metadata: Record<string, unknown>;
  /** Índices (em `attachments`) cujo arquivo foi salvo, na ordem. */
  savedIndexes: number[];
};

function contentTypeFor(att: MetaAttachment, mime: string): "image" | "file" | "audio" {
  if (att.type === "image") return "image";
  if (att.type === "audio") return "audio";
  if (att.type === "story_mention") return baseMime(mime).startsWith("image/") ? "image" : "file";
  return "file"; // vídeo (o front escolhe o player pelo mime) e arquivo
}

/**
 * Junta texto + anexos + resultado dos downloads (`outcomes[i]` = undefined
 * para o que não se baixa: post, reel, curtida, sticker, fallback).
 * Legenda/texto manda no `content`; sem texto, placeholder em PT-BR.
 */
export function composeInbound(
  text: string,
  attachments: MetaAttachment[],
  outcomes: Array<MediaOutcome | undefined>
): ComposedInbound {
  const first = attachments[0];
  const metadata: Record<string, unknown> = {};
  const savedIndexes: number[] = [];
  const unavailable: MetaAttachment[] = [];
  let unavailable1: Extract<MediaOutcome, { kind: "unavailable" }> | undefined;
  let contentType: ComposedInbound["contentType"] = "text";

  attachments.forEach((att, i) => {
    const out = outcomes[i];
    if (out?.kind === "saved") {
      savedIndexes.push(i);
      if (contentType === "text") contentType = contentTypeFor(att, out.mime);
    } else if (out?.kind === "unavailable") {
      unavailable.push(att);
      unavailable1 ??= out;
    }
  });

  metadata.metaType = first ? first.type : "text";
  const link = attachments.find(
    (a) => (a.type === "ig_post" || a.type === "ig_reel" || a.type === "fallback") && (a.url || a.title)
  );
  if (link) {
    metadata.metaLink = { ...(link.url ? { url: link.url } : {}), ...(link.title ? { title: link.title } : {}) };
  }
  if (unavailable1) {
    metadata.mediaUnavailable = unavailable1.code;
    if (unavailable1.detail) metadata.mediaUnavailableDetail = unavailable1.detail;
    // Para o reprocessamento (F4/ops): só o que não foi baixado.
    metadata.metaAttachments = unavailable;
  }

  let content = text;
  if (!content && first) {
    if (first.type === "fallback") {
      content = [first.title, first.url].filter(Boolean).join("\n") || PLACEHOLDER_BY_TYPE.fallback;
    } else {
      content = PLACEHOLDER_BY_TYPE[first.type];
    }
  }
  return { content, contentType, metadata, savedIndexes };
}

// ── Reações ──

export type StoredReactionLike = { emoji: string; sender: string; senderName?: string; at: number };

const EMOJI_BY_REACTION: Record<string, string> = {
  love: "❤️",
  like: "👍",
  haha: "😂",
  wow: "😮",
  sad: "😢",
  angry: "😡",
};

/** Emoji de uma reação de entrada: o do evento; senão o nome (`love` → ❤️); desconhecido = null. */
export function reactionEmoji(ev: { emoji?: string; reaction?: string }): string | null {
  if (ev.emoji && ev.emoji.trim()) return ev.emoji.trim();
  const name = ev.reaction?.trim().toLowerCase();
  return name ? (EMOJI_BY_REACTION[name] ?? null) : null;
}

/** Mesmo formato do WhatsApp: uma entrada por `sender`; `emoji` vazio remove. */
export function nextReactions(
  prior: unknown,
  change: { sender: string; emoji: string; at: number; senderName?: string }
): StoredReactionLike[] {
  const list = Array.isArray(prior) ? (prior as StoredReactionLike[]) : [];
  const without = list.filter((r) => r && r.sender !== change.sender);
  if (!change.emoji) return without;
  return [
    ...without,
    {
      emoji: change.emoji,
      sender: change.sender,
      ...(change.senderName ? { senderName: change.senderName } : {}),
      at: change.at,
    },
  ];
}

// ── Edição e apagada ──

export type EditVersion = { content: string; at: number };

/** Acrescenta a versão anterior ao histórico e mantém as últimas `EDIT_HISTORY_MAX`. */
export function appendEditHistory(prior: unknown, previous: string, at: number): EditVersion[] {
  const list = Array.isArray(prior) ? (prior as EditVersion[]) : [];
  const next = [...list, { content: previous.slice(0, EDIT_PREVIOUS_MAX_CHARS), at }];
  return next.slice(-EDIT_HISTORY_MAX);
}

/** Chaves que sobrevivem à "apagada pelo cliente": nada que guarde o texto ou a mídia. */
const KEEP_ON_DELETE = ["reactions", "replyToMid", "standby", "referral"] as const;

export function scrubbedDeletedMetadata(
  metadata: Record<string, unknown> | undefined,
  at: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEEP_ON_DELETE) if (metadata?.[k] !== undefined) out[k] = metadata[k];
  out.deletedByCustomer = true;
  out.deletedAt = at;
  return out;
}
