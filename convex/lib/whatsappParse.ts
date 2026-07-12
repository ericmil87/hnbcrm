/**
 * Pure parsing of Meta WhatsApp Cloud API webhook payloads + signature
 * verification. No Convex context — unit-testable in isolation.
 */

export interface ParsedInboundMessage {
  externalId: string; // wamid — globally unique, used for idempotency
  from: string; // sender wa_id (phone digits)
  profileName?: string;
  timestamp: number; // ms epoch
  contentType: "text" | "image" | "file" | "audio";
  content: string;
  media?: { id: string; mimeType?: string; filename?: string };
  metadata: Record<string, unknown>;
}

export interface ParsedStatusUpdate {
  externalId: string; // wamid of the outbound message this status refers to
  status: "sent" | "delivered" | "read" | "failed";
  errorDetail?: string;
}

export interface ParsedWebhookValue {
  messages: ParsedInboundMessage[];
  statuses: ParsedStatusUpdate[];
}

/** Extract phone_number_id from an UNTRUSTED payload (pre-signature routing key). */
export function extractPhoneNumberId(payload: unknown): string | null {
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const id = (change as { value?: { metadata?: { phone_number_id?: unknown } } })
        ?.value?.metadata?.phone_number_id;
      if (typeof id === "string" && id.length > 0) return id;
    }
  }
  return null;
}

function parseMessage(
  message: Record<string, any>,
  contacts: Array<Record<string, any>> | undefined
): ParsedInboundMessage | null {
  const wamid = message.id;
  const from = message.from;
  if (typeof wamid !== "string" || typeof from !== "string") return null;

  const profileName = contacts?.find((c) => c.wa_id === from)?.profile?.name
    ?? contacts?.[0]?.profile?.name;
  const timestamp = Number(message.timestamp) * 1000 || Date.now();
  const type = message.type as string;

  const base = {
    externalId: wamid,
    from,
    profileName: typeof profileName === "string" ? profileName : undefined,
    timestamp,
  };
  const metadata: Record<string, unknown> = { whatsappType: type };

  switch (type) {
    case "text":
      return { ...base, contentType: "text", content: message.text?.body ?? "", metadata };
    case "image":
      return {
        ...base,
        contentType: "image",
        content: message.image?.caption ?? "[imagem]",
        media: { id: message.image?.id, mimeType: message.image?.mime_type },
        metadata,
      };
    case "sticker":
      return {
        ...base,
        contentType: "image",
        content: "[figurinha]",
        media: { id: message.sticker?.id, mimeType: message.sticker?.mime_type },
        metadata,
      };
    case "audio":
      return {
        ...base,
        contentType: "audio",
        content: message.audio?.voice ? "[mensagem de voz]" : "[áudio]",
        media: { id: message.audio?.id, mimeType: message.audio?.mime_type },
        metadata,
      };
    case "video":
      return {
        ...base,
        contentType: "file",
        content: message.video?.caption ?? "[vídeo]",
        media: { id: message.video?.id, mimeType: message.video?.mime_type },
        metadata,
      };
    case "document":
      return {
        ...base,
        contentType: "file",
        content: message.document?.caption ?? message.document?.filename ?? "[documento]",
        media: {
          id: message.document?.id,
          mimeType: message.document?.mime_type,
          filename: message.document?.filename,
        },
        metadata,
      };
    case "interactive": {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
      return {
        ...base,
        contentType: "text",
        content: reply?.title ?? "[resposta interativa]",
        metadata: {
          ...metadata,
          interactiveType: message.interactive?.type,
          replyId: reply?.id,
          replyDescription: reply?.description,
        },
      };
    }
    case "button":
      // Template quick-reply button
      return {
        ...base,
        contentType: "text",
        content: message.button?.text ?? "[resposta de botão]",
        metadata: { ...metadata, buttonPayload: message.button?.payload },
      };
    case "location": {
      const loc = message.location ?? {};
      const label = [loc.name, loc.address].filter(Boolean).join(" — ");
      return {
        ...base,
        contentType: "text",
        content: `Localização: ${loc.latitude}, ${loc.longitude}${label ? ` (${label})` : ""}`,
        metadata: { ...metadata, location: loc },
      };
    }
    case "contacts": {
      const shared = (message.contacts ?? [])
        .map((c: Record<string, any>) => {
          const name = c.name?.formatted_name ?? "";
          const phone = c.phones?.[0]?.phone ?? "";
          return [name, phone].filter(Boolean).join(" ");
        })
        .filter(Boolean)
        .join("; ");
      return {
        ...base,
        contentType: "text",
        content: `Contato compartilhado: ${shared || "(sem dados)"}`,
        metadata: { ...metadata, contacts: message.contacts },
      };
    }
    case "reaction":
      return {
        ...base,
        contentType: "text",
        content: `Reagiu com ${message.reaction?.emoji ?? "?"}`,
        metadata: { ...metadata, reactionTo: message.reaction?.message_id },
      };
    default:
      return {
        ...base,
        contentType: "text",
        content: `[unsupported message type: ${type}]`,
        metadata: { ...metadata, raw: message },
      };
  }
}

function parseStatus(status: Record<string, any>): ParsedStatusUpdate | null {
  const wamid = status.id;
  const value = status.status;
  if (typeof wamid !== "string") return null;
  if (value !== "sent" && value !== "delivered" && value !== "read" && value !== "failed") {
    return null;
  }
  const errors = Array.isArray(status.errors) ? status.errors : [];
  const errorDetail = errors.length
    ? errors
        .map((e: Record<string, any>) =>
          [e.code, e.title, e.error_data?.details].filter(Boolean).join(": ")
        )
        .join(" | ")
    : undefined;
  return { externalId: wamid, status: value, errorDetail };
}

/** Parse every `field: "messages"` change in a (signature-verified) payload. */
export function parseWebhookPayload(payload: Record<string, any>): ParsedWebhookValue {
  const messages: ParsedInboundMessage[] = [];
  const statuses: ParsedStatusUpdate[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      for (const raw of value.messages ?? []) {
        const parsed = parseMessage(raw, value.contacts);
        if (parsed) messages.push(parsed);
      }
      for (const raw of value.statuses ?? []) {
        const parsed = parseStatus(raw);
        if (parsed) statuses.push(parsed);
      }
    }
  }

  return { messages, statuses };
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with
 * the app secret). Constant-time comparison.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length).toLowerCase();

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
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
