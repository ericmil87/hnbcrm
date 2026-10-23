/**
 * Parser puro dos webhooks Meta Messaging: `object:"page"` (Messenger) e
 * `object:"instagram"` (sem rede, sem ctx; modelo `lib/whatsappParse.ts`).
 *
 * NUNCA lança: payload lixo vira `{ object: null, events: [] }` ou evento
 * `unknown`. Eventos saem ORDENADOS por `timestamp` dentro do lote (a Meta pode
 * entregar fora de ordem).
 */
import { verifyWebhookSignature } from "./whatsappParse";

export type MetaSurface = "messenger" | "instagram";

export type MetaAttachment = {
  type:
    | "image"
    | "video"
    | "audio"
    | "file"
    | "story_mention"
    | "ig_post"
    | "ig_reel"
    | "like_heart"
    | "sticker"
    | "fallback"
    | "other";
  url?: string;
  mediaId?: string;
  title?: string;
  stickerId?: number;
};

export type MetaReferral = {
  source?: string;
  type?: string;
  ref?: string;
  adId?: string;
};

export type MetaEvent = { surface: MetaSurface; accountId: string } & (
  | {
      kind: "message";
      userId: string;
      mid: string;
      timestamp: number;
      text?: string;
      attachments: MetaAttachment[];
      replyToMid?: string;
      storyReply?: { url?: string; id?: string };
      quickReplyPayload?: string;
      referral?: MetaReferral;
      standby?: boolean;
    }
  | {
      kind: "echo";
      userId: string; // = recipient (o cliente)
      mid: string;
      timestamp: number;
      appId?: string;
      metadata?: string;
      text?: string;
      attachments: MetaAttachment[];
    }
  | { kind: "delivery"; userId: string; mids: string[]; watermark: number }
  | { kind: "read"; userId: string; watermark?: number; mid?: string }
  | {
      kind: "reaction";
      userId: string;
      mid: string;
      action: "react" | "unreact";
      reaction?: string;
      emoji?: string;
    }
  | { kind: "postback"; userId: string; mid?: string; title: string; payload: string; timestamp: number }
  | { kind: "referral"; userId: string; referral: MetaReferral; timestamp: number }
  | { kind: "deleted"; userId: string; mid: string }
  | { kind: "edited"; userId?: string; mid: string; text?: string }
  | { kind: "unsupported"; userId: string; mid: string; timestamp: number }
  | { kind: "unknown"; field?: string }
);

type Rec = Record<string, unknown>;

function isRec(x: unknown): x is Rec {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function str(x: unknown): string | undefined {
  if (typeof x === "string" && x.length > 0) return x;
  if (typeof x === "number" && Number.isFinite(x)) return String(x);
  return undefined;
}
function num(x: unknown): number | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  return undefined;
}

/** O "curtir" do Messenger chega como sticker com este id [2a]; vira like_heart (D7). */
const LIKE_STICKER_ID = 369239263222822;

function parseAttachments(raw: unknown): MetaAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: MetaAttachment[] = [];
  for (const a of raw) {
    if (!isRec(a)) continue;
    const payload = isRec(a.payload) ? a.payload : {};
    const t = str(a.type) ?? "";
    const url = str(payload.url) ?? str(a.url);
    const title = str(a.title) ?? str(payload.title);
    const stickerId = num(payload.sticker_id);
    const mediaId = str(payload.ig_post_media_id) ?? str(payload.reel_video_id);
    let type: MetaAttachment["type"];
    switch (t) {
      case "image":
      case "video":
      case "audio":
      case "file":
      case "story_mention":
      case "ig_post":
      case "ig_reel":
      case "like_heart":
      case "fallback":
        type = t;
        break;
      case "reel":
        type = "ig_reel";
        break;
      case "share":
        type = "ig_post";
        break;
      default:
        type = "other";
    }
    if (stickerId !== undefined && (type === "image" || type === "other")) {
      type = stickerId === LIKE_STICKER_ID ? "like_heart" : "sticker";
    }
    out.push({
      type,
      ...(url ? { url } : {}),
      ...(mediaId ? { mediaId } : {}),
      ...(title ? { title } : {}),
      ...(stickerId !== undefined ? { stickerId } : {}),
    });
  }
  return out;
}

function parseReferral(raw: unknown): MetaReferral | undefined {
  if (!isRec(raw)) return undefined;
  const ad = isRec(raw.ads_context_data) ? raw.ads_context_data : {};
  const adId = str(raw.ad_id) ?? str(ad.ad_id);
  const r: MetaReferral = {
    ...(str(raw.source) ? { source: str(raw.source) } : {}),
    ...(str(raw.type) ? { type: str(raw.type) } : {}),
    ...(str(raw.ref) ? { ref: str(raw.ref) } : {}),
    ...(adId ? { adId } : {}),
  };
  return Object.keys(r).length > 0 ? r : undefined;
}

type Ranked = { ts: number; idx: number; event: MetaEvent };
type Base = { surface: MetaSurface; accountId: string };

function parseMessagingItem(
  m: Rec,
  base: Base,
  isStandby: boolean,
  fallbackTs: number
): { ts: number; event: MetaEvent } {
  const sender = isRec(m.sender) ? str(m.sender.id) : undefined;
  const recipient = isRec(m.recipient) ? str(m.recipient.id) : undefined;
  const ts = num(m.timestamp) ?? fallbackTs;
  const unknown = (field?: string): { ts: number; event: MetaEvent } => ({
    ts,
    event: { ...base, kind: "unknown", ...(field ? { field } : {}) },
  });

  if (isRec(m.message)) {
    const msg = m.message;
    const mid = str(msg.mid);
    if (msg.is_echo === true) {
      if (!mid || !recipient) return unknown("message_echoes");
      return {
        ts,
        event: {
          ...base,
          kind: "echo",
          userId: recipient,
          mid,
          timestamp: ts,
          ...(str(msg.app_id) ? { appId: str(msg.app_id) } : {}),
          ...(typeof msg.metadata === "string" && msg.metadata ? { metadata: msg.metadata } : {}),
          ...(typeof msg.text === "string" ? { text: msg.text } : {}),
          attachments: parseAttachments(msg.attachments),
        },
      };
    }
    if (!sender || !mid) return unknown("messages");
    if (msg.is_deleted === true) return { ts, event: { ...base, kind: "deleted", userId: sender, mid } };
    if (msg.is_unsupported === true) {
      return { ts, event: { ...base, kind: "unsupported", userId: sender, mid, timestamp: ts } };
    }
    const replyTo = isRec(msg.reply_to) ? msg.reply_to : undefined;
    const story = replyTo && isRec(replyTo.story) ? replyTo.story : undefined;
    const quick = isRec(msg.quick_reply) ? str(msg.quick_reply.payload) : undefined;
    const referral = parseReferral(msg.referral);
    return {
      ts,
      event: {
        ...base,
        kind: "message",
        userId: sender,
        mid,
        timestamp: ts,
        ...(typeof msg.text === "string" ? { text: msg.text } : {}),
        attachments: parseAttachments(msg.attachments),
        ...(replyTo && str(replyTo.mid) ? { replyToMid: str(replyTo.mid) } : {}),
        ...(story
          ? {
              storyReply: {
                ...(str(story.url) ? { url: str(story.url) } : {}),
                ...(str(story.id) ? { id: str(story.id) } : {}),
              },
            }
          : {}),
        ...(quick ? { quickReplyPayload: quick } : {}),
        ...(referral ? { referral } : {}),
        ...(isStandby ? { standby: true } : {}),
      },
    };
  }

  if (isRec(m.delivery)) {
    if (!sender) return unknown("message_deliveries");
    const mids = Array.isArray(m.delivery.mids)
      ? m.delivery.mids.map(str).filter((x): x is string => !!x)
      : [];
    return {
      ts,
      event: { ...base, kind: "delivery", userId: sender, mids, watermark: num(m.delivery.watermark) ?? ts },
    };
  }

  if (isRec(m.read)) {
    if (!sender) return unknown("message_reads");
    const watermark = num(m.read.watermark);
    const mid = str(m.read.mid);
    return {
      ts,
      event: {
        ...base,
        kind: "read",
        userId: sender,
        ...(watermark !== undefined ? { watermark } : {}),
        ...(mid ? { mid } : {}),
      },
    };
  }

  if (isRec(m.reaction)) {
    const mid = str(m.reaction.mid);
    if (!sender || !mid) return unknown("message_reactions");
    return {
      ts,
      event: {
        ...base,
        kind: "reaction",
        userId: sender,
        mid,
        action: m.reaction.action === "unreact" ? "unreact" : "react",
        ...(str(m.reaction.reaction) ? { reaction: str(m.reaction.reaction) } : {}),
        ...(str(m.reaction.emoji) ? { emoji: str(m.reaction.emoji) } : {}),
      },
    };
  }

  if (isRec(m.postback)) {
    if (!sender) return unknown("messaging_postbacks");
    return {
      ts,
      event: {
        ...base,
        kind: "postback",
        userId: sender,
        ...(str(m.postback.mid) ? { mid: str(m.postback.mid) } : {}),
        title: typeof m.postback.title === "string" ? m.postback.title : "",
        payload: typeof m.postback.payload === "string" ? m.postback.payload : "",
        timestamp: ts,
      },
    };
  }

  if (isRec(m.referral)) {
    const referral = parseReferral(m.referral);
    if (!sender || !referral) return unknown("messaging_referrals");
    return { ts, event: { ...base, kind: "referral", userId: sender, referral, timestamp: ts } };
  }

  if (isRec(m.message_edit)) {
    const mid = str(m.message_edit.mid);
    if (!mid) return unknown("message_edits");
    return {
      ts,
      event: {
        ...base,
        kind: "edited",
        ...(sender ? { userId: sender } : {}),
        mid,
        ...(typeof m.message_edit.text === "string" ? { text: m.message_edit.text } : {}),
      },
    };
  }

  return unknown();
}

export function parseMetaMessagingWebhook(body: unknown): {
  object: "page" | "instagram" | null;
  events: MetaEvent[];
} {
  try {
    if (!isRec(body)) return { object: null, events: [] };
    const object = body.object === "page" ? "page" : body.object === "instagram" ? "instagram" : null;
    if (!object || !Array.isArray(body.entry)) return { object: null, events: [] };
    const surface: MetaSurface = object === "page" ? "messenger" : "instagram";

    const ranked: Ranked[] = [];
    let idx = 0;
    for (const entry of body.entry) {
      if (!isRec(entry)) continue;
      const accountId = str(entry.id);
      if (!accountId) continue;
      const base: Base = { surface, accountId };
      const entryTs = num(entry.time) ?? 0;

      for (const [key, standby] of [
        ["messaging", false],
        ["standby", true],
      ] as const) {
        const list = entry[key];
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (!isRec(item)) continue;
          const parsed = parseMessagingItem(item, base, standby, entryTs);
          ranked.push({ ts: parsed.ts, idx: idx++, event: parsed.event });
        }
      }

      if (Array.isArray(entry.changes)) {
        for (const change of entry.changes) {
          if (!isRec(change)) continue;
          const field = str(change.field);
          const value = isRec(change.value) ? change.value : {};
          const edit = isRec(value.message_edit) ? value.message_edit : value;
          const mid = str(edit.mid);
          if ((field === "message_edit" || field === "message_edits") && mid) {
            ranked.push({
              ts: entryTs,
              idx: idx++,
              event: {
                ...base,
                kind: "edited",
                mid,
                ...(typeof edit.text === "string" ? { text: edit.text } : {}),
              },
            });
          } else {
            ranked.push({
              ts: entryTs,
              idx: idx++,
              event: { ...base, kind: "unknown", ...(field ? { field } : {}) },
            });
          }
        }
      }
    }
    ranked.sort((a, b) => a.ts - b.ts || a.idx - b.idx);
    return { object, events: ranked.map((r) => r.event) };
  } catch {
    return { object: null, events: [] };
  }
}

/**
 * Botão "Testar" do App Dashboard: payload com ids sintéticos ("0", "12334",
 * mid "random_mid"). Responde 200 e descarta (nunca roteia para tenant).
 */
export function isTestPayload(body: unknown): boolean {
  try {
    if (!isRec(body) || !Array.isArray(body.entry) || body.entry.length === 0) return false;
    for (const entry of body.entry) {
      if (!isRec(entry)) return false;
      if (str(entry.id) === "0") continue;
      const items = [
        ...(Array.isArray(entry.messaging) ? entry.messaging : []),
        ...(Array.isArray(entry.standby) ? entry.standby : []),
      ];
      const synthetic =
        items.length > 0 &&
        items.every((m) => {
          if (!isRec(m)) return false;
          const senderId = isRec(m.sender) ? str(m.sender.id) : undefined;
          const mid = isRec(m.message) ? str(m.message.mid) : undefined;
          return senderId === "12334" || mid === "random_mid";
        });
      if (!synthetic) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Assinatura `X-Hub-Signature-256` (HMAC-SHA256 do corpo cru com o App Secret). */
export async function verifyMetaSignature(
  rawBody: string,
  header: string | null,
  appSecret: string
): Promise<boolean> {
  if (!appSecret) return false;
  try {
    return await verifyWebhookSignature(rawBody, header, appSecret);
  } catch {
    return false;
  }
}
