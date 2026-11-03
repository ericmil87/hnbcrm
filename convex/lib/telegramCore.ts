/**
 * Copilot on Telegram — pure core (F0): update parsing, link codes, link
 * defaults and the bot copy (PT-BR). No ctx, no network.
 */
import { escapeHtml } from "./telegramFormat";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TELEGRAM_BOT_KEY_PLATFORM = "platform";
/** Link code TTL (D2). */
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
/** `deleteMessage` window on revocation (§5). Telegram itself refuses > 48 h. */
export const CLEANUP_DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;
export const CLEANUP_DELETE_MAX = 200;
/** `lastSeenAt` is only rewritten when older than this (cheap writes). */
export const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;
/** Max 429 retries for one reply (§3.8). */
export const MAX_SEND_ATTEMPTS = 3;
/** `allowed_updates` of the platform webhook (§3.2). */
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "my_chat_member",
  "stopped_message_generation",
] as const;
/** F0 command list (`setMyCommands`). F2 extends it. */
export const TELEGRAM_F0_COMMANDS = [
  { command: "ajuda", description: "Como usar o bot" },
  { command: "sair", description: "Desconectar este Telegram" },
] as const;

export const DEFAULT_LINK_PREFS = { relayAssignedConversations: true, mediaInbound: true };
export const DEFAULT_LINK_REPORTS = { enabled: true, morningHour: 8, eveningHour: 18 };
export const DEFAULT_LINK_ASSISTANT = {
  mode: "suggest" as const,
  suggestOnEvents: true,
  autoSendDelaySeconds: 15,
  autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false },
};

// ---------------------------------------------------------------------------
// Link codes (D2): 32 random bytes, base64url (43 chars), stored as SHA-256 hex
// ---------------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateLinkCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function hashLinkCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A `/start` payload that can be a link code (Telegram allows ≤ 64 of `A-Za-z0-9_-`). */
export function looksLikeLinkCode(payload: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(payload);
}

export function deepLinkUrl(botUsername: string, code: string): string {
  return `https://t.me/${botUsername.replace(/^@/, "")}?start=${code}`;
}

// ---------------------------------------------------------------------------
// Update parsing
// ---------------------------------------------------------------------------

export type ParsedUpdateKind =
  | "message"
  | "callback_query"
  | "my_chat_member"
  | "stopped_message_generation"
  | "other";

/** Minimal slice of an update persisted in `telegramUpdates.parsed`. */
export type ParsedUpdate = {
  kind: ParsedUpdateKind;
  chatId?: number;
  chatType?: string;
  fromId?: number;
  username?: string;
  firstName?: string;
  text?: string;
  messageId?: number;
  callbackQueryId?: string;
  callbackData?: string;
  memberStatus?: string;
  /** F3 (D21): the largest photo, the voice note, etc. (never the bytes). */
  media?: ParsedMedia;
};

export type ParsedMedia = {
  kind: "voice" | "audio" | "photo" | "video" | "video_note" | "document";
  fileId: string;
  fileSize?: number;
  mimeType?: string;
};

function mediaOf(message: Record<string, unknown>): ParsedMedia | undefined {
  const file = (kind: ParsedMedia["kind"], raw: unknown, defaultMime?: string): ParsedMedia | undefined => {
    const f = obj(raw);
    const fileId = str(f?.file_id, 256);
    if (!fileId) return undefined;
    const fileSize = num(f?.file_size);
    const mimeType = str(f?.mime_type, 100) ?? defaultMime;
    return { kind, fileId, ...(fileSize !== undefined ? { fileSize } : {}), ...(mimeType ? { mimeType } : {}) };
  };
  if (message.voice) return file("voice", message.voice, "audio/ogg");
  if (message.audio) return file("audio", message.audio);
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    // Telegram sends several sizes; the last is the largest.
    return file("photo", message.photo[message.photo.length - 1], "image/jpeg");
  }
  if (message.video) return file("video", message.video);
  if (message.video_note) return file("video_note", message.video_note);
  if (message.document) return file("document", message.document);
  return undefined;
}

const MAX_TEXT = 4096;
const MAX_NAME = 128;

function obj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}
function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}
function str(x: unknown, max: number): string | undefined {
  return typeof x === "string" ? x.slice(0, max) : undefined;
}

/** `update_id` of a raw update, or null when the body is not an update. */
export function updateIdOf(update: unknown): number | null {
  const id = num(obj(update)?.update_id);
  return id !== undefined && Number.isInteger(id) ? id : null;
}

/** Never throws. Unknown shapes become `{kind:"other"}`. */
export function parseTelegramUpdate(update: unknown): ParsedUpdate {
  const u = obj(update);
  if (!u) return { kind: "other" };

  const message = obj(u.message);
  if (message) {
    const chat = obj(message.chat);
    const from = obj(message.from);
    return {
      kind: "message",
      chatId: num(chat?.id),
      chatType: str(chat?.type, 32),
      fromId: num(from?.id),
      username: str(from?.username, MAX_NAME),
      firstName: str(from?.first_name, MAX_NAME),
      text: str(message.text, MAX_TEXT) ?? str(message.caption, MAX_TEXT),
      messageId: num(message.message_id),
      ...(mediaOf(message) ? { media: mediaOf(message) } : {}),
    };
  }

  const cq = obj(u.callback_query);
  if (cq) {
    const from = obj(cq.from);
    const cqMessage = obj(cq.message);
    const chat = obj(cqMessage?.chat);
    return {
      kind: "callback_query",
      // Without `message` (inline-mode callbacks, very old messages) there is
      // no chat: never assume the sender's private chat.
      chatId: num(chat?.id),
      chatType: str(chat?.type, 32),
      fromId: num(from?.id),
      username: str(from?.username, MAX_NAME),
      firstName: str(from?.first_name, MAX_NAME),
      messageId: num(cqMessage?.message_id),
      callbackQueryId: str(cq.id, 128),
      callbackData: str(cq.data, 64),
    };
  }

  const mcm = obj(u.my_chat_member);
  if (mcm) {
    const chat = obj(mcm.chat);
    const from = obj(mcm.from);
    return {
      kind: "my_chat_member",
      chatId: num(chat?.id),
      chatType: str(chat?.type, 32),
      fromId: num(from?.id),
      memberStatus: str(obj(mcm.new_chat_member)?.status, 32),
    };
  }

  const smg = obj(u.stopped_message_generation);
  if (smg) {
    const chat = obj(smg.chat);
    return { kind: "stopped_message_generation", chatId: num(chat?.id), chatType: str(chat?.type, 32) };
  }

  return { kind: "other" };
}

/** callback_query id straight from the raw body (for the webhook response, D5). */
export function callbackQueryIdOf(update: unknown): string | null {
  const id = obj(obj(update)?.callback_query)?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export type ParsedCommand = { command: string; payload: string };

/** `/start abc`, `/sair@hnbcrm_bot` → `{command:"start", payload:"abc"}`; null when not a command. */
export function parseCommand(text: string | undefined): ParsedCommand | null {
  if (!text) return null;
  const m = text.trim().match(/^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { command: m[1].toLowerCase(), payload: (m[2] ?? "").trim() };
}

// ---------------------------------------------------------------------------
// Bot copy (PT-BR, HTML). Names are always escaped here.
// ---------------------------------------------------------------------------

export function settingsUrl(appBaseUrl: string): string {
  return `${appBaseUrl}/app/configuracoes?secao=notifications`;
}

export const COPY = {
  unlinked:
    "Este Telegram ainda não está conectado a uma conta do HNBCRM.\n" +
    "Abra Configurações → Notificações → Telegram no CRM e toque em \"Conectar\".",
  unlinkedButton: "🔗 Abrir configurações",
  codeInvalid:
    "Este link expirou ou já foi usado. Gere outro em Configurações → Notificações → Telegram.",
  chatTaken:
    "Este Telegram já está conectado a outra conta do HNBCRM. Use /sair lá primeiro.",
  moduleOff:
    "O Telegram não está habilitado nesta organização. Peça a um admin para ligar em Configurações → Notificações → Telegram.",
  learning:
    "Ainda estou aprendendo: por enquanto respondo aos comandos (/ajuda lista todos). O Copiloto, por texto e áudio, chega na próxima versão.",
  help:
    "<b>HNBCRM no Telegram</b>\n" +
    "Repasses, tarefas e alertas chegam aqui com botões para agir na hora.\n\n" +
    "/hoje · resumo do dia\n" +
    "/repasses · repasses pendentes\n" +
    "/tarefas · suas tarefas\n" +
    "/leads · seus leads\n" +
    "/foco · escolher a conversa em foco\n" +
    "/novo · limpar o foco\n" +
    "/pausar · silenciar notificações\n" +
    "/org · trocar de organização\n" +
    "/teclado · mostrar ou ocultar o teclado\n" +
    "/tour · reabre o guia\n" +
    "/sair · desconectar este Telegram\n\n" +
    "O Copiloto, por texto e áudio, chega na próxima versão.",
} as const;

export function welcomeText(args: { memberName: string; orgName: string; otherOrgNames: string[] }): string {
  const base =
    `Conectado como <b>${escapeHtml(args.memberName)}</b> em <b>${escapeHtml(args.orgName)}</b>. ` +
    "Você vai receber repasses, tarefas e alertas aqui, pode me mandar texto ou áudio a qualquer hora. " +
    "/ajuda mostra tudo.";
  if (args.otherOrgNames.length === 0) return base;
  const others = args.otherOrgNames.map((n) => `<b>${escapeHtml(n)}</b>`).join(", ");
  return (
    `${base}\n\nEste Telegram também está conectado a ${others}: as notificações de todas chegam aqui. ` +
    `A organização ativa agora é <b>${escapeHtml(args.orgName)}</b>.`
  );
}

export function alreadyLinkedText(args: { memberName: string; orgName: string }): string {
  return (
    `Você já está conectado como <b>${escapeHtml(args.memberName)}</b> em <b>${escapeHtml(args.orgName)}</b>. ` +
    "/ajuda mostra tudo."
  );
}

export type CleanupReason = "unlink" | "sair" | "member_removed" | "moved";

export function farewellText(reason: CleanupReason, orgName: string): string {
  const org = escapeHtml(orgName);
  if (reason === "member_removed") {
    return `Sua conta não está mais nesta organização (${org}). Este Telegram foi desconectado do HNBCRM.`;
  }
  if (reason === "moved") {
    return `Desconectado do HNBCRM (${org}): sua conta foi conectada a outro Telegram.`;
  }
  return (
    `Desconectado do HNBCRM (${org}). Você não vai mais receber nada desta organização aqui. ` +
    "Para conectar de novo, use Configurações → Notificações → Telegram no CRM."
  );
}
