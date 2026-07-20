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
 * A quoted-message reference for an outbound reply. `stanzaId` is the whatsmeow
 * id (our stored `externalId`) of the message being replied to; `participant` is
 * the JID of that message's sender (only needed when quoting the CONTACT's own
 * message — for a reply to something WE sent, wuzapi infers it).
 *
 * Maps to wuzapi's `ContextInfo` — confirmed field names against the wuzapi
 * API.md (`{"ContextInfo":{"StanzaId":"…","Participant":"…@s.whatsapp.net"}}`).
 */
export interface BridgeQuote {
  stanzaId: string;
  participant?: string;
}

/** Build the wuzapi `ContextInfo` object from a quote (omitting empty fields). */
function contextInfoFor(quote: BridgeQuote | undefined): Record<string, unknown> | undefined {
  if (!quote || !quote.stanzaId) return undefined;
  const ctx: Record<string, unknown> = { StanzaId: quote.stanzaId };
  if (quote.participant && quote.participant.length > 0) ctx.Participant = quote.participant;
  return ctx;
}

/**
 * Build the POST request to send a text message through a wuzapi instance.
 *
 * Path `/chat/send/text`, auth header name `token` (per-instance token, NOT the
 * admin token), and body casing `Phone`/`Body` — all confirmed against the real
 * wuzapi gateway in the 2026-07-19 pilot.
 *
 * `toPhone` is E.164 digits WITHOUT a leading '+' (matches the ingress `from`).
 * When `quote` is present a `ContextInfo` is attached so the message renders as a
 * reply (fields confirmed against wuzapi API.md).
 */
export function buildBridgeTextSendRequest(params: {
  baseUrl: string;
  token: string;
  toPhone: string;
  body: string;
  quote?: BridgeQuote;
}): BridgeSendRequest {
  const base = params.baseUrl.replace(/\/+$/, "");
  const body: Record<string, unknown> = { Phone: params.toPhone, Body: params.body };
  const contextInfo = contextInfoFor(params.quote);
  if (contextInfo) body.ContextInfo = contextInfo;
  return {
    url: `${base}/chat/send/text`,
    headers: {
      "Content-Type": "application/json",
      token: params.token,
    },
    body: JSON.stringify(body),
  };
}

/**
 * Build the POST request to REACT to a message through a wuzapi instance.
 *
 * Path `/chat/react`, body `{Phone, Body: <emoji>, Id}` — confirmed against
 * wuzapi API.md. An empty `emoji` REMOVES a previous reaction. `Id` is the
 * whatsmeow id of the target message (our stored `externalId`).
 *
 * VALIDAR: the API.md example prefixes a reaction to OUR OWN message with `me:`
 * (`"Id":"me:069E…"`). We apply that prefix when `fromMe` is true; reacting to a
 * message the CONTACT sent uses the raw id.
 */
export function buildBridgeReactRequest(params: {
  baseUrl: string;
  token: string;
  toPhone: string;
  emoji: string;
  stanzaId: string;
  fromMe: boolean;
}): BridgeSendRequest {
  const base = params.baseUrl.replace(/\/+$/, "");
  const id = params.fromMe ? `me:${params.stanzaId}` : params.stanzaId;
  return {
    url: `${base}/chat/react`,
    headers: {
      "Content-Type": "application/json",
      token: params.token,
    },
    body: JSON.stringify({ Phone: params.toPhone, Body: params.emoji, Id: id }),
  };
}

/**
 * Build the POST request to MARK inbound messages as read.
 *
 * Path `/chat/markread`, body `{Id: [ids], ChatPhone, SenderPhone}` — confirmed
 * against wuzapi API.md. `Id` is the list of whatsmeow message ids to ack.
 * `senderPhone` defaults to `chatPhone` for 1:1 chats (VALIDAR: whether wuzapi
 * requires SenderPhone at all for direct chats).
 */
export function buildBridgeMarkReadRequest(params: {
  baseUrl: string;
  token: string;
  ids: string[];
  chatPhone: string;
  senderPhone?: string;
}): BridgeSendRequest {
  const base = params.baseUrl.replace(/\/+$/, "");
  return {
    url: `${base}/chat/markread`,
    headers: {
      "Content-Type": "application/json",
      token: params.token,
    },
    body: JSON.stringify({
      Id: params.ids,
      ChatPhone: params.chatPhone,
      SenderPhone: params.senderPhone ?? params.chatPhone,
    }),
  };
}

/**
 * Build the POST request to set chat presence (typing indicator).
 *
 * Path `/chat/presence`, body `{Phone, State, Media}` — confirmed against wuzapi
 * API.md. `State` is "composing" (typing) or "paused" (stopped). `Media` is left
 * empty for text typing ("audio" would signal recording a voice note).
 */
export function buildBridgePresenceRequest(params: {
  baseUrl: string;
  token: string;
  toPhone: string;
  state: "composing" | "paused";
}): BridgeSendRequest {
  const base = params.baseUrl.replace(/\/+$/, "");
  return {
    url: `${base}/chat/presence`,
    headers: {
      "Content-Type": "application/json",
      token: params.token,
    },
    body: JSON.stringify({ Phone: params.toPhone, State: params.state, Media: "" }),
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
  quote?: BridgeQuote;
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
  // VALIDAR: media endpoints accept ContextInfo for quoted replies just like /chat/send/text.
  const contextInfo = contextInfoFor(params.quote);
  if (contextInfo) body.ContextInfo = contextInfo;

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

export type BridgeAckResult = { ok: true } | { ok: false; error: string };

/**
 * Interpret the response of a wuzapi "ack" endpoint (react / markread / presence)
 * that returns no message id — just success/failure. Tolerant of casing and of a
 * bare 200 with no body.
 */
export function parseBridgeAckResponse(
  httpOk: boolean,
  status: number,
  responseBody: unknown
): BridgeAckResult {
  const b = (responseBody && typeof responseBody === "object" ? responseBody : {}) as Record<string, any>;
  const explicitFail = b.success === false || b.Success === false;
  if (httpOk && !explicitFail) return { ok: true };
  const error =
    firstString(b.error, b.Error, b.message, b.Message) ?? `Falha na operação (HTTP ${status})`;
  return { ok: false, error };
}
