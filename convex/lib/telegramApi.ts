/**
 * Telegram Bot API client — the ONLY place that talks to api.telegram.org
 * (D13). Build guard: `convex/telegramApiPort.test.ts`.
 *
 * - Global `fetch` (default Convex runtime; call it from actions only).
 * - Token from `process.env.TELEGRAM_BOT_TOKEN`; `opts.token` is reserved for
 *   the future per-org bots (F6). No token = `{ok:false, kind:"disabled"}` and
 *   one warning (D14: DEV without a token never touches a real chat).
 * - Never logs the token, the request URL (it carries the token), chat ids,
 *   names or message text. Failures log only the method, kind and error code.
 * - Never throws: every outcome is a discriminated `TelegramResult`.
 */
import { htmlToPlainText, splitMessage, TELEGRAM_TEXT_LIMIT } from "./telegramFormat";

export type TelegramErrorKind =
  | "rate_limited"
  | "blocked"
  | "not_modified"
  | "bad_request"
  | "network"
  | "other"
  | "disabled";

export type TelegramFailure = {
  ok: false;
  kind: TelegramErrorKind;
  errorCode?: number;
  description?: string;
  /** 429 only: seconds Telegram asks us to wait (`parameters.retry_after`). */
  retryAfterSeconds?: number;
};

export type TelegramResult<T> = { ok: true; result: T } | TelegramFailure;

export type TelegramCallOptions = {
  /** Per-org bot token (F6). Default: `TELEGRAM_BOT_TOKEN`. */
  token?: string;
  timeoutMs?: number;
};

const API_BASE = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Classifies a Bot API error response (pure; exported for tests). */
export function classifyTelegramError(
  errorCode: number | undefined,
  description: string | undefined,
): TelegramErrorKind {
  const d = (description ?? "").toLowerCase();
  if (errorCode === 429) return "rate_limited";
  if (errorCode === 403) return "blocked";
  if (errorCode === 400 && d.includes("message is not modified")) return "not_modified";
  if (errorCode === 400) return "bad_request";
  return "other";
}

/**
 * One Bot API call. `params` is sent as JSON. The returned `description` comes
 * from Telegram and may echo request details: callers must not log it.
 */
export async function callTelegram<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  opts: TelegramCallOptions = {},
): Promise<TelegramResult<T>> {
  return await postTelegram<T>(
    method,
    { headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) },
    opts,
  );
}

/**
 * F4: multipart upload (documents/audio keep their real file name, which a URL
 * send cannot set). Same outcome contract and logging rules as `callTelegram`.
 */
export async function callTelegramMultipart<T = unknown>(
  method: string,
  form: FormData,
  opts: TelegramCallOptions = {},
): Promise<TelegramResult<T>> {
  return await postTelegram<T>(method, { body: form }, opts);
}

async function postTelegram<T>(
  method: string,
  init: { headers?: Record<string, string>; body: string | FormData },
  opts: TelegramCallOptions,
): Promise<TelegramResult<T>> {
  const token = opts.token ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn(`[telegram] TELEGRAM_BOT_TOKEN ausente; chamada ignorada: ${method}`);
    return { ok: false, kind: "disabled" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let body: unknown;
  try {
    const response = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      ...(init.headers ? { headers: init.headers } : {}),
      body: init.body,
      signal: controller.signal,
    });
    try {
      body = await response.json();
    } catch {
      console.warn(`[telegram] ${method}: resposta inválida (HTTP ${response.status})`);
      return { ok: false, kind: response.status >= 500 ? "network" : "other", errorCode: response.status };
    }
  } catch (e) {
    console.warn(`[telegram] ${method}: falha de rede (${e instanceof Error ? e.name : "erro"})`);
    return { ok: false, kind: "network" };
  } finally {
    clearTimeout(timer);
  }

  const parsed = (body ?? {}) as {
    ok?: boolean;
    result?: T;
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  };
  if (parsed.ok === true) return { ok: true, result: parsed.result as T };
  const kind = classifyTelegramError(parsed.error_code, parsed.description);
  if (kind !== "not_modified") {
    console.warn(`[telegram] ${method}: ${kind} (${parsed.error_code ?? "?"})`);
  }
  const retryAfter = parsed.parameters?.retry_after;
  return {
    ok: false,
    kind,
    errorCode: parsed.error_code,
    description: parsed.description,
    ...(typeof retryAfter === "number" ? { retryAfterSeconds: retryAfter } : {}),
  };
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export type InlineKeyboardButton =
  | { text: string; url: string }
  | { text: string; callback_data: string };

export type ReplyMarkup =
  | { inline_keyboard: InlineKeyboardButton[][] }
  | { remove_keyboard: true }
  | { keyboard: { text: string }[][]; resize_keyboard: true; is_persistent: true }
  | { force_reply: true; input_field_placeholder?: string };

export type SentMessage = { message_id: number };

export type SendMessageArgs = {
  chatId: number;
  text: string;
  replyMarkup?: ReplyMarkup;
  /** Default "HTML". `null` = plain text. */
  parseMode?: "HTML" | null;
  /** Default true (no previews of CRM links). */
  disablePreview?: boolean;
  protectContent?: boolean;
};

/** Telegram refused our HTML (D12): the one case worth a plain-text retry. */
export function isParseEntitiesError(res: TelegramFailure): boolean {
  return res.kind === "bad_request" && (res.description ?? "").toLowerCase().includes("can't parse entities");
}

/** A `sendMessage` failure says how many chunks went out before it. */
export type SendFailure = TelegramFailure & { sentCount: number };

/**
 * Sends a text, split in ≤ 4096-char chunks (`splitMessage`). The reply
 * markup goes on the LAST chunk only. Returns the ids of every sent chunk; on
 * a failure mid-way, the failure carries `sentCount` (chunks already sent stay
 * sent, so a retry resumes from `chunks.slice(sentCount)`).
 */
export async function sendMessage(
  args: SendMessageArgs,
  opts?: TelegramCallOptions,
): Promise<{ ok: true; result: SentMessage[] } | SendFailure> {
  return await sendMessageChunks({ ...args, chunks: splitMessage(args.text, TELEGRAM_TEXT_LIMIT) }, opts);
}

/**
 * Same as `sendMessage` with the chunks already cut (429 resume). A chunk
 * Telegram cannot parse ("can't parse entities") is retried ONCE as plain
 * text: tags stripped, entities decoded, no `parse_mode`.
 */
export async function sendMessageChunks(
  args: Omit<SendMessageArgs, "text"> & { chunks: string[] },
  opts?: TelegramCallOptions,
): Promise<{ ok: true; result: SentMessage[] } | SendFailure> {
  const parseMode = args.parseMode === undefined ? "HTML" : args.parseMode;
  const sent: SentMessage[] = [];
  for (let i = 0; i < args.chunks.length; i++) {
    const last = i === args.chunks.length - 1;
    const params = (text: string, mode: "HTML" | null) => ({
      chat_id: args.chatId,
      text,
      ...(mode ? { parse_mode: mode } : {}),
      link_preview_options: { is_disabled: args.disablePreview !== false },
      ...(args.protectContent ? { protect_content: true } : {}),
      ...(last && args.replyMarkup ? { reply_markup: args.replyMarkup } : {}),
    });
    let res = await callTelegram<SentMessage>("sendMessage", params(args.chunks[i], parseMode), opts);
    if (!res.ok && parseMode && isParseEntitiesError(res)) {
      res = await callTelegram<SentMessage>("sendMessage", params(htmlToPlainText(args.chunks[i]), null), opts);
    }
    if (!res.ok) return { ...res, sentCount: sent.length };
    sent.push({ message_id: res.result.message_id });
  }
  return { ok: true, result: sent };
}

export async function editMessageText(
  args: {
    chatId: number;
    messageId: number;
    text: string;
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] };
    parseMode?: "HTML" | null;
    disablePreview?: boolean;
  },
  opts?: TelegramCallOptions,
): Promise<TelegramResult<unknown>> {
  const parseMode = args.parseMode === undefined ? "HTML" : args.parseMode;
  const params = (text: string, mode: "HTML" | null) => ({
    chat_id: args.chatId,
    message_id: args.messageId,
    // Never cut inside a tag/entity: the first balanced chunk of `splitMessage`.
    text: splitMessage(text, TELEGRAM_TEXT_LIMIT)[0] ?? "",
    ...(mode ? { parse_mode: mode } : {}),
    link_preview_options: { is_disabled: args.disablePreview !== false },
    ...(args.replyMarkup ? { reply_markup: args.replyMarkup } : {}),
  });
  const res = await callTelegram("editMessageText", params(args.text, parseMode), opts);
  if (!res.ok && parseMode && isParseEntitiesError(res)) {
    return await callTelegram("editMessageText", params(htmlToPlainText(args.text), null), opts);
  }
  return res;
}

export async function deleteMessage(
  args: { chatId: number; messageId: number },
  opts?: TelegramCallOptions,
): Promise<TelegramResult<boolean>> {
  return await callTelegram<boolean>("deleteMessage", { chat_id: args.chatId, message_id: args.messageId }, opts);
}

export async function answerCallbackQuery(
  args: { callbackQueryId: string; text?: string; showAlert?: boolean },
  opts?: TelegramCallOptions,
): Promise<TelegramResult<boolean>> {
  return await callTelegram<boolean>(
    "answerCallbackQuery",
    {
      callback_query_id: args.callbackQueryId,
      ...(args.text ? { text: args.text.slice(0, 200) } : {}),
      ...(args.showAlert ? { show_alert: true } : {}),
    },
    opts,
  );
}

export async function setWebhook(
  args: { url: string; secretToken?: string; allowedUpdates: string[]; dropPendingUpdates?: boolean },
  opts?: TelegramCallOptions,
): Promise<TelegramResult<boolean>> {
  return await callTelegram<boolean>(
    "setWebhook",
    {
      url: args.url,
      allowed_updates: args.allowedUpdates,
      ...(args.secretToken ? { secret_token: args.secretToken } : {}),
      ...(args.dropPendingUpdates ? { drop_pending_updates: true } : {}),
    },
    opts,
  );
}

export async function deleteWebhook(
  args: { dropPendingUpdates?: boolean } = {},
  opts?: TelegramCallOptions,
): Promise<TelegramResult<boolean>> {
  return await callTelegram<boolean>(
    "deleteWebhook",
    args.dropPendingUpdates ? { drop_pending_updates: true } : {},
    opts,
  );
}

export type WebhookInfo = {
  url: string;
  has_custom_certificate?: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
};

export async function getWebhookInfo(opts?: TelegramCallOptions): Promise<TelegramResult<WebhookInfo>> {
  return await callTelegram<WebhookInfo>("getWebhookInfo", {}, opts);
}

export async function setMyCommands(
  args: { commands: { command: string; description: string }[] },
  opts?: TelegramCallOptions,
): Promise<TelegramResult<boolean>> {
  return await callTelegram<boolean>("setMyCommands", { commands: args.commands }, opts);
}

export type BotInfo = { id: number; is_bot: boolean; first_name: string; username?: string };

export async function getMe(opts?: TelegramCallOptions): Promise<TelegramResult<BotInfo>> {
  return await callTelegram<BotInfo>("getMe", {}, opts);
}

// ---------------------------------------------------------------------------
// F3: streaming drafts, chat actions and file download (voice/photo)
// ---------------------------------------------------------------------------

/**
 * Bot API 9.5 `sendMessageDraft`: streams a partial answer into the chat
 * (D10). Plain text, ≤ 4096. Callers throttle (≥ 1 s) and fall back to
 * `sendChatAction` when the method is refused.
 */
export async function sendMessageDraft(
  args: { chatId: number; draftId: number; text: string },
  opts?: TelegramCallOptions,
): Promise<TelegramResult<boolean>> {
  return await callTelegram<boolean>(
    "sendMessageDraft",
    { chat_id: args.chatId, draft_id: args.draftId, text: args.text.slice(0, TELEGRAM_TEXT_LIMIT) || "…" },
    opts,
  );
}

export async function sendChatAction(
  args: { chatId: number; action: "typing" | "record_voice" | "upload_photo" },
  opts?: TelegramCallOptions,
): Promise<TelegramResult<boolean>> {
  return await callTelegram<boolean>("sendChatAction", { chat_id: args.chatId, action: args.action }, opts);
}

/** Bot API limit for `getFile` downloads. */
export const TELEGRAM_FILE_MAX_BYTES = 20 * 1024 * 1024;

export async function getFile(
  args: { fileId: string },
  opts?: TelegramCallOptions,
): Promise<TelegramResult<{ file_id: string; file_path?: string; file_size?: number }>> {
  return await callTelegram("getFile", { file_id: args.fileId }, opts);
}

/**
 * Downloads a file returned by `getFile` (the file URL carries the token, so
 * it lives here and is never logged). Bounded by `maxBytes` and `timeoutMs`.
 */
export async function downloadTelegramFile(
  filePath: string,
  opts: { maxBytes?: number; timeoutMs?: number; token?: string } = {},
): Promise<{ ok: true; bytes: ArrayBuffer; contentType: string } | { ok: false; reason: "disabled" | "too_large" | "network" | "http" }> {
  const token = opts.token ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, reason: "disabled" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const response = await fetch(`${API_BASE}/file/bot${token}/${filePath}`, { signal: controller.signal });
    if (!response.ok) {
      console.warn(`[telegram] download: HTTP ${response.status}`);
      return { ok: false, reason: "http" };
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > (opts.maxBytes ?? TELEGRAM_FILE_MAX_BYTES)) return { ok: false, reason: "too_large" };
    return { ok: true, bytes, contentType: response.headers.get("content-type") ?? "application/octet-stream" };
  } catch (e) {
    console.warn(`[telegram] download: falha de rede (${e instanceof Error ? e.name : "erro"})`);
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// F4 (D21): files to the chat, by a storage URL or as an upload
// ---------------------------------------------------------------------------

/** Bot API caption limit (after entity parsing). */
export const TELEGRAM_CAPTION_LIMIT = 1024;

export type SendFileArgs = {
  chatId: number;
  /** Storage URL (`ctx.storage.getUrl`; it does not expire by itself). Never a `file_id` from another bot. */
  url: string;
  /** Already-escaped HTML caption (clipped to the Bot API limit here). */
  caption?: string;
  /** Documents: the name Telegram shows. */
  fileName?: string;
  protectContent?: boolean;
  replyMarkup?: ReplyMarkup;
};

const FILE_METHODS = {
  photo: ["sendPhoto", "photo"],
  voice: ["sendVoice", "voice"],
  audio: ["sendAudio", "audio"],
  document: ["sendDocument", "document"],
} as const;
export type TelegramFileKind = keyof typeof FILE_METHODS;

/**
 * `sendPhoto` / `sendVoice` / `sendAudio` / `sendDocument` by URL. Telegram
 * fetches the URL itself (photo ≤ 5 MB, others ≤ 20 MB); a URL it cannot
 * fetch comes back as `bad_request` and the caller falls back to a link line.
 */
export async function sendFile(
  kind: TelegramFileKind,
  args: SendFileArgs,
  opts?: TelegramCallOptions,
): Promise<TelegramResult<SentMessage>> {
  const [method, field] = FILE_METHODS[kind];
  const caption = args.caption ? clipCaption(args.caption) : undefined;
  return await callTelegram<SentMessage>(
    method,
    {
      chat_id: args.chatId,
      [field]: args.url,
      ...(caption ? { caption, parse_mode: "HTML" } : {}),
      ...(args.protectContent ? { protect_content: true } : {}),
      ...(args.replyMarkup ? { reply_markup: args.replyMarkup } : {}),
    },
    { timeoutMs: 30_000, ...opts },
  );
}
/**
 * Upload variant: the bytes go in the request so Telegram shows `fileName`
 * (documents, audio). The caller read the blob from storage (≤ 20 MB).
 */
export async function sendFileUpload(
  kind: TelegramFileKind,
  args: Omit<SendFileArgs, "url"> & { blob: Blob; fileName: string },
  opts?: TelegramCallOptions,
): Promise<TelegramResult<SentMessage>> {
  const [method, field] = FILE_METHODS[kind];
  const form = new FormData();
  form.append("chat_id", String(args.chatId));
  form.append(field, args.blob, args.fileName);
  const caption = args.caption ? clipCaption(args.caption) : undefined;
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }
  if (args.protectContent) form.append("protect_content", "true");
  if (args.replyMarkup) form.append("reply_markup", JSON.stringify(args.replyMarkup));
  return await callTelegramMultipart<SentMessage>(method, form, { timeoutMs: 60_000, ...opts });
}

export const sendPhoto = (a: SendFileArgs, o?: TelegramCallOptions) => sendFile("photo", a, o);
export const sendVoice = (a: SendFileArgs, o?: TelegramCallOptions) => sendFile("voice", a, o);
export const sendAudio = (a: SendFileArgs, o?: TelegramCallOptions) => sendFile("audio", a, o);
export const sendDocument = (a: SendFileArgs, o?: TelegramCallOptions) => sendFile("document", a, o);

/** Clips an HTML caption to the limit without cutting an entity or leaving a tag open (plain fallback). */
function clipCaption(html: string): string {
  if (html.length <= TELEGRAM_CAPTION_LIMIT) return html;
  const plain = htmlToPlainText(html);
  const cut = plain.slice(0, TELEGRAM_CAPTION_LIMIT - 1).trimEnd() + "…";
  return cut.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
