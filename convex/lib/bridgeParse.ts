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
  from: string; // CONTACT phone digits (E.164 without '+') — the other side of the chat
  // true quando a mensagem saiu do NOSSO número: ou é o eco do que o CRM
  // acabou de enviar (absorvido pela idempotência de externalId), ou alguém
  // digitou no app do celular. Nos dois casos a mensagem é `outbound`.
  fromMe: boolean;
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
  // Preenchidos SÓ em recibo de grupo: o JID da sala e quem confirmou. Num
  // grupo o recibo chega uma vez por membro, então `readBy` precisa saber quem.
  chatJid?: string;
  readerJid?: string;
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

// ── Grupos (v0.57) ──
//
// Um grupo NÃO é um contato: o parser nunca tenta virar `@g.us` em telefone
// (`jidToPhone` devolveria o id numérico da sala como se fosse um MSISDN). O
// autor é um MEMBRO, identificado pelo LID (`Info.Sender` no modo "lid") e/ou
// pelo telefone (`Info.SenderAlt`). O nome só existe no `PushName`.

/** Uma mensagem dentro de um grupo monitorado (ou não — quem filtra é o ingest). */
export interface ParsedBridgeGroupMessage {
  chatJid: string; // "1203…@g.us"
  externalId: string;
  fromMe: boolean;
  senderLid?: string; // "…@lid" — chave estável do membro
  senderPhone?: string; // dígitos, quando o evento expõe o MSISDN
  senderName?: string; // PushName (undefined quando fromMe — o nome seria o nosso)
  timestamp: number;
  contentType: "text" | "image" | "file" | "audio";
  content: string;
  media?: ParsedBridgeMedia;
  mentions?: string[]; // ContextInfo.MentionedJID, como veio (LID ou telefone)
  quote?: { stanzaId: string; participant?: string };
  metadata: Record<string, unknown>;
}

/** Reação de um membro a uma mensagem do grupo. */
export interface ParsedBridgeGroupReaction {
  chatJid: string;
  targetExternalId: string;
  emoji: string; // "" = reação removida
  senderLid?: string;
  senderPhone?: string;
  senderName?: string;
  timestamp: number;
}

/** whatsmeow `GroupInfo`: alguma coisa mudou num grupo em que estamos. */
export interface ParsedBridgeGroupInfoEvent {
  jid: string;
  actorJid?: string; // quem fez a mudança (Sender)
  timestamp: number;
  name?: string;
  topic?: string;
  isLocked?: boolean;
  isAnnounce?: boolean;
  join: string[];
  leave: string[];
  promote: string[];
  demote: string[];
  joinReason?: string;
  newInviteLink?: string;
}

/** whatsmeow `JoinedGroup`: nós entramos (ou fomos adicionados). */
export interface ParsedBridgeJoinedGroup {
  jid: string;
  reason?: string;
  type?: string; // "new" quando o grupo acabou de ser criado
  timestamp: number;
  /** O `GroupInfo` embutido, cru — normalizado por `lib/bridgeGroups.ts`. */
  groupInfoRaw: Record<string, unknown>;
}

/** Alguém digitando dentro de um grupo. */
export interface ParsedBridgeGroupPresence {
  chatJid: string;
  senderLid?: string;
  senderPhone?: string;
  state: "composing" | "paused";
}

export type ParsedBridgeEvent =
  | { kind: "message"; message: ParsedBridgeInbound }
  | { kind: "receipt"; receipt: ParsedBridgeReceipt }
  | { kind: "reaction"; reaction: ParsedBridgeReaction }
  | { kind: "chat_presence"; presence: ParsedBridgePresence }
  | { kind: "group_message"; message: ParsedBridgeGroupMessage }
  | { kind: "group_reaction"; reaction: ParsedBridgeGroupReaction }
  | { kind: "group_info"; info: ParsedBridgeGroupInfoEvent }
  | { kind: "joined_group"; joined: ParsedBridgeJoinedGroup }
  | { kind: "group_presence"; presence: ParsedBridgeGroupPresence }
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

/**
 * O nó ContextInfo da mensagem, venha ele do texto estendido ou de uma mídia.
 * É onde moram menções (`mentionedJid`), quote (`stanzaId`/`participant`) e o
 * `expiration` das mensagens temporárias.
 */
function contextInfoOf(waMsg: Record<string, any>): Record<string, any> | undefined {
  const node =
    pick(waMsg, "extendedTextMessage", "ExtendedTextMessage") ??
    pick(waMsg, "imageMessage", "ImageMessage") ??
    pick(waMsg, "stickerMessage", "StickerMessage") ??
    pick(waMsg, "audioMessage", "AudioMessage") ??
    pick(waMsg, "videoMessage", "VideoMessage") ??
    pick(waMsg, "documentMessage", "DocumentMessage");
  const ci = pick(node, "contextInfo", "ContextInfo");
  return ci && typeof ci === "object" ? (ci as Record<string, any>) : undefined;
}

/** JIDs mencionados na mensagem (podem vir em LID ou em telefone). */
function mentionsFrom(ci: Record<string, any> | undefined): string[] {
  const raw = pick(ci, "mentionedJid", "mentionedJID", "MentionedJID", "MentionedJid");
  if (!Array.isArray(raw)) return [];
  return raw.filter((j): j is string => typeof j === "string" && j.length > 0);
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

  // Mensagem que saiu do NOSSO número. Até a v0.55 era descartada aqui para
  // evitar o eco do que o próprio CRM enviava — só que o WhatsApp multi-device
  // manda o MESMO evento para o eco e para o que um humano digita no app do
  // celular, então descartar os dois fazia a conversa do inbox divergir da
  // conversa real. Agora segue como `outbound`: o eco morre na idempotência de
  // `externalId` (o envio já gravou o id), o do aparelho entra como mensagem.
  const fromMe = info.IsFromMe === true || info.isFromMe === true;

  const chatJid = String(pick(info, "Chat", "chat") ?? "");
  const senderJid = String(pick(info, "Sender", "sender") ?? "");
  // Grupo tem caminho PRÓPRIO desde a v0.57: o chat é uma sala (`@g.us`, que
  // `jidToPhone` transformaria num MSISDN falso) e o autor é um membro. Quem
  // decide ingerir ou descartar é o ingest, que sabe se o grupo é monitorado.
  if (
    info.IsGroup === true ||
    info.isGroup === true ||
    chatJid.endsWith("@g.us") ||
    senderJid.endsWith("@g.us")
  ) {
    return parseGroupMessage(info, waMsg, chatJid, senderJid, fromMe);
  }

  const externalId = pick(info, "ID", "Id", "id");
  // CONFIRMADO no piloto: com privacy LID ativo, Sender/Chat vêm como "…@lid"
  // (dígitos NÃO são o telefone) e o MSISDN real vem em SenderAlt
  // ("5581…@s.whatsapp.net"). Preferir o primeiro candidato não-LID; se só
  // houver LID, ignorar em vez de criar um contato com número falso.
  //
  // `from` é sempre o TELEFONE DO CONTATO (a outra ponta da conversa), porque é
  // ele que resolve contato/lead. Numa mensagem nossa o `Sender` somos nós, então
  // o telefone tem de sair do `Chat` — usar `Sender` aqui criaria um lead com o
  // nosso próprio número a cada mensagem enviada pelo aparelho.
  const senderAltJid = String(pick(info, "SenderAlt", "senderAlt") ?? "");
  const chatAltJid = String(pick(info, "ChatAlt", "chatAlt", "RecipientAlt", "recipientAlt") ?? "");
  const candidates = fromMe
    ? [chatJid, chatAltJid]
    : [senderJid, senderAltJid, chatJid];
  const phoneJid = candidates.find((j) => j && !isLidJid(j));
  if (!phoneJid) {
    return { kind: "ignored", reason: "lid-only sender (no phone JID)" };
  }
  const from = jidToPhone(phoneJid);
  if (typeof externalId !== "string" || externalId.length === 0 || !from) {
    return { kind: "ignored", reason: "missing id or sender" };
  }

  // `PushName` é o nome de quem ENVIOU. Na mensagem que sai do nosso número esse
  // nome é o NOSSO — propagá-lo renomearia o contato a cada envio pelo aparelho.
  const profileName = fromMe ? undefined : strUndef(pick(info, "PushName", "pushName"));
  const timestamp = parseTimestamp(pick(info, "Timestamp", "timestamp"));

  // A reaction from the contact is NOT a message — surface it as its own event so
  // the ingest can patch the target message instead of creating a standalone note.
  const reactionNode = pick(waMsg, "reactionMessage", "ReactionMessage");
  if (reactionNode) {
    // A NOSSA reação (do inbox ou do aparelho) continua fora: o ingest grava
    // reação sempre com `sender: "contact"`, então deixar passar atribuiria ao
    // contato um emoji que fomos nós que pusemos.
    if (fromMe) return { kind: "ignored", reason: "reaction fromMe" };
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
      fromMe,
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
 * Mensagem dentro de um grupo (`Info.IsGroup`), incluindo reação de membro.
 *
 * Identidade do autor, medida no gateway real (16/09/2026, modo `lid`):
 *  - `Info.Sender` = "…@lid" (id de privacidade, NÃO é telefone);
 *  - `Info.SenderAlt` = "5581…@s.whatsapp.net" (o MSISDN);
 *  - em grupo modo `pn` os dois papéis se invertem, então olhamos o SUFIXO de
 *    cada JID em vez de confiar na posição.
 *
 * `PushName` é do membro que falou — a ÚNICA fonte de nome (o gateway devolve
 * `DisplayName` vazio em `/group/info`). Quando a mensagem é nossa (`fromMe`) o
 * PushName é o NOSSO, então é descartado, mesma regra do 1:1.
 */
function parseGroupMessage(
  info: Record<string, any>,
  waMsg: Record<string, any>,
  chatJid: string,
  senderJid: string,
  fromMe: boolean
): ParsedBridgeEvent {
  if (!chatJid.endsWith("@g.us")) {
    // `IsGroup` sem um chat `@g.us`: payload inconsistente — não inventar sala.
    return { kind: "ignored", reason: "group event without group chat jid" };
  }
  const externalId = strUndef(pick(info, "ID", "Id", "id"));
  if (!externalId) return { kind: "ignored", reason: "group message without id" };

  const senderAltJid = String(pick(info, "SenderAlt", "senderAlt") ?? "");
  const senderCandidates = [senderJid, senderAltJid].filter((j) => j && !j.endsWith("@g.us"));
  const senderLid = senderCandidates.find((j) => isLidJid(j));
  const phoneJid = senderCandidates.find((j) => !isLidJid(j));
  const senderPhone = phoneJid ? jidToPhone(phoneJid) ?? undefined : undefined;
  const senderName = fromMe ? undefined : strUndef(pick(info, "PushName", "pushName"));
  const timestamp = parseTimestamp(pick(info, "Timestamp", "timestamp"));

  // Reação: não é mensagem — o ingest usa para patchar a mensagem alvo.
  const reactionNode = pick(waMsg, "reactionMessage", "ReactionMessage");
  if (reactionNode) {
    // A NOSSA reação fica fora: o ingest grava reação com autoria de membro, e
    // deixar passar atribuiria a um participante um emoji que fomos nós que pusemos.
    if (fromMe) return { kind: "ignored", reason: "group reaction fromMe" };
    const parsedReaction = reactionFrom(reactionNode);
    if (!parsedReaction) return { kind: "ignored", reason: "group reaction without target id" };
    return {
      kind: "group_reaction",
      reaction: {
        chatJid,
        targetExternalId: parsedReaction.targetExternalId,
        emoji: parsedReaction.emoji,
        ...(senderLid ? { senderLid } : {}),
        ...(senderPhone ? { senderPhone } : {}),
        ...(senderName ? { senderName } : {}),
        timestamp,
      },
    };
  }

  const extracted = extractContent(waMsg);
  const ci = contextInfoOf(waMsg);
  const mentions = mentionsFrom(ci);
  const stanzaId = strUndef(pick(ci, "stanzaId", "stanzaID", "StanzaID", "StanzaId"));
  // Em grupo o quote SÓ renderiza com o JID do autor da mensagem citada.
  const quoteParticipant = strUndef(pick(ci, "participant", "Participant"));

  return {
    kind: "group_message",
    message: {
      chatJid,
      externalId,
      fromMe,
      ...(senderLid ? { senderLid } : {}),
      ...(senderPhone ? { senderPhone } : {}),
      ...(senderName ? { senderName } : {}),
      timestamp,
      contentType: extracted.contentType,
      content: extracted.content,
      ...(extracted.media ? { media: extracted.media } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(stanzaId
        ? { quote: { stanzaId, ...(quoteParticipant ? { participant: quoteParticipant } : {}) } }
        : {}),
      metadata: extracted.metadataExtra,
    },
  };
}

/**
 * Teto de itens de UMA lista do evento `GroupInfo`.
 *
 * Cada entrada custa um `mergeParticipant` LINEAR sobre a lista guardada e uma
 * linha na timeline, dentro de UMA mutation. Um evento com milhares de entradas
 * faria trabalho quadrático e estouraria a transação. O HMAC prova que o payload
 * veio do gateway — não que o gateway está íntegro nem que o whatsmeow não vai
 * emitir um evento patológico (review de segurança nº 7). O valor é o mesmo
 * `GROUP_PARTICIPANTS_CAP` do núcleo (limite estrutural do WhatsApp); duplicado
 * aqui porque o parser é PURO e não importa nada de `lib/groupChatCore`.
 */
const GROUP_EVENT_JID_CAP = 1024;

/** Lista de JIDs de um campo do evento GroupInfo (Join/Leave/Promote/Demote). */
function jidList(event: Record<string, any>, ...keys: string[]): string[] {
  const raw = pick(event, ...keys);
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (out.length >= GROUP_EVENT_JID_CAP) break;
    if (typeof item === "string" && item.length > 0) out.push(item);
    // whatsmeow serializa types.JID como string, mas uma variante em objeto
    // ({User, Server}) já apareceu em forks — aceitar não custa nada.
    else if (item && typeof item === "object") {
      const user = strUndef(pick(item as Record<string, any>, "User", "user"));
      const server = strUndef(pick(item as Record<string, any>, "Server", "server"));
      if (user) out.push(server ? `${user}@${server}` : user);
    }
  }
  return out;
}

/**
 * whatsmeow `GroupInfo` — mudou nome/tópico/config, ou entrou/saiu/foi
 * promovido alguém. `Name`/`Topic` são structs aninhadas (`{Name: "..."}`),
 * e vêm AUSENTES quando não foi isso que mudou: só patcha o que veio.
 *
 * FIXTURE SINTÉTICA: montada a partir das structs do whatsmeow
 * (`types/events.GroupInfo`) — este evento ainda não foi capturado do gateway
 * real (a assinatura só passa a incluí-lo a partir desta versão).
 */
function parseGroupInfoEvent(event: Record<string, any>): ParsedBridgeEvent {
  const jid = strUndef(pick(event, "JID", "jid"));
  if (!jid || !jid.endsWith("@g.us")) {
    return { kind: "ignored", reason: "group info without group jid" };
  }
  const nameNode = pick(event, "Name", "name");
  const topicNode = pick(event, "Topic", "topic");
  const lockedNode = pick(event, "Locked", "locked");
  const announceNode = pick(event, "Announce", "announce");

  const name =
    typeof nameNode === "string"
      ? strUndef(nameNode)
      : strUndef(pick(nameNode, "Name", "name"));
  const topic =
    typeof topicNode === "string"
      ? topicNode
      : typeof pick(topicNode, "Topic", "topic") === "string"
        ? (pick(topicNode, "Topic", "topic") as string)
        : undefined;
  const isLocked =
    typeof lockedNode === "boolean"
      ? lockedNode
      : typeof pick(lockedNode, "IsLocked", "isLocked") === "boolean"
        ? (pick(lockedNode, "IsLocked", "isLocked") as boolean)
        : undefined;
  const isAnnounce =
    typeof announceNode === "boolean"
      ? announceNode
      : typeof pick(announceNode, "IsAnnounce", "isAnnounce") === "boolean"
        ? (pick(announceNode, "IsAnnounce", "isAnnounce") as boolean)
        : undefined;

  return {
    kind: "group_info",
    info: {
      jid,
      ...(strUndef(pick(event, "Sender", "sender"))
        ? { actorJid: strUndef(pick(event, "Sender", "sender")) }
        : {}),
      timestamp: parseTimestamp(pick(event, "Timestamp", "timestamp")),
      ...(name !== undefined ? { name } : {}),
      ...(topic !== undefined ? { topic } : {}),
      ...(isLocked !== undefined ? { isLocked } : {}),
      ...(isAnnounce !== undefined ? { isAnnounce } : {}),
      join: jidList(event, "Join", "join"),
      leave: jidList(event, "Leave", "leave"),
      promote: jidList(event, "Promote", "promote"),
      demote: jidList(event, "Demote", "demote"),
      ...(strUndef(pick(event, "JoinReason", "joinReason"))
        ? { joinReason: strUndef(pick(event, "JoinReason", "joinReason")) }
        : {}),
      ...(strUndef(pick(event, "NewInviteLink", "newInviteLink"))
        ? { newInviteLink: strUndef(pick(event, "NewInviteLink", "newInviteLink")) }
        : {}),
    },
  };
}

/**
 * whatsmeow `JoinedGroup` — entramos num grupo (ou fomos adicionados). O
 * `GroupInfo` completo vem EMBUTIDO (mesma struct de `/group/info`), então o
 * corpo cru segue para `lib/bridgeGroups.parseGroupInfoStruct`, que é a
 * referência única de normalização de grupo.
 *
 * FIXTURE SINTÉTICA — mesma ressalva de `parseGroupInfoEvent`.
 */
function parseJoinedGroupEvent(event: Record<string, any>): ParsedBridgeEvent {
  // O struct do grupo pode estar embutido (campos no topo) ou aninhado.
  const nested = pick(event, "GroupInfo", "groupInfo");
  const groupRaw = (nested && typeof nested === "object" ? nested : event) as Record<string, any>;
  const jid = strUndef(pick(groupRaw, "JID", "jid"));
  if (!jid || !jid.endsWith("@g.us")) {
    return { kind: "ignored", reason: "joined group without group jid" };
  }
  return {
    kind: "joined_group",
    joined: {
      jid,
      ...(strUndef(pick(event, "Reason", "reason"))
        ? { reason: strUndef(pick(event, "Reason", "reason")) }
        : {}),
      ...(strUndef(pick(event, "Type", "type"))
        ? { type: strUndef(pick(event, "Type", "type")) }
        : {}),
      timestamp: parseTimestamp(pick(groupRaw, "GroupCreated", "groupCreated")),
      groupInfoRaw: groupRaw,
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
  const chatJid = String(pick(event, "Chat", "chat") ?? "");
  const isGroup =
    pick(event, "IsGroup", "isGroup") === true || chatJid.endsWith("@g.us");

  // A receipt about our sent message comes FROM the recipient (IsFromMe false).
  // An IsFromMe receipt would be our own read on another device — ignore it.
  //
  // EXCEÇÃO DE GRUPO: num recibo de grupo o `Sender` do evento é a NOSSA conta
  // (somos o dono da mensagem confirmada) e quem leu vem em `MessageSender`,
  // então `IsFromMe` vem true no caminho normal. Aplicar o descarte aqui
  // mataria TODO recibo de grupo. A leitura do próprio aparelho continua fora
  // por outro caminho: `read-self`/`played-self` não mapeiam para status algum.
  if (!isGroup && (event?.IsFromMe === true || event?.isFromMe === true)) {
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
  if (!isGroup) return { kind: "receipt", receipt: { status, externalIds } };

  // Quem confirmou: `MessageSender` é o campo documentado; `Sender`/`Participant`
  // ficam como reserva defensiva (a sala nunca serve de leitor).
  const readerJid = [
    strUndef(pick(event, "MessageSender", "messageSender")),
    strUndef(pick(event, "Participant", "participant")),
    strUndef(pick(event, "Sender", "sender")),
  ].find((j) => j !== undefined && !j.endsWith("@g.us"));

  return {
    kind: "receipt",
    receipt: {
      status,
      externalIds,
      chatJid,
      ...(readerJid ? { readerJid } : {}),
    },
  };
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
  if (t === "groupinfo" || t === "group_info") return parseGroupInfoEvent(event);
  if (t === "joinedgroup" || t === "joined_group") return parseJoinedGroupEvent(event);
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
 * Chat 1:1 → "digitando/parou" do contato. Grupo → quem digita é um MEMBRO
 * (`group_presence`, com LID/telefone em vez do telefone do chat). Presença do
 * nosso próprio aparelho é descartada nos dois casos.
 */
function parseChatPresence(event: Record<string, any>): ParsedBridgeEvent {
  const chatJid = String(pick(event, "Chat", "chat") ?? "");
  const senderJid = String(pick(event, "Sender", "sender") ?? "");
  const fromMe = pick(event, "IsFromMe", "isFromMe") === true;
  const rawState = String(pick(event, "State", "state") ?? "").toLowerCase();
  const state =
    rawState === "composing" ? "composing" : rawState === "paused" ? "paused" : null;

  const isGroup = pick(event, "IsGroup", "isGroup") === true || chatJid.endsWith("@g.us");
  if (isGroup) {
    if (fromMe) return { kind: "ignored", reason: "group presence from self" };
    if (!state || !chatJid.endsWith("@g.us")) {
      return { kind: "ignored", reason: "group presence without state/chat" };
    }
    const senderAltJid = String(pick(event, "SenderAlt", "senderAlt") ?? "");
    const candidates = [senderJid, senderAltJid].filter((j) => j && !j.endsWith("@g.us"));
    const senderLid = candidates.find((j) => isLidJid(j));
    const phoneJid = candidates.find((j) => !isLidJid(j));
    return {
      kind: "group_presence",
      presence: {
        chatJid,
        ...(senderLid ? { senderLid } : {}),
        ...(phoneJid && jidToPhone(phoneJid) ? { senderPhone: jidToPhone(phoneJid)! } : {}),
        state,
      },
    };
  }

  if (fromMe || senderJid.endsWith("@g.us")) {
    return { kind: "ignored", reason: "presence from self/group" };
  }
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
