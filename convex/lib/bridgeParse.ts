/**
 * Pure parsing of wuzapi (whatsmeow) webhook payloads + HMAC verification for
 * the unofficial WhatsApp "bridge" provider. No Convex context — unit-testable
 * in isolation, and DEFENSIVE: an unrecognized payload returns an "ignored"
 * result, never a throw.
 *
 * ⚠️ The wuzapi webhook envelope and event shapes were derived from the
 * whatsmeow event model and validated against a real wuzapi gateway in the
 * pilot of 2026-07-19. Fields still marked `VALIDAR:` are the ones that
 * particular run did not exercise. The parser reads both lowerCamelCase (proto
 * JSON) and PascalCase (Go struct) key spellings so it survives whichever
 * serialization wuzapi emits.
 */

export interface ParsedBridgeMedia {
  kind: string; // "image" | "sticker" | "audio" | "video" | "document"
  mimeType?: string;
  filename?: string;
  // Full whatsmeow media descriptor (url/directPath/mediaKey/fileSha256/…).
  // U4 uses this to download + decrypt the bytes; U2 only carries it along.
  descriptor?: Record<string, unknown>;
}

export interface ParsedBridgeInbound {
  externalId: string; // whatsmeow message ID (Info.ID) — used for idempotency
  from: string; // sender phone digits (E.164 without '+')
  profileName?: string;
  timestamp: number; // ms epoch
  contentType: "text" | "image" | "file" | "audio";
  content: string;
  media?: ParsedBridgeMedia; // carried into message metadata for U4 (not downloaded here)
  metadata: Record<string, unknown>;
}

export interface ParsedBridgeReceipt {
  status: "delivered" | "read" | "failed";
  externalIds: string[]; // whatsmeow message IDs this receipt refers to
}

/** A quoted/replied-to message reference lifted from a whatsmeow ContextInfo. */
export interface ParsedBridgeQuoted {
  externalId: string; // whatsmeow id of the quoted message (ContextInfo.StanzaID)
  participant?: string; // JID of the quoted message's sender (as delivered)
  preview?: string; // short text preview of the quoted message, when available
}

/** An inbound reaction from the contact to a specific message. */
export interface ParsedBridgeReaction {
  targetExternalId: string; // whatsmeow id of the message being reacted to
  emoji: string; // "" means the contact REMOVED their reaction
  from: string; // sender phone digits (E.164 without '+')
  senderName?: string;
  timestamp: number; // ms epoch
}

/** Contact typing state in a 1:1 chat (whatsmeow ChatPresence). */
export interface ParsedBridgePresence {
  phone: string; // contact phone digits
  state: "composing" | "paused";
}

export type ParsedBridgeEvent =
  | { kind: "message"; message: ParsedBridgeInbound }
  | { kind: "receipt"; receipt: ParsedBridgeReceipt }
  | { kind: "reaction"; reaction: ParsedBridgeReaction }
  | { kind: "chat_presence"; presence: ParsedBridgePresence }
  | { kind: "ignored"; reason: string };

/** First defined value among the given keys (tolerates casing differences). */
function pick(obj: Record<string, any> | null | undefined, ...keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function strUndef(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extract the instance routing key from an UNTRUSTED payload (before signature
 * verification), mirroring extractPhoneNumberId in the Meta path.
 *
 * CONFIRMADO no piloto (2026-07-19): o envelope real do wuzapi é
 * `{ event, instanceName, type, userID }` — `instanceName` é o nome criado via
 * `POST /admin/users` (= nosso `bridgeInstanceId`). Os demais candidatos ficam
 * como fallback defensivo p/ builds antigos.
 */
export function extractBridgeInstanceId(payload: unknown): string | null {
  const p = payload as Record<string, any> | null;
  if (!p || typeof p !== "object") return null;
  const candidates = [
    p.instanceName,
    p.InstanceName,
    p.instanceId,
    p.instance,
    p.userID,
    p.userId,
    p.userinfo,
    p.id,
    p.name,
    p.token,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
    if (typeof c === "number") return String(c);
  }
  return null;
}

/** JID ("15550000000@s.whatsapp.net", "15550000000.0:1@s.whatsapp.net") → phone digits. */
function jidToPhone(jid: string): string | null {
  if (!jid) return null;
  const at = jid.indexOf("@");
  let user = at >= 0 ? jid.slice(0, at) : jid;
  // Strip AD-JID device/agent suffixes: "15550000000.0:1" → "15550000000"
  user = user.split(":")[0].split(".")[0];
  const digits = user.replace(/[^0-9]/g, "");
  return digits.length > 0 ? digits : null;
}

/** An @lid JID carries a privacy LID, not a phone — its digits are NOT a MSISDN. */
function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid");
}

/** whatsmeow Timestamp: RFC3339 string, unix-seconds string, or number. */
function parseTimestamp(ts: unknown): number {
  if (typeof ts === "number") return ts > 1e12 ? ts : ts * 1000;
  if (typeof ts === "string" && ts.trim() !== "") {
    const asNum = Number(ts);
    if (!Number.isNaN(asNum)) return asNum > 1e12 ? asNum : asNum * 1000;
    const parsed = Date.parse(ts); // RFC3339
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function mediaFrom(kind: string, node: Record<string, any>): ParsedBridgeMedia {
  return {
    kind,
    mimeType: strUndef(pick(node, "mimetype", "Mimetype", "mimeType")),
    filename: strUndef(pick(node, "fileName", "FileName", "filename")),
    // VALIDAR: the full node is assumed to carry the whatsmeow media descriptor
    // (URL/DirectPath/MediaKey/FileSHA256/FileEncSHA256) that U4 needs.
    descriptor: node,
  };
}

interface ExtractedContent {
  contentType: "text" | "image" | "file" | "audio";
  content: string;
  media?: ParsedBridgeMedia;
  metadataExtra: Record<string, unknown>;
}

/**
 * Lift the quoted-message reference from a node's ContextInfo, if any. whatsmeow
 * attaches ContextInfo to extendedTextMessage AND to every media node when the
 * user replies. Returns undefined when there is no quote (or no StanzaID).
 *
 * VALIDAR: exact ContextInfo key casing from the live gateway — we read the proto
 * JSON (`stanzaId`/`quotedMessage`) and Go struct (`StanzaID`/`QuotedMessage`)
 * spellings, plus `participant`.
 */
function quotedFrom(node: Record<string, any> | undefined): ParsedBridgeQuoted | undefined {
  const ci = pick(node, "contextInfo", "ContextInfo");
  if (!ci || typeof ci !== "object") return undefined;
  const stanzaId = strUndef(pick(ci, "stanzaId", "stanzaID", "StanzaID", "StanzaId", "id", "ID"));
  if (!stanzaId) return undefined;
  const participant = strUndef(pick(ci, "participant", "Participant"));
  const quotedMessage = pick(ci, "quotedMessage", "QuotedMessage");
  // extractContent never recurses into ContextInfo, so this is a safe one-level
  // preview of whatever the quoted message was (text or a "[imagem]" placeholder).
  const preview =
    quotedMessage && typeof quotedMessage === "object"
      ? strUndef(extractContent(quotedMessage).content)
      : undefined;
  return {
    externalId: stanzaId,
    ...(participant ? { participant } : {}),
    ...(preview ? { preview } : {}),
  };
}

/** Map a decrypted whatsmeow waE2E.Message to our content shape. */
function extractContent(waMsg: Record<string, any>): ExtractedContent {
  const conversation = pick(waMsg, "conversation", "Conversation");
  const extended = pick(waMsg, "extendedTextMessage", "ExtendedTextMessage");
  const image = pick(waMsg, "imageMessage", "ImageMessage");
  const sticker = pick(waMsg, "stickerMessage", "StickerMessage");
  const audio = pick(waMsg, "audioMessage", "AudioMessage");
  const video = pick(waMsg, "videoMessage", "VideoMessage");
  const doc = pick(waMsg, "documentMessage", "DocumentMessage");
  const reaction = pick(waMsg, "reactionMessage", "ReactionMessage");

  // The node bearing the ContextInfo (quote) for this message, if any.
  const quoted = quotedFrom(extended ?? image ?? sticker ?? audio ?? video ?? doc);
  const quoteMeta = quoted ? { quoted } : {};

  if (typeof conversation === "string" && conversation.length > 0) {
    return { contentType: "text", content: conversation, metadataExtra: { bridgeType: "text" } };
  }
  if (extended) {
    const text = pick(extended, "text", "Text");
    return {
      contentType: "text",
      content: typeof text === "string" ? text : "",
      metadataExtra: { bridgeType: "extendedText", ...quoteMeta },
    };
  }
  if (image) {
    return {
      contentType: "image",
      content: strOr(pick(image, "caption", "Caption"), "[imagem]"),
      media: mediaFrom("image", image),
      metadataExtra: { bridgeType: "image", ...quoteMeta },
    };
  }
  if (sticker) {
    return {
      contentType: "image",
      content: "[figurinha]",
      media: mediaFrom("sticker", sticker),
      metadataExtra: { bridgeType: "sticker", ...quoteMeta },
    };
  }
  if (audio) {
    const ptt = pick(audio, "ptt", "PTT", "Ptt") === true;
    return {
      contentType: "audio",
      content: ptt ? "[mensagem de voz]" : "[áudio]",
      media: mediaFrom("audio", audio),
      metadataExtra: { bridgeType: "audio", ...quoteMeta },
    };
  }
  if (video) {
    return {
      contentType: "file",
      content: strOr(pick(video, "caption", "Caption"), "[vídeo]"),
      media: mediaFrom("video", video),
      metadataExtra: { bridgeType: "video", ...quoteMeta },
    };
  }
  if (doc) {
    const fileName = pick(doc, "fileName", "FileName", "filename");
    const caption = pick(doc, "caption", "Caption");
    return {
      contentType: "file",
      content: strOr(fileName, strOr(caption, "[documento]")),
      media: mediaFrom("document", doc),
      metadataExtra: { bridgeType: "document", ...quoteMeta },
    };
  }
  if (reaction) {
    // Reactions are handled as a distinct event upstream (parseMessage); this
    // branch only survives as a defensive fallback for an unexpected shape.
    const emoji = pick(reaction, "text", "Text");
    const targetId = pick(pick(reaction, "key", "Key") ?? {}, "ID", "Id", "id");
    return {
      contentType: "text",
      content: `Reagiu com ${strOr(emoji, "?")}`,
      metadataExtra: { bridgeType: "reaction", reactionTo: targetId },
    };
  }
  // Unrecognized content — keep a readable placeholder + raw for debugging
  return {
    contentType: "text",
    content: "[mensagem não suportada]",
    metadataExtra: { bridgeType: "unknown", raw: waMsg },
  };
}

/** Pull the reaction target id + emoji from a whatsmeow reactionMessage node. */
function reactionFrom(
  reaction: Record<string, any>
): { targetExternalId: string; emoji: string } | null {
  const key = pick(reaction, "key", "Key") ?? {};
  const targetExternalId = strUndef(pick(key, "ID", "Id", "id"));
  if (!targetExternalId) return null;
  // An absent/empty text means the reaction was removed — a meaningful state.
  const raw = pick(reaction, "text", "Text");
  const emoji = typeof raw === "string" ? raw : "";
  return { targetExternalId, emoji };
}

function parseMessage(event: Record<string, any>): ParsedBridgeEvent {
  const info = pick(event, "Info", "info");
  const waMsg = pick(event, "Message", "message") ?? {};
  if (!info || typeof info !== "object") return { kind: "ignored", reason: "no message info" };

  // fromMe echo → never an inbound message (avoids echo/duplication, plan §1 Modo D)
  if (info.IsFromMe === true || info.isFromMe === true) return { kind: "ignored", reason: "fromMe" };

  const chatJid = String(pick(info, "Chat", "chat") ?? "");
  const senderJid = String(pick(info, "Sender", "sender") ?? "");
  // Ignore group messages for now (plan U2 scope)
  if (
    info.IsGroup === true ||
    info.isGroup === true ||
    chatJid.endsWith("@g.us") ||
    senderJid.endsWith("@g.us")
  ) {
    return { kind: "ignored", reason: "group" };
  }

  const externalId = pick(info, "ID", "Id", "id");
  // CONFIRMADO no piloto: com privacy LID ativo, Sender/Chat vêm como "…@lid"
  // (dígitos NÃO são o telefone) e o MSISDN real vem em SenderAlt
  // ("5581…@s.whatsapp.net"). Preferir o primeiro candidato não-LID; se só
  // houver LID, ignorar em vez de criar um contato com número falso.
  const senderAltJid = String(pick(info, "SenderAlt", "senderAlt") ?? "");
  const phoneJid = [senderJid, senderAltJid, chatJid].find((j) => j && !isLidJid(j));
  if (!phoneJid) {
    return { kind: "ignored", reason: "lid-only sender (no phone JID)" };
  }
  const from = jidToPhone(phoneJid);
  if (typeof externalId !== "string" || externalId.length === 0 || !from) {
    return { kind: "ignored", reason: "missing id or sender" };
  }

  const profileName = strUndef(pick(info, "PushName", "pushName"));
  const timestamp = parseTimestamp(pick(info, "Timestamp", "timestamp"));

  // A reaction from the contact is NOT a message — surface it as its own event so
  // the ingest can patch the target message instead of creating a standalone note.
  const reactionNode = pick(waMsg, "reactionMessage", "ReactionMessage");
  if (reactionNode) {
    const parsedReaction = reactionFrom(reactionNode);
    if (!parsedReaction) return { kind: "ignored", reason: "reaction without target id" };
    return {
      kind: "reaction",
      reaction: {
        targetExternalId: parsedReaction.targetExternalId,
        emoji: parsedReaction.emoji,
        from,
        senderName: profileName,
        timestamp,
      },
    };
  }

  const extracted = extractContent(waMsg);

  return {
    kind: "message",
    message: {
      externalId,
      from,
      profileName,
      timestamp,
      contentType: extracted.contentType,
      content: extracted.content,
      ...(extracted.media ? { media: extracted.media } : {}),
      metadata: extracted.metadataExtra,
    },
  };
}

/**
 * Map whatsmeow ReceiptType → our deliveryStatus union (schema: sent | delivered
 * | read | failed). Receipt types confirmed against the real gateway in the
 * 2026-07-19 pilot.
 */
function mapReceiptType(t: string): "delivered" | "read" | "failed" | null {
  switch (t) {
    case "": // ReceiptTypeDelivered is the empty string
    case "delivery":
    case "delivered":
    case "Delivered":
      return "delivered";
    case "read":
    case "Read":
      return "read";
    case "played": // no dedicated "played" state — a played voice note was read
    case "Played":
      return "read";
    case "server-error":
    case "ServerError":
      return "failed";
    // read-self / played-self are our own other devices — not a customer signal
    default:
      return null;
  }
}

function parseReceipt(event: Record<string, any>): ParsedBridgeEvent {
  // A receipt about our sent message comes FROM the recipient (IsFromMe false).
  // An IsFromMe receipt would be our own read on another device — ignore it.
  if (event?.IsFromMe === true || event?.isFromMe === true) {
    return { kind: "ignored", reason: "receipt fromMe" };
  }
  const ids = pick(event, "MessageIDs", "MessageIds", "messageIds", "IDs", "Ids");
  const externalIds: string[] = Array.isArray(ids)
    ? ids.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const rawType = pick(event, "Type", "type");
  const status = mapReceiptType(typeof rawType === "string" ? rawType : "");
  if (!status || externalIds.length === 0) {
    return { kind: "ignored", reason: "receipt without mappable status/ids" };
  }
  return { kind: "receipt", receipt: { status, externalIds } };
}

/**
 * Parse one wuzapi webhook payload into a message, a receipt, or an ignored
 * result. Never throws — unrecognized shapes return { kind: "ignored" }.
 *
 * VALIDAR: assumed envelope is `{ type, token, event: <whatsmeow event> }`.
 * If wuzapi nests differently (e.g. flattens the event onto the top level or
 * uses `data`/`jsonData`), the fallbacks below still try to recover it.
 */
export function parseBridgeEvent(payload: unknown): ParsedBridgeEvent {
  const p = payload as Record<string, any> | null;
  if (!p || typeof p !== "object") return { kind: "ignored", reason: "empty" };

  // Nome do evento: `type` (envelope clássico) ou `event` quando este é string
  // (envelope alternativo `{event: "ChatPresence", data: {...}}` visto na doc).
  const type =
    typeof p.type === "string"
      ? p.type
      : typeof p.Type === "string"
        ? p.Type
        : typeof p.event === "string"
          ? p.event
          : typeof p.Event === "string"
            ? p.Event
            : undefined;
  // The whatsmeow event body — nested under `event`/`data`, else the payload
  // itself. Só valores-objeto contam (em um dos envelopes `event` é a string acima).
  const bodyCandidate = [p.event, p.Event, p.data, p.Data].find(
    (x) => x !== null && typeof x === "object"
  );
  const event = (bodyCandidate ?? p) as Record<string, any>;

  const t = (type ?? "").toLowerCase();
  if (t.includes("receipt") || t === "ack") return parseReceipt(event);
  if (t === "chatpresence" || t === "chat_presence") return parseChatPresence(event);
  if (
    t === "message" ||
    pick(event, "Info", "info") !== undefined ||
    pick(event, "Message", "message") !== undefined
  ) {
    return parseMessage(event);
  }
  // Presence, HistorySync, Connected, etc. — not ingested here
  return { kind: "ignored", reason: type ? `unhandled type ${type}` : "unrecognized" };
}

/**
 * whatsmeow ChatPresence: { Chat, Sender, IsFromMe, IsGroup, State, Media }.
 * Só interessa "digitando/parou" de contato em chat 1:1 — self/grupo é ignorado.
 */
function parseChatPresence(event: Record<string, any>): ParsedBridgeEvent {
  const chatJid = String(pick(event, "Chat", "chat") ?? "");
  const senderJid = String(pick(event, "Sender", "sender") ?? "");
  if (
    pick(event, "IsFromMe", "isFromMe") === true ||
    pick(event, "IsGroup", "isGroup") === true ||
    chatJid.endsWith("@g.us") ||
    senderJid.endsWith("@g.us")
  ) {
    return { kind: "ignored", reason: "presence from self/group" };
  }
  const rawState = String(pick(event, "State", "state") ?? "").toLowerCase();
  const state =
    rawState === "composing" ? "composing" : rawState === "paused" ? "paused" : null;
  const phone = jidToPhone(senderJid) ?? jidToPhone(chatJid);
  if (!state || !phone) return { kind: "ignored", reason: "presence without state/phone" };
  return { kind: "chat_presence", presence: { phone, state } };
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify the wuzapi webhook HMAC-SHA256 of the raw body with the shared secret.
 * Constant-time comparison.
 *
 * The gateway sends `x-hmac-signature` carrying raw lowercase hex (confirmed in
 * the 2026-07-19 pilot). We tolerate an optional `sha256=` prefix so a
 * Meta-style header also verifies.
 */
export async function verifyBridgeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!signatureHeader) return false;
  const provided = signatureHeader.replace(/^sha256=/i, "").trim().toLowerCase();
  if (provided.length === 0) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = hexEncode(new Uint8Array(mac));

  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
