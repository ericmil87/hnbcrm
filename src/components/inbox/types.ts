// Shared types + media helpers for the Inbox message rendering.
// The backend `getMessages` query returns `v.any()`, so we describe the
// fields we actually consume here rather than relying on generated types.

export interface InboxAttachmentFile {
  _id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string | null;
}

export interface InboxMessage {
  _id: string;
  conversationId: string;
  content: string;
  contentType?: "text" | "image" | "file" | "audio";
  direction: string;
  senderType: string;
  isInternal: boolean;
  createdAt: number;
  deliveryStatus?: "sent" | "delivered" | "read" | "failed";
  /** Espelho pesquisável da leitura da imagem (campo de topo, indexado). */
  imageDescription?: string;
  metadata?: Record<string, any>;
  attachmentFiles?: InboxAttachmentFile[];
  sender?: { name?: string | null } | null;
}

// Quoted (reply) context stored on a message's metadata by the backend.
export interface QuotedMeta {
  externalId?: string;
  participant?: string;
  preview?: string;
  messageId?: string;
  fromMe?: boolean;
}

// A single reaction. `sender` is "contact" for the remote party, otherwise a
// teamMembers id string.
export interface ReactionMeta {
  emoji: string;
  sender: string;
  senderName?: string;
  at: number;
}

export type TranscriptionStatus = "done" | "pending" | "failed" | "skipped";

export interface TranscriptionMeta {
  status: TranscriptionStatus;
  text?: string;
  language?: string;
  durationSec?: number;
  error?: string;
  at?: number;
}

export type VisionStatus = "done" | "pending" | "failed" | "skipped";

// Tipo de imagem reconhecido pelo passe de visão.
export type VisionKind =
  | "comprovante"
  | "documento"
  | "boleto"
  | "nota_fiscal"
  | "foto"
  | "print"
  | "outro";

// Campos estruturados extraídos de comprovantes/documentos. Cada chave vem
// como string ou null (o modelo devolve o objeto completo, com nulos).
export type VisionFields = Record<string, string | null>;

export interface VisionMeta {
  status: VisionStatus;
  text?: string;
  tipo?: VisionKind;
  fields?: VisionFields;
  model?: string;
  error?: string;
  at?: number;
}

export function getQuoted(message: InboxMessage): QuotedMeta | null {
  const q = message.metadata?.quoted;
  return q && typeof q === "object" ? (q as QuotedMeta) : null;
}

// The original message id a reply points at (string, matches InboxMessage._id).
export function getQuotedMessageId(message: InboxMessage): string | null {
  const fromQuoted = getQuoted(message)?.messageId;
  if (fromQuoted) return fromQuoted;
  const top = message.metadata?.quotedMessageId;
  return typeof top === "string" && top.length > 0 ? top : null;
}

export function getReactions(message: InboxMessage): ReactionMeta[] {
  const r = message.metadata?.reactions;
  if (!Array.isArray(r)) return [];
  return r.filter(
    (x): x is ReactionMeta => x && typeof x === "object" && typeof x.emoji === "string" && x.emoji.length > 0
  );
}

export function getTranscription(message: InboxMessage): TranscriptionMeta | null {
  const t = message.metadata?.transcription;
  return t && typeof t === "object" && typeof t.status === "string"
    ? (t as TranscriptionMeta)
    : null;
}

export function getVision(message: InboxMessage): VisionMeta | null {
  const vision = message.metadata?.vision;
  if (!vision || typeof vision !== "object" || typeof vision.status !== "string") return null;
  const meta = vision as VisionMeta;
  // A descrição canônica vive no campo de topo (indexado); metadata.vision.text
  // é o espelho. Preferimos o topo quando os dois existem.
  const text = typeof message.imageDescription === "string" && message.imageDescription.length > 0
    ? message.imageDescription
    : meta.text;
  return { ...meta, text };
}

// Grouped reactions for compact rendering: one entry per distinct emoji with a
// running count and the names behind it (for a hover title).
export interface GroupedReaction {
  emoji: string;
  count: number;
  names: string[];
  senders: string[];
}

export function groupReactions(reactions: ReactionMeta[]): GroupedReaction[] {
  const map = new Map<string, GroupedReaction>();
  for (const r of reactions) {
    const existing = map.get(r.emoji);
    const name = r.senderName || (r.sender === "contact" ? "Contato" : "Membro");
    if (existing) {
      existing.count += 1;
      existing.names.push(name);
      existing.senders.push(r.sender);
    } else {
      map.set(r.emoji, { emoji: r.emoji, count: 1, names: [name], senders: [r.sender] });
    }
  }
  return Array.from(map.values());
}

export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

export function isAudioMime(mimeType: string): boolean {
  return mimeType.startsWith("audio/");
}

export function isVideoMime(mimeType: string): boolean {
  return mimeType.startsWith("video/");
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A short bracketed token like "[imagem]" / "[mensagem de voz]" is a
// server-side placeholder for media whose real content lives in the
// attachment. We suppress it as bubble text when an attachment is present.
const PLACEHOLDER_RE = /^\[[^\]]{1,40}\]$/;

export function isMediaPlaceholder(content: string | undefined | null): boolean {
  if (!content) return false;
  return PLACEHOLDER_RE.test(content.trim());
}

// Voice notes: the unofficial bridge tags them as `bridgeType: "audio"`; the
// official Cloud API sends an audio mime with a "[mensagem de voz]" placeholder.
export function isVoiceNote(message: InboxMessage): boolean {
  if (message.metadata?.bridgeType === "audio") return true;
  const hasAudioAttachment = (message.attachmentFiles ?? []).some((f) =>
    isAudioMime(f.mimeType)
  );
  return hasAudioAttachment && isMediaPlaceholder(message.content);
}

export function isSticker(message: InboxMessage): boolean {
  return message.metadata?.bridgeType === "sticker";
}

// Imagem "de verdade": foto/print/documento fotografado. Espelha o que a leitura
// de imagem aceita no servidor (`contentType: "image"`), e figurinha não conta —
// é ruído de alto volume, marcado em campos diferentes pelo bridge e pela
// Cloud API.
export function isImageMessage(message: InboxMessage): boolean {
  if (isSticker(message) || message.metadata?.whatsappType === "sticker") return false;
  return message.contentType === "image";
}

export function hasMediaProblem(message: InboxMessage): boolean {
  return Boolean(message.metadata?.mediaPending || message.metadata?.mediaError);
}
