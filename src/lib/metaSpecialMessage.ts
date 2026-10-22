// Mensagens do Instagram/Messenger que não são texto/mídia comum (Meta Messaging F2).
// Puro: descreve o que mostrar a partir de `metadata`; quem desenha é MetaSpecialCard.

type Meta = Record<string, any> | null | undefined;

export type MetaCardKind = "story_mention" | "ig_post" | "ig_reel" | "like_heart" | "sticker" | "fallback";
export type MetaCardIcon = "story" | "post" | "reel" | "heart" | "sticker" | "link";

export interface MetaCardInfo {
  kind: MetaCardKind;
  icon: MetaCardIcon;
  title: string;
  /** Título do conteúdo compartilhado (post, reel, link). */
  subtitle?: string;
  action?: { label: string; href: string };
  /** Story mencionado: sem anexo disponível mostra "Story expirado". */
  expiredFallback?: string;
}

const CARD_KINDS: readonly string[] = ["story_mention", "ig_post", "ig_reel", "like_heart", "sticker", "fallback"];
const MAX_HISTORY = 5;

/** Só http(s): o link vem de terceiros e vai para um href. */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function text(v: unknown, max = 200): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

export function metaTypeOf(metadata: Meta): string | null {
  const t = metadata?.metaType;
  return typeof t === "string" ? t : null;
}

export function describeMetaCard(metadata: Meta): MetaCardInfo | null {
  const t = metaTypeOf(metadata);
  if (!t || !CARD_KINDS.includes(t)) return null;
  const link = metadata?.metaLink;
  const href = safeExternalUrl(link?.url);
  const linkTitle = text(link?.title);
  switch (t) {
    case "story_mention":
      return { kind: "story_mention", icon: "story", title: "Mencionou você em um story", expiredFallback: "Story expirado" };
    case "ig_post":
      return {
        kind: "ig_post",
        icon: "post",
        title: "Compartilhou um post",
        subtitle: linkTitle,
        action: href ? { label: "Abrir no Instagram", href } : undefined,
      };
    case "ig_reel":
      return {
        kind: "ig_reel",
        icon: "reel",
        title: "Compartilhou um reel",
        subtitle: linkTitle,
        action: href ? { label: "Abrir no Instagram", href } : undefined,
      };
    case "like_heart":
      return { kind: "like_heart", icon: "heart", title: "Curtiu" };
    case "sticker":
      return { kind: "sticker", icon: "sticker", title: "Sticker" };
    default:
      return {
        kind: "fallback",
        icon: "link",
        title: linkTitle ?? "Conteúdo compartilhado",
        action: href ? { label: "Abrir link", href } : undefined,
      };
  }
}

export interface StoryReplyInfo {
  href: string | null;
}

export function describeStoryReply(metadata: Meta): StoryReplyInfo | null {
  const sr = metadata?.storyReply;
  if (!sr || typeof sr !== "object") return null;
  return { href: safeExternalUrl(sr.url) };
}

const UNAVAILABLE_REASONS: Record<string, string> = {
  expired: "expirou antes de baixar",
  mime: "formato não suportado",
  quota: "limite de armazenamento atingido",
  too_large: "arquivo grande demais",
};

/** Texto do placeholder, ou null se a mídia está disponível. */
export function mediaUnavailableLabel(metadata: Meta): string | null {
  const v = metadata?.mediaUnavailable;
  if (!v) return null;
  const reason = typeof v === "string" ? UNAVAILABLE_REASONS[v] : undefined;
  return reason ? `Mídia indisponível (${reason})` : "Mídia indisponível";
}

export function isDeletedByCustomer(metadata: Meta): boolean {
  return metadata?.deletedByCustomer === true;
}

export const DELETED_BY_CUSTOMER_LABEL = "Mensagem apagada pelo cliente";

/** Até 5 versões anteriores, na ordem em que o backend grava. */
export function editHistoryOf(metadata: Meta): string[] {
  const h = metadata?.editHistory;
  if (!Array.isArray(h)) return [];
  return h.filter((x): x is string => typeof x === "string" && x.length > 0).slice(-MAX_HISTORY);
}

export function reactionNoteOf(metadata: Meta): string | null {
  return text(metadata?.reactionNote, 200) ?? null;
}
