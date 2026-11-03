/**
 * Telegram cards (F1, D15/D19): notification → HTML text + inline keyboard.
 * Pure: no ctx, no network. The context is loaded by `lib/telegramContext.ts`.
 *
 * Full mode (default, D15 v3): executive summary first (org · time, lead ·
 * channel · phone · board › stage · value, reason, AI summary), then the
 * customer's last message WHOLE inside `<blockquote expandable>`.
 * Discreet mode (`settings.telegram.discreet`): 200 chars, `maskDigitRuns`,
 * initials instead of the name, no phone, no WhatsApp/Instagram button, no
 * "Ver tudo". Never an e-mail address, in any mode.
 */
import type { NotificationType } from "./notify";
import { escapeHtml, expandableQuote, maskDigitRuns } from "./telegramFormat";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CardButton = { text: string; url: string } | { text: string; callback_data: string };
export type CardKeyboard = CardButton[][];
export type CardFocus = { conversationId: string; leadId?: string; handoffId?: string };
export type CardOutput = { text: string; keyboard: CardKeyboard; focus?: CardFocus };

export type HistoryLine = { at: number; author: string; text: string };

export type CardContext = {
  orgName: string;
  timezone: string;
  currency: string;
  appBaseUrl: string;
  discreet: boolean;
  now: number;
  /** The person has more than one active org on this Telegram: the header names the org. */
  multiOrg?: boolean;
  lead?: {
    id: string;
    title: string;
    phone?: string; // digits, E.164 without "+"
    instagramUsername?: string;
    value?: number;
    stageName?: string;
    boardName?: string;
  };
  conversation?: { id: string; channel: string };
  handoff?: {
    id: string;
    status: string;
    reason?: string;
    summary?: string;
    suggestedActions?: string[];
    fromAi: boolean;
    fromName?: string;
    acceptedByName?: string;
  };
  lastInbound?: { text: string; at: number };
  draft?: { messageId: string; text: string };
  task?: { id: string; title: string; dueDate?: number; status: string };
  relayLines?: HistoryLine[];
  actorName?: string;
};

export type NotificationInput = {
  _id: string;
  type: NotificationType;
  title: string;
  body?: string;
  createdAt: number;
  handoffId?: string;
  conversationId?: string;
  taskId?: string;
  campaignId?: string;
};

type TemplateKind =
  | "handoff"
  | "handoff_resolved"
  | "new_message"
  | "draft"
  | "followup"
  | "task"
  | "transferred"
  | "generic";

/**
 * Every notification type has a Telegram decision: a template here, or an
 * entry in `IGNORED_FOR_TELEGRAM`. `telegramNotifications.test.ts` reads the
 * schema union and fails when a new type has neither.
 */
export const TELEGRAM_TEMPLATES: Partial<Record<NotificationType, TemplateKind>> = {
  handoff_requested: "handoff",
  handoff_resolved: "handoff_resolved",
  new_message: "new_message",
  ai_draft_pending: "draft",
  ai_followup_needs_human: "followup",
  task_assigned: "task",
  task_due_soon: "task",
  task_overdue: "task",
  conversation_transferred: "transferred",
  task_comment_mention: "generic",
  channel_session_lost: "generic",
  ai_spend_warning: "generic",
  ai_spend_reached: "generic",
  campaign_completed: "generic",
  campaign_paused: "generic",
  group_joined: "generic",
  group_mention: "generic",
  group_post_pending: "generic",
  group_post_failed: "generic",
  group_opportunity: "generic",
  group_digest: "generic",
};

/** Types deliberately NOT sent to Telegram (none in F1; add with a reason). */
export const IGNORED_FOR_TELEGRAM: ReadonlySet<NotificationType> = new Set<NotificationType>([]);

export function hasTelegramTemplate(type: NotificationType): boolean {
  return TELEGRAM_TEMPLATES[type] !== undefined && !IGNORED_FOR_TELEGRAM.has(type);
}

// ---------------------------------------------------------------------------
// Callback data (D6): `<verb>:<convex id>[:<extra>]`, ≤ 64 bytes
// ---------------------------------------------------------------------------

export const CALLBACK_VERBS = [
  "ah", // accept handoff
  "ia", // instruct the AI (opens prompt)
  "rg", // regenerate (opens prompt)
  "rp", // reply to the customer (opens prompt)
  "sd", // send AI draft
  "dd", // discard AI draft
  "ct", // complete task
  "sz1", // snooze 1 h
  "sz9", // tomorrow 9h (org timezone)
  "va", // view all (last 10 messages)
  "rs", // summarize (back to the card)
  "cp", // cancel prompt
  "ni", // return to the AI without instruction
  "ps", // send the reply previewed in the prompt (F1 addition)
  "ae", // "Assumir eu" from the AI relay (F1 addition)
  // F3:
  "pa", // confirm a Copilot pending action (also "💡 Aplicar sugestão")
  "pc", // cancel a Copilot pending action
  "un", // undo an automatic-mode record (D22)
  "aj", // "✏️ Ajustar": focus + talk to the Copilot about it
  "md", // set the assistant mode (md:suggest / md:auto)
  "vc", // veto a countdown send (D23)
] as const;
export type CallbackVerb = (typeof CALLBACK_VERBS)[number];
export const CALLBACK_DATA_MAX_BYTES = 64;

export function callbackData(verb: CallbackVerb, id: string, extra?: string): string {
  const data = extra ? `${verb}:${id}:${extra}` : `${verb}:${id}`;
  if (new TextEncoder().encode(data).length > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(`callback_data acima de ${CALLBACK_DATA_MAX_BYTES} bytes`);
  }
  return data;
}

export function parseCallbackData(data: string | undefined): { verb: CallbackVerb; id: string; extra?: string } | null {
  if (!data || new TextEncoder().encode(data).length > CALLBACK_DATA_MAX_BYTES) return null;
  // Id charset: Convex ids (and the `n;table` ids of convex-test). The id is
  // re-validated against its table (`normalizeId`) before any read.
  const m = data.match(/^([a-z0-9]{2,3}):([A-Za-z0-9_;-]{1,40})(?::([A-Za-z0-9_-]{1,16}))?$/);
  if (!m || !(CALLBACK_VERBS as readonly string[]).includes(m[1])) return null;
  return { verb: m[1] as CallbackVerb, id: m[2], ...(m[3] ? { extra: m[3] } : {}) };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** E-mail addresses become "[e-mail]". Applied ONLY in discreet mode (`scrub`). */
export function stripEmails(text: string): string {
  return text.replace(EMAIL_RE, "[e-mail]");
}

/** Full mode keeps the text (a Pix key can be an e-mail); discreet mode hides e-mails. */
export function scrub(text: string, discreet: boolean): string {
  return discreet ? stripEmails(text) : text;
}

const DISCREET_MAX = 200;
/** Full-mode customer quote cap (review F1 #13); the rest is "continua no CRM". */
export const FULL_QUOTE_MAX = 3000;

/** Plain text → safe HTML for this mode (discreet = e-mails out, 200 chars, masked digits). */
function safe(text: string, discreet: boolean, max?: number): string {
  let t = scrub(text, discreet);
  const cap = discreet ? DISCREET_MAX : max;
  if (cap !== undefined && t.length > cap) t = `${t.slice(0, cap).trimEnd()}…`;
  if (discreet) t = maskDigitRuns(t);
  return escapeHtml(t);
}

export function initials(name: string): string {
  const parts = stripEmails(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((p) => `${p[0]!.toUpperCase()}.`)
    .join(" ");
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Discreet mode (review F1 #4): the lead's name inside free text (notification
 * title/body, task title, reason) becomes initials — the whole name and each
 * part of 3+ letters. Full mode returns the text unchanged.
 */
export function redactName(ctx: Pick<CardContext, "discreet" | "lead">, text: string): string {
  if (!ctx.discreet || !ctx.lead?.title) return text;
  const title = stripEmails(ctx.lead.title).trim();
  const ini = initials(title);
  const names = [title, ...title.split(/\s+/).filter((p) => p.length >= 3)].sort((a, b) => b.length - a.length);
  let out = text;
  for (const name of names) {
    out = out.replace(new RegExp(`(?<![\\p{L}])${escapeRe(name)}(?![\\p{L}])`, "giu"), ini);
  }
  return out;
}

/** `safe` + name redaction; in discreet mode without a known lead, free text is dropped. */
export function safeText(ctx: CardContext, text: string, max?: number): string {
  if (ctx.discreet && !ctx.lead) return "";
  return safe(redactName(ctx, text), ctx.discreet, max);
}

function leadName(ctx: CardContext): string {
  const title = ctx.lead?.title ?? "Contato";
  return ctx.discreet ? initials(title) : title;
}

export function channelLabel(channel: string | undefined): string {
  switch (channel) {
    case "whatsapp":
      return "WhatsApp";
    case "instagram":
      return "Instagram";
    case "messenger":
      return "Messenger";
    case "telegram":
      return "Telegram";
    case "email":
      return "E-mail";
    case "webchat":
      return "Chat do site";
    default:
      return "Conversa";
  }
}

/** "+55 11 98765-4321" for BR mobiles, "+<digits>" otherwise. */
export function formatPhone(digits: string): string {
  const d = digits.replace(/\D/g, "");
  const br = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  if (br) return `+55 ${br[1]} ${br[2]}-${br[3]}`;
  return `+${d}`;
}

function parts(at: number, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, dd: get("day"), mm: get("month"), hm: `${get("hour")}:${get("minute")}` };
}

export function formatTime(at: number, timeZone: string): string {
  return parts(at, timeZone).hm;
}

/** "14:31" today, "ontem 16:02", else "03/11 09:00" — in the org timezone. */
export function formatWhen(at: number, now: number, timeZone: string): string {
  const p = parts(at, timeZone);
  if (p.day === parts(now, timeZone).day) return p.hm;
  if (p.day === parts(now - 24 * 60 * 60 * 1000, timeZone).day) return `ontem ${p.hm}`;
  return `${p.dd}/${p.mm} ${p.hm}`;
}

/** Offset (ms) of `timeZone` at instant `at`: local wall clock − UTC. */
function tzOffsetMs(at: number, timeZone: string): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const g = (t: string) => Number(f.find((p) => p.type === t)?.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - (at - (at % 1000));
}

/** Instant of `hour`:00 TOMORROW in `timeZone` (DST-safe, two-pass offset). */
export function tomorrowAt(now: number, timeZone: string, hour: number): number {
  const p = parts(now, timeZone);
  const [y, m, d] = p.day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d + 1, hour, 0, 0);
  let at = guess - tzOffsetMs(guess, timeZone);
  at = guess - tzOffsetMs(at, timeZone);
  return at;
}

export function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: currency || "BRL",
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    })
      .format(value)
      .replace(/ /g, " ");
  } catch {
    return String(value);
  }
}

/** One message as text for relay/history: media become text lines (D21 fallback). */
export function messageLineText(m: {
  content: string;
  contentType: string;
  transcriptText?: string;
  imageDescription?: string;
  fileName?: string;
  /** F4: mime of the first attachment (a video travels as `file`). */
  fileMime?: string;
  sticker?: boolean;
}): string {
  const caption = m.content?.trim() ?? "";
  if (m.sticker) return "[figurinha]";
  if (m.fileMime?.toLowerCase().startsWith("video/")) {
    return caption && caption !== m.fileName ? `🎬 vídeo (abrir no CRM) ${caption}` : "🎬 vídeo (abrir no CRM)";
  }
  if (m.contentType === "image") return caption ? `[imagem] ${caption}` : "[imagem]";
  if (m.contentType === "audio") {
    return m.transcriptText ? `[áudio: ${m.transcriptText.trim()}]` : "[áudio]";
  }
  if (m.contentType === "file") {
    const label = `[📎 ${m.fileName ?? "arquivo"}]`;
    return caption && caption !== m.fileName ? `${label} ${caption}` : label;
  }
  return caption;
}

// ---------------------------------------------------------------------------
// Links (D19) and buttons
// ---------------------------------------------------------------------------

export function crmLink(ctx: Pick<CardContext, "appBaseUrl">, path: string): string {
  return `${ctx.appBaseUrl}${path}`;
}

function crmUrlFor(ctx: CardContext, n?: NotificationInput): string {
  if (n?.handoffId) return crmLink(ctx, `/app/repasses?handoff=${n.handoffId}`);
  if (n?.taskId) return crmLink(ctx, `/app/tarefas?task=${n.taskId}`);
  if (n?.conversationId) return crmLink(ctx, `/app/entrada?conversation=${n.conversationId}`);
  if (n?.campaignId) return crmLink(ctx, `/app/campanhas?campanha=${n.campaignId}`);
  if (n?.type === "channel_session_lost") return crmLink(ctx, "/app/configuracoes?secao=channels");
  if (n?.type === "ai_spend_warning" || n?.type === "ai_spend_reached") {
    return crmLink(ctx, "/app/configuracoes?secao=ai");
  }
  if (ctx.conversation) return crmLink(ctx, `/app/entrada?conversation=${ctx.conversation.id}`);
  if (ctx.lead) return crmLink(ctx, `/app/pipeline?lead=${ctx.lead.id}`);
  return crmLink(ctx, "/app/painel");
}

function externalButton(ctx: CardContext): CardButton | null {
  if (ctx.discreet || !ctx.conversation || !ctx.lead) return null;
  if (ctx.conversation.channel === "whatsapp" && ctx.lead.phone) {
    return { text: "📱 Abrir no WhatsApp", url: `https://wa.me/${ctx.lead.phone.replace(/\D/g, "")}` };
  }
  if (ctx.conversation.channel === "instagram" && ctx.lead.instagramUsername) {
    return { text: "📷 Abrir no Instagram", url: `https://ig.me/m/${ctx.lead.instagramUsername.replace(/^@/, "")}` };
  }
  return null;
}

function linkRow(ctx: CardContext, n?: NotificationInput, crmText = "🔗 Abrir no CRM"): CardButton[] {
  const ext = externalButton(ctx);
  return [...(ext ? [ext] : []), { text: crmText, url: crmUrlFor(ctx, n) }];
}

const cb = (text: string, verb: CallbackVerb, id: string): CardButton => ({ text, callback_data: callbackData(verb, id) });

function viewAllRow(ctx: CardContext): CardButton[] {
  if (ctx.discreet || !ctx.conversation) return [];
  return [cb("👁 Ver tudo", "va", ctx.conversation.id)];
}

function focusOf(ctx: CardContext): CardFocus | undefined {
  if (!ctx.conversation) return undefined;
  return {
    conversationId: ctx.conversation.id,
    ...(ctx.lead ? { leadId: ctx.lead.id } : {}),
    ...(ctx.handoff ? { handoffId: ctx.handoff.id } : {}),
  };
}

const nonEmpty = (rows: CardButton[][]) => rows.filter((r) => r.length > 0);

// ---------------------------------------------------------------------------
// Card pieces
// ---------------------------------------------------------------------------

/** "<b>Maria Souza</b> · WhatsApp · +55 11 98765-4321 · Vendas › Proposta · R$ 4.800" */
export function summaryLine(ctx: CardContext): string {
  const bits: string[] = [`<b>${escapeHtml(leadName(ctx))}</b>`];
  if (ctx.conversation) bits.push(channelLabel(ctx.conversation.channel));
  if (!ctx.discreet && ctx.lead?.phone) bits.push(escapeHtml(formatPhone(ctx.lead.phone)));
  if (ctx.lead?.boardName && ctx.lead.stageName) {
    bits.push(`${escapeHtml(ctx.lead.boardName)} › ${escapeHtml(ctx.lead.stageName)}`);
  }
  if (ctx.lead?.value) bits.push(escapeHtml(formatMoney(ctx.lead.value, ctx.currency)));
  return bits.join(" · ");
}

function customerQuote(ctx: CardContext, text: string, at: number): string {
  const who = ctx.discreet ? "" : `${ctx.lead?.title?.split(/\s+/)[0] ?? "Cliente"} (${formatWhen(at, ctx.now, ctx.timezone)}): `;
  // Plain text in; expandableQuote escapes. Discreet: cut + masked BEFORE escaping.
  let body = scrub(text, ctx.discreet);
  if (ctx.discreet) {
    if (body.length > DISCREET_MAX) body = `${body.slice(0, DISCREET_MAX).trimEnd()}…`;
    body = maskDigitRuns(body);
  } else if (body.length > FULL_QUOTE_MAX) {
    // Room for the summary lines: the whole card stays editable (≤ 4096).
    body = `${body.slice(0, FULL_QUOTE_MAX).trimEnd()}… (continua no CRM)`;
  }
  return expandableQuote(`${who}"${body}"`);
}

/** "🔔 <b>Repasse da IA</b> · 14:56" — the org name only when the person has several (multi-org). */
function header(emoji: string, label: string, ctx: CardContext, at: number): string {
  const org = ctx.multiOrg ? `${escapeHtml(ctx.orgName)} · ` : "";
  return `${emoji} <b>${label}</b> · ${org}${formatWhen(at, ctx.now, ctx.timezone)}`;
}

/** The lead as a block of lines: name, "canal · telefone", "funil › etapa · valor". */
export function leadBlock(ctx: CardContext): string[] {
  if (!ctx.lead) return [];
  const lines = [`<b>${escapeHtml(leadName(ctx))}</b>`];
  const contact: string[] = [];
  if (ctx.conversation) contact.push(channelLabel(ctx.conversation.channel));
  if (!ctx.discreet && ctx.lead.phone) contact.push(escapeHtml(formatPhone(ctx.lead.phone)));
  if (contact.length > 0) lines.push(contact.join(" · "));
  const funnel: string[] = [];
  if (ctx.lead.boardName && ctx.lead.stageName) funnel.push(`${escapeHtml(ctx.lead.boardName)} › ${escapeHtml(ctx.lead.stageName)}`);
  if (ctx.lead.value) funnel.push(escapeHtml(formatMoney(ctx.lead.value, ctx.currency)));
  if (funnel.length > 0) lines.push(funnel.join(" · "));
  return lines;
}

/** Blocks separated by a blank line; empty ones dropped. */
const blocks = (parts: (string | null | undefined | false)[]): string => parts.filter(Boolean).join("\n\n");

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function buildNotificationCard(args: {
  notification: NotificationInput;
  context: CardContext;
  mode?: "full" | "discreet";
}): CardOutput {
  const n = args.notification;
  const ctx: CardContext = { ...args.context, discreet: args.mode ? args.mode === "discreet" : args.context.discreet };
  switch (TELEGRAM_TEMPLATES[n.type] ?? "generic") {
    case "handoff":
      return handoffCard(n, ctx);
    case "handoff_resolved":
      return simpleCard("✅", n, ctx, [linkRow(ctx, n, "🔗 Abrir conversa")]);
    case "new_message":
      return newMessageCard(n, ctx);
    case "draft":
      return draftCard(n, ctx);
    case "followup":
      return followUpCard(n, ctx);
    case "task":
      return taskCard(n, ctx);
    case "transferred":
      return transferredCard(n, ctx);
    default:
      return genericCard(n, ctx);
  }
}

function handoffCard(n: NotificationInput, ctx: CardContext): CardOutput {
  const h = ctx.handoff;
  const from = h?.fromAi !== false ? "Repasse da IA" : `Repasse de ${escapeHtml(scrub(h?.fromName ?? "um colega", ctx.discreet))}`;
  const head = [header("🔔", from, ctx, n.createdAt), ...leadBlock(ctx)].join("\n");
  // Suggested actions are free text that may carry names or numbers: full mode only.
  const actions =
    !ctx.discreet && h?.suggestedActions && h.suggestedActions.length > 0
      ? ["<b>Ações sugeridas</b>", ...h.suggestedActions.slice(0, 5).map((a) => `• ${safe(a, false, 160)}`)].join("\n")
      : null;
  const text = blocks([
    head,
    h?.reason ? `<b>Motivo:</b> ${safe(redactName(ctx, h.reason), ctx.discreet, 500)}` : null,
    !ctx.discreet && h?.summary ? `<b>Resumo</b>\n${safe(h.summary, false, 800)}` : null,
    actions,
    ctx.lastInbound ? customerQuote(ctx, ctx.lastInbound.text, ctx.lastInbound.at) : null,
    h && h.status !== "pending"
      ? h.status === "accepted"
        ? `⚠️ Repasse já aceito por ${escapeHtml(h.acceptedByName ?? "outro membro")}`
        : "⚠️ Este repasse já foi resolvido"
      : null,
  ]);
  if (h && h.status !== "pending") {
    return { text, keyboard: nonEmpty([viewAllRow(ctx), linkRow(ctx, n)]), focus: focusOf(ctx) };
  }
  const buttons: CardButton[] = [];
  if (h) buttons.push(cb("✅ Aceitar", "ah", h.id));
  if (ctx.conversation) {
    buttons.push(cb("🤖 Instruir a IA", "ia", ctx.conversation.id));
    buttons.push(cb("🔁 Regenerar", "rg", ctx.conversation.id));
  }
  return { text, keyboard: nonEmpty([buttons, viewAllRow(ctx), linkRow(ctx, n)]), focus: focusOf(ctx) };
}

function relayBody(ctx: CardContext, lines: HistoryLine[]): string {
  const text = lines.map((l) => l.text).filter(Boolean).join("\n");
  if (!text) return "";
  const long = text.length > 300 || lines.length > 4;
  if (long || ctx.discreet) {
    let body = scrub(text, ctx.discreet);
    if (ctx.discreet) {
      if (body.length > DISCREET_MAX) body = `${body.slice(0, DISCREET_MAX).trimEnd()}…`;
      body = maskDigitRuns(body);
    }
    return expandableQuote(body);
  }
  return lines.map((l) => `"${escapeHtml(l.text)}"`).join("\n");
}

function conversationActions(ctx: CardContext): CardButton[] {
  if (!ctx.conversation) return [];
  return [cb("💬 Responder", "rp", ctx.conversation.id), cb("🤖 Instruir a IA", "ia", ctx.conversation.id)];
}

function newMessageCard(n: NotificationInput, ctx: CardContext): CardOutput {
  const lines = ctx.relayLines ?? [];
  const at = lines.length > 0 ? lines[lines.length - 1]!.at : n.createdAt;
  const org = ctx.multiOrg ? `${escapeHtml(ctx.orgName)} · ` : "";
  const head = `💬 <b>${escapeHtml(leadName(ctx))}</b> · ${channelLabel(ctx.conversation?.channel)} · ${org}${formatWhen(at, ctx.now, ctx.timezone)}`;
  const body = relayBody(ctx, lines) || safe(n.body ?? "", ctx.discreet, 1500);
  return {
    text: blocks([head, body]),
    keyboard: nonEmpty([conversationActions(ctx), linkRow(ctx, n)]),
    focus: focusOf(ctx),
  };
}

function draftCard(n: NotificationInput, ctx: CardContext): CardOutput {
  const head = `✍️ Rascunho da IA para <b>${escapeHtml(leadName(ctx))}</b>`;
  if (!ctx.draft) {
    return {
      text: blocks([head, safe(n.body ?? "", ctx.discreet, 500), "<i>Nenhum rascunho pendente agora.</i>"]),
      keyboard: nonEmpty([linkRow(ctx, n)]),
      focus: focusOf(ctx),
    };
  }
  const draft = ctx.discreet ? safe(ctx.draft.text, true) : escapeHtml(ctx.draft.text);
  const actions: CardButton[] = [cb("📤 Enviar", "sd", ctx.draft.messageId)];
  if (ctx.conversation) actions.push(cb("🔁 Regenerar", "rg", ctx.conversation.id));
  actions.push(cb("🗑 Descartar", "dd", ctx.draft.messageId));
  return {
    text: blocks([head, `<blockquote expandable>${draft}</blockquote>`]),
    keyboard: nonEmpty([actions, linkRow(ctx, n)]),
    focus: focusOf(ctx),
  };
}

function followUpCard(n: NotificationInput, ctx: CardContext): CardOutput {
  const parts: (string | null)[] = [
    `⚠️ <b>${safeText(ctx, n.title, 300) || "Follow-up da IA precisa de você"}</b>`,
    n.body ? safeText(ctx, n.body, 800) : null,
    ctx.lead ? leadBlock(ctx).join("\n") : null,
  ];
  const actions: CardButton[] = [];
  if (ctx.conversation) actions.push(cb("🤖 Instruir a IA", "ia", ctx.conversation.id));
  if (ctx.task && ctx.task.status !== "completed") actions.push(cb("✅ Concluir tarefa", "ct", ctx.task.id));
  return { text: blocks(parts), keyboard: nonEmpty([actions, linkRow(ctx, n)]), focus: focusOf(ctx) };
}

const TASK_HEADLINE: Partial<Record<NotificationType, string>> = {
  task_assigned: "📌 Nova tarefa para você",
  task_due_soon: "📌 Tarefa vence em breve",
  task_overdue: "📌 Tarefa atrasada",
};

function taskCard(n: NotificationInput, ctx: CardContext): CardOutput {
  const t = ctx.task;
  const head = TASK_HEADLINE[n.type] ?? "📌 Tarefa";
  const headline = `<b>${t?.dueDate ? `${head} · ${formatWhen(t.dueDate, ctx.now, ctx.timezone)}` : head}</b>`;
  const taskTitle = ctx.discreet && !ctx.lead ? "Tarefa" : safeText(ctx, t?.title ?? n.body ?? n.title, 300);
  let detail = `"${taskTitle}"${ctx.lead ? ` · lead ${escapeHtml(leadName(ctx))}` : ""}`;
  if (ctx.lead?.value) detail += ` · ${escapeHtml(formatMoney(ctx.lead.value, ctx.currency))}`;
  const lines = [headline, detail];
  if (t && t.status === "completed") {
    return { text: blocks([headline, detail, "✅ Já concluída"]), keyboard: nonEmpty([linkRow(ctx, n, "🔗 Abrir tarefa")]) };
  }
  const actions: CardButton[] = t
    ? [cb("✅ Concluir", "ct", t.id), cb("⏰ Adiar 1h", "sz1", t.id), cb("🌅 Amanhã 9h", "sz9", t.id)]
    : [];
  return { text: blocks(lines), keyboard: nonEmpty([actions, linkRow(ctx, n, "🔗 Abrir tarefa")]), focus: focusOf(ctx) };
}

function transferredCard(n: NotificationInput, ctx: CardContext): CardOutput {
  const parts: (string | null)[] = [`➡️ <b>${safeText(ctx, n.title, 300) || "Conversa transferida para você"}</b>`];
  // Body is the contact label: initials only in discreet mode (the lead block already shows it).
  if (n.body && !ctx.discreet) parts.push(safe(n.body, false, 500));
  if (ctx.lead) parts.push(leadBlock(ctx).join("\n"));
  return { text: blocks(parts), keyboard: nonEmpty([conversationActions(ctx), linkRow(ctx, n)]), focus: focusOf(ctx) };
}

function simpleCard(emoji: string, n: NotificationInput, ctx: CardContext, rows: CardButton[][]): CardOutput {
  // Generic bodies are system text (spend, channel); `handoff_resolved`'s body
  // is the lead title, which `redactName` turns into initials.
  const body = n.body ? safe(redactName(ctx, n.body), ctx.discreet, 1500) : "";
  return { text: blocks([`${emoji} <b>${safe(redactName(ctx, n.title), ctx.discreet, 300)}</b>`, body]), keyboard: nonEmpty(rows), focus: focusOf(ctx) };
}

const GENERIC_EMOJI: Partial<Record<NotificationType, string>> = {
  channel_session_lost: "🔴",
  ai_spend_warning: "💸",
  ai_spend_reached: "💸",
  task_comment_mention: "💬",
  campaign_completed: "📣",
  campaign_paused: "⏸",
};

function genericCard(n: NotificationInput, ctx: CardContext): CardOutput {
  return simpleCard(GENERIC_EMOJI[n.type] ?? "🔔", n, ctx, [[{ text: "🔗 Abrir no CRM", url: crmUrlFor(ctx, n) }]]);
}

// ---------------------------------------------------------------------------
// AI relay, history ("Ver tudo"), records and prompts
// ---------------------------------------------------------------------------

/** "🤖 IA → Maria Souza · 14:34" + the text + Regenerar · Assumir eu · Ver tudo. */
export function buildAiRelayCard(ctx: CardContext, message: { text: string; at: number }): CardOutput {
  const head = `🤖 IA → <b>${escapeHtml(leadName(ctx))}</b> · ${formatWhen(message.at, ctx.now, ctx.timezone)}`;
  const body = ctx.discreet ? safe(message.text, true) : escapeHtml(message.text);
  const actions: CardButton[] = ctx.conversation
    ? [cb("🔁 Regenerar", "rg", ctx.conversation.id), cb("🙋 Assumir eu", "ae", ctx.conversation.id), ...viewAllRow(ctx)]
    : [];
  return {
    text: `${head}\n<blockquote expandable>${body}</blockquote>`,
    keyboard: nonEmpty([actions, linkRow(ctx)]),
    focus: focusOf(ctx),
  };
}

const HISTORY_LINE_MAX = 350;
const HISTORY_TOTAL_MAX = 3400;

/** "Ver tudo": last messages "autor (quando): texto" + keyboard with Resumir first. */
export function buildHistoryCard(ctx: CardContext, history: HistoryLine[], cardKeyboard: CardKeyboard): CardOutput {
  const head = `🗂 <b>${escapeHtml(leadName(ctx))}</b> · últimas ${history.length} mensagens`;
  const out: string[] = [head];
  let total = head.length;
  for (const l of history) {
    const line = `<b>${escapeHtml(l.author)}</b> (${formatWhen(l.at, ctx.now, ctx.timezone)}): ${safe(l.text, false, HISTORY_LINE_MAX)}`;
    if (total + line.length > HISTORY_TOTAL_MAX) {
      out.push("…");
      break;
    }
    out.push(line);
    total += line.length + 1;
  }
  const rows = cardKeyboard
    .map((row) => row.filter((b) => !("callback_data" in b && b.callback_data.startsWith("va:"))))
    .filter((row) => row.length > 0);
  const summarize = ctx.conversation ? [[cb("📝 Resumir", "rs", ctx.conversation.id)]] : [];
  return { text: out.join("\n"), keyboard: [...summarize, ...rows], focus: focusOf(ctx) };
}

/** `links` = WhatsApp/Instagram + CRM; `crm` = CRM only (copies that lost the race). */
export type RecordAction = "reply" | "instruct" | "regenerate" | "viewAll" | "complete" | "links" | "crm";

/** "Mensagem vira registro": status line + summary + the given buttons. */
export function buildRecordCard(
  ctx: CardContext,
  status: string,
  actions: RecordAction[],
  quote?: string,
): CardOutput {
  const lines = [status];
  if (ctx.lead) lines.push(summaryLine(ctx));
  if (quote) lines.push(`<blockquote expandable>${safe(quote, ctx.discreet, 1500)}</blockquote>`);
  const row: CardButton[] = [];
  const conv = ctx.conversation?.id;
  if (conv && actions.includes("reply")) row.push(cb("💬 Responder", "rp", conv));
  if (conv && actions.includes("instruct")) row.push(cb("🤖 Instruir a IA", "ia", conv));
  if (conv && actions.includes("regenerate")) row.push(cb("🔁 Regenerar", "rg", conv));
  if (ctx.task && actions.includes("complete")) row.push(cb("✅ Concluir", "ct", ctx.task.id));
  const rows: CardButton[][] = [row];
  if (actions.includes("viewAll")) rows.push(viewAllRow(ctx));
  const crmText = ctx.task && !conv ? "🔗 Abrir tarefa" : "🔗 Abrir no CRM";
  if (actions.includes("links")) rows.push(linkRow(ctx, undefined, crmText));
  else if (actions.includes("crm")) rows.push([{ text: crmText, url: crmUrlFor(ctx) }]);
  return { text: lines.join("\n"), keyboard: nonEmpty(rows), focus: focusOf(ctx) };
}

export function quoteSnippet(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

/**
 * D23 countdown: "⏳ Enviando em N s → lead (canal)" + the text + Regenerar ·
 * Cancelar envio (`vc:`). Used for AI drafts and for the member's own reply
 * in automatic mode.
 */
export function buildCountdownCard(
  ctx: CardContext,
  text: string,
  seconds: number,
  cancelId: string,
  attachment?: DraftAttachmentLine,
  /** Review F4 #5: the member's OWN reply (text or file) — nothing to regenerate. */
  origin: "ai" | "human" = "ai",
): CardOutput {
  const conv = ctx.conversation?.id ?? "0";
  const body = ctx.discreet ? safe(text, true) : escapeHtml(text);
  return {
    text:
      `⏳ Enviando em ${seconds} s → <b>${escapeHtml(leadName(ctx))}</b> (${channelLabel(ctx.conversation?.channel)})\n` +
      (attachment ? `${attachmentLine(attachment)}\n` : "") +
      (text.trim() ? `<blockquote expandable>${body}</blockquote>` : ""),
    keyboard:
      origin === "human"
        ? [[cb("✖ Cancelar envio", "vc", cancelId)]]
        : [[cb("🔁 Regenerar", "rg", conv), cb("✖ Cancelar envio", "vc", cancelId)]],
    focus: focusOf(ctx),
  };
}

export type PromptKind = "instruct_ai" | "regenerate" | "reply_customer";

export function buildPrompt(kind: PromptKind, ctx: CardContext): CardOutput {
  const conv = ctx.conversation?.id ?? "0";
  const name = `<b>${escapeHtml(leadName(ctx))}</b>`;
  if (kind === "instruct_ai") {
    return {
      text: `🤖 Diga à IA o que fazer com ${name} (escreva a instrução):`,
      keyboard: [[cb("↩️ Devolver sem instrução", "ni", conv), cb("✖ Cancelar", "cp", conv)]],
    };
  }
  if (kind === "regenerate") {
    return {
      text: '🔁 Por que regenerar? (ex.: "muito formal", "não ofereça desconto", "mais curta")',
      keyboard: [[cb("✖ Cancelar", "cp", conv)]],
    };
  }
  return {
    text: `💬 Escreva, grave ou mande um arquivo para ${name} (${channelLabel(ctx.conversation?.channel)}):`,
    keyboard: [[cb("✖ Cancelar", "cp", conv)]],
  };
}

/** F4 (§4.5): the attachment line of a preview/countdown/record ("📄 contrato.pdf · 3,1 MB"). */
export type DraftAttachmentLine = { name: string; size: number; kind: "photo" | "voice" | "audio" | "document" };
export function attachmentLine(a: DraftAttachmentLine): string {
  const icon = a.kind === "document" ? "📄" : a.kind === "photo" ? "📎" : "🎙";
  return `${icon} ${escapeHtml(a.name)} · ${sizeLabel(a.size)}`;
}
function sizeLabel(bytes: number): string {
  const MB = 1024 * 1024;
  const one = (n: number) => (Math.round(n * 10) / 10).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  if (bytes >= MB) return `${one(bytes / MB)} MB`;
  if (bytes >= 1024) return `${one(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function buildReplyPreview(ctx: CardContext, text: string, attachment?: DraftAttachmentLine): CardOutput {
  const conv = ctx.conversation?.id ?? "0";
  return {
    text:
      `Enviar para <b>${escapeHtml(leadName(ctx))}</b> no ${channelLabel(ctx.conversation?.channel)}?\n` +
      (attachment ? `${attachmentLine(attachment)}\n` : "") +
      (text.trim() ? `<blockquote expandable>${escapeHtml(text)}</blockquote>` : ""),
    keyboard: [[cb("📤 Enviar", "ps", conv), cb("✖ Cancelar", "cp", conv)]],
  };
}

/** §4.10 copy for a refused action. */
export function permissionDeniedText(role: string, permission: string, orgName: string): string {
  return (
    `🚫 Você não tem permissão para isso (perfil "${escapeHtml(role)}" sem ${escapeHtml(permission)}). ` +
    `Fale com um admin da ${escapeHtml(orgName)}.`
  );
}
