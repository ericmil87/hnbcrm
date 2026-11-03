/**
 * Copilot on Telegram — F4 (D21/D25): which customer attachments a card
 * carries to Telegram, and how. Reads only (bounded, org-checked).
 *
 * Matrix (customer → Telegram), one Telegram message per file, right after the card:
 * | attachment        | sent as                              | above the cap          |
 * |-------------------|--------------------------------------|------------------------|
 * | image             | `sendPhoto` by storage URL (≤ 5 MB)  | link line to the CRM   |
 * | voice (ogg/opus)  | `sendVoice` by storage URL (≤ 20 MB) | link line              |
 * | other audio       | `sendAudio` upload, real name (≤ 20 MB) | link line           |
 * | document          | `sendDocument` upload, real name (≤ 20 MB) | link line        |
 * | video             | nothing (the card line says "🎬 vídeo (abrir no CRM)") |      |
 * | sticker           | nothing (the card line says "[figurinha]")             |      |
 * Discreet org or `prefs.mediaInbound:false` → no media at all, text lines only.
 */
import { QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { isSticker } from "./mediaEnrichment";
import { MAX_TELEGRAM_FILE_BYTES, MAX_TELEGRAM_PHOTO_BYTES, fileSizeCopy } from "./telegramQuota";
import { escapeHtml } from "./telegramFormat";

type Db = QueryCtx["db"];

export type MediaOut = {
  kind: "photo" | "voice" | "audio" | "document" | "link";
  /** Absent for `link`. Resolved to a storage URL at send time, handed only to Telegram (never stored). */
  storageId?: string;
  fileName: string;
  size: number;
  mime: string;
  /** `link`: the text line (HTML, escaped) sent instead of the file. */
  text?: string;
};

/** Files per card (a burst of 20 photos must not become 20 Telegram messages). */
export const MEDIA_PER_CARD = 5;

export function conversationCrmUrl(appBaseUrl: string, conversationId: Id<"conversations">): string {
  return `${appBaseUrl}/app/entrada?conversation=${conversationId}`;
}

/** Pure: how one file travels (exported for tests). */
export function planMedia(
  file: { storageId: string; name: string; mimeType: string; size: number },
  crmUrl: string,
): MediaOut | null {
  const mime = file.mimeType.toLowerCase().split(";")[0].trim();
  if (mime.startsWith("video/")) return null;
  const base = { storageId: file.storageId, fileName: file.name, size: file.size, mime };
  const link = (label: string): MediaOut => ({
    kind: "link",
    fileName: file.name,
    size: file.size,
    mime,
    text: `${label} ${escapeHtml(file.name)} (${fileSizeCopy(file.size)}) passa do limite do Telegram. <a href="${escapeHtml(crmUrl)}">Abrir no CRM</a>`,
  });
  if (mime.startsWith("image/")) {
    return file.size <= MAX_TELEGRAM_PHOTO_BYTES ? { kind: "photo", ...base } : link("🖼");
  }
  if (file.size > MAX_TELEGRAM_FILE_BYTES) return link(mime.startsWith("audio/") ? "🎙" : "📄");
  if (mime.startsWith("audio/")) {
    const voice = mime === "audio/ogg" || mime === "audio/opus" || mime.includes("opus");
    return { kind: voice ? "voice" : "audio", ...base };
  }
  return { kind: "document", ...base };
}

/**
 * The media a card carries for `messages` (in order, capped). Empty when the
 * org is discreet or the member turned inbound media off.
 */
export async function mediaForMessages(
  db: Db,
  messages: Doc<"messages">[],
  opts: { organizationId: Id<"organizations">; discreet: boolean; mediaInbound: boolean; crmUrl: string },
): Promise<MediaOut[]> {
  if (opts.discreet || !opts.mediaInbound) return [];
  const out: MediaOut[] = [];
  for (const m of messages) {
    if (m.organizationId !== opts.organizationId || m.isInternal) continue;
    if (isSticker(m.metadata as Record<string, unknown> | undefined)) continue;
    for (const fileId of (m.attachments ?? []).slice(0, MEDIA_PER_CARD)) {
      if (out.length >= MEDIA_PER_CARD) return out;
      const file = await db.get(fileId);
      if (!file || file.organizationId !== opts.organizationId) continue;
      const planned = planMedia(file, opts.crmUrl);
      if (planned) out.push(planned);
    }
  }
  return out;
}
