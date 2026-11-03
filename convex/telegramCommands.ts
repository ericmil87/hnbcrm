/**
 * Copilot on Telegram — F2 commands and lists. Mutation-side helpers called by
 * `telegram.internalRouteUpdate` (commands, keyboard labels and the F2
 * callbacks `cmd:`/`pg:`/`fc:`/`mu:`/`org:`); they return what to send/edit and
 * the processing action delivers it. No registered functions: the routing
 * mutation is the transaction.
 *
 * Authorization: the link of the chat's active org, member alive, module on
 * (`resolveTelegramViewer`, read-only twin of `authorizeTelegramActor`), then
 * RBAC per list. Reads are indexed and bounded. Domain writes never happen
 * here (buttons on rows go through F1's `lib/telegramActions.ts`); this file
 * only touches `telegramChats` / `telegramLinks`.
 */
import { MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { hasPermission, type PermissionCategory } from "./lib/permissions";
import { safeTimezone } from "./lib/promptDateTime";
import { loadCardContext } from "./lib/telegramContext";
import { COPY } from "./lib/telegramCore";
import { escapeHtml } from "./lib/telegramFormat";
import { activeLinksOfChat, resolveTelegramViewer, revokeTelegramLink, type TelegramViewer } from "./lib/telegramLinks";
import { FOCUS_TTL_MS } from "./lib/telegramRelay";
import {
  formatTime,
  formatWhen,
  permissionDeniedText,
  tomorrowAt,
  type CardContext,
  type CardKeyboard,
} from "./lib/telegramNotifications";
import type { EditOp, SendOp } from "./lib/telegramActions";
import {
  CLEAR_FOCUS_KEYBOARD,
  CMD_COPY,
  LIST_CAP,
  MUTE_KEYBOARD,
  PAGE_SIZE,
  buildFocusPicker,
  buildFooter,
  buildHandoffRow,
  buildLeadsPage,
  buildTaskRow,
  countLabel,
  fetchLimit,
  focusSetText,
  mutedText,
  pageFooter,
  type CommandCallback,
  type FocusRowInput,
  type LeadRowInput,
  type PagedCommand,
} from "./lib/telegramCommands";

export type CmdReply = SendOp & { removeKeyboard?: boolean; persistentKeyboard?: boolean };
export type CommandResult = { replies: CmdReply[]; edits: EditOp[] };

export type CommandEnv = {
  chatId: number;
  active: Doc<"telegramLinks">;
  alive: Doc<"telegramLinks">[];
  now: number;
  appBaseUrl: string;
  /** The tapped message (callbacks only). */
  messageId?: number;
};

/** Scan caps for lists that cannot be filtered by an index (documented in the architecture doc). */
const HANDOFF_SCAN_CAP = 200;
const TASK_SCAN_CAP = 100;
const LEAD_SCAN_CAP = 100;
/** /foco reads at most ~20 leads + 2 conversations each (≈ 60 docs). */
const FOCUS_LEAD_SCAN_CAP = 20;

const NONE: CommandResult = { replies: [], edits: [] };

function say(viewer: TelegramViewer, env: CommandEnv, text: string, extra: Partial<CmdReply> = {}): CommandResult {
  return {
    replies: [{ chatId: env.chatId, text, protectContent: viewer.org.settings.telegram?.protectContent === true, ...extra }],
    edits: [],
  };
}

function denied(viewer: TelegramViewer, env: CommandEnv, category: PermissionCategory, level: string): CommandResult | null {
  if (hasPermission(viewer.perms, category, level)) return null;
  return say(viewer, env, permissionDeniedText(viewer.member.role, `${category}:${level}`, viewer.org.name));
}

async function getChat(ctx: MutationCtx, chatId: number) {
  return await ctx.db
    .query("telegramChats")
    .withIndex("by_chat_id", (q) => q.eq("chatId", chatId))
    .first();
}

function fallbackCard(viewer: TelegramViewer, env: CommandEnv): CardContext {
  return {
    orgName: viewer.org.name,
    timezone: safeTimezone(viewer.org.settings.timezone),
    currency: viewer.org.settings.currency || "BRL",
    appBaseUrl: env.appBaseUrl,
    discreet: viewer.org.settings.telegram?.discreet === true,
    now: env.now,
  };
}

async function cardFor(
  ctx: MutationCtx,
  viewer: TelegramViewer,
  env: CommandEnv,
  refs: { conversationId?: Id<"conversations">; handoffId?: Id<"handoffs">; taskId?: Id<"tasks"> },
): Promise<CardContext> {
  const c = await loadCardContext(ctx.db, { organizationId: viewer.org._id, now: env.now, appBaseUrl: env.appBaseUrl, ...refs });
  return c ?? fallbackCard(viewer, env);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** A command (slash or keyboard label) already resolved by `resolveCommandName`. */
export async function runTelegramCommand(ctx: MutationCtx, name: string, env: CommandEnv): Promise<CommandResult> {
  const res = await resolveTelegramViewer(ctx, env.active);
  if (!res.ok) return res.reason === "module_off" ? { replies: [{ chatId: env.chatId, text: COPY.moduleOff }], edits: [] } : NONE;
  return await dispatchCommand(ctx, name, res.viewer, env);
}

async function dispatchCommand(ctx: MutationCtx, name: string, viewer: TelegramViewer, env: CommandEnv): Promise<CommandResult> {
  switch (name) {
    case "hoje":
      // The report belongs to `telegramReports`; the command only asks for it.
      await ctx.scheduler.runAfter(0, internal.telegramReports.internalSendReport, {
        linkId: viewer.link._id,
        kind: "morning",
        trigger: "command",
      });
      return NONE;
    case "repasses":
    case "tarefas":
    case "leads":
    case "foco":
      return await runList(ctx, name, 0, viewer, env);
    case "novo":
      await setFocus(ctx, env.chatId, undefined, env.now);
      return say(viewer, env, CMD_COPY.focusCleared);
    case "pausar":
      return say(viewer, env, CMD_COPY.muteChoose, { keyboard: MUTE_KEYBOARD });
    case "org":
      return await runOrg(ctx, viewer, env);
    case "teclado":
      return await runKeyboardToggle(ctx, viewer, env);
    case "modo":
      return say(viewer, env, CMD_COPY.modoSoon);
    default:
      return say(viewer, env, COPY.help);
  }
}

export async function runTelegramCallback(ctx: MutationCtx, cb: CommandCallback, env: CommandEnv): Promise<CommandResult> {
  const res = await resolveTelegramViewer(ctx, env.active);
  if (!res.ok) return res.reason === "module_off" ? { replies: [{ chatId: env.chatId, text: COPY.moduleOff }], edits: [] } : NONE;
  const viewer = res.viewer;
  switch (cb.kind) {
    case "cmd":
      return await dispatchCommand(ctx, cb.command, viewer, env);
    case "page": {
      const result = await runList(ctx, cb.command, cb.offset, viewer, env);
      // Repasses/tarefas pages end in their own footer message: the tapped one loses its button.
      if (env.messageId !== undefined && (cb.command === "repasses" || cb.command === "tarefas") && result.replies.length > 0) {
        result.edits.push({ chatId: env.chatId, messageId: env.messageId, text: pageFooter(cb.offset - PAGE_SIZE), keyboard: [] });
      }
      return result;
    }
    case "focus":
      return await onFocus(ctx, cb.conversationId, viewer, env);
    case "focusOff":
      await setFocus(ctx, env.chatId, undefined, env.now);
      return say(viewer, env, CMD_COPY.focusCleared);
    case "mute":
      return await onMute(ctx, cb.mode, viewer, env);
    case "org":
      return await onOrg(ctx, cb.linkId, viewer, env);
  }
}

async function runList(ctx: MutationCtx, name: PagedCommand, offset: number, viewer: TelegramViewer, env: CommandEnv) {
  switch (name) {
    case "repasses":
      return await listHandoffs(ctx, offset, viewer, env);
    case "tarefas":
      return await listTasks(ctx, offset, viewer, env);
    case "leads":
      return await listLeads(ctx, offset, viewer, env);
    case "foco":
      return await listFocus(ctx, offset, viewer, env);
  }
}

/** Edit the tapped message when there is one, else send a fresh reply. */
function replaceOrSay(viewer: TelegramViewer, env: CommandEnv, text: string): CommandResult {
  if (env.messageId === undefined) return say(viewer, env, text);
  return { replies: [], edits: [{ chatId: env.chatId, messageId: env.messageId, text, keyboard: [] }] };
}

// ---------------------------------------------------------------------------
// /repasses
// ---------------------------------------------------------------------------

async function pendingHandoffs(ctx: MutationCtx, viewer: TelegramViewer, limit: number): Promise<Doc<"handoffs">[]> {
  const q = ctx.db
    .query("handoffs")
    .withIndex("by_organization_and_status", (x) => x.eq("organizationId", viewer.org._id).eq("status", "pending"))
    .order("asc");
  if (viewer.scope.inbox === "org") return await q.take(limit);
  // Own scope: directed to them or broadcast. No index by recipient: bounded scan.
  const out: Doc<"handoffs">[] = [];
  let scanned = 0;
  for await (const h of q) {
    if (!h.toMemberId || h.toMemberId === viewer.member._id) out.push(h);
    if (out.length >= limit || ++scanned >= HANDOFF_SCAN_CAP) break;
  }
  return out;
}

async function listHandoffs(ctx: MutationCtx, offset: number, viewer: TelegramViewer, env: CommandEnv): Promise<CommandResult> {
  const no = denied(viewer, env, "inbox", "view_own");
  if (no) return no;
  // Page 0 also needs the total for the header (counted up to the cap).
  const all = await pendingHandoffs(ctx, viewer, offset === 0 ? LIST_CAP + 1 : fetchLimit(offset));
  if (all.length === 0) return say(viewer, env, CMD_COPY.noHandoffs);
  const page = all.slice(offset, offset + PAGE_SIZE);
  if (page.length === 0) return NONE;
  const result: CommandResult = { replies: [], edits: [] };
  const protect = viewer.org.settings.telegram?.protectContent === true;
  if (offset === 0) {
    result.replies.push({
      chatId: env.chatId,
      text: `🔁 ${countLabel(all.length, "repasse pendente", "repasses pendentes")} · ${escapeHtml(viewer.org.name)}`,
      protectContent: protect,
    });
  }
  for (const [i, h] of page.entries()) {
    const card = await cardFor(ctx, viewer, env, { handoffId: h._id, conversationId: h.conversationId });
    const row = buildHandoffRow(
      card,
      { handoffId: h._id, conversationId: h.conversationId, reason: h.reason, subjectLabel: h.subjectLabel, createdAt: h.createdAt },
      offset + i + 1,
    );
    result.replies.push({ chatId: env.chatId, text: row.text, keyboard: row.keyboard, protectContent: protect });
  }
  if (all.length > offset + PAGE_SIZE) {
    const footer = buildFooter("repasses", offset, `${env.appBaseUrl}/app/repasses`);
    result.replies.push({ chatId: env.chatId, text: footer.text, keyboard: footer.keyboard, protectContent: protect });
  }
  return result;
}

// ---------------------------------------------------------------------------
// /tarefas
// ---------------------------------------------------------------------------

async function listTasks(ctx: MutationCtx, offset: number, viewer: TelegramViewer, env: CommandEnv): Promise<CommandResult> {
  const no = denied(viewer, env, "tasks", "view_own");
  if (no) return no;
  const mine: Doc<"tasks">[] = [];
  for (const status of ["pending", "in_progress"] as const) {
    mine.push(
      ...(await ctx.db
        .query("tasks")
        .withIndex("by_organization_and_assigned_and_status", (q) =>
          q.eq("organizationId", viewer.org._id).eq("assignedTo", viewer.member._id).eq("status", status),
        )
        .take(TASK_SCAN_CAP)),
    );
  }
  if (mine.length === 0) return say(viewer, env, CMD_COPY.noTasks);
  // Overdue first falls out of "by due date"; no due date goes last.
  mine.sort((a, b) => (a.dueDate ?? Number.MAX_SAFE_INTEGER) - (b.dueDate ?? Number.MAX_SAFE_INTEGER));
  const all = mine.slice(0, LIST_CAP + 1);
  const page = all.slice(offset, offset + PAGE_SIZE);
  if (page.length === 0) return NONE;
  const protect = viewer.org.settings.telegram?.protectContent === true;
  const result: CommandResult = { replies: [], edits: [] };
  if (offset === 0) {
    const overdue = all.filter((t) => t.dueDate !== undefined && t.dueDate < env.now).length;
    const late = overdue > 0 ? ` (${overdue} ${overdue === 1 ? "atrasada" : "atrasadas"})` : "";
    result.replies.push({
      chatId: env.chatId,
      text: `✅ ${countLabel(all.length, "tarefa", "tarefas")}${late} · ${escapeHtml(viewer.org.name)}`,
      protectContent: protect,
    });
  }
  const tz = safeTimezone(viewer.org.settings.timezone);
  for (const [i, t] of page.entries()) {
    const card = await cardFor(ctx, viewer, env, { taskId: t._id });
    const row = buildTaskRow(card, { taskId: t._id, title: t.title, dueDate: t.dueDate }, offset + i + 1, (at) =>
      formatWhen(at, env.now, tz),
    );
    result.replies.push({ chatId: env.chatId, text: row.text, keyboard: row.keyboard, protectContent: protect });
  }
  if (all.length > offset + PAGE_SIZE) {
    const footer = buildFooter("tarefas", offset, `${env.appBaseUrl}/app/tarefas`);
    result.replies.push({ chatId: env.chatId, text: footer.text, keyboard: footer.keyboard, protectContent: protect });
  }
  return result;
}

// ---------------------------------------------------------------------------
// /leads
// ---------------------------------------------------------------------------

async function recentLeads(ctx: MutationCtx, viewer: TelegramViewer, limit: number): Promise<Doc<"leads">[]> {
  if (viewer.scope.leads === "org") {
    return await ctx.db
      .query("leads")
      .withIndex("by_organization_and_archived", (q) => q.eq("organizationId", viewer.org._id).eq("archivedAt", undefined))
      .order("desc")
      .take(limit);
  }
  const out: Doc<"leads">[] = [];
  let scanned = 0;
  const q = ctx.db
    .query("leads")
    .withIndex("by_organization_and_assigned", (x) => x.eq("organizationId", viewer.org._id).eq("assignedTo", viewer.member._id))
    .order("desc");
  for await (const lead of q) {
    if (lead.archivedAt === undefined) out.push(lead);
    if (out.length >= limit || ++scanned >= LEAD_SCAN_CAP) break;
  }
  return out;
}

async function listLeads(ctx: MutationCtx, offset: number, viewer: TelegramViewer, env: CommandEnv): Promise<CommandResult> {
  const no = denied(viewer, env, "leads", "view_own");
  if (no) return no;
  const all = await recentLeads(ctx, viewer, fetchLimit(offset));
  if (all.length === 0) return say(viewer, env, CMD_COPY.noLeads);
  const page = all.slice(offset, offset + PAGE_SIZE);
  if (page.length === 0) return NONE;
  const rows: LeadRowInput[] = [];
  for (const lead of page) {
    const stage = await ctx.db.get(lead.stageId);
    rows.push({
      leadId: lead._id,
      title: lead.title,
      stageName: stage?.name,
      value: lead.value,
      lastActivityAt: lead.lastActivityAt,
    });
  }
  const card = fallbackCard(viewer, env);
  const header = `👥 ${viewer.scope.leads === "org" ? "Leads" : "Seus leads"} · ${escapeHtml(viewer.org.name)}`;
  const built = buildLeadsPage({
    header,
    rows,
    offset,
    discreet: card.discreet,
    currency: card.currency,
    now: env.now,
    appBaseUrl: env.appBaseUrl,
    hasMore: all.length > offset + PAGE_SIZE,
  });
  return say(viewer, env, built.text, { keyboard: built.keyboard });
}

// ---------------------------------------------------------------------------
// /foco, /novo
// ---------------------------------------------------------------------------

async function setFocus(
  ctx: MutationCtx,
  chatId: number,
  focus: { conversationId: Id<"conversations">; leadId?: Id<"leads"> } | undefined,
  now: number,
) {
  const chat = await getChat(ctx, chatId);
  if (!chat) return;
  await ctx.db.patch(chat._id, {
    focus: focus ? { ...focus, setAt: now, source: "command" as const } : undefined,
    updatedAt: now,
  });
}

/** My open conversations: the primary open one of each of my non-archived leads, newest lead first. */
async function myOpenConversations(ctx: MutationCtx, viewer: TelegramViewer, limit: number): Promise<(FocusRowInput & { leadId: Id<"leads"> })[]> {
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_organization_and_assigned", (q) => q.eq("organizationId", viewer.org._id).eq("assignedTo", viewer.member._id))
    .order("desc")
    .take(FOCUS_LEAD_SCAN_CAP);
  const out: (FocusRowInput & { leadId: Id<"leads"> })[] = [];
  for (const lead of leads) {
    if (lead.archivedAt !== undefined) continue;
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_lead", (q) => q.eq("leadId", lead._id))
      .order("desc")
      .take(2);
    const open = convs.find((c) => c.status === "active" && c.archivedAt === undefined && c.kind !== "group");
    if (open) out.push({ conversationId: open._id, leadId: lead._id, title: lead.title, channel: open.channel });
    if (out.length >= limit) break;
  }
  return out;
}

async function listFocus(ctx: MutationCtx, offset: number, viewer: TelegramViewer, env: CommandEnv): Promise<CommandResult> {
  const no = denied(viewer, env, "inbox", "view_own");
  if (no) return no;
  const result: CommandResult = { replies: [], edits: [] };
  const chat = await getChat(ctx, env.chatId);
  if (offset === 0 && chat?.focus && env.now - chat.focus.setAt < FOCUS_TTL_MS) {
    const card = await cardFor(ctx, viewer, env, { conversationId: chat.focus.conversationId });
    if (card.conversation) {
      const current = focusSetText(card).replace(/^🎯 Foco:/, "🎯 Foco atual:").replace(/ Tudo que você me disser.*$/, "");
      result.replies.push(...say(viewer, env, current, { keyboard: CLEAR_FOCUS_KEYBOARD }).replies);
    }
  }
  const all = await myOpenConversations(ctx, viewer, fetchLimit(offset));
  const page = all.slice(offset, offset + PAGE_SIZE);
  if (page.length === 0) {
    if (offset === 0) result.replies.push(...say(viewer, env, CMD_COPY.noConversations).replies);
    return result;
  }
  const picker = buildFocusPicker({
    rows: page,
    offset,
    discreet: viewer.org.settings.telegram?.discreet === true,
    hasMore: all.length > offset + PAGE_SIZE,
    appBaseUrl: env.appBaseUrl,
  });
  result.replies.push(...say(viewer, env, picker.text, { keyboard: picker.keyboard }).replies);
  return result;
}

async function onFocus(ctx: MutationCtx, rawId: string, viewer: TelegramViewer, env: CommandEnv): Promise<CommandResult> {
  const no = denied(viewer, env, "inbox", "view_own");
  if (no) return no;
  const id = ctx.db.normalizeId("conversations", rawId);
  const conversation = id ? await ctx.db.get(id) : null;
  if (!conversation || conversation.organizationId !== viewer.org._id || conversation.kind === "group" || !conversation.leadId) {
    return say(viewer, env, CMD_COPY.focusGone);
  }
  const lead = await ctx.db.get(conversation.leadId);
  if (!lead || lead.organizationId !== viewer.org._id || (viewer.scope.inbox === "own" && lead.assignedTo !== viewer.member._id)) {
    return say(viewer, env, CMD_COPY.focusGone);
  }
  await setFocus(ctx, env.chatId, { conversationId: conversation._id, leadId: lead._id }, env.now);
  const card = await cardFor(ctx, viewer, env, { conversationId: conversation._id });
  return say(viewer, env, focusSetText(card));
}

// ---------------------------------------------------------------------------
// /pausar
// ---------------------------------------------------------------------------

async function onMute(ctx: MutationCtx, mode: "1h" | "tomorrow" | "off", viewer: TelegramViewer, env: CommandEnv): Promise<CommandResult> {
  const tz = safeTimezone(viewer.org.settings.timezone);
  const until = mode === "1h" ? env.now + 60 * 60 * 1000 : mode === "tomorrow" ? tomorrowAt(env.now, tz, 8) : undefined;
  // A person mutes their phone, not an org: every active link of this chat.
  for (const link of await activeLinksOfChat(ctx, env.chatId)) {
    await ctx.db.patch(link._id, { mutedUntil: until });
  }
  if (until === undefined) return replaceOrSay(viewer, env, CMD_COPY.unmuted);
  const when = formatWhen(until, env.now, tz);
  const label = when.includes("/") ? `amanhã ${formatTime(until, tz)}` : when;
  return replaceOrSay(viewer, env, mutedText(label));
}

// ---------------------------------------------------------------------------
// /org
// ---------------------------------------------------------------------------

async function runOrg(ctx: MutationCtx, viewer: TelegramViewer, env: CommandEnv): Promise<CommandResult> {
  const others = env.alive.filter((l) => l._id !== env.active._id);
  if (others.length === 0) return say(viewer, env, CMD_COPY.singleOrg(viewer.org.name));
  const keyboard: CardKeyboard = [];
  for (const link of others) {
    const org = await ctx.db.get(link.organizationId);
    if (org) keyboard.push([{ text: org.name.slice(0, 60), callback_data: `org:${link._id}` }]);
  }
  if (keyboard.length === 0) return say(viewer, env, CMD_COPY.singleOrg(viewer.org.name));
  return say(viewer, env, CMD_COPY.orgChoose(viewer.org.name), { keyboard });
}

async function onOrg(ctx: MutationCtx, rawId: string, viewer: TelegramViewer, env: CommandEnv): Promise<CommandResult> {
  const id = ctx.db.normalizeId("telegramLinks", rawId);
  const link = id ? (await activeLinksOfChat(ctx, env.chatId)).find((l) => l._id === id) : undefined;
  if (!link) return replaceOrSay(viewer, env, CMD_COPY.orgGone);
  const member = await ctx.db.get(link.teamMemberId);
  const target = await resolveTelegramViewer(ctx, link);
  if (!member || !target.ok) {
    if (target.ok === false && target.reason === "member_dead") {
      // Dead member: cut it through the single door (the cleanup says goodbye).
      await revokeTelegramLink(ctx, link, "member_removed", { now: env.now });
    }
    return replaceOrSay(viewer, env, CMD_COPY.orgGone);
  }
  const chat = await getChat(ctx, env.chatId);
  if (chat) {
    await ctx.db.patch(chat._id, {
      activeOrganizationId: link.organizationId,
      activeTeamMemberId: link.teamMemberId,
      // Focus belongs to the org it was set in.
      focus: undefined,
      updatedAt: env.now,
    });
  }
  return replaceOrSay(viewer, env, CMD_COPY.orgSwitched(target.viewer.org.name));
}

// ---------------------------------------------------------------------------
// /teclado
// ---------------------------------------------------------------------------

async function runKeyboardToggle(ctx: MutationCtx, viewer: TelegramViewer, env: CommandEnv): Promise<CommandResult> {
  const chat = await getChat(ctx, env.chatId);
  const showing = chat?.keyboardShown === true;
  if (chat) await ctx.db.patch(chat._id, { keyboardShown: !showing, updatedAt: env.now });
  return showing
    ? say(viewer, env, CMD_COPY.keyboardOff, { removeKeyboard: true })
    : say(viewer, env, CMD_COPY.keyboardOn, { persistentKeyboard: true });
}
