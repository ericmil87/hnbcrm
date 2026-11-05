/**
 * Telegram actions (F1, D6/D8) — the ONLY Telegram module that calls domain
 * ports. Every handler runs `authorizeTelegramActor` first: chat → the link of
 * the card's org (from the tapped delivery, not the chat's active org) →
 * member alive → module on → RBAC with the same category/level as the public
 * mutation → entity of that org → port. Build guard: `telegramActionsPort.test.ts`.
 *
 * Runs inside a mutation and returns what to send/edit; the action sends
 * (`telegram.internalProcessUpdate`). Writes carry `via:"telegram"`.
 */
import { ConvexError, type Value } from "convex/values";
import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { acceptHandoffCore, rejectHandoffWithInstructionCore } from "../handoffs";
import { acceptAiDraftCore, discardAiDraftCore, requestAiDraftCore, returnToAiCore } from "../attendant";
import { assumeConversationCore, internalSendMessageCore } from "../conversations";
import { applyTaskCompletion, reopenTaskCore, snoozeTaskCore } from "./taskOps";
import { requireAccountWithEmail } from "./auth";
import { canStartReconnect } from "./channelReconnectCore";
import { safeTimezone } from "./promptDateTime";
import { discardDraftFile, discardPromptDraft, type DraftAttachment, type PendingPrompt } from "./telegramDrafts";
import { otherHumanHolder } from "./conversationHolder";
import { syncFollowUpForTask } from "./followUpOps";
import { hasPermission, resolvePermissions, type PermissionCategory, type Permissions, type Role } from "./permissions";
import { modulesOf } from "./orgModules";
import { activeLinksOfChat, isLinkMemberAlive, revokeTelegramLink } from "./telegramLinks";
import { loadCardContext, loadHistory, pendingDraftOf } from "./telegramContext";
import { conversationCrmUrl, mediaForMessages, type MediaOut } from "./telegramMedia";
import { COPY } from "./telegramCore";
import { confirmPendingActionCore, cancelPendingActionCore } from "./copilotPendingActions";
import { moveLeadToStageCore } from "./leadStageMove";
import {
  MODE_COPY,
  STEP_LABELS,
  AUTO_PAUSE_UNDOS,
  autoSendSeconds,
  autoWriteTools,
  AI_BACK_IN_CHARGE,
  draftAutoSendable,
  isTelegramRequestedDraft,
  effectiveAssistantMode,
} from "./telegramAssistant";
import { escapeHtml } from "./telegramFormat";
import { PAIRING_ATTEMPTS_PER_HOUR, consumePairingAttempt, pairingWindow } from "./pairingQuota";
import {
  buildAiRelayCard,
  attachmentLine,
  buildCountdownCard,
  buildHistoryCard,
  buildNotificationCard,
  buildPrompt,
  buildRecordCard,
  reconnectLimitCard,
  reconnectNotAllowedCard,
  buildReplyPreview,
  formatTime,
  formatWhen,
  parseCallbackData,
  permissionDeniedText,
  quoteSnippet,
  tomorrowAt,
  type CardContext,
  type CardKeyboard,
  type CallbackVerb,
  type PromptKind,
} from "./telegramNotifications";

export const PROMPT_TTL_MS = 15 * 60 * 1000;
export const INSTRUCTION_MAX_CHARS = 2000;
/** Server-side cap for a reply typed in Telegram (the dispatcher splits per channel). */
export const REPLY_MAX_CHARS = 4096;

export type DeliveryKind = "notification" | "relay" | "prompt" | "copilot" | "auto_record" | "draft" | "media";
export type RecordSpec = {
  organizationId: Id<"organizations">;
  linkId: Id<"telegramLinks">;
  kind: DeliveryKind;
  conversationId?: Id<"conversations">;
  handoffId?: Id<"handoffs">;
  taskId?: Id<"tasks">;
  notificationId?: Id<"notifications">;
  crmMessageId?: Id<"messages">;
  /** F4: the blob a media message carried (dedupe of "Ver tudo"). */
  mediaStorageId?: string;
  /** The sent message becomes `telegramChats.pendingPrompt.promptMessageId`… */
  setPromptMessageId?: boolean;
  /** …only if the open prompt still has this `expiresAt` (the one the send was for). */
  promptExpiresAt?: number;
  /** F3 (D22): automatic-mode record. */
  undo?: { steps: { kind: string; refId: string; before?: Value; after?: Value }[]; expiresAt: number };
  /** F3 (D23): countdown card. */
  autoSend?: { delayMs: number; draftMessageId?: Id<"messages"> };
};
export type SendOp = {
  chatId: number;
  text: string;
  keyboard?: CardKeyboard;
  protectContent?: boolean;
  record?: RecordSpec;
  /** F4 (D21): files sent right after this message, one Telegram message each. */
  media?: MediaOut[];
};
export type EditOp = { chatId: number; messageId: number; text: string; keyboard?: CardKeyboard };
export type ActionResult = { replies: SendOp[]; edits: EditOp[] };

const empty = (): ActionResult => ({ replies: [], edits: [] });

/** "Ver tudo" does not resend a file this chat got for the conversation in the last 7 days. */
const MEDIA_DEDUPE_MS = 7 * 24 * 60 * 60 * 1000;
function alreadySentLine(m: MediaOut, crmUrl: string): string {
  const icon = m.mime.startsWith("image/") ? "🖼" : m.mime.startsWith("audio/") ? "🎙" : "📄";
  return `${icon} ${escapeHtml(m.fileName)} (já enviado acima) · <a href="${escapeHtml(crmUrl)}">Abrir no CRM</a>`;
}

/** `ConvexError.data.kind` of a failed Telegram action (review F1 #10). */
export const TELEGRAM_FAILURE = "telegramFailure";

/**
 * A port threw: abort the WHOLE mutation (every write so far rolls back — a
 * caught exception would keep the partial writes) and still tell the user.
 * `telegram.internalProcessUpdate` sends `result` from the thrown error.
 */
function failWith(result: ActionResult): never {
  throw new ConvexError({ kind: TELEGRAM_FAILURE, result });
}
const say = (chatId: number, text: string): ActionResult => ({ replies: [{ chatId, text }], edits: [] });

// ---------------------------------------------------------------------------
// Authorization (D6)
// ---------------------------------------------------------------------------

export type TelegramActor = {
  link: Doc<"telegramLinks">;
  member: Doc<"teamMembers">;
  org: Doc<"organizations">;
};

async function chatOf(ctx: MutationCtx, chatId: number) {
  return await ctx.db
    .query("telegramChats")
    .withIndex("by_chat_id", (q) => q.eq("chatId", chatId))
    .first();
}

/**
 * The single authorization door of Telegram actions. `organizationId` is the
 * org of the card (delivery row) when known; otherwise the chat's active org.
 * A removed member has the link revoked here (the cleanup says goodbye).
 */
export async function authorizeTelegramActor(
  ctx: MutationCtx,
  args: {
    chatId: number;
    organizationId?: Id<"organizations">;
    permission?: [PermissionCategory, string];
    now: number;
  },
): Promise<{ ok: true; actor: TelegramActor } | { ok: false; result: ActionResult }> {
  const links = await activeLinksOfChat(ctx, args.chatId);
  const chat = await chatOf(ctx, args.chatId);
  const orgId = args.organizationId ?? chat?.activeOrganizationId;
  const link = links.find((l) => l.organizationId === orgId);
  if (!link) {
    return {
      ok: false,
      result: say(args.chatId, "Este cartão é de uma organização que não está conectada a este Telegram."),
    };
  }
  const member = await ctx.db.get(link.teamMemberId);
  if (!member || !isLinkMemberAlive(link, member)) {
    await revokeTelegramLink(ctx, link, "member_removed", { now: args.now });
    return { ok: false, result: empty() };
  }
  const org = await ctx.db.get(link.organizationId);
  if (!org || !modulesOf(org).telegram) return { ok: false, result: say(args.chatId, COPY.moduleOff) };
  if (args.permission) {
    const [category, level] = args.permission;
    const perms = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
    if (!hasPermission(perms, category, level)) {
      return {
        ok: false,
        result: say(args.chatId, permissionDeniedText(member.role, `${category}:${level}`, org.name)),
      };
    }
  }
  return { ok: true, actor: { link, member, org } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Tap = {
  chatId: number;
  messageId: number;
  id: string;
  now: number;
  appBaseUrl: string;
  delivery: Doc<"telegramDeliveries"> | null;
  orgId?: Id<"organizations">;
};

function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : "";
  // ConvexError carries data; plain Error carries a PT-BR message from the port.
  const data = (e as { data?: unknown })?.data;
  const msg = typeof data === "string" ? data : raw.replace(/^Uncaught (Convex)?Error:\s*/, "");
  return `⚠️ ${escapeHtml(msg || "Não foi possível concluir a ação.")}`;
}

async function contextFor(
  ctx: MutationCtx,
  actor: TelegramActor,
  tap: Pick<Tap, "now" | "appBaseUrl">,
  refs: { conversationId?: Id<"conversations">; handoffId?: Id<"handoffs">; taskId?: Id<"tasks">; notification?: Doc<"notifications"> },
): Promise<CardContext> {
  const c = await loadCardContext(ctx.db, {
    organizationId: actor.org._id,
    now: tap.now,
    appBaseUrl: tap.appBaseUrl,
    // Multi-org chat: the rebuilt card keeps the org name in its header.
    chatId: actor.link.chatId,
    ...refs,
  });
  return c ?? {
    orgName: actor.org.name,
    timezone: "America/Sao_Paulo",
    currency: "BRL",
    appBaseUrl: tap.appBaseUrl,
    discreet: false,
    now: tap.now,
  };
}

async function setFocus(
  ctx: MutationCtx,
  chatId: number,
  focus: { conversationId: Id<"conversations">; leadId?: Id<"leads">; handoffId?: Id<"handoffs"> },
  now: number,
) {
  const chat = await chatOf(ctx, chatId);
  if (!chat) return;
  await ctx.db.patch(chat._id, { focus: { ...focus, setAt: now, source: "notification" }, updatedAt: now });
}

/**
 * `callback_data` is client-supplied: an id is accepted only if it belongs to
 * the expected TABLE (a handoff verb with a task id resolves to nothing).
 */
async function getTyped<T extends "conversations" | "handoffs" | "messages" | "tasks" | "leads">(
  ctx: MutationCtx,
  table: T,
  id: string,
) {
  const normalized = ctx.db.normalizeId(table, id);
  return normalized ? await ctx.db.get(normalized) : null;
}

async function conversationOf(ctx: MutationCtx, actor: TelegramActor, id: string) {
  const conversation = await getTyped(ctx, "conversations", id);
  return conversation && conversation.organizationId === actor.org._id ? conversation : null;
}

async function pendingHandoffOf(ctx: MutationCtx, conversationId: Id<"conversations">) {
  return await ctx.db
    .query("handoffs")
    .withIndex("by_conversation_and_status", (q) => q.eq("conversationId", conversationId).eq("status", "pending"))
    .first();
}

/** Clears the open prompt. An UNSENT file draft is discarded (quota back, file row + blob deleted). */
async function clearPrompt(ctx: MutationCtx, chatId: number, now: number, opts: { sent?: boolean } = {}) {
  const chat = await chatOf(ctx, chatId);
  if (!chat?.pendingPrompt) return;
  if (!opts.sent) await discardPromptDraft(ctx, chat.pendingPrompt);
  await ctx.db.patch(chat._id, { pendingPrompt: undefined, updatedAt: now });
}

export { discardPromptDraft };

/** contentType of the CRM message for a file sent from Telegram. */
function contentTypeOf(a: DraftAttachment | undefined): "text" | "image" | "audio" | "file" {
  if (!a) return "text";
  return a.kind === "photo" ? "image" : a.kind === "document" ? "file" : "audio";
}

/**
 * The card a reply was sent from remembers the CRM message (and the quota of
 * its file): a failed dispatch edits it to "✗ Falhou" and gives the quota back
 * (`lib/telegramRelay.maybeNotifyTelegramSendFailed`).
 */
async function bindSentMessage(
  ctx: MutationCtx,
  chatId: number,
  cardMessageId: number,
  crmMessageId: Id<"messages">,
  attachment: DraftAttachment | undefined,
) {
  const delivery = await ctx.db
    .query("telegramDeliveries")
    .withIndex("by_chat_and_message", (q) => q.eq("chatId", chatId).eq("messageId", cardMessageId))
    .first();
  if (!delivery) return;
  await ctx.db.patch(delivery._id, {
    sentCrmMessageId: crmMessageId,
    ...(attachment
      ? { fileQuota: { bytes: attachment.size, dayKey: attachment.quota.dayKey, ...(attachment.quota.hourStart !== undefined ? { hourStart: attachment.quota.hourStart } : {}) } }
      : {}),
  });
}

const notFound = (chatId: number) => say(chatId, "⚠️ Não encontrei este item. Ele pode ter sido apagado.");

function edit(tap: Pick<Tap, "chatId" | "messageId">, card: { text: string; keyboard: CardKeyboard }): EditOp {
  return { chatId: tap.chatId, messageId: tap.messageId, text: card.text, keyboard: card.keyboard };
}

const INBOX_REPLY: [PermissionCategory, string] = ["inbox", "reply"];
const INBOX_VIEW: [PermissionCategory, string] = ["inbox", "view_own"];

// ---------------------------------------------------------------------------
// Callback entry point
// ---------------------------------------------------------------------------

export async function handleTelegramCallback(
  ctx: MutationCtx,
  args: { chatId: number; messageId?: number; data?: string; now: number; appBaseUrl: string },
): Promise<ActionResult> {
  const parsed = parseCallbackData(args.data);
  if (!parsed || args.messageId === undefined) return empty();
  const delivery = await ctx.db
    .query("telegramDeliveries")
    .withIndex("by_chat_and_message", (q) => q.eq("chatId", args.chatId).eq("messageId", args.messageId!))
    .first();
  const chat = await chatOf(ctx, args.chatId);
  const tap: Tap = {
    chatId: args.chatId,
    messageId: args.messageId,
    id: parsed.id,
    now: args.now,
    appBaseUrl: args.appBaseUrl,
    delivery,
    orgId: delivery?.organizationId ?? chat?.pendingPrompt?.organizationId ?? chat?.activeOrganizationId,
  };
  const handlers: Record<CallbackVerb, (ctx: MutationCtx, tap: Tap) => Promise<ActionResult>> = {
    ah: onAcceptHandoff,
    ia: (c, t) => onOpenPrompt(c, t, "instruct_ai"),
    rg: (c, t) => onOpenPrompt(c, t, "regenerate"),
    rp: (c, t) => onOpenPrompt(c, t, "reply_customer"),
    ni: onReturnWithoutInstruction,
    cp: onCancelPrompt,
    ps: onSendPreviewedReply,
    sd: onSendDraft,
    dd: onDiscardDraft,
    ct: onCompleteTask,
    sz1: (c, t) => onSnoozeTask(c, t, "1h"),
    sz9: (c, t) => onSnoozeTask(c, t, "tomorrow9"),
    va: onViewAll,
    rs: onSummarize,
    ae: onAssume,
    // F3
    pa: onConfirmPending,
    pc: onCancelPending,
    un: onUndoAutoRecord,
    aj: onAdjust,
    md: onSetMode,
    vc: onVetoSend,
    // v0.78: reconnect the WhatsApp (bridge) from the channel_session_lost card
    rc: (c, t) => onReconnect(c, t, "code"),
    rcq: (c, t) => onReconnect(c, t, "qr"),
    rcx: onReconnectCancel,
  };
  return await handlers[parsed.verb](ctx, tap);
}

// ---------------------------------------------------------------------------
// Handlers (authorization first in every one)
// ---------------------------------------------------------------------------

async function onAcceptHandoff(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: INBOX_REPLY, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const handoff = await getTyped(ctx, "handoffs", tap.id);
  if (!handoff || handoff.organizationId !== actor.org._id) return notFound(tap.chatId);
  if (handoff.conversationId) {
    await setFocus(ctx, tap.chatId, { conversationId: handoff.conversationId, leadId: handoff.leadId, handoffId: handoff._id }, tap.now);
  }
  try {
    await acceptHandoffCore(ctx, { handoff, member: actor.member, via: "telegram" });
  } catch (e) {
    const fresh = await ctx.db.get(handoff._id);
    if (fresh?.status === "accepted" && fresh.acceptedBy) {
      // Lost the race: only the tapped card changes (every other copy is edited
      // by `telegram.internalMarkHandoffCards`, scheduled from `acceptHandoffCore`).
      const owner = await ctx.db.get(fresh.acceptedBy);
      const card = await contextFor(ctx, actor, tap, { handoffId: fresh._id, conversationId: fresh.conversationId });
      const at = formatTime(fresh.resolvedAt ?? tap.now, card.timezone);
      const record = buildRecordCard(card, `⚠️ Repasse já aceito por ${escapeHtml(owner?.name ?? "outro membro")} · ${at}`, ["viewAll", "crm"]);
      failWith({ replies: [], edits: [edit(tap, record)] });
    }
    failWith(say(tap.chatId, errorText(e)));
  }
  // The other recipients' copies are edited by the hook in `acceptHandoffCore`
  // (it skips this member: via "telegram"); this card becomes the record.
  const card = await contextFor(ctx, actor, tap, { handoffId: handoff._id, conversationId: handoff.conversationId });
  const mine = buildRecordCard(card, `✅ Aceito por você · ${formatTime(tap.now, card.timezone)}`, ["reply", "instruct", "links"]);
  return { replies: [], edits: [edit(tap, mine)] };
}

/**
 * Stale-card guard (review F1 #1): a card that still offers "Instruir a IA" /
 * "Devolver" / "Assumir" must not take the conversation from whoever took it
 * since (accepted in the web app, assumed in the inbox). Returns the copy to
 * show, or null when the actor may proceed.
 */
async function takenOverCopy(
  ctx: MutationCtx,
  actor: TelegramActor,
  conversation: Doc<"conversations">,
  handoffId: string | undefined,
  now: number,
  timezone: string,
): Promise<string | null> {
  const holder = await otherHumanHolder(ctx.db, {
    organizationId: actor.org._id,
    actorId: actor.member._id,
    conversation,
    handoffId,
    now,
  });
  if (!holder) return null;
  return `⚠️ ${escapeHtml(holder.member.name)} assumiu esta conversa${holder.at ? ` às ${formatTime(holder.at, timezone)}` : ""}.`;
}

/** Refusal for a stale card: the card (if known) becomes the record and the copy is said. */
async function refuseTakenOver(
  ctx: MutationCtx,
  actor: TelegramActor,
  tap: Pick<Tap, "chatId" | "now" | "appBaseUrl">,
  conversation: Doc<"conversations">,
  copy: string,
  cardMessageId: number | undefined,
): Promise<ActionResult> {
  const card = await contextFor(ctx, actor, tap, { conversationId: conversation._id });
  const record = buildRecordCard(card, copy, ["viewAll", "crm"]);
  const edits: EditOp[] = cardMessageId
    ? [{ chatId: tap.chatId, messageId: cardMessageId, text: record.text, keyboard: record.keyboard }]
    : [];
  return { replies: [{ chatId: tap.chatId, text: copy }], edits };
}

async function onOpenPrompt(ctx: MutationCtx, tap: Tap, kind: PromptKind): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: INBOX_REPLY, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const conversation = await conversationOf(ctx, actor, tap.id);
  if (!conversation) return notFound(tap.chatId);
  const chat = await chatOf(ctx, tap.chatId);
  if (!chat) return empty();
  if (kind === "instruct_ai") {
    const tz = (await contextFor(ctx, actor, tap, {})).timezone;
    const copy = await takenOverCopy(ctx, actor, conversation, tap.delivery?.handoffId, tap.now, tz);
    if (copy) return await refuseTakenOver(ctx, actor, tap, conversation, copy, tap.messageId);
  }
  // D23: "Regenerar" on a countdown card vetoes the pending send first.
  if (kind === "regenerate" && tap.delivery?.kind === "draft" && tap.delivery.draft && !tap.delivery.draft.sentAt) {
    await ctx.db.patch(tap.delivery._id, { draft: { ...tap.delivery.draft, vetoedAt: tap.now } });
  }
  const expiresAt = tap.now + PROMPT_TTL_MS;
  if (chat.pendingPrompt) await discardPromptDraft(ctx, chat.pendingPrompt);
  await ctx.db.patch(chat._id, {
    pendingPrompt: {
      kind,
      conversationId: conversation._id,
      ...(tap.delivery?.handoffId ? { refId: tap.delivery.handoffId } : {}),
      promptMessageId: 0,
      cardMessageId: tap.messageId,
      organizationId: actor.org._id,
      expiresAt,
    },
    focus: { conversationId: conversation._id, leadId: conversation.leadId, setAt: tap.now, source: "notification" },
    updatedAt: tap.now,
  });
  const card = await contextFor(ctx, actor, tap, { conversationId: conversation._id });
  const prompt = buildPrompt(kind, card);
  return {
    replies: [
      {
        chatId: tap.chatId,
        text: prompt.text,
        keyboard: prompt.keyboard,
        record: {
          organizationId: actor.org._id,
          linkId: actor.link._id,
          kind: "prompt",
          conversationId: conversation._id,
          setPromptMessageId: true,
          promptExpiresAt: expiresAt,
        },
      },
    ],
    edits: [],
  };
}

/** Returns to the AI: pending handoff → reject with instruction; otherwise `returnToAiCore`. */
async function returnToAi(ctx: MutationCtx, actor: TelegramActor, conversation: Doc<"conversations">, instruction?: string) {
  const handoff = await pendingHandoffOf(ctx, conversation._id);
  if (handoff) {
    await rejectHandoffWithInstructionCore(ctx, { handoff, member: actor.member, instruction, via: "telegram" });
  } else {
    await returnToAiCore(ctx, { conversation, member: actor.member, instruction, via: "telegram" });
  }
}

async function onReturnWithoutInstruction(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: INBOX_REPLY, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const conversation = await conversationOf(ctx, actor, tap.id);
  if (!conversation) return notFound(tap.chatId);
  const chat = await chatOf(ctx, tap.chatId);
  const cardMessageId = chat?.pendingPrompt?.cardMessageId;
  const refHandoff = chat?.pendingPrompt?.refId ?? tap.delivery?.handoffId;
  const tz = (await contextFor(ctx, actor, tap, {})).timezone;
  const copy = await takenOverCopy(ctx, actor, conversation, refHandoff, tap.now, tz);
  if (copy) {
    await clearPrompt(ctx, tap.chatId, tap.now);
    return await refuseTakenOver(ctx, actor, tap, conversation, copy, cardMessageId ?? tap.messageId);
  }
  try {
    await returnToAi(ctx, actor, conversation);
  } catch (e) {
    failWith(say(tap.chatId, errorText(e)));
  }
  await clearPrompt(ctx, tap.chatId, tap.now);
  const card = await contextFor(ctx, actor, tap, { conversationId: conversation._id });
  const record = buildRecordCard(card, `🤖 Devolvido à IA por você · ${formatTime(tap.now, card.timezone)}`, ["viewAll", "links"]);
  const edits: EditOp[] = [{ chatId: tap.chatId, messageId: tap.messageId, text: "↩️ Devolvido à IA sem instrução." }];
  if (cardMessageId) edits.push({ chatId: tap.chatId, messageId: cardMessageId, text: record.text, keyboard: record.keyboard });
  return { replies: [], edits };
}

async function onCancelPrompt(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, now: tap.now });
  if (!auth.ok) return auth.result;
  await clearPrompt(ctx, tap.chatId, tap.now);
  return { replies: [], edits: [{ chatId: tap.chatId, messageId: tap.messageId, text: "✖ Cancelado." }] };
}

async function onSendPreviewedReply(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: INBOX_REPLY, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const chat = await chatOf(ctx, tap.chatId);
  const prompt = chat?.pendingPrompt;
  const attachment = prompt?.draftAttachments?.[0];
  if (!prompt || prompt.kind !== "reply_customer" || (!prompt.draftText && !attachment) || prompt.conversationId !== tap.id) {
    return say(tap.chatId, "⌛ Esta prévia não está mais ativa. Toque em Responder no cartão de novo.");
  }
  const draftText = prompt.draftText ?? "";
  if (prompt.expiresAt <= tap.now) {
    await clearPrompt(ctx, tap.chatId, tap.now);
    return say(tap.chatId, EXPIRED);
  }
  // Only the CURRENT preview sends (review F1 #3): an older preview of the same
  // prompt would otherwise send the newest text.
  if (tap.messageId !== prompt.promptMessageId) {
    return {
      replies: [{ chatId: tap.chatId, text: "⚠️ Esta prévia não é mais a atual. Use a prévia mais recente." }],
      edits: [{ chatId: tap.chatId, messageId: tap.messageId, text: "✖ Prévia substituída por uma mais recente." }],
    };
  }
  const conversation = await conversationOf(ctx, actor, tap.id);
  if (!conversation) return notFound(tap.chatId);
  let sentId: Id<"messages">;
  try {
    sentId = await internalSendMessageCore(ctx, {
      conversationId: conversation._id,
      content: draftText,
      contentType: contentTypeOf(attachment),
      ...(attachment ? { attachments: [attachment.fileId] } : {}),
      teamMemberId: actor.member._id,
      via: "telegram",
    });
  } catch (e) {
    failWith(say(tap.chatId, errorText(e)));
  }
  await clearPrompt(ctx, tap.chatId, tap.now, { sent: true });
  await bindSentMessage(ctx, tap.chatId, tap.messageId, sentId, attachment);
  const card = await contextFor(ctx, actor, tap, { conversationId: conversation._id });
  const time = formatTime(tap.now, card.timezone);
  const sentRecord = buildRecordCard(
    card,
    `✓ Enviado · ${time}${attachment ? ` · ${attachmentLine(attachment)}` : ""}`,
    [],
    draftText || undefined,
  );
  const edits: EditOp[] = [edit(tap, sentRecord)];
  if (prompt.cardMessageId) {
    const record = buildRecordCard(card, `💬 Respondido por você · ${time}`, ["reply", "instruct", "links"]);
    edits.push({ chatId: tap.chatId, messageId: prompt.cardMessageId, text: record.text, keyboard: record.keyboard });
  }
  return { replies: [], edits };
}

async function draftOf(ctx: MutationCtx, actor: TelegramActor, id: string) {
  const draft = await getTyped(ctx, "messages", id);
  if (!draft || draft.organizationId !== actor.org._id) return null;
  const conversation = await ctx.db.get(draft.conversationId);
  if (!conversation || conversation.organizationId !== actor.org._id) return null;
  return { draft, conversation };
}

async function onSendDraft(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: INBOX_REPLY, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const found = await draftOf(ctx, actor, tap.id);
  if (!found) return notFound(tap.chatId);
  await setFocus(ctx, tap.chatId, { conversationId: found.conversation._id, leadId: found.conversation.leadId }, tap.now);
  try {
    await acceptAiDraftCore(ctx, { draft: found.draft, conversation: found.conversation, member: actor.member, via: "telegram" });
  } catch (e) {
    failWith(say(tap.chatId, errorText(e)));
  }
  const card = await contextFor(ctx, actor, tap, { conversationId: found.conversation._id });
  const closing = isTelegramRequestedDraft(found.draft.metadata?.aiDraft) ? `\n${AI_BACK_IN_CHARGE}` : "";
  const record = buildRecordCard(
    card,
    `✅ Rascunho enviado por você · ${formatTime(tap.now, card.timezone)}${closing}`,
    ["viewAll", "links"],
    found.draft.content,
  );
  return { replies: [], edits: [edit(tap, record)] };
}

async function onDiscardDraft(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: INBOX_REPLY, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const found = await draftOf(ctx, actor, tap.id);
  if (!found) return notFound(tap.chatId);
  const discarded = await discardAiDraftCore(ctx, { draft: found.draft, member: actor.member, via: "telegram" });
  const card = await contextFor(ctx, actor, tap, { conversationId: found.conversation._id });
  const status = discarded
    ? `🗑 Rascunho descartado por você · ${formatTime(tap.now, card.timezone)}`
    : "⚠️ Este rascunho já foi revisado.";
  return { replies: [], edits: [edit(tap, buildRecordCard(card, status, ["regenerate", "links"]))] };
}

async function taskOf(ctx: MutationCtx, actor: TelegramActor, id: string) {
  const task = await getTyped(ctx, "tasks", id);
  return task && task.organizationId === actor.org._id ? task : null;
}

async function onCompleteTask(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  // Same gate as the public `tasks.completeTask` (membership only).
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const task = await taskOf(ctx, actor, tap.id);
  if (!task) return notFound(tap.chatId);
  const card = await contextFor(ctx, actor, tap, { taskId: task._id });
  const title = `📌 "${escapeHtml(quoteSnippet(task.title, 120))}"`;
  if (task.status === "completed") {
    return { replies: [], edits: [edit(tap, buildRecordCard(card, `${title} ✅ Já estava concluída`, ["links"]))] };
  }
  // One audit row: `applyTaskCompletion` writes it, with `via:"telegram"`.
  await applyTaskCompletion(ctx, task, actor.member, tap.now, undefined, "telegram");
  await syncFollowUpForTask(ctx, task._id);
  const record = buildRecordCard(card, `${title} ✅ Concluída por você · ${formatTime(tap.now, card.timezone)}`, ["links"]);
  return { replies: [], edits: [edit(tap, record)] };
}

async function onSnoozeTask(ctx: MutationCtx, tap: Tap, mode: "1h" | "tomorrow9"): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const task = await taskOf(ctx, actor, tap.id);
  if (!task) return notFound(tap.chatId);
  const card = await contextFor(ctx, actor, tap, { taskId: task._id });
  const until = mode === "1h" ? tap.now + 60 * 60 * 1000 : tomorrowAt(tap.now, card.timezone, 9);
  await snoozeTaskCore(ctx, task, actor.member, until, tap.now, { via: "telegram" });
  await syncFollowUpForTask(ctx, task._id);
  const record = buildRecordCard(
    card,
    `📌 "${escapeHtml(quoteSnippet(task.title, 120))}" ⏰ Adiada para ${formatWhen(until, tap.now, card.timezone)}`,
    ["complete", "links"],
  );
  return { replies: [], edits: [edit(tap, record)] };
}

/** Rebuilds the card of the tapped delivery (for "Ver tudo" keyboards and "Resumir"). */
async function rebuildCard(ctx: MutationCtx, actor: TelegramActor, tap: Tap, conversationId: Id<"conversations">) {
  const d = tap.delivery;
  const notification = d?.notificationId ? await ctx.db.get(d.notificationId) : null;
  if (notification && notification.organizationId === actor.org._id) {
    const card = await contextFor(ctx, actor, tap, { notification });
    return {
      card,
      out: buildNotificationCard({
        notification: { ...notification, _id: notification._id },
        context: card,
      }),
    };
  }
  const card = await contextFor(ctx, actor, tap, { conversationId, handoffId: d?.handoffId });
  const crm = d?.crmMessageId ? await ctx.db.get(d.crmMessageId) : null;
  if (crm && crm.organizationId === actor.org._id) {
    return { card, out: buildAiRelayCard(card, { text: crm.content, at: crm.createdAt }) };
  }
  return { card, out: buildRecordCard(card, "💬 Conversa", ["reply", "instruct", "viewAll", "links"]) };
}

async function onViewAll(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: INBOX_VIEW, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const conversation = await conversationOf(ctx, actor, tap.id);
  if (!conversation) return notFound(tap.chatId);
  await setFocus(ctx, tap.chatId, { conversationId: conversation._id, leadId: conversation.leadId }, tap.now);
  const { card, out } = await rebuildCard(ctx, actor, tap, conversation._id);
  if (card.discreet) return empty(); // no "Ver tudo" in discreet mode
  const history = await loadHistory(ctx.db, conversation, card.lead?.title);
  // F4 (D21): the files of the visible history go right after (newest last, capped).
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversation._id))
    .order("desc")
    .take(40);
  const visible = recent.filter((m) => !m.isInternal && m.direction !== "internal").slice(0, 10).reverse();
  const crmUrl = conversationCrmUrl(tap.appBaseUrl, conversation._id);
  const planned = await mediaForMessages(ctx.db, visible, {
    organizationId: actor.org._id,
    discreet: card.discreet,
    mediaInbound: actor.link.prefs.mediaInbound,
    crmUrl,
  });
  // A file this chat already got for this conversation is not sent again (review F4 #3): the line + link instead.
  const already = await ctx.db
    .query("telegramDeliveries")
    .withIndex("by_conversation_and_sent", (q) => q.eq("conversationId", conversation._id).gt("sentAt", tap.now - MEDIA_DEDUPE_MS))
    .order("desc")
    .take(200);
  const sentBlobs = new Set(
    already.filter((d) => d.chatId === tap.chatId && d.kind === "media" && d.mediaStorageId).map((d) => d.mediaStorageId!),
  );
  const media: MediaOut[] = planned.map((m) =>
    m.storageId && sentBlobs.has(m.storageId)
      ? { kind: "link", fileName: m.fileName, size: m.size, mime: m.mime, text: alreadySentLine(m, crmUrl) }
      : m,
  );
  const replies: SendOp[] =
    media.length > 0
      ? [
          {
            chatId: tap.chatId,
            text: "",
            media,
            record: { organizationId: actor.org._id, linkId: actor.link._id, kind: "media", conversationId: conversation._id },
          },
        ]
      : [];
  return { replies, edits: [edit(tap, buildHistoryCard(card, history, out.keyboard))] };
}

async function onSummarize(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: INBOX_VIEW, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const conversation = await conversationOf(ctx, actor, tap.id);
  if (!conversation) return notFound(tap.chatId);
  const { out } = await rebuildCard(ctx, actor, tap, conversation._id);
  return { replies: [], edits: [edit(tap, out)] };
}

async function onAssume(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: INBOX_REPLY, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const conversation = await conversationOf(ctx, actor, tap.id);
  if (!conversation) return notFound(tap.chatId);
  await setFocus(ctx, tap.chatId, { conversationId: conversation._id, leadId: conversation.leadId }, tap.now);
  const tz = (await contextFor(ctx, actor, tap, {})).timezone;
  const copy = await takenOverCopy(ctx, actor, conversation, tap.delivery?.handoffId, tap.now, tz);
  if (copy) return await refuseTakenOver(ctx, actor, tap, conversation, copy, tap.messageId);
  const handoff = await pendingHandoffOf(ctx, conversation._id);
  try {
    if (handoff) await acceptHandoffCore(ctx, { handoff, member: actor.member, via: "telegram" });
    else await assumeConversationCore(ctx, { conversation, member: actor.member, via: "telegram" });
  } catch (e) {
    failWith(say(tap.chatId, errorText(e)));
  }
  const card = await contextFor(ctx, actor, tap, { conversationId: conversation._id });
  const record = buildRecordCard(card, `🙋 Você assumiu a conversa · ${formatTime(tap.now, card.timezone)}`, ["reply", "links"]);
  return { replies: [], edits: [edit(tap, record)] };
}

// ---------------------------------------------------------------------------
// Prompt answers (§3.4, F1 subset: text only)
// ---------------------------------------------------------------------------

export const PROMPT_EXPIRED_COPY = "⌛ Este pedido expirou. Toque no botão do cartão de novo.";
const EXPIRED = PROMPT_EXPIRED_COPY;
export const TEXT_ONLY_COPY = "Por enquanto só texto por aqui; áudio e foto chegam na próxima versão.";

function fmtCount(n: number): string {
  return n.toLocaleString("pt-BR");
}

/**
 * The next message of a chat with an open prompt. Returns null when there is
 * no prompt (the caller answers as usual).
 */
export async function handleTelegramPromptAnswer(
  ctx: MutationCtx,
  args: { chatId: number; text?: string; now: number; appBaseUrl: string },
): Promise<ActionResult | null> {
  const chat = await chatOf(ctx, args.chatId);
  const prompt = chat?.pendingPrompt;
  if (!chat || !prompt) return null;
  if (prompt.expiresAt <= args.now) {
    await clearPrompt(ctx, args.chatId, args.now);
    return say(args.chatId, EXPIRED);
  }
  const text = args.text?.trim();
  if (!text) return say(args.chatId, TEXT_ONLY_COPY);

  const auth = await authorizeTelegramActor(ctx, {
    chatId: args.chatId,
    organizationId: prompt.organizationId,
    permission: INBOX_REPLY,
    now: args.now,
  });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const conversation = prompt.conversationId ? await conversationOf(ctx, actor, prompt.conversationId) : null;
  if (!conversation) {
    await clearPrompt(ctx, args.chatId, args.now);
    return notFound(args.chatId);
  }
  const tapLike = { now: args.now, appBaseUrl: args.appBaseUrl };
  const card = await contextFor(ctx, actor, tapLike, { conversationId: conversation._id });
  const time = formatTime(args.now, card.timezone);

  if (prompt.kind === "instruct_ai" || prompt.kind === "regenerate") {
    if (text.length > INSTRUCTION_MAX_CHARS) {
      return {
        replies: [
          {
            chatId: args.chatId,
            text: `⏳ A instrução tem ${fmtCount(text.length)} caracteres; o máximo é ${fmtCount(INSTRUCTION_MAX_CHARS)}. Resuma e mande de novo.`,
            keyboard: [[{ text: "✖ Cancelar", callback_data: `cp:${conversation._id}` }]],
          },
        ],
        edits: [],
      };
    }
  }

  if (prompt.kind === "instruct_ai") {
    const copy = await takenOverCopy(
      ctx,
      actor,
      conversation,
      prompt.refId,
      args.now,
      card.timezone,
    );
    if (copy) {
      await clearPrompt(ctx, args.chatId, args.now);
      return await refuseTakenOver(ctx, actor, { chatId: args.chatId, ...tapLike }, conversation, copy, prompt.cardMessageId);
    }
    try {
      await returnToAi(ctx, actor, conversation, text);
    } catch (e) {
      failWith(say(args.chatId, errorText(e)));
    }
    await clearPrompt(ctx, args.chatId, args.now);
    const record = buildRecordCard(
      card,
      `🤖 Devolvido à IA por você · ${time} · instrução: "${escapeHtml(quoteSnippet(text))}"`,
      ["viewAll", "links"],
    );
    const edits: EditOp[] = [];
    if (prompt.cardMessageId) edits.push({ chatId: args.chatId, messageId: prompt.cardMessageId, text: record.text, keyboard: record.keyboard });
    if (prompt.promptMessageId) edits.push({ chatId: args.chatId, messageId: prompt.promptMessageId, text: `🤖 Instrução: <i>${escapeHtml(quoteSnippet(text))}</i>` });
    return { replies: [{ chatId: args.chatId, text: "🤖 Instrução enviada. A IA responde em instantes e eu te mostro." }], edits };
  }

  if (prompt.kind === "regenerate") {
    const draft = await pendingDraftOf(ctx.db, conversation._id);
    try {
      await requestAiDraftCore(ctx, {
        conversation,
        member: actor.member,
        instruction: text,
        sourceDraftId: draft?._id,
        via: "telegram",
      });
    } catch (e) {
      failWith(say(args.chatId, errorText(e)));
    }
    // The next draft must reach Telegram: the attendant dedupes ai_draft_pending
    // by "one UNREAD per conversation", so this member's unread ones are read now.
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_member_and_read", (q) => q.eq("memberId", actor.member._id).eq("readAt", undefined))
      .order("desc")
      .take(50);
    for (const n of unread) {
      if (n.type === "ai_draft_pending" && n.conversationId === conversation._id) await ctx.db.patch(n._id, { readAt: args.now });
    }
    await clearPrompt(ctx, args.chatId, args.now);
    const edits: EditOp[] = [];
    if (prompt.promptMessageId) edits.push({ chatId: args.chatId, messageId: prompt.promptMessageId, text: `🔁 Motivo: <i>${escapeHtml(quoteSnippet(text))}</i>` });
    return { replies: [{ chatId: args.chatId, text: "🔁 Pedi uma nova versão à IA. O rascunho chega aqui em instantes." }], edits };
  }

  // reply_customer: preview first; nothing leaves before "📤 Enviar".
  if (text.length > REPLY_MAX_CHARS) {
    return say(args.chatId, `⏳ A mensagem tem ${fmtCount(text.length)} caracteres; o máximo é ${fmtCount(REPLY_MAX_CHARS)}.`);
  }
  return await stageReplyDraft(ctx, { chatId: args.chatId, now: args.now, actor, chat, prompt, conversation, card, text });
}

/**
 * The member's reply becomes the prompt's draft and a preview (suggest: 📤
 * Enviar; auto: the D23 countdown). Shared by text and files (F4): a file
 * keeps an existing text draft as its caption only when it brings none.
 */
async function stageReplyDraft(
  ctx: MutationCtx,
  args: {
    chatId: number;
    now: number;
    actor: TelegramActor;
    chat: Doc<"telegramChats">;
    prompt: PendingPrompt;
    conversation: Doc<"conversations">;
    card: CardContext;
    text: string;
    attachment?: DraftAttachment;
  },
): Promise<ActionResult> {
  const { actor, chat, prompt, conversation, card, text } = args;
  const expiresAt = args.now + PROMPT_TTL_MS;
  const attachment = args.attachment ?? prompt.draftAttachments?.[0];
  await ctx.db.patch(chat._id, {
    pendingPrompt: {
      ...prompt,
      draftText: text,
      ...(attachment ? { draftAttachments: [attachment] } : {}),
      expiresAt,
    },
    updatedAt: args.now,
  });
  // F4 (review #2): a file draft nobody touches again is discarded AT its expiry, not on the next update.
  if (attachment) {
    await ctx.scheduler.runAt(expiresAt, internal.telegramFiles.internalExpirePromptDraft, { chatId: args.chatId, expiresAt });
  }
  const edits: EditOp[] = prompt.promptMessageId
    ? [{ chatId: args.chatId, messageId: prompt.promptMessageId, text: "💬 Prévia logo abaixo." }]
    : [];
  // D23: in automatic mode the preview is a countdown that sends unless vetoed (text or file alike).
  if (effectiveAssistantMode(actor.link, actor.org) === "auto") {
    const seconds = autoSendSeconds(actor.link);
    const countdown = buildCountdownCard(card, text, seconds, conversation._id, attachment, "human");
    return {
      replies: [
        {
          chatId: args.chatId,
          text: countdown.text,
          keyboard: countdown.keyboard,
          record: {
            organizationId: actor.org._id,
            linkId: actor.link._id,
            kind: "draft",
            conversationId: conversation._id,
            setPromptMessageId: true,
            promptExpiresAt: expiresAt,
            autoSend: { delayMs: seconds * 1000 },
          },
        },
      ],
      edits,
    };
  }
  const preview = buildReplyPreview(card, text, attachment);
  return {
    replies: [
      {
        chatId: args.chatId,
        text: preview.text,
        keyboard: preview.keyboard,
        record: {
          organizationId: actor.org._id,
          linkId: actor.link._id,
          kind: "prompt",
          conversationId: conversation._id,
          setPromptMessageId: true,
          promptExpiresAt: expiresAt,
        },
      },
    ],
    edits,
  };
}

/**
 * F4 (D25, §4.5): a file the member sent while "Responder" is open. It is
 * already in storage through the inbound attachment port and its quota is
 * reserved (`telegramFiles.internalReceiveReplyFile`). Here: re-authorize,
 * re-check the prompt, and stage it as the draft. Anything that stops it
 * discards the file and releases the quota — nothing is dropped silently.
 */
export async function handleTelegramReplyFile(
  ctx: MutationCtx,
  args: {
    chatId: number;
    now: number;
    appBaseUrl: string;
    file: { fileId: Id<"files">; name: string; size: number; kind: DraftAttachment["kind"] };
    caption?: string;
    quota: DraftAttachment["quota"];
  },
): Promise<ActionResult> {
  const attachment: DraftAttachment = { ...args.file, quota: args.quota };
  const chat = await chatOf(ctx, args.chatId);
  const prompt = chat?.pendingPrompt;
  const file = await ctx.db.get(args.file.fileId);
  const orgId = file?.organizationId;
  if (!chat || !prompt || prompt.kind !== "reply_customer" || prompt.expiresAt <= args.now || prompt.organizationId !== orgId) {
    await discardDraftFile(ctx, attachment, orgId);
    return say(args.chatId, "⌛ O Responder não está mais aberto. Toque em Responder no cartão e mande o arquivo de novo.");
  }
  const auth = await authorizeTelegramActor(ctx, {
    chatId: args.chatId,
    organizationId: prompt.organizationId,
    permission: INBOX_REPLY,
    now: args.now,
  });
  if (!auth.ok) {
    await discardDraftFile(ctx, attachment, orgId);
    return auth.result;
  }
  const { actor } = auth;
  const conversation = prompt.conversationId ? await conversationOf(ctx, actor, prompt.conversationId) : null;
  if (!conversation) {
    await discardDraftFile(ctx, attachment, orgId);
    await clearPrompt(ctx, args.chatId, args.now);
    return notFound(args.chatId);
  }
  const caption = args.caption?.trim() ?? "";
  if (caption.length > REPLY_MAX_CHARS) {
    await discardDraftFile(ctx, attachment, orgId);
    return say(args.chatId, `⏳ A legenda tem ${fmtCount(caption.length)} caracteres; o máximo é ${fmtCount(REPLY_MAX_CHARS)}.`);
  }
  // A new file replaces the previous one of this draft.
  for (const old of prompt.draftAttachments ?? []) {
    if (old.fileId !== attachment.fileId) await discardDraftFile(ctx, old, orgId);
  }
  const card = await contextFor(ctx, actor, { now: args.now, appBaseUrl: args.appBaseUrl }, { conversationId: conversation._id });
  return await stageReplyDraft(ctx, {
    chatId: args.chatId,
    now: args.now,
    actor,
    chat,
    prompt: { ...prompt, draftAttachments: undefined },
    conversation,
    card,
    text: caption || prompt.draftText || "",
    attachment,
  });
}

// ---------------------------------------------------------------------------
// F3 — Copilot pending actions, modes, undo, veto (D18/D22/D23)
// ---------------------------------------------------------------------------

async function pendingOf(ctx: MutationCtx, actor: TelegramActor, id: string) {
  const normalized = ctx.db.normalizeId("pendingActions", id);
  const pending = normalized ? await ctx.db.get(normalized) : null;
  return pending && pending.organizationId === actor.org._id ? pending : null;
}

/** A tap on a Copilot card edits it; on a notification card ("Aplicar sugestão") it answers below. */
function resultFor(tap: Tap, text: string): ActionResult {
  if (tap.delivery?.kind === "copilot") return { replies: [], edits: [{ chatId: tap.chatId, messageId: tap.messageId, text }] };
  return say(tap.chatId, text);
}

async function onConfirmPending(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  // RBAC of the action itself is re-checked inside the core (the proposal may be old).
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const pending = await pendingOf(ctx, actor, tap.id);
  if (!pending) return notFound(tap.chatId);
  let message: string;
  try {
    message = (await confirmPendingActionCore(ctx, { pending, member: actor.member, now: tap.now, via: "telegram" })).message;
  } catch (e) {
    failWith(say(tap.chatId, errorText(e)));
  }
  const tz = (await contextFor(ctx, actor, tap, {})).timezone;
  return resultFor(tap, `✅ ${escapeHtml(message)} · ${formatTime(tap.now, tz)}`);
}

async function onCancelPending(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const pending = await pendingOf(ctx, actor, tap.id);
  if (!pending) return notFound(tap.chatId);
  try {
    await cancelPendingActionCore(ctx, { pending, member: actor.member });
  } catch (e) {
    failWith(say(tap.chatId, errorText(e)));
  }
  return resultFor(tap, "✖ Cancelado.");
}

/** `/modo` (the commands dispatcher calls this) and the onboarding card. */
export async function handleModeCommand(ctx: MutationCtx, args: { chatId: number; now: number }): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: args.chatId, now: args.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  if (actor.org.settings.telegram?.allowAutoMode === false) return say(args.chatId, MODE_COPY.autoForbidden(actor.org.name));
  const mode = effectiveAssistantMode(actor.link, actor.org);
  const lines = [MODE_COPY.current(mode, autoSendSeconds(actor.link))];
  if (actor.link.assistant.autoPausedAt !== undefined) lines.push(MODE_COPY.paused);
  const other = mode === "auto" ? { text: "💡 Sugestão", callback_data: "md:suggest" } : { text: "🤖 Automático", callback_data: "md:auto" };
  return { replies: [{ chatId: args.chatId, text: lines.join("\n"), keyboard: [[other]] }], edits: [] };
}

async function onSetMode(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  if (tap.id !== "auto" && tap.id !== "suggest") return empty();
  if (tap.id === "auto" && actor.org.settings.telegram?.allowAutoMode === false) {
    return say(tap.chatId, MODE_COPY.autoForbidden(actor.org.name));
  }
  await ctx.db.patch(actor.link._id, {
    assistant: {
      ...actor.link.assistant,
      mode: tap.id,
      // Turning automatic on again clears the undo pause and the hourly counter.
      ...(tap.id === "auto" ? { autoPausedAt: undefined, autoActionsThisHour: 0, autoHourStart: tap.now } : {}),
    },
  });
  await ctx.db.insert("auditLogs", {
    organizationId: actor.org._id,
    entityType: "telegramLink",
    entityId: actor.link._id,
    action: "update",
    actorId: actor.member._id,
    actorType: "human",
    changes: { before: { mode: actor.link.assistant.mode }, after: { mode: tap.id } },
    metadata: { event: "telegram.assistant_mode", via: "telegram" },
    description: tap.id === "auto" ? "Ligou o modo automático da assistente no Telegram" : "Voltou a assistente para o modo sugestão",
    severity: tap.id === "auto" ? "high" : "low",
    createdAt: tap.now,
  });
  const text =
    tap.id === "auto"
      ? MODE_COPY.autoOn(autoWriteTools(actor.link), actor.link.assistant.autoAllowed.replyCustomer, autoSendSeconds(actor.link))
      : MODE_COPY.suggestOn;
  return { replies: [], edits: [{ chatId: tap.chatId, messageId: tap.messageId, text }] };
}

async function onAdjust(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: INBOX_VIEW, now: tap.now });
  if (!auth.ok) return auth.result;
  const conversation = await conversationOf(ctx, auth.actor, tap.id);
  if (!conversation) return notFound(tap.chatId);
  await setFocus(ctx, tap.chatId, { conversationId: conversation._id, leadId: conversation.leadId }, tap.now);
  return say(tap.chatId, "✏️ Me diga o que ajustar nesta conversa (texto ou áudio).");
}

type UndoStep = { kind: string; refId: string; before?: unknown; after?: unknown };

/**
 * Reverts ONE automatic step. There is no "reopen" port in the domain, so the
 * inverse of an instruction/acceptance is written here, field by field, from
 * the `before` snapshot taken when the step ran; stage moves go back through
 * `moveLeadToStageCore`. Returns the line for the record card.
 */
/**
 * True when the state the step left behind changed since (someone took over,
 * resolved, reassigned, finished the task…). Undo then SKIPS the step instead
 * of overwriting newer work (review F3 #6). Steps without `after` (legacy) never drift.
 */
async function stepDrifted(ctx: MutationCtx, actor: TelegramActor, step: UndoStep, now: number): Promise<boolean> {
  if (!step.after || typeof step.after !== "object") return false;
  const after = step.after as Record<string, unknown>;
  const before = (step.before ?? {}) as Record<string, unknown>;
  switch (step.kind) {
    case "instruct":
    case "accept_handoff": {
      const handoffId =
        step.kind === "accept_handoff"
          ? ctx.db.normalizeId("handoffs", step.refId)
          : typeof before.handoffId === "string"
            ? ctx.db.normalizeId("handoffs", before.handoffId)
            : null;
      const handoff = handoffId ? await ctx.db.get(handoffId) : null;
      if ("handoffStatus" in after && handoff) {
        if (handoff.status !== after.handoffStatus || (handoff.resolvedBy ?? null) !== after.handoffResolvedBy) return true;
      }
      const conversationId =
        step.kind === "instruct" ? ctx.db.normalizeId("conversations", step.refId) : (handoff?.conversationId ?? null);
      const conversation = conversationId ? await ctx.db.get(conversationId) : null;
      if (!conversation) return false;
      const lead = conversation.leadId ? await ctx.db.get(conversation.leadId) : null;
      if (lead && "leadAssignedTo" in after) {
        const current = lead.assignedTo ?? null;
        if (current !== after.leadAssignedTo) {
          // The instructed turn (scheduled) hands the lead to the AI attendant: expected, not drift.
          const holder = current ? await ctx.db.get(current) : null;
          if (!(step.kind === "instruct" && holder?.type === "ai")) return true;
        }
      }
      const paused = conversation.aiPausedUntil !== undefined && conversation.aiPausedUntil > now;
      // Instruct unpauses (maybe later, via the scheduled turn): a NEW pause = someone took over.
      if (step.kind === "instruct") return paused && after.aiPaused !== true;
      return paused !== (after.aiPaused === true);
    }
    case "complete_task": {
      const task = await getTyped(ctx, "tasks", step.refId);
      return !!task && (task.status !== "completed" || task.completedAt !== after.completedAt);
    }
    case "snooze_task": {
      const task = await getTyped(ctx, "tasks", step.refId);
      return !!task && (task.status === "completed" || (task.snoozedUntil ?? null) !== (after.snoozedUntil ?? null));
    }
    case "create_task": {
      const task = await getTyped(ctx, "tasks", step.refId);
      return !!task && task.status !== after.status;
    }
    case "move_stage": {
      const lead = await getTyped(ctx, "leads", step.refId);
      return !!lead && lead.stageId !== after.stageId;
    }
    default:
      return false;
  }
}

async function revertStep(ctx: MutationCtx, actor: TelegramActor, step: UndoStep, now: number): Promise<string> {
  const before = (step.before ?? {}) as Record<string, unknown>;
  const label = STEP_LABELS[step.kind] ?? step.kind;
  if (await stepDrifted(ctx, actor, step, now)) return `${label}: mudou depois, não desfiz`;
  const restoreConversation = async (conversationId: Id<"conversations"> | null) => {
    const conversation = conversationId ? await ctx.db.get(conversationId) : null;
    if (conversation && conversation.organizationId === actor.org._id) {
      const notes = conversation.aiTeamNotes ?? [];
      const keep = typeof before.notesCount === "number" ? before.notesCount : notes.length;
      await ctx.db.patch(conversation._id, {
        aiPausedUntil: typeof before.aiPausedUntil === "number" ? before.aiPausedUntil : undefined,
        aiTeamNotes: notes.slice(0, keep),
        updatedAt: now,
      });
      // The instructed turn that has not run yet is dropped.
      const queued = await ctx.db
        .query("aiReplyQueue")
        .withIndex("by_conversation_and_status", (q) => q.eq("conversationId", conversation._id).eq("status", "pending"))
        .take(5);
      for (const item of queued) {
        if (item.origin === "return_to_ai" && item.instructedBy === actor.member._id) {
          await ctx.db.patch(item._id, { status: "skipped", updatedAt: now });
        }
      }
    }
    const handoffId = typeof before.handoffId === "string" ? ctx.db.normalizeId("handoffs", before.handoffId) : null;
    const handoff = handoffId ? await ctx.db.get(handoffId) : null;
    if (handoff && handoff.organizationId === actor.org._id && handoff.status !== "pending") {
      await ctx.db.patch(handoff._id, {
        status: "pending",
        acceptedBy: undefined,
        resolvedBy: undefined,
        resolvedAt: undefined,
        notes: undefined,
      });
    }
    const leadId = typeof before.leadId === "string" ? ctx.db.normalizeId("leads", before.leadId) : null;
    const lead = leadId ? await ctx.db.get(leadId) : null;
    if (lead && lead.organizationId === actor.org._id) {
      await ctx.db.patch(lead._id, {
        assignedTo: (typeof before.leadAssignedTo === "string" ? before.leadAssignedTo : undefined) as Id<"teamMembers"> | undefined,
        handoffState: (before.leadHandoffState ?? undefined) as Doc<"leads">["handoffState"],
        updatedAt: now,
      });
    }
  };

  switch (step.kind) {
    case "instruct":
      await restoreConversation(ctx.db.normalizeId("conversations", step.refId));
      return `${label}: instrução cancelada, repasse reaberto`;
    case "accept_handoff": {
      const handoff = await getTyped(ctx, "handoffs", step.refId);
      await restoreConversation(handoff?.conversationId ?? null);
      return `${label}: repasse reaberto para a equipe`;
    }
    case "complete_task":
    case "snooze_task": {
      const task = await getTyped(ctx, "tasks", step.refId);
      if (!task || task.organizationId !== actor.org._id) return `${label}: tarefa não encontrada`;
      if (step.kind === "complete_task") {
        // Through the core: done column, recurrence successor and audit stay consistent.
        const previousColumnId = typeof before.columnId === "string" ? ctx.db.normalizeId("taskColumns", before.columnId) : null;
        await reopenTaskCore(ctx, task, actor.member, now, {
          status: before.status === "in_progress" ? "in_progress" : "pending",
          ...(previousColumnId ? { previousColumnId } : {}),
          via: "telegram_auto",
        });
        return `${label}: reaberta`;
      }
      await ctx.db.patch(task._id, {
        snoozedUntil: typeof before.snoozedUntil === "number" ? before.snoozedUntil : undefined,
        updatedAt: now,
      });
      return `${label}: prazo de volta`;
    }
    case "create_task": {
      const task = await getTyped(ctx, "tasks", step.refId);
      if (!task || task.organizationId !== actor.org._id) return `${label}: tarefa não encontrada`;
      // Cancelled (not hard-deleted): the audit trail of what the assistant did stays.
      await ctx.db.patch(task._id, { status: "cancelled", updatedAt: now });
      return `${label}: cancelada`;
    }
    case "move_stage": {
      const lead = await getTyped(ctx, "leads", step.refId);
      const stageId = typeof before.stageId === "string" ? ctx.db.normalizeId("stages", before.stageId) : null;
      if (!lead || lead.organizationId !== actor.org._id || !stageId) return `${label}: lead não encontrado`;
      await moveLeadToStageCore(ctx, {
        lead,
        newStageId: stageId,
        actor: { type: "human", memberId: actor.member._id },
        metadata: { via: "telegram_auto", undo: true },
      });
      return `${label}: etapa de volta`;
    }
    default:
      return `${label}: não dá para desfazer`;
  }
}

async function onUndoAutoRecord(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: INBOX_REPLY, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const d = tap.delivery;
  if (!d || d.kind !== "auto_record" || !d.undo || d.linkId !== actor.link._id) return notFound(tap.chatId);
  const tz = (await contextFor(ctx, actor, tap, {})).timezone;
  if (d.undo.undoneAt) return say(tap.chatId, "Isso já foi desfeito.");
  if (d.undo.expiresAt <= tap.now) return say(tap.chatId, "⌛ O prazo para desfazer (10 min) passou.");
  const lines: string[] = [];
  for (const step of [...d.undo.steps].reverse()) lines.push(await revertStep(ctx, actor, step, tap.now));
  await ctx.db.patch(d._id, { undo: { ...d.undo, undoneAt: tap.now } });
  await ctx.db.insert("auditLogs", {
    organizationId: actor.org._id,
    entityType: "telegramLink",
    entityId: actor.link._id,
    action: "update",
    actorId: actor.member._id,
    actorType: "human",
    metadata: { event: "telegram.auto_undo", via: "telegram_auto", steps: d.undo.steps.map((s) => s.kind) },
    description: "Desfez ações do modo automático da assistente",
    severity: "medium",
    createdAt: tap.now,
  });
  // D22: 3 undos within an hour pause the automatic mode.
  const recent = await ctx.db
    .query("telegramDeliveries")
    .withIndex("by_link_and_sent", (q) => q.eq("linkId", actor.link._id).gt("sentAt", tap.now - 2 * 60 * 60 * 1000))
    .take(100);
  const undos = recent.filter((r) => r.kind === "auto_record" && (r.undo?.undoneAt ?? 0) > tap.now - 60 * 60 * 1000).length + 1;
  const replies: SendOp[] = [];
  if (undos >= AUTO_PAUSE_UNDOS && actor.link.assistant.autoPausedAt === undefined) {
    await ctx.db.patch(actor.link._id, { assistant: { ...actor.link.assistant, autoPausedAt: tap.now } });
    replies.push({ chatId: tap.chatId, text: MODE_COPY.pausedByUndos });
  }
  const conversationId = d.conversationId;
  const card = await contextFor(ctx, actor, tap, conversationId ? { conversationId } : {});
  const record = buildRecordCard(
    card,
    `↩️ Desfeito · ${formatTime(tap.now, tz)}\n${lines.map((l) => `• ${escapeHtml(l)}`).join("\n")}`,
    ["instruct", "links"],
  );
  return { replies, edits: [edit(tap, record)] };
}

async function onVetoSend(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: INBOX_REPLY, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const d = tap.delivery;
  if (!d || d.kind !== "draft" || !d.draft) return notFound(tap.chatId);
  if (d.draft.sentAt) return say(tap.chatId, "Já foi enviado.");
  await ctx.db.patch(d._id, { draft: { ...d.draft, vetoedAt: tap.now } });
  if (d.draft.messageId) {
    // AI draft: discarded so it never comes back (D23).
    const draftMsg = await ctx.db.get(d.draft.messageId);
    if (draftMsg && draftMsg.organizationId === actor.org._id) {
      await discardAiDraftCore(ctx, { draft: draftMsg, member: actor.member, via: "telegram" });
    }
  } else {
    await clearPrompt(ctx, tap.chatId, tap.now);
  }
  const card = await contextFor(ctx, actor, tap, d.conversationId ? { conversationId: d.conversationId } : {});
  // The member's own reply: offer Responder again (and Instruir), never Regenerar (review F4 #5).
  const record = buildRecordCard(
    card,
    `✖ Envio cancelado · ${formatTime(tap.now, card.timezone)}. Diga o que fazer, ou:`,
    d.draft.messageId ? ["instruct", "reply", "regenerate"] : ["reply", "instruct"],
  );
  return { replies: [], edits: [edit(tap, record)] };
}

/**
 * D23: the countdown elapsed (`telegram.internalAutoSendDraft`). Sends only if
 * the card was not vetoed, nothing was sent yet, the member may still reply,
 * the assistant is still in automatic mode and the draft/prompt is current.
 */
export async function executeAutoSend(
  ctx: MutationCtx,
  args: { deliveryId: Id<"telegramDeliveries">; now: number; appBaseUrl: string },
): Promise<ActionResult> {
  const d = await ctx.db.get(args.deliveryId);
  if (!d || d.kind !== "draft" || !d.draft || d.draft.vetoedAt || d.draft.sentAt) return empty();
  const auth = await authorizeTelegramActor(ctx, {
    chatId: d.chatId,
    organizationId: d.organizationId,
    permission: INBOX_REPLY,
    now: args.now,
  });
  if (!auth.ok) return empty();
  const { actor } = auth;
  const tap = { chatId: d.chatId, messageId: d.messageId, now: args.now, appBaseUrl: args.appBaseUrl };
  const card = await contextFor(ctx, actor, tap, d.conversationId ? { conversationId: d.conversationId } : {});
  if (effectiveAssistantMode(actor.link, actor.org) !== "auto") {
    const record = buildRecordCard(card, "⏸ Envio automático suspenso (modo sugestão). Toque para decidir:", ["reply", "instruct", "regenerate"]);
    return { replies: [], edits: [edit(tap, record)] };
  }
  let sentText = "";
  let sentFile: DraftAttachment | undefined;
  let backInCharge = false;
  try {
    if (d.draft.messageId) {
      const draftMsg = await ctx.db.get(d.draft.messageId);
      const conversation = draftMsg ? await ctx.db.get(draftMsg.conversationId) : null;
      const status = (draftMsg?.metadata?.aiDraft as { status?: string } | undefined)?.status;
      if (!draftMsg || !conversation || conversation.organizationId !== actor.org._id || status !== "pending") return empty();
      // D23: only drafts this member asked for from the bot are ever auto-sent.
      if (!draftAutoSendable(draftMsg.metadata?.aiDraft, actor.member._id)) return empty();
      await acceptAiDraftCore(ctx, { draft: draftMsg, conversation, member: actor.member, via: "telegram_auto" });
      sentText = draftMsg.content;
      backInCharge = isTelegramRequestedDraft(draftMsg.metadata?.aiDraft);
    } else {
      const chat = await chatOf(ctx, d.chatId);
      const prompt = chat?.pendingPrompt;
      const attachment = prompt?.draftAttachments?.[0];
      if (!prompt || prompt.kind !== "reply_customer" || (!prompt.draftText && !attachment) || prompt.promptMessageId !== d.messageId) {
        return empty();
      }
      const conversationId = prompt.conversationId;
      if (!conversationId) return empty();
      const sentId = await internalSendMessageCore(ctx, {
        conversationId,
        content: prompt.draftText ?? "",
        contentType: contentTypeOf(attachment),
        ...(attachment ? { attachments: [attachment.fileId] } : {}),
        teamMemberId: actor.member._id,
        via: "telegram_auto",
      });
      sentText = prompt.draftText ?? "";
      sentFile = attachment;
      await clearPrompt(ctx, d.chatId, args.now, { sent: true });
      await bindSentMessage(ctx, d.chatId, d.messageId, sentId, attachment);
    }
  } catch (e) {
    failWith({ replies: [], edits: [{ chatId: d.chatId, messageId: d.messageId, text: errorText(e) }] });
  }
  await ctx.db.patch(d._id, { draft: { ...d.draft, sentAt: args.now } });
  const record = buildRecordCard(
    card,
    `✓ Enviado · ${formatTime(args.now, card.timezone)}${sentFile ? ` · ${attachmentLine(sentFile)}` : ""}${backInCharge ? `\n${AI_BACK_IN_CHARGE}` : ""}`,
    ["instruct", "reply", "regenerate"],
    sentText || undefined,
  );
  return { replies: [], edits: [edit(tap, record)] };
}

// ---------------------------------------------------------------------------
// v0.78 — reconnect the WhatsApp (bridge) from Telegram
// ---------------------------------------------------------------------------

const SETTINGS_MANAGE: [PermissionCategory, string] = ["settings", "manage"];
export const RECONNECT_ATTEMPTS_PER_HOUR = PAIRING_ATTEMPTS_PER_HOUR;
/** Pairing code ≈ one login websocket (~160 s); the QR rotates for ~160–180 s. */
export const RECONNECT_CODE_WINDOW_MS = 150_000;
export const RECONNECT_QR_WINDOW_MS = 180_000;

const reconnectRetry = (channelConfigId: string): CardKeyboard => [[{ text: "🔄 Tentar de novo", callback_data: `rc:${channelConfigId}` }]];
const last4Of = (config: Doc<"channelConfigs">) => {
  const digits = (config.bridgePhone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : undefined;
};

async function reconnectRowOf(ctx: MutationCtx, channelConfigId: Id<"channelConfigs">) {
  return await ctx.db
    .query("telegramReconnects")
    .withIndex("by_channel_config", (q) => q.eq("channelConfigId", channelConfigId))
    .first();
}

async function reconnectAudit(
  ctx: MutationCtx,
  config: Doc<"channelConfigs">,
  actorId: Id<"teamMembers"> | undefined,
  event: "channel.reconnect_requested" | "channel.reconnect_succeeded" | "channel.reconnect_expired" | "channel.reconnect_cancelled",
  now: number,
  extra: Record<string, unknown> = {},
) {
  // Never the token, the URL, the QR or the code: only who, which channel and how.
  await ctx.db.insert("auditLogs", {
    organizationId: config.organizationId,
    entityType: "channelConfig",
    entityId: config._id,
    action: "update",
    ...(actorId ? { actorId, actorType: "human" as const } : { actorType: "system" as const }),
    metadata: { event, via: "telegram", ...extra },
    description:
      event === "channel.reconnect_requested"
        ? "Pediu a reconexão do WhatsApp pelo Telegram"
        : event === "channel.reconnect_succeeded"
          ? "WhatsApp reconectado pelo Telegram"
          : event === "channel.reconnect_expired"
            ? "Reconexão do WhatsApp pelo Telegram expirou"
            : "Cancelou a reconexão do WhatsApp pelo Telegram",
    severity: event === "channel.reconnect_requested" || event === "channel.reconnect_succeeded" ? "high" : "medium",
    createdAt: now,
  });
}

/**
 * `rc:` (pairing code) / `rcq:` (QR instead): admin (`settings:manage`) with an
 * e-mail account, a bridge WhatsApp channel of the card's org in a
 * reconnectable state (`logged_out`/`disconnected`), 3 attempts per hour per
 * channel (switching code → QR inside a running attempt does not count).
 * Writes the attempt + anti-zombie token and schedules the reconnect action.
 */
async function onReconnect(ctx: MutationCtx, tap: Tap, mode: "code" | "qr"): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: SETTINGS_MANAGE, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  try {
    await requireAccountWithEmail(ctx, actor.member.userId);
  } catch (e) {
    return say(tap.chatId, errorText(e));
  }
  const configId = ctx.db.normalizeId("channelConfigs", tap.id);
  const config = configId ? await ctx.db.get(configId) : null;
  if (!config || config.organizationId !== actor.org._id) return notFound(tap.chatId);
  if (config.channel !== "whatsapp" || config.provider !== "bridge") {
    const card = reconnectNotAllowedCard("meta", tap.appBaseUrl);
    return { replies: [], edits: [edit(tap, card)] };
  }
  if (!canStartReconnect(config.bridgeSessionState)) {
    const card = reconnectNotAllowedCard(config.bridgeSessionState ?? "unknown", tap.appBaseUrl);
    return { replies: [], edits: [edit(tap, card)] };
  }
  const discreet = actor.org.settings.telegram?.discreet === true;
  if (mode === "qr" && discreet) return say(tap.chatId, "No modo discreto o QR fica desligado. Use o código de pareamento ou o CRM.");

  const row = await reconnectRowOf(ctx, config._id);
  const active = row?.token !== undefined && (row.until ?? 0) > tap.now;
  // Review v0.78 #2: one attempt per channel — another admin's running attempt is not taken over.
  if (row && active && row.chatId !== tap.chatId) {
    const holderLink = row.linkId ? await ctx.db.get(row.linkId) : null;
    const holder = holderLink ? await ctx.db.get(holderLink.teamMemberId) : null;
    const tz = (await contextFor(ctx, actor, tap, {})).timezone;
    const since = row.startedAt ? ` desde ${formatTime(row.startedAt, tz)}` : "";
    return say(
      tap.chatId,
      `⏳ ${escapeHtml(holder?.name ?? "Outra pessoa da equipe")} já está reconectando este número${since}. Aguarde ou peça que cancele.`,
    );
  }
  const sameChatActive = !!row && active && row.chatId === tap.chatId;
  // Review v0.78 #1: code → QR once per attempt, inside the attempt's window; an rcq: while the QR is
  // already showing does not hit the gateway again.
  if (mode === "qr" && sameChatActive && (row!.mode === "qr" || row!.qrSwitched)) {
    return say(tap.chatId, "📷 O QR já está logo abaixo. Leia com o celular do número; ele renova sozinho.");
  }
  const switchingToQr = mode === "qr" && sameChatActive;
  // Mesmo teto da web (`lib/pairingQuota.ts`); trocar para QR não consome tentativa.
  const quota = consumePairingAttempt(row, tap.now);
  const { hourStart, attempts } = pairingWindow(row, tap.now);
  if (!switchingToQr && !quota.allowed) {
    const tz = (await contextFor(ctx, actor, tap, {})).timezone;
    const card = reconnectLimitCard({ nextAt: quota.resetsAt, tz });
    return { replies: [{ chatId: tap.chatId, text: card.text, keyboard: card.keyboard }], edits: [] };
  }
  const edits: EditOp[] = [];
  if (sameChatActive && !switchingToQr) {
    // A new attempt replaces the running one in this chat: its photo goes, its card says so.
    if (row!.qrMessageId) {
      await ctx.scheduler.runAfter(0, internal.telegramReconnect.internalDeleteQrPhoto, { chatId: tap.chatId, messageId: row!.qrMessageId });
    }
    if (row!.cardMessageId && row!.cardMessageId !== tap.messageId) {
      edits.push({ chatId: tap.chatId, messageId: row!.cardMessageId, text: "↪️ Tentativa substituída por uma nova.", keyboard: [] });
    }
  }
  const token = `${tap.now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const startedAt = switchingToQr ? (row!.startedAt ?? tap.now) : tap.now;
  const fields = {
    hourStart,
    attempts: switchingToQr ? attempts : quota.next.attempts,
    token,
    linkId: actor.link._id,
    chatId: tap.chatId,
    cardMessageId: switchingToQr ? (row!.cardMessageId ?? tap.messageId) : tap.messageId,
    mode,
    qrSwitched: switchingToQr,
    startedAt,
    // The QR window counts from the attempt's start: switching never extends it.
    until: startedAt + (mode === "code" ? RECONNECT_CODE_WINDOW_MS : RECONNECT_QR_WINDOW_MS),
    qrHash: undefined,
    qrMessageId: undefined,
    updatedAt: tap.now,
  };
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert("telegramReconnects", { organizationId: config.organizationId, channelConfigId: config._id, ...fields });
  if (!switchingToQr) await reconnectAudit(ctx, config, actor.member._id, "channel.reconnect_requested", tap.now, { mode });
  await ctx.scheduler.runAfter(0, internal.telegramReconnect.internalStartReconnect, { channelConfigId: config._id, token });
  const waiting = mode === "code" ? "⏳ Pedindo o código de pareamento ao WhatsApp…" : "⏳ Gerando o QR…";
  return { replies: [], edits: [...edits, { chatId: tap.chatId, messageId: fields.cardMessageId, text: waiting, keyboard: [] }] };
}

/** `rcx:` — cancels the running attempt (token cleared: the watcher stops), the QR photo is deleted. */
async function onReconnectCancel(ctx: MutationCtx, tap: Tap): Promise<ActionResult> {
  const auth = await authorizeTelegramActor(ctx, { chatId: tap.chatId, organizationId: tap.orgId, permission: SETTINGS_MANAGE, now: tap.now });
  if (!auth.ok) return auth.result;
  const { actor } = auth;
  const configId = ctx.db.normalizeId("channelConfigs", tap.id);
  const config = configId ? await ctx.db.get(configId) : null;
  if (!config || config.organizationId !== actor.org._id) return notFound(tap.chatId);
  const row = await reconnectRowOf(ctx, config._id);
  if (row?.token) {
    await ctx.db.patch(row._id, { token: undefined, qrMessageId: undefined, qrHash: undefined, updatedAt: tap.now });
    if (row.qrMessageId && row.chatId) {
      await ctx.scheduler.runAfter(0, internal.telegramReconnect.internalDeleteQrPhoto, { chatId: row.chatId, messageId: row.qrMessageId });
    }
    await reconnectAudit(ctx, config, actor.member._id, "channel.reconnect_cancelled", tap.now);
  }
  const text = "✖ Reconexão cancelada.";
  const keyboard = reconnectRetry(config._id);
  // The tap may be on the QR photo (caption) or on the code card: the code card becomes the record.
  const cardId = row?.cardMessageId && row.cardMessageId !== tap.messageId ? row.cardMessageId : tap.messageId;
  return { replies: [], edits: [{ chatId: tap.chatId, messageId: cardId, text, keyboard }] };
}

/** The channel fields the reconnect core needs — never the whole `channelConfigs` doc (review v0.78 #6). */
export type ReconnectConfig = {
  _id: Id<"channelConfigs">;
  organizationId: Id<"organizations">;
  channel: string;
  provider?: string;
  bridgeBaseUrl?: string;
  bridgeInstanceId?: string;
  bridgeTokenEncrypted?: string;
  bridgePhone?: string;
  bridgeSessionState?: string;
};
function reconnectConfigOf(c: Doc<"channelConfigs">): ReconnectConfig {
  return {
    _id: c._id,
    organizationId: c.organizationId,
    channel: c.channel,
    ...(c.provider ? { provider: c.provider } : {}),
    ...(c.bridgeBaseUrl ? { bridgeBaseUrl: c.bridgeBaseUrl } : {}),
    ...(c.bridgeInstanceId ? { bridgeInstanceId: c.bridgeInstanceId } : {}),
    ...(c.bridgeTokenEncrypted ? { bridgeTokenEncrypted: c.bridgeTokenEncrypted } : {}),
    ...(c.bridgePhone ? { bridgePhone: c.bridgePhone } : {}),
    ...(c.bridgeSessionState ? { bridgeSessionState: c.bridgeSessionState } : {}),
  };
}

export type ReconnectRun = {
  ok: true;
  config: ReconnectConfig;
  organizationId: Id<"organizations">;
  linkId: Id<"telegramLinks">;
  memberId: Id<"teamMembers">;
  chatId: number;
  cardMessageId: number;
  qrMessageId?: number;
  qrHash?: string;
  mode: "code" | "qr";
  startedAt: number;
  until: number;
  discreet: boolean;
  protectContent: boolean;
  timezone: string;
  last4?: string;
};

/**
 * Every step of a reconnect attempt (start and each watcher tick) passes here
 * first: the token must still be the attempt's (anti-zombie: another attempt
 * or a cancel owns the row now → silent stop), and the member must still be a
 * live, linked `settings:manage` of the channel's org. Losing that stops the
 * attempt for good: the QR photo is deleted (scheduled BEFORE the field is
 * cleared) and the card says "✖ Reconexão interrompida" (review v0.78 #3).
 */
export async function authorizeReconnectRun(
  ctx: MutationCtx,
  args: { channelConfigId: Id<"channelConfigs">; token: string; now: number },
): Promise<ReconnectRun | { ok: false; result: ActionResult }> {
  const silent = { ok: false as const, result: empty() };
  const row = await reconnectRowOf(ctx, args.channelConfigId);
  if (!row || row.token !== args.token || row.chatId === undefined || row.cardMessageId === undefined || !row.mode) return silent;
  const interrupt = async (extra: ActionResult = empty()) => {
    if (row.qrMessageId !== undefined) {
      await ctx.scheduler.runAfter(0, internal.telegramReconnect.internalDeleteQrPhoto, { chatId: row.chatId!, messageId: row.qrMessageId });
    }
    await ctx.db.patch(row._id, { token: undefined, qrMessageId: undefined, qrHash: undefined, updatedAt: args.now });
    return {
      ok: false as const,
      result: {
        replies: extra.replies,
        edits: [...extra.edits, { chatId: row.chatId!, messageId: row.cardMessageId!, text: "✖ Reconexão interrompida.", keyboard: [] }],
      },
    };
  };
  const config = await ctx.db.get(args.channelConfigId);
  if (!config || config.organizationId !== row.organizationId) return await interrupt();
  const auth = await authorizeTelegramActor(ctx, { chatId: row.chatId, organizationId: row.organizationId, permission: SETTINGS_MANAGE, now: args.now });
  if (!auth.ok) return await interrupt(auth.result);
  if (auth.actor.link._id !== row.linkId) return await interrupt();
  const { actor } = auth;
  return {
    ok: true,
    config: reconnectConfigOf(config),
    organizationId: row.organizationId,
    linkId: actor.link._id,
    memberId: actor.member._id,
    chatId: row.chatId,
    cardMessageId: row.cardMessageId,
    ...(row.qrMessageId !== undefined ? { qrMessageId: row.qrMessageId } : {}),
    ...(row.qrHash !== undefined ? { qrHash: row.qrHash } : {}),
    mode: row.mode,
    startedAt: row.startedAt ?? args.now,
    until: row.until ?? args.now,
    discreet: actor.org.settings.telegram?.discreet === true,
    protectContent: actor.org.settings.telegram?.protectContent === true,
    timezone: safeTimezone(actor.org.settings.timezone),
    ...(last4Of(config) ? { last4: last4Of(config) } : {}),
  };
}

/** Ends (or updates) the attempt — only while the token is still this attempt's. */
export async function settleReconnect(
  ctx: MutationCtx,
  args: {
    channelConfigId: Id<"channelConfigs">;
    token: string;
    now: number;
    outcome?: "succeeded" | "expired" | "failed";
    /** Review v0.78 #5: a gateway hiccup on start gives the attempt back (3 hiccups must not lock the hour). */
    refund?: boolean;
    patch?: { qrMessageId?: number; qrHash?: string; mode?: "code" | "qr"; until?: number };
    memberId?: Id<"teamMembers">;
  },
): Promise<boolean> {
  const row = await reconnectRowOf(ctx, args.channelConfigId);
  if (!row || row.token !== args.token) return false;
  const config = await ctx.db.get(args.channelConfigId);
  if (args.outcome) {
    await ctx.db.patch(row._id, {
      token: undefined,
      qrMessageId: undefined,
      qrHash: undefined,
      ...(args.refund ? { attempts: Math.max(0, row.attempts - 1) } : {}),
      updatedAt: args.now,
    });
    if (config && args.outcome !== "failed") {
      await reconnectAudit(
        ctx,
        config,
        args.memberId,
        args.outcome === "succeeded" ? "channel.reconnect_succeeded" : "channel.reconnect_expired",
        args.now,
      );
    }
    return true;
  }
  if (args.patch) await ctx.db.patch(row._id, { ...args.patch, updatedAt: args.now });
  return true;
}
