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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
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
