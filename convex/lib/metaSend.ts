/**
 * Envio Meta Messaging (Instagram + Messenger), puro: limites, divisão de
 * texto, payloads da Send API, classificação de erro e janela de serviço.
 * Sem ctx, sem rede (D4, §5 do plano). O dispatcher é
 * `metaMessaging.internalDispatchMessage`; a porta é `lib/outboundDispatch.ts`.
 *
 * Limites: Instagram 1000 BYTES UTF-8 por mensagem; Messenger 2000 caracteres
 * (code points), com teto de trabalho de 1900 até medirmos ao vivo.
 */
import type { MetaSurface } from "./metaMessagingParse";

export const TEXT_LIMIT = {
  instagram: { unit: "bytes", max: 1000 },
  messenger: { unit: "chars", max: 2000 },
} as const;

/** Teto efetivo usado na divisão (Messenger com folga até a medição viva). */
const WORKING_MAX: Record<MetaSurface, number> = { instagram: 1000, messenger: 1900 };

export const META_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Conversa aberta por anúncio (Click-to-Messenger / Click-to-Direct): 7 dias. */
export const META_AD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Margem que SÓ a IA aplica (F3). A janela humana é cheia. */
export const META_AI_WINDOW_MARGIN_MS = 15 * 60 * 1000;

export const OUTSIDE_WINDOW_COPY = "Fora da janela de 24 h: aguarde o cliente escrever de novo.";

// ── Divisão de texto ──

const encoder = new TextEncoder();

function measure(s: string, surface: MetaSurface): number {
  if (surface === "instagram") return encoder.encode(s).length;
  let n = 0;
  for (const _ of s) n++; // code points
  return n;
}

/** Grafemas (emoji com ZWJ/tom de pele ficam inteiros); fallback por code point. */
function graphemes(s: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) {
    const out: string[] = [];
    for (const g of new Seg(undefined, { granularity: "grapheme" }).segment(s)) out.push(g.segment);
    return out;
  }
  return Array.from(s);
}

// Níveis de quebra: parágrafo > frase > palavra. O separador fica no fim da unidade.
const LEVELS: RegExp[] = [/(\n\s*\n)/, /(?<=[.!?…])(\s+)/, /(\s+)/];

function unitsAt(text: string, level: number): string[] {
  const parts = text.split(LEVELS[level]);
  const units: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const u = parts[i] + (parts[i + 1] ?? "");
    if (u) units.push(u);
  }
  return units;
}

function atoms(text: string, surface: MetaSurface, max: number, level: number): string[] {
  if (measure(text, surface) <= max) return [text];
  if (level >= LEVELS.length) {
    // Uma "palavra" maior que o limite: corta por grafema, nunca no meio de um.
    const out: string[] = [];
    let cur = "";
    for (const g of graphemes(text)) {
      if (cur && measure(cur + g, surface) > max) {
        out.push(cur);
        cur = "";
      }
      cur += g;
    }
    if (cur) out.push(cur);
    return out;
  }
  const units = unitsAt(text, level);
  if (units.length <= 1) return atoms(text, surface, max, level + 1);
  return units.flatMap((u) => atoms(u, surface, max, level + 1));
}

/**
 * Divide `text` em partes que cabem no limite da superfície, preferindo quebrar
 * entre parágrafos, depois entre frases, depois entre palavras. Partes vazias
 * somem; espaço nas pontas de cada parte é aparado.
 */
export function splitMetaText(text: string, surface: MetaSurface): string[] {
  const max = WORKING_MAX[surface];
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (measure(trimmed, surface) <= max) return [trimmed];

  const pieces: string[] = [];
  let cur = "";
  for (const atom of atoms(trimmed, surface, max, 0)) {
    if (cur && measure((cur + atom).trimEnd(), surface) > max) {
      pieces.push(cur);
      cur = "";
    }
    cur += atom;
  }
  if (cur) pieces.push(cur);
  return pieces.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ── Payloads ──

export type MetaSendPayload = Record<string, unknown>;

export function buildTextPayload(
  surface: MetaSurface,
  userId: string,
  text: string,
  opts: { messageId: string; replyToMid?: string }
): MetaSendPayload {
  return {
    recipient: { id: userId },
    // Messenger: sempre RESPONSE (dentro da janela). Sem tags (HUMAN_AGENT fora).
    ...(surface === "messenger" ? { messaging_type: "RESPONSE" } : {}),
    ...(opts.replyToMid ? { reply_to: { mid: opts.replyToMid } } : {}),
    // `metadata` volta no eco: é como reconhecemos a nossa própria mensagem (D6).
    message: { text, metadata: `hnb:${opts.messageId}` },
  };
}

export type MetaMediaKind = "image" | "audio" | "video" | "file";

/** Formato da Send API para mídia por URL (F2). */
export function buildMediaPayload(
  surface: MetaSurface,
  userId: string,
  kind: MetaMediaKind,
  url: string,
  opts: { messageId: string; replyToMid?: string }
): MetaSendPayload {
  return {
    recipient: { id: userId },
    ...(surface === "messenger" ? { messaging_type: "RESPONSE" } : {}),
    ...(opts.replyToMid ? { reply_to: { mid: opts.replyToMid } } : {}),
    message: {
      attachment: { type: kind, payload: { url, is_reusable: false } },
      metadata: `hnb:${opts.messageId}`,
    },
  };
}

export function buildSenderActionPayload(
  userId: string,
  action: "typing_on" | "typing_off" | "mark_seen"
): MetaSendPayload {
  return { recipient: { id: userId }, sender_action: action };
}

export function mediaKindForMime(surface: MetaSurface, mime: string): MetaMediaKind | null {
  const m = mime.toLowerCase().split(";")[0].trim();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (surface === "messenger") return m ? "file" : null;
  // Instagram aceita arquivo só como PDF.
  return m === "application/pdf" ? "file" : null;
}

// ── Reação de saída (Instagram) ──

/** A Graph só documenta `love` para reagir no Instagram: qualquer emoji vira `love`. */
export function buildReactionPayload(
  userId: string,
  mid: string,
  action: "react" | "unreact"
): MetaSendPayload {
  return {
    recipient: { id: userId },
    sender_action: action,
    payload: action === "react" ? { message_id: mid, reaction: "love" } : { message_id: mid },
  };
}

export const REACTION_NOTE_LOCAL_ONLY = "Reação visível só no HNBCRM";
export const REACTION_NOTE_AS_LOVE = "Enviada como ❤️ (o Instagram só aceita essa reação pela API)";
export const REACTION_NOTE_NO_MID = "Reação visível só no HNBCRM (mensagem sem id da Meta)";

const LOVE_EMOJIS = new Set(["❤️", "❤", "♥️", "♥"]);

/** Nota a gravar em `metadata.reactionNote` (ausente = nada a avisar). `emoji` vazio = remoção. */
export function reactionNoteFor(surface: MetaSurface, emoji: string, hasMid: boolean): string | undefined {
  if (!emoji) return undefined;
  if (surface === "messenger") return REACTION_NOTE_LOCAL_ONLY;
  if (!hasMid) return REACTION_NOTE_NO_MID;
  return LOVE_EMOJIS.has(emoji) ? undefined : REACTION_NOTE_AS_LOVE;
}

// ── Mídia de saída: o que cada superfície aceita ──

const MB = 1024 * 1024;
const IG_IMAGE = new Set(["image/png", "image/jpeg", "image/jpg"]);
const IG_AUDIO = new Set(["audio/aac", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/wav", "audio/x-wav", "audio/wave"]);
const IG_VIDEO = new Set([
  "video/mp4",
  "video/ogg",
  "video/avi",
  "video/x-msvideo",
  "video/quicktime",
  "video/webm",
]);

export type MetaMediaCheck =
  | { ok: true; kind: MetaMediaKind; heavy: boolean }
  | { ok: false; reason: string };

const surfaceName = (s: MetaSurface) => (s === "instagram" ? "Instagram" : "Messenger");

/** Áudio e vídeo contam como envio "pesado" no ritmo do canal (10/s no Instagram). */
export function isHeavyMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return m.startsWith("audio/") || m.startsWith("video/");
}

/**
 * Valida um anexo de saída: tipo aceito pela superfície e tamanho no teto
 * (Instagram: imagem png/jpeg 8 MB; áudio/vídeo/PDF 25 MB; Messenger: 25 MB).
 * Recusa devolve a frase para `dispatchNote`.
 */
export function checkMetaOutboundMedia(
  surface: MetaSurface,
  file: { name: string; mimeType: string; size: number }
): MetaMediaCheck {
  const mime = file.mimeType.toLowerCase().split(";")[0].trim();
  const label = `"${file.name}"`;
  let kind: MetaMediaKind | null = null;
  let max = 25 * MB;
  if (surface === "instagram") {
    if (IG_IMAGE.has(mime)) {
      kind = "image";
      max = 8 * MB;
    } else if (IG_AUDIO.has(mime)) kind = "audio";
    else if (IG_VIDEO.has(mime)) kind = "video";
    else if (mime === "application/pdf") kind = "file";
  } else if (mime.startsWith("image/")) kind = "image";
  else if (mime.startsWith("audio/")) kind = "audio";
  else if (mime.startsWith("video/")) kind = "video";
  else if (mime) kind = "file";
  if (!kind) {
    return { ok: false, reason: `Anexo ${label} não enviado: o ${surfaceName(surface)} não aceita este tipo de arquivo.` };
  }
  if (file.size > max) {
    return {
      ok: false,
      reason: `Anexo ${label} não enviado: passa do limite de ${max / MB} MB do ${surfaceName(surface)}.`,
    };
  }
  return { ok: true, kind, heavy: kind === "audio" || kind === "video" };
}

// ── Erros ──

export type MetaErrorKind =
  | "token_invalid"
  | "outside_window"
  | "rate_limited"
  | "user_unavailable"
  | "no_thread_control"
  | "permission"
  | "bad_request"
  | "transient";

export type MetaErrorClass = {
  kind: MetaErrorKind;
  code?: number;
  subcode?: number;
  userMessage: string;
};

export const META_ERROR_COPY: Record<MetaErrorKind, string> = {
  token_invalid:
    "Este canal precisa ser reconectado: a autorização da Meta expirou ou foi revogada. Reconecte em Configurações > Canais.",
  outside_window: OUTSIDE_WINDOW_COPY,
  rate_limited: "A Meta limitou o envio deste canal por excesso de mensagens. Tente de novo em alguns minutos.",
  user_unavailable: "Esta pessoa não está disponível para receber mensagens agora.",
  no_thread_control:
    "Outro app (ex. Caixa de entrada do Meta Business Suite) controla esta conversa. Defina o HNBCRM como app padrão em Configurações da Página > Mensagens avançadas.",
  permission: "O HNBCRM não tem permissão para enviar nesta conta. Reconecte o canal e confirme as permissões.",
  bad_request: "A Meta recusou a mensagem.",
  transient: "A Meta não respondeu. Tente de novo em instantes.",
};

// Subcódigos conhecidos de "fora da janela" (Messenger 2018278; Instagram 2534022).
// Não medidos ao vivo ainda (§13): os dois caem em código 10.
const OUTSIDE_WINDOW_SUBCODES = new Set([2018278, 2534022]);

function numField(x: unknown): number | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && /^\d+$/.test(x)) return Number(x);
  return undefined;
}

/**
 * Classifica a resposta de erro da Send API. `status` 0 = falha de rede/timeout.
 * Nunca devolve o texto da Meta como `userMessage` (pode citar ids); só o código.
 */
export function classifyMetaError(status: number, body: unknown): MetaErrorClass {
  const err =
    body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object"
      ? (body.error as Record<string, unknown>)
      : {};
  const code = numField(err.code);
  const subcode = numField(err.error_subcode);
  const out = (kind: MetaErrorKind, msg?: string): MetaErrorClass => ({
    kind,
    ...(code !== undefined ? { code } : {}),
    ...(subcode !== undefined ? { subcode } : {}),
    userMessage: msg ?? META_ERROR_COPY[kind],
  });

  if (code === 190) return out("token_invalid");
  if (code === 613 || code === 4) return out("rate_limited");
  if (code === 551 || code === 1545041 || subcode === 1545041) return out("user_unavailable");
  if (code === 10) {
    if (subcode === 2018300) return out("no_thread_control");
    if (subcode !== undefined && OUTSIDE_WINDOW_SUBCODES.has(subcode)) return out("outside_window");
    return out("permission");
  }
  if (code === 100) return out("bad_request", `A Meta recusou a mensagem (erro 100${subcode ? `/${subcode}` : ""}).`);
  if (status === 0 || status >= 500 || code === 1 || code === 2) return out("transient");
  return out("bad_request", `A Meta recusou a mensagem${code !== undefined ? ` (erro ${code})` : ` (HTTP ${status})`}.`);
}

// ── Janela de serviço ──

/**
 * Estado da janela a partir de uma âncora: 24 h após a última inbound, ou
 * 7 dias quando `openedByAd`. Sem âncora = fechada (conversa nova, nunca
 * escreveu). Sem margem: a margem de 15 min é da IA (F3).
 */
export function serviceWindowState(
  _surface: MetaSurface,
  lastInboundAt: number | undefined,
  openedByAd: boolean,
  now: number
): { open: boolean; closesAt?: number } {
  if (lastInboundAt === undefined) return { open: false };
  const closesAt = lastInboundAt + (openedByAd ? META_AD_WINDOW_MS : META_WINDOW_MS);
  return { open: now < closesAt, closesAt };
}

/**
 * Fechamento da janela de uma CONVERSA Meta: o maior entre 24 h da última
 * inbound e 7 dias do clique no anúncio (`windowOpenedByAdAt`). Sem relógio,
 * para as queries reativas devolverem o carimbo.
 */
export function metaWindowClosesAt(conversation: {
  lastInboundAt?: number;
  windowOpenedByAdAt?: number;
}): number | null {
  const regular = conversation.lastInboundAt !== undefined ? conversation.lastInboundAt + META_WINDOW_MS : null;
  const ad =
    conversation.windowOpenedByAdAt !== undefined ? conversation.windowOpenedByAdAt + META_AD_WINDOW_MS : null;
  if (regular === null) return ad;
  if (ad === null) return regular;
  return Math.max(regular, ad);
}

export function metaConversationWindow(
  surface: MetaSurface,
  conversation: { lastInboundAt?: number; windowOpenedByAdAt?: number },
  now: number
): { open: boolean; closesAt?: number } {
  const regular = serviceWindowState(surface, conversation.lastInboundAt, false, now);
  const ad = serviceWindowState(surface, conversation.windowOpenedByAdAt, true, now);
  const closesAt = metaWindowClosesAt(conversation);
  return { open: regular.open || ad.open, ...(closesAt !== null ? { closesAt } : {}) };
}

/** "hnb:<messageId>" → messageId (ou null). */
export function parseHnbMetadata(metadata: string | undefined): string | null {
  if (!metadata || !metadata.startsWith("hnb:")) return null;
  const id = metadata.slice(4).trim();
  return id ? id : null;
}

/** App ids do Page Inbox / Business Suite (a doc cita os dois). */
export const PAGE_INBOX_APP_IDS = new Set(["263902037430900", "26390203743090"]);

export function viaAppFor(appId: string | undefined): "page_inbox" | "other" | "unknown" {
  if (!appId) return "unknown";
  return PAGE_INBOX_APP_IDS.has(appId) ? "page_inbox" : "other";
}

/** Últimos 4 caracteres, para log (nunca o id inteiro). */
export function last4(id: string): string {
  return id.slice(-4);
}
