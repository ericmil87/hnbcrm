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
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireAccountWithEmail, requireAuth, requirePermission } from "./lib/auth";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./lib/permissions";
import { coalesceKeys, createNotification } from "./lib/notify";
import { shouldDeliver } from "./lib/notificationPolicy";
import { loadMemberPrefs, orgDefaultsOf } from "./lib/notificationPrefs";
import { messagePreview, notificationCopy } from "./lib/notificationCopy";
import { editMessageText } from "./lib/telegramApi";
import {
  PROMPT_EXPIRED_COPY,
  TELEGRAM_FAILURE,
  executeAutoSend,
  handleTelegramCallback,
  handleTelegramPromptAnswer,
  discardPromptDraft,
  type EditOp,
  type RecordSpec,
  type SendOp,
} from "./lib/telegramActions";
import { loadCardContext } from "./lib/telegramContext";
import {
  buildAiRelayCard,
  buildCountdownCard,
  buildNotificationCard,
  buildRecordCard,
  formatTime,
  type CardKeyboard,
} from "./lib/telegramNotifications";
import { escapeHtml } from "./lib/telegramFormat";
import { PERSISTENT_KEYBOARD, CMD_COPY, parseCommandCallback, resolveCommandName } from "./lib/telegramCommands";
import { runTelegramCallback, runTelegramCommand } from "./telegramCommands";
import { buildWelcomeCard } from "./lib/telegramOnboarding";
import { FOCUS_TTL_MS, resolveRelayRecipient } from "./lib/telegramRelay";
import { COPILOT_COPY } from "./telegramCopilot";
import { appendFirstTimeTip } from "./lib/telegramOnboarding";
import {
  AI_BACK_IN_CHARGE,
  AUTO_SEND_MAX_S,
  AUTO_SEND_MIN_S,
  autoSendSeconds,
  draftAutoSendable,
  effectiveAssistantMode,
} from "./lib/telegramAssistant";
import { assertModule, modulesOf } from "./lib/orgModules";
import { appUrl } from "./lib/appUrl";
import { cronsDisabled } from "./lib/cronGuard";
import { sendMessage, sendMessageChunks, deleteMessage, sendFile, sendFileUpload, type ReplyMarkup } from "./lib/telegramApi";
import { conversationCrmUrl, mediaForMessages, type MediaOut } from "./lib/telegramMedia";
import { fileSizeCopy } from "./lib/telegramQuota";
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

const keyboardValidator = v.array(
  v.array(
    v.union(
      v.object({ text: v.string(), url: v.string() }),
      v.object({ text: v.string(), callback_data: v.string() }),
      // v0.78: "📋 Copiar código" (Bot API CopyTextButton).
      v.object({ text: v.string(), copy_text: v.object({ text: v.string() }) }),
    ),
  ),
);

/** After a successful send, the message is recorded in `telegramDeliveries`. */
const recordValidator = v.object({
  organizationId: v.id("organizations"),
  linkId: v.id("telegramLinks"),
  kind: v.union(
    v.literal("notification"),
    v.literal("relay"),
    v.literal("prompt"),
    // F3: Copilot answers/cards, automatic-mode record, countdown draft (D22/D23).
    v.literal("copilot"),
    v.literal("auto_record"),
    v.literal("draft"),
    // F4 (D21): a file sent right after a card.
    v.literal("media"),
  ),
  conversationId: v.optional(v.id("conversations")),
  handoffId: v.optional(v.id("handoffs")),
  taskId: v.optional(v.id("tasks")),
  notificationId: v.optional(v.id("notifications")),
  crmMessageId: v.optional(v.id("messages")),
  mediaStorageId: v.optional(v.string()),
  setPromptMessageId: v.optional(v.boolean()),
  /** `expiresAt` of the prompt open when the send was decided (binds the id to THAT prompt). */
  promptExpiresAt: v.optional(v.number()),
  /** F3 (D22): automatic-mode record — what "Desfazer" reverts, until `expiresAt`. */
  undo: v.optional(
    v.object({
      steps: v.array(v.object({ kind: v.string(), refId: v.string(), before: v.optional(v.any()), after: v.optional(v.any()) })),
      expiresAt: v.number(),
    }),
  ),
  /** F3 (D23): countdown card — `internalAutoSendDraft` fires after `delayMs` unless vetoed. */
  autoSend: v.optional(v.object({ delayMs: v.number(), draftMessageId: v.optional(v.id("messages")) })),
});

/** F4 (D21): one file a card carries (`lib/telegramMedia.MediaOut`). */
const mediaOutValidator = v.object({
  kind: v.union(v.literal("photo"), v.literal("voice"), v.literal("audio"), v.literal("document"), v.literal("link")),
  storageId: v.optional(v.string()),
  fileName: v.string(),
  size: v.number(),
  mime: v.string(),
  text: v.optional(v.string()),
});

/** A bot reply decided by a mutation and sent by an action. */
const replyValidator = v.object({
  chatId: v.number(),
  text: v.string(),
  /** Inline button "🔗 Abrir configurações" → settings page. */
  settingsButton: v.optional(v.boolean()),
  removeKeyboard: v.optional(v.boolean()),
  /** F2: the persistent reply keyboard (📋 Hoje · 🔁 Repasses · ✅ Tarefas · ⏸ Pausar). */
  persistentKeyboard: v.optional(v.boolean()),
  protectContent: v.optional(v.boolean()),
  keyboard: v.optional(keyboardValidator),
  record: v.optional(recordValidator),
  media: v.optional(v.array(mediaOutValidator)),
});
type Reply = SendOp & { settingsButton?: boolean; removeKeyboard?: boolean; persistentKeyboard?: boolean };

/** "Mensagem vira registro": edit of a message the bot already sent. */
const editValidator = v.object({
  chatId: v.number(),
  messageId: v.number(),
  text: v.string(),
  keyboard: v.optional(keyboardValidator),
});
const repliesReturn = v.object({ replies: v.array(replyValidator), edits: v.optional(v.array(editValidator)) });

const cleanupReasonValidator = v.union(
  v.literal("unlink"),
  v.literal("sair"),
  v.literal("member_removed"),
  v.literal("moved"),
);

const autoAllowedValidator = v.object({
  instructAi: v.boolean(),
  createTask: v.boolean(),
  moveStage: v.boolean(),
  acceptHandoff: v.boolean(),
  replyCustomer: v.boolean(),
});

const myLinkValidator = v.object({
  _id: v.id("telegramLinks"),
  status: v.union(v.literal("active"), v.literal("blocked"), v.literal("revoked")),
  username: v.optional(v.string()),
  firstName: v.optional(v.string()),
  linkedAt: v.number(),
  lastSeenAt: v.number(),
  mutedUntil: v.optional(v.number()),
  prefs: v.object({ relayAssignedConversations: v.boolean(), mediaInbound: v.boolean() }),
  reports: v.object({
    enabled: v.boolean(),
    morningHour: v.number(),
    eveningHour: v.number(),
    weekends: v.optional(v.boolean()), // F2 relatórios
  }),
  assistant: v.object({
    mode: v.union(v.literal("suggest"), v.literal("auto")),
    // F3 (D22/D23): settings shown in the card; hourly counters stay server-side.
    suggestOnEvents: v.boolean(),
    autoSendDelaySeconds: v.number(),
    autoAllowed: autoAllowedValidator,
    autoPausedAt: v.optional(v.number()),
  }),
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
    // F1: org options (card section for admins) and whether this member may change them.
    org: v.object({ discreet: v.boolean(), protectContent: v.boolean(), allowAutoMode: v.boolean() }),
    canManage: v.boolean(),
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
    const tg = org?.settings.telegram;
    const perms = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
    return {
      moduleEnabled: modulesOf(org).telegram,
      botUsername: botUsernameEnv(),
      org: {
        discreet: tg?.discreet === true,
        protectContent: tg?.protectContent === true,
        allowAutoMode: tg?.allowAutoMode !== false,
      },
      canManage: hasPermission(perms, "settings", "manage"),
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
            assistant: {
              mode: link.assistant.mode,
              suggestOnEvents: link.assistant.suggestOnEvents,
              autoSendDelaySeconds: autoSendSeconds(link),
              autoAllowed: link.assistant.autoAllowed,
              ...(link.assistant.autoPausedAt !== undefined ? { autoPausedAt: link.assistant.autoPausedAt } : {}),
            },
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
        weekends: v.optional(v.boolean()), // F2 relatórios
      }),
    ),
    // F3 (D22/D23): assistant mode and its limits, edited from the card.
    assistant: v.optional(
      v.object({
        mode: v.optional(v.union(v.literal("suggest"), v.literal("auto"))),
        suggestOnEvents: v.optional(v.boolean()),
        autoSendDelaySeconds: v.optional(v.number()),
        autoAllowed: v.optional(autoAllowedValidator.partial()),
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
    if (args.reports?.weekends !== undefined) reports.weekends = args.reports.weekends; // F2 relatórios
    await ctx.db.patch(link._id, { prefs, reports });
    if (args.assistant) await updateAssistantSettings(ctx, link, member, args.assistant);
    return null;
  },
});

type AssistantPatch = {
  mode?: "suggest" | "auto";
  suggestOnEvents?: boolean;
  autoSendDelaySeconds?: number;
  autoAllowed?: Partial<Doc<"telegramLinks">["assistant"]["autoAllowed"]>;
};

/** Card edits of the assistant (D22/D23): same rules as `/modo`, audited. */
async function updateAssistantSettings(
  ctx: MutationCtx,
  link: Doc<"telegramLinks">,
  member: Doc<"teamMembers">,
  patch: AssistantPatch,
) {
  const delay = patch.autoSendDelaySeconds;
  if (delay !== undefined && (!Number.isInteger(delay) || delay < AUTO_SEND_MIN_S || delay > AUTO_SEND_MAX_S)) {
    throw new ConvexError(`O tempo para cancelar precisa ser um número inteiro entre ${AUTO_SEND_MIN_S} e ${AUTO_SEND_MAX_S} segundos`);
  }
  const now = Date.now();
  const before = link.assistant;
  if (patch.mode === "auto" && before.mode !== "auto") {
    const org = await ctx.db.get(link.organizationId);
    if (org?.settings.telegram?.allowAutoMode === false) {
      throw new ConvexError("O modo automático está desligado nesta organização");
    }
  }
  const turningAutoOn = patch.mode === "auto" && (before.mode !== "auto" || before.autoPausedAt !== undefined);
  const next: Doc<"telegramLinks">["assistant"] = {
    ...before,
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.suggestOnEvents !== undefined ? { suggestOnEvents: patch.suggestOnEvents } : {}),
    ...(delay !== undefined ? { autoSendDelaySeconds: delay } : {}),
    autoAllowed: { ...before.autoAllowed, ...compact(patch.autoAllowed ?? {}) },
    // Choosing automatic again clears the undo pause and the hourly counter (same as `/modo`).
    ...(turningAutoOn ? { autoPausedAt: undefined, autoActionsThisHour: 0, autoHourStart: now } : {}),
  };
  await ctx.db.patch(link._id, { assistant: next });
  const view = (a: Doc<"telegramLinks">["assistant"]) => ({
    mode: a.mode,
    suggestOnEvents: a.suggestOnEvents,
    autoSendDelaySeconds: a.autoSendDelaySeconds,
    autoAllowed: a.autoAllowed,
  });
  const widened =
    turningAutoOn || (next.autoAllowed.replyCustomer && !before.autoAllowed.replyCustomer);
  await ctx.db.insert("auditLogs", {
    organizationId: link.organizationId,
    entityType: "telegramLink",
    entityId: link._id,
    action: "update",
    actorId: member._id,
    actorType: "human",
    changes: { before: view(before), after: view(next) },
    metadata: { event: "telegram.assistant_mode", via: "app" },
    description: turningAutoOn
      ? "Ligou o modo automático da assistente no Telegram"
      : "Alterou as configurações da assistente no Telegram",
    severity: widened ? "high" : "low",
    createdAt: now,
  });
}

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
  // F3 (D21): incoming media (voice/audio/photo/video/document).
  media: v.optional(
    v.object({
      kind: v.union(
        v.literal("voice"),
        v.literal("audio"),
        v.literal("photo"),
        v.literal("video"),
        v.literal("video_note"),
        v.literal("document"),
      ),
      fileId: v.string(),
      fileSize: v.optional(v.number()),
      mimeType: v.optional(v.string()),
      fileName: v.optional(v.string()),
    }),
  ),
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
  patch: Partial<Pick<Doc<"telegramChats">, "activeOrganizationId" | "activeTeamMemberId" | "keyboardShown">>,
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
    if (p.kind === "stopped_message_generation") {
      // F3 (D10): the user tapped "stop" on a streaming answer — the running turn ends.
      const chat = await getChat(ctx, chatId);
      if (chat) await ctx.db.patch(chat._id, { cancelRequestedAt: now, updatedAt: now });
      return none;
    }
    if (p.kind !== "message" && p.kind !== "callback_query") return none;

    // Hard expiry: an expired prompt (and its `draftText`) is removed on ANY update.
    const chatRow = await getChat(ctx, chatId);
    const promptExpired = chatRow?.pendingPrompt !== undefined && chatRow.pendingPrompt.expiresAt <= now;
    if (chatRow && promptExpired) {
      // F4: an unsent file draft goes too (quota back, file row + blob deleted).
      await discardPromptDraft(ctx, chatRow.pendingPrompt!);
      await ctx.db.patch(chatRow._id, { pendingPrompt: undefined, updatedAt: now });
    }

    const { active, alive, removed } = await resolveChat(ctx, chatId, now);
    if (!active) {
      // Removed member: the cleanup's farewell already says it; nothing else.
      if (removed > 0) return none;
      return { replies: [unlinkedReply(chatId)] };
    }
    await touchLink(ctx, active, p, now);
    if (p.kind === "callback_query") {
      // F2: list/command buttons (`cmd:`, `pg:`, `fc:`, `mu:`, `org:`).
      const commandCb = parseCommandCallback(p.callbackData);
      if (commandCb) {
        return await runTelegramCallback(ctx, commandCb, {
          chatId,
          active,
          alive,
          now,
          appBaseUrl: appUrl(),
          messageId: p.messageId,
        });
      }
      // F1: buttons → lib/telegramActions (reauthorization + single ports).
      return await handleTelegramCallback(ctx, {
        chatId,
        messageId: p.messageId,
        data: p.callbackData,
        now,
        appBaseUrl: appUrl(),
      });
    }

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
    // F2: slash commands and persistent-keyboard labels.
    const commandName = resolveCommandName(cmd, p.text);
    if (commandName) {
      return await runTelegramCommand(ctx, commandName, { chatId, active, alive, now, appBaseUrl: appUrl() });
    }
    if (cmd) return { replies: [{ chatId, text: CMD_COPY.unknown, protectContent }] };
    if (promptExpired) return { replies: [{ chatId, text: PROMPT_EXPIRED_COPY }] };
    // F3 (D21): voice/audio go to the Copilot runner FIRST (the transcript may
    // answer an open prompt there); video is not supported.
    const media = p.media;
    const openPrompt = chatRow?.pendingPrompt && !promptExpired ? chatRow.pendingPrompt : undefined;
    const replyPrompt =
      openPrompt?.kind === "reply_customer" && openPrompt.organizationId === active.organizationId ? openPrompt : undefined;
    if (media && (media.kind === "video" || media.kind === "video_note")) {
      // §4.5: videos never go to the customer; with an open reply, offer the CRM.
      const keyboard = replyPrompt?.conversationId
        ? [[{ text: "🔗 Abrir conversa", url: conversationCrmUrl(appUrl(), replyPrompt.conversationId) }]]
        : undefined;
      return { replies: [{ chatId, text: COPILOT_COPY.video, protectContent, ...(keyboard ? { keyboard } : {}) }] };
    }
    // F4 (D25): a file while "Responder" is open goes to the CUSTOMER (voice too, as audio).
    if (media && replyPrompt) {
      await ctx.scheduler.runAfter(0, internal.telegramFiles.internalReceiveReplyFile, {
        linkId: active._id,
        chatId,
        media,
        ...(p.text ? { caption: p.text } : {}),
      });
      return none;
    }
    if (media?.kind === "document") return { replies: [{ chatId, text: COPY_DOCUMENT_WITHOUT_PROMPT, protectContent }] };
    if (media && (media.kind === "voice" || media.kind === "audio")) {
      await ctx.scheduler.runAfter(0, internal.telegramCopilot.internalCopilotTurn, {
        linkId: active._id,
        source: "voice",
        media,
        ...(p.text ? { text: p.text } : {}),
      });
      return none;
    }
    // An open prompt (instruct / regenerate / reply) consumes the next message.
    const answered = await handleTelegramPromptAnswer(ctx, { chatId, text: p.text, now, appBaseUrl: appUrl() });
    if (answered) return answered;
    // F3 (D9): everything else is a Copilot turn (photo → vision first).
    if (media && media.kind === "photo") {
      await ctx.scheduler.runAfter(0, internal.telegramCopilot.internalCopilotTurn, {
        linkId: active._id,
        source: "photo",
        media,
        ...(p.text ? { text: p.text } : {}),
      });
      return none;
    }
    if (p.text?.trim()) {
      await ctx.scheduler.runAfter(0, internal.telegramCopilot.internalCopilotTurn, {
        linkId: active._id,
        source: "text",
        text: p.text,
      });
      return none;
    }
    return { replies: [{ chatId, text: COPY.learning, protectContent }] };
  },
});

/** F4: a document with no reply open has nobody to go to. */
export const COPY_DOCUMENT_WITHOUT_PROMPT =
  "Para mandar um arquivo ao cliente, toque em Responder no cartão da conversa (ou use /foco e responda).";

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
    // P6: the persistent keyboard is on by default; a user who hid it keeps it hidden.
    const chatBefore = await getChat(ctx, chatId);
    const keyboardShown = chatBefore?.keyboardShown ?? true;
    await upsertChat(
      ctx,
      chatId,
      args.telegramUserId,
      { activeOrganizationId: code.organizationId, activeTeamMemberId: member._id, keyboardShown },
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
    // D24: card 0 of the tour. A message carries one reply_markup (inline wins), so the
    // persistent keyboard (P6, default on) comes in its own short message.
    await ctx.db.patch(linkId, { onboarding: { step: 0 } });
    const protectContent = await protectContentFor(ctx, code.organizationId);
    const welcome = buildWelcomeCard({ memberName: member.name, orgName: org.name, otherOrgNames });
    return {
      replies: [
        { chatId, text: welcome.text, keyboard: welcome.keyboard, protectContent },
        ...(keyboardShown ? [{ chatId, text: CMD_COPY.keyboardOn, protectContent, persistentKeyboard: true }] : []),
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

function markupFor(
  reply: Pick<Reply, "removeKeyboard" | "settingsButton" | "keyboard" | "persistentKeyboard">,
): ReplyMarkup | undefined {
  if (reply.removeKeyboard) return { remove_keyboard: true };
  if (reply.keyboard && reply.keyboard.length > 0) return { inline_keyboard: reply.keyboard };
  if (reply.persistentKeyboard) return PERSISTENT_KEYBOARD;
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
  persistentKeyboard: v.optional(v.boolean()),
  protectContent: v.optional(v.boolean()),
  keyboard: v.optional(keyboardValidator),
  record: v.optional(recordValidator),
  /** F4: this item is ONE file (then `chunks` is empty). */
  media: v.optional(mediaOutValidator),
  /** F4 (D25): the pacing slot already claimed for this item — send at it, never claim again. */
  slotAt: v.optional(v.number()),
});
type Resume = Omit<Reply, "text" | "media"> & { chunks: string[]; media?: MediaOut; slotAt?: number };

/**
 * Sends replies strictly in order. On a 429 the undelivered part of the
 * current reply AND every reply after it travel together in ONE retry job, so
 * a later row can never overtake an earlier one and nothing is sent twice.
 */
async function deliverReplies(ctx: ActionCtx, replies: Reply[], attempt: number): Promise<void> {
  const items: Resume[] = [];
  for (const { text, media, ...opts } of replies) {
    if (text.trim()) items.push({ ...opts, chunks: splitMessage(text) });
    // F4 (D21): each file is its own item (own pacing slot, own delivery row), right after the card.
    for (const m of media ?? []) {
      items.push({
        chatId: opts.chatId,
        chunks: [],
        media: m,
        ...(opts.protectContent ? { protectContent: true } : {}),
        ...(opts.record ? { record: mediaRecordOf(opts.record) } : {}),
      });
    }
  }
  await deliverSeries(ctx, items, attempt);
}

/** The delivery row of a file: same link/conversation as its card, never its notification (callbacks/broadcast edits key on that). */
function mediaRecordOf(r: RecordSpec): RecordSpec {
  return {
    organizationId: r.organizationId,
    linkId: r.linkId,
    kind: "media",
    ...(r.conversationId ? { conversationId: r.conversationId } : {}),
  };
}

/**
 * Pacing (D25): every item claims ONE send slot (`internalClaimTelegramSendSlot`,
 * 1 msg/s per chat + 25 msg/s global). A slot in the future reschedules the
 * rest of the series AT the slot, carrying `slotAt`, so it is sent there without
 * claiming again. Order is kept: later items wait behind the first.
 */
const PACING_SLACK_MS = 30;
async function deliverSeries(ctx: ActionCtx, items: Resume[], attempt: number): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    if (items[i].slotAt === undefined) {
      const now = Date.now();
      const { sendAt }: { sendAt: number } = await ctx.runMutation(internal.telegramQuota.internalClaimTelegramSendSlot, {
        chatId: items[i].chatId,
        now,
      });
      if (sendAt > now + PACING_SLACK_MS) {
        await ctx.scheduler.runAt(sendAt, internal.telegram.internalDeliverReply, {
          replies: [{ ...items[i], slotAt: sendAt }, ...items.slice(i + 1)],
          attempt,
        });
        return;
      }
    }
    const rest = await deliverChunks(ctx, items[i], attempt);
    if (rest && "insert" in rest) {
      // A follow-up message (settings-link fallback) is a new item: it claims its own slot (review F4 #7).
      items.splice(i + 1, 0, rest.insert);
      continue;
    }
    if (rest) {
      await ctx.scheduler.runAfter(rest.delayMs, internal.telegram.internalDeliverReply, {
        replies: [{ ...rest.resume, slotAt: undefined }, ...items.slice(i + 1)],
        attempt: attempt + 1,
      });
      return;
    }
  }
}

/**
 * Returns what to retry when Telegram rate-limited the send (and attempts
 * remain), a follow-up item to send next (`insert`), or null.
 */
async function deliverChunks(
  ctx: ActionCtx,
  reply: Resume,
  attempt: number,
): Promise<{ resume: Resume; delayMs: number } | { insert: Resume } | null> {
  if (reply.media) return await deliverMedia(ctx, reply, attempt);
  if (reply.chunks.length === 0) return null;
  const res = await sendMessageChunks({
    chatId: reply.chatId,
    chunks: reply.chunks,
    replyMarkup: markupFor(reply),
    protectContent: reply.protectContent,
  });
  if (res.ok) {
    const last = res.result[res.result.length - 1];
    if (reply.record && last) {
      await ctx.runMutation(internal.telegram.internalRecordDelivery, {
        record: reply.record,
        chatId: reply.chatId,
        messageId: last.message_id,
      });
    }
    return null;
  }
  if (res.kind === "bad_request" && reply.settingsButton) {
    // A URL button Telegram refuses (e.g. a localhost APP_URL in DEV): the link as text, as a NEW
    // item of the series (own pacing slot), without the button.
    return {
      insert: {
        chatId: reply.chatId,
        chunks: [`${escapeHtml(htmlToPlainText(reply.chunks.join("\n")))}\n${escapeHtml(settingsUrl(appUrl()))}`],
        ...(reply.protectContent ? { protectContent: true } : {}),
      },
    };
  }
  if (res.kind === "blocked") {
    await ctx.runMutation(internal.telegram.internalMarkChatBlocked, { chatId: reply.chatId });
    return null;
  }
  if (res.kind === "rate_limited" && attempt < MAX_SEND_ATTEMPTS) {
    const delayMs = Math.min(Math.max(res.retryAfterSeconds ?? 1, 1), 300) * 1000;
    // Only what was not delivered travels: chunks already sent are never repeated.
    return { resume: { ...reply, chunks: reply.chunks.slice(res.sentCount) }, delayMs };
  }
  return null;
}

/**
 * One file (F4, D21). No file quota (that is for what the MEMBER sends); a
 * file Telegram cannot take → the link line instead, never
 * a silent drop. Photo/voice by a storage URL (only Telegram sees it); audio/document as an
 * upload so Telegram shows the real name. Never a `file_id` of another bot.
 */
async function deliverMedia(
  ctx: ActionCtx,
  item: Resume,
  attempt: number,
): Promise<{ resume: Resume; delayMs: number } | null> {
  const m = item.media!;
  const sendLine = async (text: string) => {
    const res = await sendMessage({ chatId: item.chatId, text, protectContent: item.protectContent });
    const last = res.ok ? res.result[res.result.length - 1] : undefined;
    if (last && item.record) {
      await ctx.runMutation(internal.telegram.internalRecordDelivery, {
        record: item.record,
        chatId: item.chatId,
        messageId: last.message_id,
      });
    }
  };
  const linkLine = (why?: string) =>
    `${m.kind === "photo" ? "🖼" : m.kind === "document" ? "📄" : "🎙"} ${escapeHtml(m.fileName)} (${fileSizeCopy(m.size)})` +
    (why ? ` · ${why}` : "") +
    (item.record?.conversationId ? ` · <a href="${escapeHtml(conversationCrmUrl(appUrl(), item.record.conversationId))}">Abrir no CRM</a>` : "");
  if (m.kind === "link" || !m.storageId) {
    await sendLine(m.text ?? linkLine());
    return null;
  }
  // Relay of CUSTOMER files: pacing + MEDIA_PER_CARD only. D25's file quota is for what the
  // MEMBER sends (review F4 #3), so 30 customer photos never block the member's contract.
  let res: Awaited<ReturnType<typeof sendFile>>;
  if (m.kind === "photo" || m.kind === "voice") {
    const url = await ctx.storage.getUrl(m.storageId as Id<"_storage">);
    if (!url) {
      await sendLine(linkLine("arquivo indisponível"));
      return null;
    }
    res = await sendFile(m.kind, { chatId: item.chatId, url, protectContent: item.protectContent });
  } else {
    const blob = await ctx.storage.get(m.storageId as Id<"_storage">);
    if (!blob) {
      await sendLine(linkLine("arquivo indisponível"));
      return null;
    }
    res = await sendFileUpload(m.kind, { chatId: item.chatId, blob, fileName: m.fileName, protectContent: item.protectContent });
  }
  if (res.ok) {
    if (item.record) {
      await ctx.runMutation(internal.telegram.internalRecordDelivery, {
        record: { ...item.record, mediaStorageId: m.storageId },
        chatId: item.chatId,
        messageId: res.result.message_id,
      });
    }
    return null;
  }
  if (res.kind === "blocked") {
    await ctx.runMutation(internal.telegram.internalMarkChatBlocked, { chatId: item.chatId });
    return null;
  }
  if (res.kind === "rate_limited" && attempt < MAX_SEND_ATTEMPTS) {
    return { resume: item, delayMs: Math.min(Math.max(res.retryAfterSeconds ?? 1, 1), 300) * 1000 };
  }
  // Telegram could not take the file (URL fetch failed, type refused): the link instead.
  await sendLine(linkLine());
  return null;
}

/** The result carried by a failed Telegram action (`lib/telegramActions.failWith`), if any. */
function telegramFailureOf(e: unknown): { kind?: string; result?: { replies: Reply[]; edits: EditOp[] } } | null {
  if (!(e instanceof ConvexError)) return null;
  let data: unknown = e.data;
  // Across `runMutation` the data may arrive serialized (convex-test does this).
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  return data && typeof data === "object" ? (data as { kind?: string; result?: { replies: Reply[]; edits: EditOp[] } }) : null;
}

/** Edits ("mensagem vira registro"); "not modified" is fine, a failed edit is best effort. */
async function deliverEdits(edits: EditOp[] | undefined): Promise<void> {
  for (const e of edits ?? []) {
    await editMessageText({
      chatId: e.chatId,
      messageId: e.messageId,
      text: e.text,
      replyMarkup: { inline_keyboard: e.keyboard ?? [] },
    });
  }
}

/** F3: sends a mutation's `{replies, edits}` (prompt answers from a voice note, mode changes, undo). */
export const internalDeliverActionResult = internalAction({
  args: { result: v.object({ replies: v.array(replyValidator), edits: v.optional(v.array(editValidator)) }) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deliverEdits(args.result.edits);
    await deliverReplies(ctx, args.result.replies, 1);
    return null;
  },
});

/** Records a bot message (base of callbacks, broadcast edits, deleteMessage ≤ 48 h). */
export const internalRecordDelivery = internalMutation({
  args: { record: recordValidator, chatId: v.number(), messageId: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const r: RecordSpec = args.record;
    const now = Date.now();
    await ctx.db.insert("telegramDeliveries", {
      organizationId: r.organizationId,
      linkId: r.linkId,
      chatId: args.chatId,
      messageId: args.messageId,
      kind: r.kind,
      ...(r.notificationId ? { notificationId: r.notificationId } : {}),
      ...(r.handoffId ? { handoffId: r.handoffId } : {}),
      ...(r.conversationId ? { conversationId: r.conversationId } : {}),
      ...(r.taskId ? { taskId: r.taskId } : {}),
      ...(r.crmMessageId ? { crmMessageId: r.crmMessageId } : {}),
      ...(r.mediaStorageId ? { mediaStorageId: r.mediaStorageId } : {}),
      ...(r.undo ? { undo: r.undo } : {}),
      ...(r.autoSend
        ? { draft: { ...(r.autoSend.draftMessageId ? { messageId: r.autoSend.draftMessageId } : {}), sendAt: now + r.autoSend.delayMs } }
        : {}),
      sentAt: now,
    });
    if (r.autoSend) {
      // D23: the veto window starts when the countdown card is on the screen.
      const deliveryId = (
        await ctx.db
          .query("telegramDeliveries")
          .withIndex("by_chat_and_message", (q) => q.eq("chatId", args.chatId).eq("messageId", args.messageId))
          .first()
      )?._id;
      if (deliveryId) {
        await ctx.scheduler.runAfter(r.autoSend.delayMs, internal.telegram.internalAutoSendDraft, { deliveryId });
      }
    }
    if (r.setPromptMessageId) {
      const chat = await getChat(ctx, args.chatId);
      const sameprompt =
        chat?.pendingPrompt !== undefined &&
        (r.promptExpiresAt === undefined || chat.pendingPrompt.expiresAt === r.promptExpiresAt);
      if (chat?.pendingPrompt && sameprompt) {
        await ctx.db.patch(chat._id, {
          pendingPrompt: { ...chat.pendingPrompt, promptMessageId: args.messageId },
          updatedAt: now,
        });
      }
    }
    return null;
  },
});

/** 429 retry of the undelivered chunks of one reply (§3.8, at most `MAX_SEND_ATTEMPTS`). */
export const internalDeliverReply = internalAction({
  // `reply` (single) is the pre-F2 shape; jobs scheduled before the deploy still carry it.
  args: { replies: v.optional(v.array(resumeValidator)), reply: v.optional(resumeValidator), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deliverSeries(ctx, args.replies ?? (args.reply ? [args.reply] : []), args.attempt);
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
      let edits: EditOp[] | undefined;
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
        const res: { replies: Reply[]; edits?: EditOp[] } = await ctx.runMutation(
          internal.telegram.internalRouteUpdate,
          { updateRowId: args.updateRowId },
        );
        replies = res.replies;
        edits = res.edits;
      }
      await deliverEdits(edits);
      await deliverReplies(ctx, replies, 1);
      await ctx.runMutation(internal.telegram.internalFinishUpdate, { updateRowId: args.updateRowId, status: "done" });
    } catch (e) {
      // A Telegram action whose port threw: the mutation rolled back (no
      // partial writes) and the error carries what to tell the user.
      const data = telegramFailureOf(e);
      if (data?.kind === TELEGRAM_FAILURE && data.result) {
        await deliverEdits(data.result.edits);
        await deliverReplies(ctx, data.result.replies, 1);
        await ctx.runMutation(internal.telegram.internalFinishUpdate, { updateRowId: args.updateRowId, status: "done" });
        return null;
      }
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
    // Nothing of the revoked org stays on the chat: open prompt (may hold
    // `draftText`) and conversation focus (review F1 #11).
    const promptOfOrg = chat.pendingPrompt?.organizationId === link.organizationId;
    const focusConv = chat.focus ? await ctx.db.get(chat.focus.conversationId) : null;
    const focusOfOrg = chat.focus !== undefined && (!focusConv || focusConv.organizationId === link.organizationId);
    if (promptOfOrg || focusOfOrg) {
      await ctx.db.patch(chat._id, {
        ...(promptOfOrg ? { pendingPrompt: undefined } : {}),
        ...(focusOfOrg ? { focus: undefined } : {}),
        updatedAt: now,
      });
    }
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
  args: {
    linkId: v.id("telegramLinks"),
    reason: cleanupReasonValidator,
    /** F4 (D25): pacing slot already claimed for the farewell. */
    slotAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const plan: { chatId: number; orgName: string; messageIds: number[]; protectContent: boolean } | null =
      await ctx.runQuery(internal.telegram.internalGetCleanupPlan, {
        linkId: args.linkId,
        since: Date.now() - CLEANUP_DELETE_WINDOW_MS,
      });
    if (plan && args.slotAt === undefined) {
      const now = Date.now();
      const { sendAt }: { sendAt: number } = await ctx.runMutation(internal.telegramQuota.internalClaimTelegramSendSlot, {
        chatId: plan.chatId,
        now,
      });
      if (sendAt > now + PACING_SLACK_MS) {
        await ctx.scheduler.runAt(sendAt, internal.telegram.internalCleanupRevokedLink, { ...args, slotAt: sendAt });
        return null;
      }
    }
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

// ---------------------------------------------------------------------------
// F1 — notification delivery (D7), relay (D20) and org settings
// ---------------------------------------------------------------------------

const cardTargetValidator = v.object({
  chatId: v.number(),
  text: v.string(),
  keyboard: keyboardValidator,
  protectContent: v.boolean(),
  record: recordValidator,
  /** F3 (D24): the link's updated `tipsShown` when the card carried a first-time tip. */
  tipsShown: v.optional(v.array(v.string())),
  /** F4 (D21): files sent right after the card. */
  media: v.optional(v.array(mediaOutValidator)),
});
type CardTarget = {
  chatId: number;
  text: string;
  keyboard: CardKeyboard;
  protectContent: boolean;
  record: RecordSpec;
  tipsShown?: string[];
  media?: MediaOut[];
};

/** The live link that may receive a card for this member/org, or null (re-checked at delivery). */
async function deliverableLink(
  ctx: { db: QueryCtx["db"] },
  memberId: Id<"teamMembers">,
  organizationId: Id<"organizations">,
  now: number,
  opts: { conversationContent?: boolean; type?: string; explicitRequest?: boolean } = {},
) {
  const link = await ctx.db
    .query("telegramLinks")
    .withIndex("by_member_and_status", (q) => q.eq("teamMemberId", memberId).eq("status", "active"))
    .first();
  if (!link || link.organizationId !== organizationId) return null;
  const member = await ctx.db.get(link.teamMemberId);
  if (!member || !isLinkMemberAlive(link, member)) return null;
  // C1: mesma política do agendamento (pausa `pausedUntil` + `mutedUntil` legado, silêncio,
  // preferência por canal), recheckada na entrega. O pedido de ajuda urgente fura pausa.
  // `explicitRequest`: resposta da IA a um pedido que o próprio membro fez no bot — não passa
  // por preferência, pausa nem silêncio (só exige vínculo ativo e membro vivo).
  if (!opts.explicitRequest) {
    const prefs = await loadMemberPrefs(ctx, organizationId, memberId);
    const orgForPolicy = prefs?.preset ? null : await ctx.db.get(organizationId);
    const decision = shouldDeliver({
      type: opts.type ?? "new_message",
      channel: "telegram",
      prefs,
      orgDefaults: orgDefaultsOf(orgForPolicy),
      now,
      legacyMutedUntil: link.mutedUntil,
    });
    if (decision !== "deliver") return null;
  }
  // Conversation content (customer text, relay) only to whoever still has at
  // least `inbox:view_own` — same helper as the actions (review F1 #9).
  if (opts.conversationContent) {
    const perms = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
    if (!hasPermission(perms, "inbox", "view_own")) return null;
  }
  const org = await ctx.db.get(organizationId);
  if (!org || !modulesOf(org).telegram) return null;
  return { link, org };
}

/** Everything the delivery action needs, in one read (`now` passed in: no clock in queries). */
export const internalGetNotificationDelivery = internalQuery({
  args: {
    notificationId: v.id("notifications"),
    now: v.number(),
    /** F3 (D22): "🤔 Não decidi sozinha…" line on top of the card. */
    preface: v.optional(v.string()),
    /** F3 (D22, suggest mode): "💡 Sugiro: …" + "💡 Aplicar sugestão" (`pa:`). */
    suggestion: v.optional(v.object({ pendingActionId: v.id("pendingActions"), summary: v.string() })),
  },
  returns: v.union(v.null(), cardTargetValidator),
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.notificationId);
    if (!n) return null;
    const target = await deliverableLink(ctx, n.memberId, n.organizationId, args.now, {
      type: n.type,
      conversationContent: n.conversationId !== undefined || n.handoffId !== undefined,
    });
    if (!target) return null;
    const context = await loadCardContext(ctx.db, {
      organizationId: n.organizationId,
      now: args.now,
      appBaseUrl: appUrl(),
      notification: n,
    });
    if (!context) return null;
    const baseRecord = {
      organizationId: n.organizationId,
      linkId: target.link._id,
      notificationId: n._id,
      ...(n.handoffId ? { handoffId: n.handoffId } : {}),
      ...(n.conversationId ? { conversationId: n.conversationId } : {}),
      ...(n.taskId ? { taskId: n.taskId } : {}),
    };
    const protectContent = target.org.settings.telegram?.protectContent === true;
    // D23: in automatic mode an AI draft card is a countdown that sends unless vetoed.
    const mode = effectiveAssistantMode(target.link, target.org);
    const draftDoc =
      n.type === "ai_draft_pending" && mode === "auto" && context.draft
        ? await ctx.db.get(context.draft.messageId as Id<"messages">)
        : null;
    if (context.draft && draftDoc && draftAutoSendable(draftDoc.metadata?.aiDraft, n.memberId)) {
      const seconds = autoSendSeconds(target.link);
      const card = buildCountdownCard(context, context.draft.text, seconds, context.draft.messageId);
      return {
        chatId: target.link.chatId,
        text: card.text,
        keyboard: card.keyboard,
        protectContent,
        record: {
          ...baseRecord,
          kind: "draft" as const,
          autoSend: { delayMs: seconds * 1000, draftMessageId: context.draft.messageId as Id<"messages"> },
        },
      };
    }
    const card = buildNotificationCard({ notification: { ...n, _id: n._id }, context });
    const tip = appendFirstTimeTip({ type: n.type, tipsShown: target.link.tipsShown });
    const text = [
      args.preface ? escapeHtml(args.preface) : null,
      card.text,
      args.suggestion ? `💡 <b>Sugiro:</b> ${escapeHtml(args.suggestion.summary)}` : null,
      tip.line ? escapeHtml(tip.line) : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    const keyboard = args.suggestion
      ? [[{ text: "💡 Aplicar sugestão", callback_data: `pa:${args.suggestion.pendingActionId}` }], ...card.keyboard]
      : card.keyboard;
    const media = await notificationMedia(ctx, n, target.link, context.discreet);
    return {
      chatId: target.link.chatId,
      text,
      keyboard,
      protectContent,
      record: { ...baseRecord, kind: "notification" as const },
      ...(tip.line ? { tipsShown: tip.tipsShown } : {}),
      ...(media.length > 0 ? { media } : {}),
    };
  },
});

/**
 * F4 (D21): the customer files a card carries — the relayed messages of a
 * `new_message`, the last customer message of a `handoff_requested`.
 */
async function notificationMedia(
  ctx: QueryCtx,
  n: Doc<"notifications">,
  link: Doc<"telegramLinks">,
  discreet: boolean,
): Promise<MediaOut[]> {
  if (!n.conversationId || discreet || !link.prefs.mediaInbound) return [];
  const conversation = await ctx.db.get(n.conversationId);
  if (!conversation || conversation.organizationId !== n.organizationId) return [];
  let messages: Doc<"messages">[] = [];
  if (n.type === "new_message") {
    const ids = (n.data as { messageIds?: unknown } | undefined)?.messageIds;
    for (const id of Array.isArray(ids) ? ids.slice(0, 50) : []) {
      const m = typeof id === "string" ? await ctx.db.get(id as Id<"messages">) : null;
      if (m && m.conversationId === conversation._id) messages.push(m);
    }
  } else if (n.type === "handoff_requested") {
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversation._id))
      .order("desc")
      .take(20);
    const lastInbound = recent.find((m) => m.direction === "inbound");
    if (lastInbound) messages = [lastInbound];
  } else {
    return [];
  }
  return await mediaForMessages(ctx.db, messages, {
    organizationId: n.organizationId,
    discreet,
    mediaInbound: link.prefs.mediaInbound,
    crmUrl: conversationCrmUrl(appUrl(), conversation._id),
  });
}

/**
 * Scheduled by `createNotification` (lib/notify.ts) for members with an active
 * link. F3 (D22): first asks whether the assistant handles the event — auto
 * mode runs `internalAssistantAutoTurn` (which falls back to this card with a
 * preface when it does not act); suggest mode with `suggestOnEvents` runs the
 * read-only suggestion turn, which comes back here with `suggestion`.
 */
export const internalDeliverNotification = internalAction({
  args: {
    notificationId: v.id("notifications"),
    forceCard: v.optional(v.boolean()),
    preface: v.optional(v.string()),
    suggestion: v.optional(v.object({ pendingActionId: v.id("pendingActions"), summary: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!args.forceCard && !args.suggestion) {
      const decision: { route: "card" | "auto" | "suggest"; linkId?: Id<"telegramLinks"> } = await ctx.runQuery(
        internal.telegramCopilot.internalAssistantDecision,
        { notificationId: args.notificationId, now: Date.now() },
      );
      if (decision.route === "auto" && decision.linkId) {
        await ctx.runAction(internal.telegramCopilot.internalAssistantAutoTurn, {
          linkId: decision.linkId,
          notificationId: args.notificationId,
        });
        return null;
      }
      if (decision.route === "suggest" && decision.linkId) {
        await ctx.runAction(internal.telegramCopilot.internalAssistantSuggestTurn, {
          linkId: decision.linkId,
          notificationId: args.notificationId,
        });
        return null;
      }
    }
    const target: CardTarget | null = await ctx.runQuery(internal.telegram.internalGetNotificationDelivery, {
      notificationId: args.notificationId,
      now: Date.now(),
      ...(args.preface ? { preface: args.preface } : {}),
      ...(args.suggestion ? { suggestion: args.suggestion } : {}),
    });
    if (!target) return null;
    const { tipsShown, ...reply } = target;
    await deliverReplies(ctx, [reply], 1);
    if (tipsShown) {
      await ctx.runMutation(internal.telegram.internalSetTipsShown, { linkId: target.record.linkId, tipsShown });
    }
    return null;
  },
});

/** D23: the countdown elapsed — sends unless vetoed (`lib/telegramActions.executeAutoSend`). */
export const internalExecuteAutoSend = internalMutation({
  args: { deliveryId: v.id("telegramDeliveries") },
  returns: v.object({ replies: v.array(replyValidator), edits: v.array(editValidator) }),
  handler: async (ctx, args) => {
    return await executeAutoSend(ctx, { deliveryId: args.deliveryId, now: Date.now(), appBaseUrl: appUrl() });
  },
});

/** Scheduled by `internalRecordDelivery` when a countdown card goes out (D23). */
export const internalAutoSendDraft = internalAction({
  args: { deliveryId: v.id("telegramDeliveries") },
  returns: v.null(),
  handler: async (ctx, args) => {
    let result: { replies: Reply[]; edits: EditOp[] };
    try {
      result = await ctx.runMutation(internal.telegram.internalExecuteAutoSend, { deliveryId: args.deliveryId });
    } catch (e) {
      const data = telegramFailureOf(e);
      if (data?.kind !== TELEGRAM_FAILURE || !data.result) throw e;
      result = data.result;
    }
    await deliverEdits(result.edits);
    await deliverReplies(ctx, result.replies, 1);
    return null;
  },
});

/** D24: first-time tips already shown on this link (helper `appendFirstTimeTip`). */
export const internalSetTipsShown = internalMutation({
  args: { linkId: v.id("telegramLinks"), tipsShown: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (link) await ctx.db.patch(link._id, { tipsShown: args.tipsShown.slice(0, 50) });
    return null;
  },
});

/**
 * End of the 20 s window: ONE `new_message` for the member (B2: bell grouped
 * per conversation, with or without Telegram; Telegram consumes it through the
 * fan-out of `createNotification`, once per window). Old buffers (before B2)
 * carry `linkId` instead of `memberId` and drain the same way.
 */
export const internalFlushRelayBuffer = internalMutation({
  args: { bufferId: v.id("telegramRelayBuffer") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const buffer = await ctx.db.get(args.bufferId);
    if (!buffer) return null;
    await ctx.db.delete(buffer._id);
    let memberId = buffer.memberId;
    if (!memberId && buffer.linkId) memberId = (await ctx.db.get(buffer.linkId))?.teamMemberId;
    const conversation = await ctx.db.get(buffer.conversationId);
    if (!memberId || !conversation) return null;
    const now = Date.now();
    // Re-check: someone may have handed the conversation back to the AI meanwhile.
    const lead = conversation.leadId ? await ctx.db.get(conversation.leadId) : null;
    const recipient = await resolveRelayRecipient(ctx, conversation, lead, now);
    if (!recipient || recipient._id !== memberId) return null;
    const previews: string[] = [];
    for (const id of buffer.messageIds) {
      const m = await ctx.db.get(id);
      if (m && m.conversationId === conversation._id) previews.push(messagePreview(m));
    }
    if (previews.length === 0) return null;
    const more = buffer.droppedCount ?? 0;
    const inWindow = previews.length + more;
    const preview = previews.filter(Boolean).join(" · ");
    await createNotification(ctx, {
      organizationId: buffer.organizationId,
      memberId,
      type: "new_message",
      ...notificationCopy({ type: "new_message", contactName: lead?.title, count: inWindow, preview }),
      conversationId: conversation._id,
      channel: conversation.channel,
      data: { messageIds: buffer.messageIds, ...(more > 0 ? { moreCount: more } : {}) },
      coalesce: {
        key: coalesceKeys.newMessage(conversation._id),
        increment: inWindow,
        telegramOnPatch: true, // one Telegram send per window (the window is the relay's unit)
        render: (count) => notificationCopy({ type: "new_message", contactName: lead?.title, count, preview }),
      },
    });
    return null;
  },
});

/**
 * D20 amended (0.77.2): "🤖 IA → …" goes ONLY for the reply to an
 * instruction/regeneration asked from the bot (`metadata.aiReply`), once, to
 * the member who asked — with the closing line. Focus no longer relays.
 */
export const AI_RELAY_CLOSING = AI_BACK_IN_CHARGE;
export const internalGetAiRelayTargets = internalQuery({
  args: { messageId: v.id("messages"), now: v.number() },
  returns: v.array(cardTargetValidator),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.direction !== "outbound" || message.senderType !== "ai") return [];
    const marker = (message.metadata as { aiReply?: { requestedVia?: string; instructedBy?: string } } | undefined)?.aiReply;
    if (!marker || (marker.requestedVia !== "telegram" && marker.requestedVia !== "telegram_auto") || !marker.instructedBy) return [];
    const conversation = await ctx.db.get(message.conversationId);
    if (!conversation || conversation.kind === "group") return [];
    const memberId = ctx.db.normalizeId("teamMembers", marker.instructedBy);
    if (!memberId) return [];
    const target = await deliverableLink(ctx, memberId, conversation.organizationId, args.now, { conversationContent: true, explicitRequest: true });
    if (!target) return [];
    const link = target.link;
    // Once per CRM message (a retried job must not send it twice).
    const recent = await ctx.db
      .query("telegramDeliveries")
      .withIndex("by_conversation_and_sent", (q) => q.eq("conversationId", conversation._id).gt("sentAt", args.now - FOCUS_TTL_MS))
      .order("desc")
      .take(50);
    if (recent.some((d) => d.crmMessageId === message._id && d.linkId === link._id)) return [];
    const context = await loadCardContext(ctx.db, {
      organizationId: conversation.organizationId,
      now: args.now,
      appBaseUrl: appUrl(),
      conversationId: conversation._id,
    });
    if (!context) return [];
    const card = buildAiRelayCard(context, { text: message.content, at: message.createdAt });
    // F4 (D21): the AI sent a file (flyer, document) → it goes right after the relay card.
    const media = await mediaForMessages(ctx.db, [message], {
      organizationId: conversation.organizationId,
      discreet: context.discreet,
      mediaInbound: link.prefs.mediaInbound,
      crmUrl: conversationCrmUrl(appUrl(), conversation._id),
    });
    return [
      {
        chatId: link.chatId,
        text: `${card.text}\n${AI_RELAY_CLOSING}`,
        keyboard: card.keyboard,
        ...(media.length > 0 ? { media } : {}),
        protectContent: target.org.settings.telegram?.protectContent === true,
        record: {
          organizationId: conversation.organizationId,
          linkId: link._id,
          kind: "relay" as const,
          conversationId: conversation._id,
          crmMessageId: message._id,
        },
      },
    ];
  },
});

/** Scheduled by `lib/telegramRelay.maybeScheduleAiReplyRelay` after the attendant commits a reply. */
export const internalRelayAiReply = internalAction({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const targets: CardTarget[] = await ctx.runQuery(internal.telegram.internalGetAiRelayTargets, {
      messageId: args.messageId,
      now: Date.now(),
    });
    for (const target of targets) await deliverReplies(ctx, [target], 1);
    return null;
  },
});

/** Configurações → Telegram (org): discreet / protect_content / automatic mode. Admin only. */
export const updateOrgTelegramSettings = mutation({
  args: {
    organizationId: v.id("organizations"),
    discreet: v.optional(v.boolean()),
    protectContent: v.optional(v.boolean()),
    allowAutoMode: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Same gate as `orgModules.setOrgModules`.
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    const before = org.settings.telegram ?? {};
    const after = { ...before };
    if (args.discreet !== undefined) after.discreet = args.discreet;
    if (args.protectContent !== undefined) after.protectContent = args.protectContent;
    if (args.allowAutoMode !== undefined) after.allowAutoMode = args.allowAutoMode;
    const now = Date.now();
    await ctx.db.patch(org._id, { settings: { ...org.settings, telegram: after }, updatedAt: now });
    await ctx.db.insert("auditLogs", {
      organizationId: org._id,
      entityType: "organization",
      entityId: org._id,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: { before: { ...before }, after: { ...after } },
      metadata: { event: "telegram.settings_updated" },
      description: "Alterou as opções do Telegram da organização",
      severity: "medium",
      createdAt: now,
    });
    return null;
  },
});

/** Ops health: `telegramUpdates` by status since `since` (bounded). */
export const internalUpdateStats = internalQuery({
  args: { since: v.number() },
  returns: v.object({
    pending: v.number(),
    done: v.number(),
    error: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const LIMIT = 2000;
    const rows = await ctx.db
      .query("telegramUpdates")
      .withIndex("by_received_at", (q) => q.gt("receivedAt", args.since))
      .take(LIMIT + 1);
    const counted = rows.slice(0, LIMIT);
    return {
      pending: counted.filter((r) => r.status === "pending").length,
      done: counted.filter((r) => r.status === "done").length,
      error: counted.filter((r) => r.status === "error").length,
      truncated: rows.length > LIMIT,
    };
  },
});

/**
 * Every live copy of a handoff card becomes the record of how it was resolved
 * (review F1 #2/#5): "✅ Aceito por Ana · hh:mm" or "🤖 Devolvido à IA por Ana",
 * with only Ver tudo / WhatsApp / CRM. Copies of revoked/blocked links or of
 * members who left are skipped; `skipMemberId` = who acted from Telegram (their
 * own card already became the record).
 */
export const internalGetHandoffCardEdits = internalQuery({
  args: { handoffId: v.id("handoffs"), skipMemberId: v.optional(v.id("teamMembers")), now: v.number() },
  returns: v.array(editValidator),
  handler: async (ctx, args) => {
    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff || handoff.status === "pending") return [];
    const resolverId = handoff.status === "accepted" ? handoff.acceptedBy : handoff.resolvedBy;
    const resolver = resolverId ? await ctx.db.get(resolverId) : null;
    const context = await loadCardContext(ctx.db, {
      organizationId: handoff.organizationId,
      now: args.now,
      appBaseUrl: appUrl(),
      handoffId: handoff._id,
      conversationId: handoff.conversationId,
    });
    if (!context) return [];
    const who = escapeHtml(resolver?.name ?? "outro membro");
    const at = formatTime(handoff.resolvedAt ?? args.now, context.timezone);
    const status = handoff.status === "accepted" ? `✅ Aceito por ${who} · ${at}` : `🤖 Devolvido à IA por ${who} · ${at}`;
    const record = buildRecordCard(context, status, ["viewAll", "links"]);
    const copies = await ctx.db
      .query("telegramDeliveries")
      .withIndex("by_handoff", (q) => q.eq("handoffId", handoff._id))
      .take(50);
    const out: EditOp[] = [];
    for (const d of copies) {
      const link = await ctx.db.get(d.linkId);
      if (!link || link.status !== "active" || link.organizationId !== handoff.organizationId) continue;
      if (args.skipMemberId && link.teamMemberId === args.skipMemberId) continue;
      if (!isLinkMemberAlive(link, await ctx.db.get(link.teamMemberId))) continue;
      out.push({ chatId: d.chatId, messageId: d.messageId, text: record.text, keyboard: record.keyboard });
    }
    return out;
  },
});

/** Scheduled by `lib/telegramRelay.maybeScheduleHandoffCardsUpdate` (accept/reject/cancel cores). */
export const internalMarkHandoffCards = internalAction({
  args: { handoffId: v.id("handoffs"), skipMemberId: v.optional(v.id("teamMembers")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const edits: EditOp[] = await ctx.runQuery(internal.telegram.internalGetHandoffCardEdits, {
      handoffId: args.handoffId,
      skipMemberId: args.skipMemberId,
      now: Date.now(),
    });
    await deliverEdits(edits);
    return null;
  },
});
