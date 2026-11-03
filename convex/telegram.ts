/**
 * Copilot on Telegram — F0 (foundation and linking). See
 * `docs/architecture/telegram.md`.
 *
 * Public: `createLinkCode`, `getMyLink`, `unlink`, `updateMyLinkPrefs`.
 * Ingress (D5): `POST /webhooks/telegram/platform` (`telegramHttp.ts`) →
 * `internalIngestUpdate` (dedupe by `update_id`, persist, schedule) →
 * `internalProcessUpdate` (action: routing mutation + replies through
 * `lib/telegramApi.ts`, the only Bot API client).
 *
 * Never log the token, a chat id next to a name, or message text.
 */
import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireAccountWithEmail, requireAuth } from "./lib/auth";
import { assertModule, modulesOf } from "./lib/orgModules";
import { appUrl } from "./lib/appUrl";
import { cronsDisabled } from "./lib/cronGuard";
import { sendMessage, sendMessageChunks, deleteMessage, type ReplyMarkup } from "./lib/telegramApi";
import { htmlToPlainText, splitMessage } from "./lib/telegramFormat";
import {
  CLEANUP_DELETE_MAX,
  CLEANUP_DELETE_WINDOW_MS,
  COPY,
  DEFAULT_LINK_ASSISTANT,
  DEFAULT_LINK_PREFS,
  DEFAULT_LINK_REPORTS,
  LAST_SEEN_THROTTLE_MS,
  LINK_CODE_TTL_MS,
  MAX_SEND_ATTEMPTS,
  alreadyLinkedText,
  deepLinkUrl,
  farewellText,
  generateLinkCode,
  hashLinkCode,
  looksLikeLinkCode,
  parseCommand,
  parseTelegramUpdate,
  settingsUrl,
  updateIdOf,
  welcomeText,
  type ParsedUpdate,
} from "./lib/telegramCore";
import {
  activeLinksOfChat,
  isLinkMemberAlive,
  liveLinksOfMember,
  revokeTelegramLink,
  revokeTelegramLinksForMember,
} from "./lib/telegramLinks";

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/** A bot reply decided by a mutation and sent by an action. */
const replyValidator = v.object({
  chatId: v.number(),
  text: v.string(),
  /** Inline button "🔗 Abrir configurações" → settings page. */
  settingsButton: v.optional(v.boolean()),
  removeKeyboard: v.optional(v.boolean()),
  protectContent: v.optional(v.boolean()),
});
type Reply = {
  chatId: number;
  text: string;
  settingsButton?: boolean;
  removeKeyboard?: boolean;
  protectContent?: boolean;
};
const repliesReturn = v.object({ replies: v.array(replyValidator) });

const cleanupReasonValidator = v.union(
  v.literal("unlink"),
  v.literal("sair"),
  v.literal("member_removed"),
  v.literal("moved"),
);

const myLinkValidator = v.object({
  _id: v.id("telegramLinks"),
  status: v.union(v.literal("active"), v.literal("blocked"), v.literal("revoked")),
  username: v.optional(v.string()),
  firstName: v.optional(v.string()),
  linkedAt: v.number(),
  lastSeenAt: v.number(),
  mutedUntil: v.optional(v.number()),
  prefs: v.object({ relayAssignedConversations: v.boolean(), mediaInbound: v.boolean() }),
  reports: v.object({ enabled: v.boolean(), morningHour: v.number(), eveningHour: v.number() }),
  assistant: v.object({ mode: v.union(v.literal("suggest"), v.literal("auto")) }),
});

function botUsernameEnv(): string | null {
  const raw = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return raw ? raw : null;
}

// ---------------------------------------------------------------------------
// Public API (Configurações → Notificações → Telegram)
// ---------------------------------------------------------------------------

/** Generates a one-time deep link `https://t.me/<bot>?start=<code>` (D2). */
export const createLinkCode = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.object({ url: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const user = await requireAccountWithEmail(ctx);
    if (member.type !== "human" || member.userId !== user._id) {
      throw new ConvexError("Só membros humanos podem conectar o Telegram");
    }
    await assertModule(ctx, args.organizationId, "telegram");
    const botUsername = botUsernameEnv();
    if (!botUsername) throw new ConvexError("Telegram não está configurado neste ambiente");

    // Invalidates the member's previous unused codes (only the latest link works).
    const previous = await ctx.db
      .query("telegramLinkCodes")
      .withIndex("by_member", (q) => q.eq("teamMemberId", member._id))
      .take(50);
    for (const row of previous) {
      if (row.usedAt === undefined) await ctx.db.delete(row._id);
    }

    const now = Date.now();
    const code = generateLinkCode();
    const expiresAt = now + LINK_CODE_TTL_MS;
    await ctx.db.insert("telegramLinkCodes", {
      organizationId: args.organizationId,
      teamMemberId: member._id,
      userId: user._id,
      codeHash: await hashLinkCode(code),
      expiresAt,
      createdAt: now,
    });
    return { url: deepLinkUrl(botUsername, code), expiresAt };
  },
});

/** Card state. A `revoked` link reads as `link:null`; `blocked` is returned. */
export const getMyLink = query({
  args: { organizationId: v.id("organizations") },
  returns: v.object({
    moduleEnabled: v.boolean(),
    botUsername: v.union(v.string(), v.null()),
    link: v.union(v.null(), myLinkValidator),
  }),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const org = await ctx.db.get(args.organizationId);
    const active = await ctx.db
      .query("telegramLinks")
      .withIndex("by_member_and_status", (q) => q.eq("teamMemberId", member._id).eq("status", "active"))
      .order("desc")
      .first();
    const link =
      active ??
      (await ctx.db
        .query("telegramLinks")
        .withIndex("by_member_and_status", (q) => q.eq("teamMemberId", member._id).eq("status", "blocked"))
        .order("desc")
        .first());
    return {
      moduleEnabled: modulesOf(org).telegram,
      botUsername: botUsernameEnv(),
      link: link
        ? {
            _id: link._id,
            status: link.status,
            username: link.username,
            firstName: link.firstName,
            linkedAt: link.linkedAt,
            lastSeenAt: link.lastSeenAt,
            mutedUntil: link.mutedUntil,
            prefs: link.prefs,
            reports: link.reports,
            assistant: { mode: link.assistant.mode },
          }
        : null,
    };
  },
});

/** "Desconectar" in the card: revokes the member's link(s) and cleans the chat. */
export const unlink = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    for (const link of await liveLinksOfMember(ctx, member._id)) {
      await revokeTelegramLink(ctx, link, "unlink", { actorId: member._id });
    }
    return null;
  },
});

function assertHour(value: number | undefined, label: string) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > 23) {
    throw new ConvexError(`${label} precisa ser uma hora inteira entre 0 e 23`);
  }
}

export const updateMyLinkPrefs = mutation({
  args: {
    organizationId: v.id("organizations"),
    prefs: v.optional(
      v.object({
        relayAssignedConversations: v.optional(v.boolean()),
        mediaInbound: v.optional(v.boolean()),
      }),
    ),
    reports: v.optional(
      v.object({
        enabled: v.optional(v.boolean()),
        morningHour: v.optional(v.number()),
        eveningHour: v.optional(v.number()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    assertHour(args.reports?.morningHour, "Horário da manhã");
    assertHour(args.reports?.eveningHour, "Horário do fim do dia");
    const [link] = await liveLinksOfMember(ctx, member._id);
    if (!link) throw new ConvexError("Nenhum Telegram conectado nesta organização");
    const prefs = { ...link.prefs };
    if (args.prefs?.relayAssignedConversations !== undefined) {
      prefs.relayAssignedConversations = args.prefs.relayAssignedConversations;
    }
    if (args.prefs?.mediaInbound !== undefined) prefs.mediaInbound = args.prefs.mediaInbound;
    const reports = { ...link.reports };
    if (args.reports?.enabled !== undefined) reports.enabled = args.reports.enabled;
    if (args.reports?.morningHour !== undefined) reports.morningHour = args.reports.morningHour;
    if (args.reports?.eveningHour !== undefined) reports.eveningHour = args.reports.eveningHour;
    await ctx.db.patch(link._id, { prefs, reports });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Ingress (D5)
// ---------------------------------------------------------------------------

/** Drops `undefined` fields (the stored `parsed` stays a clean object). */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, val]) => val !== undefined)) as T;
}

/** Idempotent by `(botKey, update_id)`: persists `pending` and schedules processing. */
export const internalIngestUpdate = internalMutation({
  args: { botKey: v.string(), update: v.any() },
  returns: v.object({ duplicate: v.boolean(), kind: v.string() }),
  handler: async (ctx, args) => {
    const updateId = updateIdOf(args.update);
    if (updateId === null) return { duplicate: false, kind: "invalid" };
    const existing = await ctx.db
      .query("telegramUpdates")
      .withIndex("by_bot_and_update_id", (q) => q.eq("botKey", args.botKey).eq("updateId", updateId))
      .first();
    if (existing) return { duplicate: true, kind: existing.kind };

    const parsed = parseTelegramUpdate(args.update);
    const updateRowId = await ctx.db.insert("telegramUpdates", {
      botKey: args.botKey,
      updateId,
      kind: parsed.kind,
      chatId: parsed.chatId,
      receivedAt: Date.now(),
      status: "pending",
      parsed: compact(parsed),
    });
    await ctx.scheduler.runAfter(0, internal.telegram.internalProcessUpdate, { updateRowId });
    return { duplicate: false, kind: parsed.kind };
  },
});

const parsedValidator = v.object({
  kind: v.union(
    v.literal("message"),
    v.literal("callback_query"),
    v.literal("my_chat_member"),
    v.literal("stopped_message_generation"),
    v.literal("other"),
  ),
  chatId: v.optional(v.number()),
  chatType: v.optional(v.string()),
  fromId: v.optional(v.number()),
  username: v.optional(v.string()),
  firstName: v.optional(v.string()),
  text: v.optional(v.string()),
  messageId: v.optional(v.number()),
  callbackQueryId: v.optional(v.string()),
  callbackData: v.optional(v.string()),
  memberStatus: v.optional(v.string()),
});

export const internalGetUpdate = internalQuery({
  args: { updateRowId: v.id("telegramUpdates") },
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(v.literal("pending"), v.literal("done"), v.literal("error")),
      parsed: v.optional(parsedValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.updateRowId);
    return row ? { status: row.status, parsed: row.parsed } : null;
  },
});

/** Terminal state; the `parsed` slice (may hold the member's text) is dropped. */
export const internalFinishUpdate = internalMutation({
  args: {
    updateRowId: v.id("telegramUpdates"),
    status: v.union(v.literal("done"), v.literal("error")),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.updateRowId);
    if (!row) return null;
    await ctx.db.patch(args.updateRowId, {
      status: args.status,
      error: args.error?.slice(0, 200),
      parsed: undefined,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Routing (mutations decide, the action sends)
// ---------------------------------------------------------------------------

async function getChat(ctx: { db: MutationCtx["db"] }, chatId: number) {
  return await ctx.db
    .query("telegramChats")
    .withIndex("by_chat_id", (q) => q.eq("chatId", chatId))
    .first();
}

async function upsertChat(
  ctx: MutationCtx,
  chatId: number,
  telegramUserId: number,
  patch: Partial<Pick<Doc<"telegramChats">, "activeOrganizationId" | "activeTeamMemberId">>,
  now: number,
) {
  const chat = await getChat(ctx, chatId);
  if (chat) {
    await ctx.db.patch(chat._id, { ...patch, updatedAt: now });
    return chat._id;
  }
  return await ctx.db.insert("telegramChats", { chatId, telegramUserId, ...patch, updatedAt: now });
}

function unlinkedReply(chatId: number): Reply {
  return { chatId, text: COPY.unlinked, settingsButton: true };
}

/**
 * Active links of the chat whose member is still alive. Dead ones (member
 * removed) are revoked here, so removal cuts access on the next update even
 * before the sweep runs. Keeps the chat's active org pointing at a live link.
 */
async function resolveChat(ctx: MutationCtx, chatId: number, now: number) {
  const alive: Doc<"telegramLinks">[] = [];
  let removed = 0;
  for (const link of await activeLinksOfChat(ctx, chatId)) {
    if (isLinkMemberAlive(link, await ctx.db.get(link.teamMemberId))) alive.push(link);
    else {
      await revokeTelegramLink(ctx, link, "member_removed", { now });
      removed++;
    }
  }
  const chat = await getChat(ctx, chatId);
  if (alive.length === 0) {
    if (chat && (chat.activeOrganizationId || chat.activeTeamMemberId)) {
      await ctx.db.patch(chat._id, { activeOrganizationId: undefined, activeTeamMemberId: undefined, updatedAt: now });
    }
    return { chat, active: null, alive, removed };
  }
  const active = alive.find((l) => l.teamMemberId === chat?.activeTeamMemberId) ?? alive[alive.length - 1];
  if (chat) {
    await ctx.db.patch(chat._id, {
      activeOrganizationId: active.organizationId,
      activeTeamMemberId: active.teamMemberId,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("telegramChats", {
      chatId,
      telegramUserId: active.telegramUserId,
      activeOrganizationId: active.organizationId,
      activeTeamMemberId: active.teamMemberId,
      updatedAt: now,
    });
  }
  return { chat, active, alive, removed };
}

async function touchLink(ctx: MutationCtx, link: Doc<"telegramLinks">, p: ParsedUpdate, now: number) {
  if (now - link.lastSeenAt < LAST_SEEN_THROTTLE_MS) return;
  await ctx.db.patch(link._id, {
    lastSeenAt: now,
    ...(p.username !== undefined ? { username: p.username } : {}),
    ...(p.firstName !== undefined ? { firstName: p.firstName } : {}),
  });
}

async function protectContentFor(ctx: MutationCtx, organizationId: Id<"organizations">) {
  const org = await ctx.db.get(organizationId);
  return org?.settings.telegram?.protectContent === true;
}

/** Everything except `/start <code>` (that is `internalConsumeLinkCode`). */
export const internalRouteUpdate = internalMutation({
  args: { updateRowId: v.id("telegramUpdates") },
  returns: repliesReturn,
  handler: async (ctx, args) => {
    const none = { replies: [] as Reply[] };
    const row = await ctx.db.get(args.updateRowId);
    if (!row || row.status !== "pending" || !row.parsed) return none;
    const p = row.parsed;
    const chatId = p.chatId;
    if (chatId === undefined) return none;
    // F0 talks only in private chats (a group would expose CRM data to everyone in it).
    // No chat type (e.g. a callback without `message`) is NOT private: ack only.
    if (p.chatType !== "private") return none;
    const now = Date.now();

    if (p.kind === "my_chat_member") {
      if (p.memberStatus === "kicked" || p.memberStatus === "left") {
        for (const link of await activeLinksOfChat(ctx, chatId)) {
          await ctx.db.patch(link._id, { status: "blocked" });
        }
      } else if (p.memberStatus === "member") {
        // Unblocked: blocked links of live members come back.
        const blocked = await ctx.db
          .query("telegramLinks")
          .withIndex("by_chat_id_and_status", (q) => q.eq("chatId", chatId).eq("status", "blocked"))
          .take(20);
        for (const link of blocked) {
          if (isLinkMemberAlive(link, await ctx.db.get(link.teamMemberId))) {
            await ctx.db.patch(link._id, { status: "active", lastSeenAt: now });
          } else {
            await revokeTelegramLink(ctx, link, "member_removed", { now });
          }
        }
      }
      return none;
    }
    if (p.kind !== "message" && p.kind !== "callback_query") return none;

    const { active, alive, removed } = await resolveChat(ctx, chatId, now);
    if (!active) {
      // Removed member: the cleanup's farewell already says it; nothing else.
      if (removed > 0) return none;
      return { replies: [unlinkedReply(chatId)] };
    }
    await touchLink(ctx, active, p, now);
    if (p.kind === "callback_query") return none; // F0: ack only (webhook body)

    const cmd = parseCommand(p.text);
    if (cmd?.command === "sair") {
      for (const link of alive) await revokeTelegramLink(ctx, link, "sair", { actorId: link.teamMemberId, now });
      return none;
    }

    const org = await ctx.db.get(active.organizationId);
    const protectContent = org?.settings.telegram?.protectContent === true;
    if (!modulesOf(org).telegram) return { replies: [{ chatId, text: COPY.moduleOff }] };

    if (cmd?.command === "start") {
      const member = await ctx.db.get(active.teamMemberId);
      return {
        replies: [
          {
            chatId,
            text: alreadyLinkedText({ memberName: member?.name ?? "", orgName: org?.name ?? "" }),
            protectContent,
          },
        ],
      };
    }
    if (cmd?.command === "ajuda" || cmd?.command === "help") {
      return { replies: [{ chatId, text: COPY.help, protectContent }] };
    }
    return { replies: [{ chatId, text: COPY.learning, protectContent }] };
  },
});

/** `/start <code>` (D2): validates the one-time code and creates/refreshes the link. */
export const internalConsumeLinkCode = internalMutation({
  args: {
    chatId: v.number(),
    telegramUserId: v.number(),
    username: v.optional(v.string()),
    firstName: v.optional(v.string()),
    code: v.string(),
  },
  returns: repliesReturn,
  handler: async (ctx, args) => {
    const { chatId } = args;
    const invalid = { replies: [{ chatId, text: COPY.codeInvalid }] };
    if (!looksLikeLinkCode(args.code)) return invalid;
    const now = Date.now();
    const hash = await hashLinkCode(args.code);
    const code = await ctx.db
      .query("telegramLinkCodes")
      .withIndex("by_code_hash", (q) => q.eq("codeHash", hash))
      .first();
    if (!code || code.usedAt !== undefined || code.expiresAt <= now) return invalid;

    const member = await ctx.db.get(code.teamMemberId);
    if (!member || !isLinkMemberAlive({ organizationId: code.organizationId, userId: code.userId }, member)) {
      await ctx.db.patch(code._id, { usedAt: now });
      return invalid;
    }
    const org = await ctx.db.get(code.organizationId);
    if (!org || !modulesOf(org).telegram) return { replies: [{ chatId, text: COPY.moduleOff }] };

    // One Telegram = one person: refuse a chat already bound to another user.
    // `blocked` links count too: unblocking (`my_chat_member` "member")
    // reactivates them, which would leave two userIds on one chat.
    const { alive } = await resolveChat(ctx, chatId, now);
    if (alive.some((l) => l.userId !== code.userId)) {
      return { replies: [{ chatId, text: COPY.chatTaken }] };
    }
    const blockedOfChat = await ctx.db
      .query("telegramLinks")
      .withIndex("by_chat_id_and_status", (q) => q.eq("chatId", chatId).eq("status", "blocked"))
      .take(20);
    for (const link of blockedOfChat) {
      if (link.userId === code.userId) continue;
      if (isLinkMemberAlive(link, await ctx.db.get(link.teamMemberId))) {
        return { replies: [{ chatId, text: COPY.chatTaken }] };
      }
      await revokeTelegramLink(ctx, link, "member_removed", { now });
    }

    // The member keeps ONE live link: an older one in another chat is revoked
    // (that chat gets the farewell); a blocked/active one in this chat is reused.
    let linkId: Id<"telegramLinks"> | null = null;
    for (const link of await liveLinksOfMember(ctx, member._id)) {
      if (link.chatId === chatId && link.status === "active" && linkId === null) {
        linkId = link._id;
        continue;
      }
      await revokeTelegramLink(ctx, link, link.chatId === chatId ? "relinked" : "moved", {
        actorId: member._id,
        now,
      });
    }
    if (linkId) {
      await ctx.db.patch(linkId, {
        telegramUserId: args.telegramUserId,
        username: args.username,
        firstName: args.firstName,
        lastSeenAt: now,
      });
    } else {
      linkId = await ctx.db.insert("telegramLinks", {
        organizationId: code.organizationId,
        teamMemberId: member._id,
        userId: code.userId,
        chatId,
        telegramUserId: args.telegramUserId,
        username: args.username,
        firstName: args.firstName,
        status: "active",
        prefs: { ...DEFAULT_LINK_PREFS },
        assistant: { ...DEFAULT_LINK_ASSISTANT, autoAllowed: { ...DEFAULT_LINK_ASSISTANT.autoAllowed } },
        reports: { ...DEFAULT_LINK_REPORTS },
        linkedAt: now,
        lastSeenAt: now,
      });
    }
    await upsertChat(
      ctx,
      chatId,
      args.telegramUserId,
      { activeOrganizationId: code.organizationId, activeTeamMemberId: member._id },
      now,
    );
    await ctx.db.patch(code._id, { usedAt: now });
    await ctx.db.insert("auditLogs", {
      organizationId: code.organizationId,
      entityType: "telegramLink",
      entityId: linkId,
      action: "create",
      actorId: member._id,
      actorType: "human",
      metadata: { event: "telegram.linked", via: "telegram", teamMemberId: member._id },
      description: "Conectou o Telegram",
      severity: "high",
      createdAt: now,
    });

    const otherOrgNames: string[] = [];
    for (const l of alive) {
      if (l.organizationId === code.organizationId) continue;
      const other = await ctx.db.get(l.organizationId);
      if (other) otherOrgNames.push(other.name);
    }
    return {
      replies: [
        {
          chatId,
          text: welcomeText({ memberName: member.name, orgName: org.name, otherOrgNames }),
          protectContent: await protectContentFor(ctx, code.organizationId),
        },
      ],
    };
  },
});

/** 403 from Telegram or `my_chat_member` kicked: the chat's active links → `blocked`. */
export const internalMarkChatBlocked = internalMutation({
  args: { chatId: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const link of await activeLinksOfChat(ctx, args.chatId)) {
      await ctx.db.patch(link._id, { status: "blocked" });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Processing action
// ---------------------------------------------------------------------------

function markupFor(reply: Pick<Reply, "removeKeyboard" | "settingsButton">): ReplyMarkup | undefined {
  if (reply.removeKeyboard) return { remove_keyboard: true };
  if (reply.settingsButton) {
    return { inline_keyboard: [[{ text: COPY.unlinkedButton, url: settingsUrl(appUrl()) }]] };
  }
  return undefined;
}

/** Reply options without the text: what a 429 resume needs besides the chunks. */
const resumeValidator = v.object({
  chatId: v.number(),
  /** Chunks NOT yet delivered (already cut by `splitMessage`). */
  chunks: v.array(v.string()),
  settingsButton: v.optional(v.boolean()),
  removeKeyboard: v.optional(v.boolean()),
  protectContent: v.optional(v.boolean()),
});
type Resume = Omit<Reply, "text"> & { chunks: string[] };

async function deliverReply(ctx: ActionCtx, reply: Reply, attempt: number): Promise<void> {
  const { text, ...opts } = reply;
  await deliverChunks(ctx, { ...opts, chunks: splitMessage(text) }, attempt);
}

async function deliverChunks(ctx: ActionCtx, reply: Resume, attempt: number): Promise<void> {
  if (reply.chunks.length === 0) return;
  const res = await sendMessageChunks({
    chatId: reply.chatId,
    chunks: reply.chunks,
    replyMarkup: markupFor(reply),
    protectContent: reply.protectContent,
  });
  if (res.ok) return;
  if (res.kind === "bad_request" && reply.settingsButton) {
    // A URL button Telegram refuses (e.g. a localhost APP_URL in DEV): send the link as text.
    await sendMessage({
      chatId: reply.chatId,
      text: `${htmlToPlainText(reply.chunks.join("\n"))}\n${settingsUrl(appUrl())}`,
      parseMode: null,
    });
    return;
  }
  if (res.kind === "blocked") {
    await ctx.runMutation(internal.telegram.internalMarkChatBlocked, { chatId: reply.chatId });
    return;
  }
  if (res.kind === "rate_limited" && attempt < MAX_SEND_ATTEMPTS) {
    const delayMs = Math.min(Math.max(res.retryAfterSeconds ?? 1, 1), 300) * 1000;
    // Only what was not delivered travels: chunks already sent are never repeated.
    await ctx.scheduler.runAfter(delayMs, internal.telegram.internalDeliverReply, {
      reply: { ...reply, chunks: reply.chunks.slice(res.sentCount) },
      attempt: attempt + 1,
    });
  }
}

/** 429 retry of the undelivered chunks of one reply (§3.8, at most `MAX_SEND_ATTEMPTS`). */
export const internalDeliverReply = internalAction({
  args: { reply: resumeValidator, attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deliverChunks(ctx, args.reply, args.attempt);
    return null;
  },
});

export const internalProcessUpdate = internalAction({
  args: { updateRowId: v.id("telegramUpdates") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row: { status: "pending" | "done" | "error"; parsed?: ParsedUpdate } | null = await ctx.runQuery(
      internal.telegram.internalGetUpdate,
      { updateRowId: args.updateRowId },
    );
    if (!row || row.status !== "pending") return null;
    try {
      const p = row.parsed;
      const cmd = p?.kind === "message" ? parseCommand(p.text) : null;
      let replies: Reply[];
      if (
        p &&
        cmd?.command === "start" &&
        cmd.payload &&
        p.chatId !== undefined &&
        p.fromId !== undefined &&
        p.chatType === "private"
      ) {
        const res: { replies: Reply[] } = await ctx.runMutation(internal.telegram.internalConsumeLinkCode, {
          chatId: p.chatId,
          telegramUserId: p.fromId,
          username: p.username,
          firstName: p.firstName,
          code: cmd.payload,
        });
        replies = res.replies;
      } else {
        const res: { replies: Reply[] } = await ctx.runMutation(internal.telegram.internalRouteUpdate, {
          updateRowId: args.updateRowId,
        });
        replies = res.replies;
      }
      for (const reply of replies) await deliverReply(ctx, reply, 1);
      await ctx.runMutation(internal.telegram.internalFinishUpdate, { updateRowId: args.updateRowId, status: "done" });
    } catch (e) {
      // Name only: Convex validation messages echo argument values (code, names).
      const error = e instanceof Error ? e.name : "erro";
      console.error(`[telegram] update falhou: ${e instanceof Error ? e.name : "erro"}`);
      await ctx.runMutation(internal.telegram.internalFinishUpdate, {
        updateRowId: args.updateRowId,
        status: "error",
        error,
      });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Revocation cleanup (§3.1 step 4, §5)
// ---------------------------------------------------------------------------

export const internalGetCleanupPlan = internalQuery({
  args: { linkId: v.id("telegramLinks"), since: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      chatId: v.number(),
      orgName: v.string(),
      messageIds: v.array(v.number()),
      protectContent: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) return null;
    const org = await ctx.db.get(link.organizationId);
    const deliveries = await ctx.db
      .query("telegramDeliveries")
      .withIndex("by_link_and_sent", (q) => q.eq("linkId", args.linkId).gt("sentAt", args.since))
      .take(CLEANUP_DELETE_MAX);
    return {
      chatId: link.chatId,
      orgName: org?.name ?? "",
      messageIds: deliveries.filter((d) => d.chatId === link.chatId).map((d) => d.messageId),
      protectContent: org?.settings.telegram?.protectContent === true,
    };
  },
});

/** Re-points (or clears) the chat's active org after a revocation. */
export const internalFinishLinkCleanup = internalMutation({
  args: { linkId: v.id("telegramLinks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) return null;
    const chat = await getChat(ctx, link.chatId);
    if (!chat) return null;
    const others = (await activeLinksOfChat(ctx, link.chatId)).filter((l) => l._id !== link._id);
    const now = Date.now();
    if (others.length === 0) {
      await ctx.db.patch(chat._id, { activeOrganizationId: undefined, activeTeamMemberId: undefined, updatedAt: now });
    } else if (!others.some((l) => l.teamMemberId === chat.activeTeamMemberId)) {
      const next = others[others.length - 1];
      await ctx.db.patch(chat._id, {
        activeOrganizationId: next.organizationId,
        activeTeamMemberId: next.teamMemberId,
        updatedAt: now,
      });
    }
    return null;
  },
});

/** Farewell (removes the reply keyboard), deletes the bot's messages ≤ 48 h, fixes the chat pointer. */
export const internalCleanupRevokedLink = internalAction({
  args: { linkId: v.id("telegramLinks"), reason: cleanupReasonValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const plan: { chatId: number; orgName: string; messageIds: number[]; protectContent: boolean } | null =
      await ctx.runQuery(internal.telegram.internalGetCleanupPlan, {
        linkId: args.linkId,
        since: Date.now() - CLEANUP_DELETE_WINDOW_MS,
      });
    if (plan) {
      const farewell = await sendMessage({
        chatId: plan.chatId,
        text: farewellText(args.reason, plan.orgName),
        replyMarkup: { remove_keyboard: true },
        protectContent: plan.protectContent,
      });
      if (!(farewell.ok === false && farewell.kind === "disabled")) {
        for (const messageId of plan.messageIds) {
          const res = await deleteMessage({ chatId: plan.chatId, messageId });
          // Best effort: stop on rate limit/blocked (Telegram already refuses > 48 h).
          if (!res.ok && (res.kind === "rate_limited" || res.kind === "blocked" || res.kind === "disabled")) break;
        }
      }
    }
    await ctx.runMutation(internal.telegram.internalFinishLinkCleanup, { linkId: args.linkId });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Member removal
// ---------------------------------------------------------------------------

/** Same effect as the hook in `removeTeamMember` (for REST/ops callers). */
export const internalRevokeLinksForMember = internalMutation({
  args: { teamMemberId: v.id("teamMembers"), actorId: v.optional(v.id("teamMembers")) },
  returns: v.object({ revoked: v.number() }),
  handler: async (ctx, args) => {
    return { revoked: await revokeTelegramLinksForMember(ctx, args.teamMemberId, { actorId: args.actorId }) };
  },
});

const SWEEP_DEFAULT_PAGE = 100;
const SWEEP_MAX_PAGE = 200;

/**
 * Safety net (daily cron + ops): live links (`active`, then `blocked`) whose
 * member was removed (or is no longer a live human of the org) are revoked.
 * A blocked link counts: unblocking would bring it back. `dryRun` default
 * TRUE and scans one page of `status` (default `active`; `nextStatus` says
 * what to pass next); real runs re-schedule themselves by cursor and move
 * from `active` to `blocked`. `isDone` = the whole sweep is done. Output has
 * ids only (no names, no chat ids). No audit per row (ops rule).
 *
 *   npx convex run telegram:internalRevokeForRemovedMembers '{}'
 *   npx convex run telegram:internalRevokeForRemovedMembers '{"status":"blocked"}'
 *   npx convex run telegram:internalRevokeForRemovedMembers '{"dryRun":false}'
 */
export const internalRevokeForRemovedMembers = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    fromCron: v.optional(v.boolean()),
    status: v.optional(v.union(v.literal("active"), v.literal("blocked"))),
  },
  returns: v.object({
    dryRun: v.boolean(),
    status: v.union(v.literal("active"), v.literal("blocked")),
    nextStatus: v.union(v.literal("blocked"), v.null()),
    skipped: v.optional(v.literal("crons_disabled")),
    scanned: v.number(),
    toRevoke: v.number(),
    revoked: v.number(),
    sample: v.array(v.object({ linkId: v.id("telegramLinks"), organizationId: v.id("organizations") })),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const status = args.status ?? "active";
    if (args.fromCron && cronsDisabled()) {
      return {
        dryRun,
        status,
        nextStatus: null,
        skipped: "crons_disabled" as const,
        scanned: 0,
        toRevoke: 0,
        revoked: 0,
        sample: [],
        isDone: true,
        continueCursor: null,
      };
    }
    const raw = args.pageSize ?? SWEEP_DEFAULT_PAGE;
    const numItems = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), SWEEP_MAX_PAGE) : SWEEP_DEFAULT_PAGE;
    const page = await ctx.db
      .query("telegramLinks")
      .withIndex("by_status", (q) => q.eq("status", status))
      .paginate({ numItems, cursor: args.cursor ?? null });
    const dead: Doc<"telegramLinks">[] = [];
    for (const link of page.page) {
      if (!isLinkMemberAlive(link, await ctx.db.get(link.teamMemberId))) dead.push(link);
    }
    let revoked = 0;
    const nextStatus = page.isDone && status === "active" ? ("blocked" as const) : null;
    if (!dryRun) {
      const now = Date.now();
      for (const link of dead) {
        await revokeTelegramLink(ctx, link, "member_removed", { audit: false, now });
        revoked++;
      }
      if (!page.isDone || nextStatus) {
        await ctx.scheduler.runAfter(0, internal.telegram.internalRevokeForRemovedMembers, {
          cursor: page.isDone ? null : page.continueCursor,
          pageSize: numItems,
          dryRun: false,
          fromCron: args.fromCron,
          status: nextStatus ?? status,
        });
      }
    }
    console.log(
      JSON.stringify({ event: "telegramRevokeSweep", dryRun, status, scanned: page.page.length, toRevoke: dead.length, revoked }),
    );
    return {
      dryRun,
      status,
      nextStatus,
      scanned: page.page.length,
      toRevoke: dead.length,
      revoked,
      sample: dead.slice(0, 20).map((l) => ({ linkId: l._id, organizationId: l.organizationId })),
      isDone: page.isDone && status === "blocked",
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
