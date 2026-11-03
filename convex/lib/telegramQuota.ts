/**
 * Copilot on Telegram — file limits (D25, pure): per-link and per-org quotas,
 * media classification and the refusal copy (§4.5). No ctx, no network. The
 * transactional reservation lives in `convex/telegramQuota.ts`.
 */
import { atLocal, localDateKey, localParts } from "./executiveReport";
import { validateInboundMimeType } from "./fileValidation";
import { escapeHtml } from "./telegramFormat";
import { formatTime } from "./telegramNotifications";

const MB = 1024 * 1024;

export const QUOTA_LIMITS = {
  filesPerHourPerLink: 30,
  bytesPerDayPerLink: 150 * MB,
  filesPerDayPerOrg: 500,
} as const;

/** `getFile` ceiling of the Bot API. */
export const MAX_TELEGRAM_FILE_BYTES = 20 * MB;
/** `sendPhoto` by URL. */
export const MAX_TELEGRAM_PHOTO_BYTES = 5 * MB;

export type LinkQuota = { hourStart: number; filesThisHour: number; dayKey: string; bytesToday: number };
export type OrgQuota = { dayKey: string; files: number; bytes: number };
export type QuotaRefusal = "hour" | "day_bytes" | "org_day";

/** Local day key ("AAAA-MM-DD") in the org timezone — the quota day. */
export function localDayKey(now: number, tz: string): string {
  return localDateKey(now, tz);
}

/** Start of the current clock hour (minutes are whole in every real timezone). */
export function hourStartOf(now: number, tz: string): number {
  return now - (localParts(now, tz).minute * 60_000 + (now % 60_000));
}

export function checkLinkQuota(
  quota: LinkQuota | undefined,
  args: { now: number; tz: string; bytes: number },
): { ok: true; next: LinkQuota } | { ok: false; reason: "hour" | "day_bytes"; retryAt: number } {
  const hourStart = hourStartOf(args.now, args.tz);
  const dayKey = localDayKey(args.now, args.tz);
  const filesThisHour = quota && quota.hourStart === hourStart ? quota.filesThisHour : 0;
  const bytesToday = quota && quota.dayKey === dayKey ? quota.bytesToday : 0;
  if (filesThisHour >= QUOTA_LIMITS.filesPerHourPerLink) {
    return { ok: false, reason: "hour", retryAt: hourStart + 3_600_000 };
  }
  if (bytesToday + args.bytes > QUOTA_LIMITS.bytesPerDayPerLink) {
    return { ok: false, reason: "day_bytes", retryAt: atLocal(args.now, args.tz, 1, 0) };
  }
  return { ok: true, next: { hourStart, filesThisHour: filesThisHour + 1, dayKey, bytesToday: bytesToday + args.bytes } };
}

export function checkOrgQuota(
  quota: OrgQuota | undefined,
  args: { now: number; tz: string; bytes?: number },
): { ok: true; next: OrgQuota } | { ok: false; reason: "org_day"; retryAt: number } {
  const dayKey = localDayKey(args.now, args.tz);
  const files = quota && quota.dayKey === dayKey ? quota.files : 0;
  const bytes = quota && quota.dayKey === dayKey ? quota.bytes : 0;
  if (files >= QUOTA_LIMITS.filesPerDayPerOrg) {
    return { ok: false, reason: "org_day", retryAt: atLocal(args.now, args.tz, 1, 0) };
  }
  return { ok: true, next: { dayKey, files: files + 1, bytes: bytes + (args.bytes ?? 0) } };
}

// ---------------------------------------------------------------------------
// Copy (§4.5)
// ---------------------------------------------------------------------------

/** "3,1 MB", "24 MB", "820 KB", "512 B". */
export function fileSizeCopy(bytes: number): string {
  const fmt = (n: number) => (Number.isInteger(Math.round(n * 10) / 10) ? String(Math.round(n * 10) / 10) : (Math.round(n * 10) / 10).toFixed(1).replace(".", ","));
  if (bytes >= MB) return `${fmt(bytes / MB)} MB`;
  if (bytes >= 1024) return `${fmt(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function quotaRefusalCopy(reason: QuotaRefusal, retryAt: number, tz: string): string {
  const at = formatTime(retryAt, tz);
  switch (reason) {
    case "hour":
      return `⏳ Você já enviou ${QUOTA_LIMITS.filesPerHourPerLink} arquivos nesta hora pelo Telegram. Libera às ${at}. Enquanto isso, use o CRM.`;
    case "day_bytes":
      return `📦 Você já enviou ${fileSizeCopy(QUOTA_LIMITS.bytesPerDayPerLink)} em arquivos hoje pelo Telegram. Libera às ${at} de amanhã. Enquanto isso, use o CRM.`;
    case "org_day":
      return `⏳ Sua organização atingiu o limite de ${QUOTA_LIMITS.filesPerDayPerOrg} arquivos hoje pelo Telegram. Libera às ${at} de amanhã. Enquanto isso, use o CRM.`;
  }
}

export function fileTooBigCopy(bytes: number, max = MAX_TELEGRAM_FILE_BYTES): string {
  return `📦 Esse arquivo tem ${fileSizeCopy(bytes)}; o máximo pelo Telegram é ${fileSizeCopy(max)}. Mande pelo CRM.`;
}

export function fileTypeRefusedCopy(extension: string): string {
  const ext = extension ? ` (${escapeHtml(extension)})` : "";
  return `🚫 Tipo de arquivo não permitido${ext}. Aceito PDF, imagens, áudio, Office, CSV, TXT e ZIP.`;
}

export const VIDEO_REFUSED_COPY = "Ainda não envio vídeos pelo Telegram. Mande pelo CRM ou pelo WhatsApp.";

// ---------------------------------------------------------------------------
// Allowlist (the INBOUND one — never a second list)
// ---------------------------------------------------------------------------

/** Extension → mime, only to infer a type when Telegram sends none/octet-stream. */
const EXTENSION_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".zip": "application/zip",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

export function extensionOf(fileName: string | undefined): string {
  const m = (fileName ?? "").toLowerCase().match(/\.[a-z0-9]{1,8}$/);
  return m ? m[0] : "";
}

/** Coarse type of a mime, to compare a declared mime with the one its extension implies. */
function mimeFamily(mime: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/zip" || mime === "application/x-zip-compressed") return "zip";
  if (/msword|ms-excel|ms-powerpoint|officedocument/.test(mime)) return "office";
  return mime;
}
/** csv is often declared as Excel; OOXML files are zips. */
function familiesCompatible(implied: string, declared: string): boolean {
  if (implied === declared) return true;
  if (implied === "text" && declared === "office") return true;
  if ((implied === "office" && declared === "zip") || (implied === "zip" && declared === "office")) return true;
  return false;
}

/**
 * A document is accepted when its type passes `validateInboundMimeType` and is
 * not video. With an extension, the extension decides (review F4 #1): it must
 * be a known one (`EXTENSION_MIME`) AND agree with the declared mime family, so
 * `boleto.exe` declared as `application/pdf` is refused. Without an extension
 * the declared mime must stand on its own. The bytes are checked after the
 * download (`sniffMatchesMime`).
 */
export function isAllowedDocument(fileName: string | undefined, mime: string | undefined): boolean {
  const declared = (mime ?? "").split(";")[0].trim().toLowerCase();
  const generic = !declared || declared === "application/octet-stream";
  const ext = extensionOf(fileName);
  let type = declared;
  if (ext) {
    const implied = EXTENSION_MIME[ext];
    if (!implied) return false;
    if (!generic && !familiesCompatible(mimeFamily(implied), mimeFamily(declared))) return false;
    if (generic) type = implied;
  } else if (generic) {
    return false;
  }
  if (!type || type.startsWith("video/")) return false;
  return validateInboundMimeType(type);
}

/**
 * Magic bytes of the common types (review F4 #1). `false` = the bytes are NOT
 * what the mime says (refuse); `true` = they match; `null` = no signature for
 * this type (text/csv) — not checked.
 */
export function sniffMatchesMime(bytes: Uint8Array, mime: string): boolean | null {
  const m = mime.split(";")[0].trim().toLowerCase();
  const at = (offset: number, sig: number[]) => sig.every((b, i) => bytes[offset + i] === b);
  const ascii = (offset: number, text: string) => at(offset, [...text].map((c) => c.charCodeAt(0)));
  const fam = mimeFamily(m);
  if (fam === "pdf") return ascii(0, "%PDF");
  if (fam === "zip" || /officedocument/.test(m)) return at(0, [0x50, 0x4b, 0x03, 0x04]) || at(0, [0x50, 0x4b, 0x05, 0x06]);
  if (fam === "office") return at(0, [0xd0, 0xcf, 0x11, 0xe0]); // legacy OLE (.doc/.xls/.ppt)
  if (m === "image/jpeg") return at(0, [0xff, 0xd8, 0xff]);
  if (m === "image/png") return at(0, [0x89, 0x50, 0x4e, 0x47]);
  if (m === "image/gif") return ascii(0, "GIF8");
  if (m === "image/webp") return ascii(0, "RIFF") && ascii(8, "WEBP");
  if (m === "audio/ogg" || m === "audio/opus") return ascii(0, "OggS");
  if (m === "audio/wav" || m === "audio/x-wav") return ascii(0, "RIFF") && ascii(8, "WAVE");
  if (m === "audio/mpeg") return ascii(0, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (m === "audio/mp4" || m === "audio/x-m4a") return ascii(4, "ftyp");
  return null;
}

// ---------------------------------------------------------------------------
// Media classification
// ---------------------------------------------------------------------------

export type TelegramMediaKind = "photo" | "voice" | "audio" | "document" | "video" | "video_note" | "sticker" | "none";
export type TelegramMedia = { kind: TelegramMediaKind; fileId?: string; fileSize?: number; mime?: string; fileName?: string };

function obj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}
const s = (x: unknown, max = 256) => (typeof x === "string" ? x.slice(0, max) : undefined);
const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined);

/** Never throws. The largest photo size wins; animations count as video. */
export function classifyTelegramMedia(message: unknown): TelegramMedia {
  const m = obj(message);
  if (!m) return { kind: "none" };
  const pick = (kind: TelegramMediaKind, o: Record<string, unknown> | null, extra: Partial<TelegramMedia> = {}): TelegramMedia | null => {
    const fileId = s(o?.file_id, 256);
    if (!o || !fileId) return null;
    return { kind, fileId, fileSize: n(o.file_size), mime: s(o.mime_type, 128), fileName: s(o.file_name), ...extra };
  };
  if (Array.isArray(m.photo) && m.photo.length > 0) {
    const sizes = m.photo.map(obj).filter((p): p is Record<string, unknown> => p !== null);
    const best = sizes.reduce<Record<string, unknown> | null>(
      (acc, p) => (!acc || (n(p.file_size) ?? 0) >= (n(acc.file_size) ?? 0) ? p : acc),
      null,
    );
    const hit = pick("photo", best, { mime: "image/jpeg" });
    if (hit) return hit;
  }
  return (
    pick("voice", obj(m.voice)) ??
    pick("audio", obj(m.audio)) ??
    pick("document", obj(m.document)) ??
    pick("video", obj(m.video)) ??
    pick("video", obj(m.animation)) ??
    pick("video_note", obj(m.video_note)) ??
    pick("sticker", obj(m.sticker)) ??
    { kind: "none" }
  );
}
