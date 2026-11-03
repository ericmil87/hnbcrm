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
import { ConvexError } from "convex/values";
import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { acceptHandoffCore, rejectHandoffWithInstructionCore } from "../handoffs";
import { acceptAiDraftCore, discardAiDraftCore, requestAiDraftCore, returnToAiCore } from "../attendant";
import { assumeConversationCore, internalSendMessageCore } from "../conversations";
import { applyTaskCompletion, snoozeTaskCore } from "./taskOps";
import { syncFollowUpForTask } from "./followUpOps";
import { hasPermission, resolvePermissions, type PermissionCategory, type Permissions, type Role } from "./permissions";
import { modulesOf } from "./orgModules";
import { activeLinksOfChat, isLinkMemberAlive, revokeTelegramLink } from "./telegramLinks";
import { loadCardContext, loadHistory, pendingDraftOf } from "./telegramContext";
import { COPY } from "./telegramCore";
import { escapeHtml } from "./telegramFormat";
import {
  buildAiRelayCard,
  buildHistoryCard,
  buildNotificationCard,
  buildPrompt,
  buildRecordCard,
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

export type DeliveryKind = "notification" | "relay" | "prompt";
export type RecordSpec = {
  organizationId: Id<"organizations">;
  linkId: Id<"telegramLinks">;
  kind: DeliveryKind;
  conversationId?: Id<"conversations">;
  handoffId?: Id<"handoffs">;
  taskId?: Id<"tasks">;
  notificationId?: Id<"notifications">;
  crmMessageId?: Id<"messages">;
  /** The sent message becomes `telegramChats.pendingPrompt.promptMessageId`… */
  setPromptMessageId?: boolean;
  /** …only if the open prompt still has this `expiresAt` (the one the send was for). */
  promptExpiresAt?: number;
};
export type SendOp = { chatId: number; text: string; keyboard?: CardKeyboard; protectContent?: boolean; record?: RecordSpec };
export type EditOp = { chatId: number; messageId: number; text: string; keyboard?: CardKeyboard };
export type ActionResult = { replies: SendOp[]; edits: EditOp[] };

const empty = (): ActionResult => ({ replies: [], edits: [] });

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
async function getTyped<T extends "conversations" | "handoffs" | "messages" | "tasks">(
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

async function clearPrompt(ctx: MutationCtx, chatId: number, now: number) {
  const chat = await chatOf(ctx, chatId);
  if (chat?.pendingPrompt) await ctx.db.patch(chat._id, { pendingPrompt: undefined, updatedAt: now });
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
  let ownerId: Id<"teamMembers"> | undefined;
  let at: number | undefined;
  const normalized = handoffId ? ctx.db.normalizeId("handoffs", handoffId) : null;
  const handoff = normalized ? await ctx.db.get(normalized) : null;
  if (handoff && handoff.organizationId === actor.org._id && handoff.status === "accepted" && handoff.acceptedBy) {
    ownerId = handoff.acceptedBy;
    at = handoff.resolvedAt;
  } else {
    const paused = conversation.aiPausedUntil !== undefined && conversation.aiPausedUntil > now;
    const lead = conversation.leadId ? await ctx.db.get(conversation.leadId) : null;
    if (paused && lead?.assignedTo) {
      ownerId = lead.assignedTo;
      at = lead.handoffState?.toMemberId === lead.assignedTo ? lead.handoffState.completedAt : undefined;
    }
  }
  if (!ownerId || ownerId === actor.member._id) return null;
  const owner = await ctx.db.get(ownerId);
  if (!owner || owner.type !== "human" || owner.organizationId !== actor.org._id || owner.removedAt !== undefined) return null;
  return `⚠️ ${escapeHtml(owner.name)} assumiu esta conversa${at ? ` às ${formatTime(at, timezone)}` : ""}.`;
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
  const expiresAt = tap.now + PROMPT_TTL_MS;
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
  if (!prompt || prompt.kind !== "reply_customer" || !prompt.draftText || prompt.conversationId !== tap.id) {
    return say(tap.chatId, "⌛ Esta prévia não está mais ativa. Toque em Responder no cartão de novo.");
  }
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
  try {
    await internalSendMessageCore(ctx, {
      conversationId: conversation._id,
      content: prompt.draftText,
      teamMemberId: actor.member._id,
      via: "telegram",
    });
  } catch (e) {
    failWith(say(tap.chatId, errorText(e)));
  }
  await clearPrompt(ctx, tap.chatId, tap.now);
  const card = await contextFor(ctx, actor, tap, { conversationId: conversation._id });
  const time = formatTime(tap.now, card.timezone);
  const sentRecord = buildRecordCard(card, `✓ Enviado · ${time}`, [], prompt.draftText);
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
  const record = buildRecordCard(card, `✅ Rascunho enviado por você · ${formatTime(tap.now, card.timezone)}`, ["viewAll", "links"], found.draft.content);
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
  return { replies: [], edits: [edit(tap, buildHistoryCard(card, history, out.keyboard))] };
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
  const expiresAt = args.now + PROMPT_TTL_MS;
  await ctx.db.patch(chat._id, {
    pendingPrompt: { ...prompt, draftText: text, expiresAt },
    updatedAt: args.now,
  });
  const preview = buildReplyPreview(card, text);
  const edits: EditOp[] = prompt.promptMessageId
    ? [{ chatId: args.chatId, messageId: prompt.promptMessageId, text: "💬 Prévia logo abaixo." }]
    : [];
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
