/**
 * Pure adapter for the wuzapi (whatsmeow) REST send API — the outbound half of
 * the unofficial WhatsApp "bridge" provider. No Convex context and no fetch: it
 * only builds the request pieces and interprets the response, so it is trivially
 * unit-testable. The action (convex/whatsapp.ts) owns the actual fetch.
 *
 * Wave U3 scope: TEXT. Wave U4 adds outbound MEDIA (image/audio/document/video)
 * via the per-type `/chat/send/*` endpoints — same header, same response parser.
 *
 * ⚠️ The wuzapi REST contract here was validated against a real wuzapi gateway
 * in the pilot of 2026-07-19. Fields still marked `VALIDAR:` are the ones that
 * run did not exercise; the response parser is deliberately tolerant of casing
 * so it survives whichever serialization wuzapi emits.
 */

export interface BridgeSendRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export type BridgeSendResult =
  | { ok: true; externalId: string }
  | { ok: false; error: string };

/**
 * Build the POST request to send a text message through a wuzapi instance.
 *
 * Path `/chat/send/text`, auth header name `token` (per-instance token, NOT the
 * admin token), and body casing `Phone`/`Body` — all confirmed against the real
 * wuzapi gateway in the 2026-07-19 pilot.
 *
 * `toPhone` is E.164 digits WITHOUT a leading '+' (matches the ingress `from`).
 */
export function buildBridgeTextSendRequest(params: {
  baseUrl: string;
  token: string;
  toPhone: string;
  body: string;
}): BridgeSendRequest {
  const base = params.baseUrl.replace(/\/+$/, "");
  return {
    url: `${base}/chat/send/text`,
    headers: {
      "Content-Type": "application/json",
      token: params.token,
    },
    body: JSON.stringify({ Phone: params.toPhone, Body: params.body }),
  };
}

/**
 * The four wuzapi media send endpoints. We route by the file's mime type, not by
 * the inbound whatsmeow "kind", so a sticker (image/webp) goes out as an image and
 * anything unrecognized falls back to "document".
 */
export type BridgeMediaSendKind = "image" | "audio" | "document" | "video";

/** mime type → the wuzapi send endpoint / body field to use. */
export function bridgeSendKindForMime(mimeType: string): BridgeMediaSendKind {
  const m = mimeType.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "document";
}

// Endpoint path + JSON body field carrying the base64 data-URI, per kind.
// VALIDAR: paths `/chat/send/{image,audio,document,video}` and the PascalCase
// body field names (Image/Audio/Document/Video) against the live wuzapi in U6.
const MEDIA_ENDPOINT: Record<BridgeMediaSendKind, { path: string; field: string }> = {
  image: { path: "/chat/send/image", field: "Image" },
  audio: { path: "/chat/send/audio", field: "Audio" },
  document: { path: "/chat/send/document", field: "Document" },
  video: { path: "/chat/send/video", field: "Video" },
};

/**
 * Build the POST request to send ONE media attachment through a wuzapi instance.
 *
 * `dataUri` is the base64 data-URI wuzapi expects (`data:<mime>;base64,<...>`).
 * `caption` is attached where WhatsApp supports it (image/video/document) and
 * omitted for audio (voice notes carry no caption). `filename` is only meaningful
 * for documents.
 *
 * VALIDAR: field casing (Phone/Caption/FileName) and that audio is accepted as a
 * data-URI (voice note / PTT) — confirm against the live gateway in the pilot.
 */
export function buildBridgeMediaSendRequest(params: {
  baseUrl: string;
  token: string;
  toPhone: string;
  kind: BridgeMediaSendKind;
  dataUri: string;
  caption?: string;
  filename?: string;
}): BridgeSendRequest {
  const base = params.baseUrl.replace(/\/+$/, "");
  const { path, field } = MEDIA_ENDPOINT[params.kind];

  const body: Record<string, unknown> = {
    Phone: params.toPhone,
    [field]: params.dataUri,
  };
  // Audio (voice note) takes no caption; the others do when we have real text.
  if (params.kind !== "audio" && params.caption && params.caption.length > 0) {
    body.Caption = params.caption;
  }
  if (params.kind === "document" && params.filename && params.filename.length > 0) {
    body.FileName = params.filename;
  }

  return {
    url: `${base}${path}`,
    headers: {
      "Content-Type": "application/json",
      token: params.token,
    },
    body: JSON.stringify(body),
  };
}

/** First non-empty string among the candidates (tolerates casing differences). */
function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

/**
 * Interpret a wuzapi send response into a success (with the whatsmeow message id
 * that becomes our `externalId` — the SAME id the U2 receipts reference) or a
 * readable error.
 *
 * VALIDAR: the assumed success envelope is
 *   { code: 200, success: true, data: { Id: "3EB0…", Details: "Sent", … } }
 * and errors carry a top-level `error`/`message` (or non-2xx HTTP). The parser
 * reads several id spellings and both `data`/top-level so it survives variants.
 */
export function parseBridgeSendResponse(
  httpOk: boolean,
  status: number,
  responseBody: unknown
): BridgeSendResult {
  const b = (responseBody && typeof responseBody === "object" ? responseBody : {}) as Record<string, any>;
  const data = (b.data ?? b.Data ?? {}) as Record<string, any>;

  const explicitFail = b.success === false || b.Success === false;
  const externalId = firstString(
    data.Id,
    data.id,
    data.ID,
    data.MessageID,
    data.messageId,
    b.Id,
    b.id,
    b.ID
  );

  if (httpOk && !explicitFail && externalId) {
    return { ok: true, externalId };
  }

  const error =
    firstString(
      b.error,
      b.Error,
      b.message,
      b.Message,
      data.Details,
      data.details,
      data.error
    ) ??
    (httpOk && !externalId
      ? "Gateway não retornou o id da mensagem"
      : `Falha no envio (HTTP ${status})`);

  return { ok: false, error };
}
