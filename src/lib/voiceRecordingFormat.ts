// Format choice for browser voice notes (MediaRecorder).
//
// Chrome/Firefox record ogg or webm with opus; Safari (iPhone, iPad, Mac, and
// the installed PWA) records mp4/AAC. The upload must carry the REAL format of
// the recording: Safari may ignore the requested type, so the final mime and
// extension come from the bytes (container signature) and the recorder/blob
// labels, never from what we asked for.
//
// Kept outside the component so the onboarding can reuse it.

export type VoiceContainer = "ogg" | "webm" | "mp4";

/** Upload format accepted by the server allowlist (convex/lib/fileValidation.ts). */
export interface VoiceUploadFormat {
  container: VoiceContainer;
  /** Base mime sent as Content-Type and saved in `files.mimeType`. */
  mimeType: "audio/ogg" | "audio/webm" | "audio/mp4";
  /** File extension without the dot. */
  ext: "ogg" | "webm" | "m4a";
}

const UPLOAD_FORMAT: Record<VoiceContainer, VoiceUploadFormat> = {
  ogg: { container: "ogg", mimeType: "audio/ogg", ext: "ogg" },
  webm: { container: "webm", mimeType: "audio/webm", ext: "webm" },
  mp4: { container: "mp4", mimeType: "audio/mp4", ext: "m4a" },
};

/**
 * Requested types, in order of preference: ogg/opus is what WhatsApp plays as
 * a voice note, webm/opus is what Chrome records, mp4/AAC is what Safari
 * records. The backend transcodes to ogg/opus on send when needed.
 */
export const VOICE_RECORDING_CANDIDATES: readonly string[] = [
  "audio/ogg;codecs=opus",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
];

export type VoiceRecordingRequest =
  | { ok: true; /** "" = let the browser pick its default. */ mimeType: string }
  | { ok: false; error: "no_media_recorder" };

/**
 * Picks the type to request from MediaRecorder. `isTypeSupported` is
 * `MediaRecorder.isTypeSupported` (injected for tests); `null` means the
 * browser has no MediaRecorder at all.
 *
 * When no candidate is reported as supported we still record with the
 * browser default (older Safari answers `isTypeSupported` inconsistently);
 * `resolveVoiceUploadFormat` then rejects the result if it is unusable.
 */
export function pickVoiceRecordingType(
  isTypeSupported: ((type: string) => boolean) | null
): VoiceRecordingRequest {
  if (!isTypeSupported) return { ok: false, error: "no_media_recorder" };
  for (const candidate of VOICE_RECORDING_CANDIDATES) {
    let supported = false;
    try {
      supported = isTypeSupported(candidate);
    } catch {
      supported = false;
    }
    if (supported) return { ok: true, mimeType: candidate };
  }
  return { ok: true, mimeType: "" };
}

/** Container from a mime label ("audio/mp4;codecs=mp4a.40.2" → "mp4"). */
export function containerFromMimeType(mimeType: string | null | undefined): VoiceContainer | null {
  if (!mimeType) return null;
  const base = mimeType.split(";")[0].trim().toLowerCase();
  switch (base) {
    case "audio/ogg":
    case "application/ogg":
      return "ogg";
    case "audio/webm":
    case "video/webm":
      return "webm";
    case "audio/mp4":
    case "audio/x-m4a":
    case "audio/m4a":
    case "video/mp4":
      return "mp4";
    default:
      return null;
  }
}

/**
 * Container from the first bytes of the recording: "OggS", EBML header
 * (webm/matroska) or an ISO-BMFF box ("ftyp", or "moof"/"styp" for a
 * fragmented mp4 that starts without one). `null` when unrecognized.
 */
export function sniffVoiceContainer(head: Uint8Array): VoiceContainer | null {
  if (head.length >= 4 && head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) {
    return "ogg";
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return "webm";
  }
  if (head.length >= 8) {
    const box = String.fromCharCode(head[4], head[5], head[6], head[7]);
    if (box === "ftyp" || box === "moof" || box === "styp" || box === "moov") return "mp4";
  }
  return null;
}

export type VoiceUploadResolution =
  | ({ ok: true } & VoiceUploadFormat)
  | { ok: false; error: "empty_recording" | "unsupported_format"; detectedType: string };

/**
 * Decides the upload format from what was ACTUALLY recorded.
 * Priority: container signature in the bytes > `recorder.mimeType` >
 * `blob.type` > the requested type (only used when the browser reports
 * nothing at all, which means it honored the request).
 */
export function resolveVoiceUploadFormat(input: {
  head: Uint8Array;
  size: number;
  recorderMimeType?: string | null;
  blobType?: string | null;
  requestedMimeType?: string | null;
}): VoiceUploadResolution {
  const labels = [input.recorderMimeType, input.blobType].filter(
    (l): l is string => typeof l === "string" && l.trim().length > 0
  );
  const detectedType = labels[0] ?? input.requestedMimeType ?? "";
  if (input.size <= 0) return { ok: false, error: "empty_recording", detectedType };

  const sniffed = sniffVoiceContainer(input.head);
  if (sniffed) return { ok: true, ...UPLOAD_FORMAT[sniffed] };

  if (labels.length > 0) {
    const fromLabel = containerFromMimeType(labels[0]);
    return fromLabel
      ? { ok: true, ...UPLOAD_FORMAT[fromLabel] }
      : { ok: false, error: "unsupported_format", detectedType };
  }

  const fromRequest = containerFromMimeType(input.requestedMimeType);
  return fromRequest
    ? { ok: true, ...UPLOAD_FORMAT[fromRequest] }
    : { ok: false, error: "unsupported_format", detectedType };
}

/** File name for the uploaded voice note. */
export function voiceNoteFileName(format: VoiceUploadFormat, now: number): string {
  return `nota-de-voz-${now}.${format.ext}`;
}

// ── User-facing messages (PT-BR) ─────────────────────────────────────────────

export const VOICE_MESSAGES = {
  noMediaRecorder:
    "Este navegador não grava áudio. No iPhone, atualize o iOS ou use o Safari; no computador, use Chrome, Edge, Firefox ou Safari atualizados.",
  noGetUserMedia:
    "Gravação de áudio indisponível neste aparelho. Abra o app pelo Safari ou por um navegador atualizado.",
  permissionDenied:
    "Permissão do microfone negada. Libere o microfone para este site nos ajustes do navegador (no iPhone: Ajustes > Apps > Safari > Microfone) e tente de novo.",
  noMicrophone: "Nenhum microfone encontrado neste aparelho.",
  micBusy: "O microfone está em uso por outro app. Feche o outro app e tente de novo.",
  formatNotSupported:
    "Este navegador gravou o áudio num formato que não conseguimos enviar. Tente pelo Safari ou pelo Chrome atualizados.",
  emptyRecording: "A gravação ficou vazia. Grave de novo, falando por pelo menos um segundo.",
  startFailed: "Não foi possível iniciar a gravação. Tente de novo.",
  recordingFailed: "A gravação foi interrompida. Tente de novo.",
} as const;

/** Maps a getUserMedia / MediaRecorder error to a clear PT-BR message. */
export function voiceStartErrorMessage(err: unknown): string {
  const name =
    err && typeof err === "object" && "name" in err && typeof (err as { name: unknown }).name === "string"
      ? (err as { name: string }).name
      : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return VOICE_MESSAGES.permissionDenied;
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return VOICE_MESSAGES.noMicrophone;
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return VOICE_MESSAGES.micBusy;
    case "NotSupportedError":
      return VOICE_MESSAGES.formatNotSupported;
    default:
      return VOICE_MESSAGES.startFailed;
  }
}

/** Message for a failed upload-format resolution. */
export function voiceUploadErrorMessage(error: "empty_recording" | "unsupported_format"): string {
  return error === "empty_recording" ? VOICE_MESSAGES.emptyRecording : VOICE_MESSAGES.formatNotSupported;
}
