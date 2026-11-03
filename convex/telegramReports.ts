/**
 * Executive reports on Telegram (F2, §3.7/§4.7, D11).
 *
 * - `internalReportsTick` (cron hourly at :05, `cronsDisabled()` first): pages
 *   `telegramLinks.by_status = active` (100 per page, re-schedules itself by
 *   cursor), loads each org once, computes the org-local hour/date with
 *   `safeTimezone`, and for every link whose `morningHour`/`eveningHour` is the
 *   current local hour (weekdays only unless `reports.weekends`) and whose
 *   stamp (`lastMorningReportDate`/`lastEveningReportDate`, "AAAA-MM-DD" local)
 *   differs: STAMPS FIRST, in the same transaction, then schedules the send with
 *   300 ms spacing. A second tick in the same hour finds the stamp: no double send.
 * - `internalSendReport({linkId, kind, trigger})` (action): gate (link active,
 *   member alive, module on, `inbox:view_own`; cron also needs `reports.enabled`
 *   and not muted), data, format (`lib/executiveReport.ts`), send, record
 *   `telegramDeliveries {kind:"report"}`. `/hoje` calls it with
 *   `trigger:"command"`, which never stamps.
 * - `internalBuildReportData` (ONE query): every section bounded by an index
 *   range + `.take`, `capped` → "50+".
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { appUrl } from "./lib/appUrl";
import { cronsDisabled } from "./lib/cronGuard";
import { modulesOf } from "./lib/orgModules";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./lib/permissions";
import { safeTimezone } from "./lib/promptDateTime";
import { monthKeyUtc, resolveSpendCap } from "./lib/aiSpend";
import { getLeadRef } from "./lib/leadRef";
import { isLinkMemberAlive, scopeOf as viewerScopeOf } from "./lib/telegramLinks";
import { sendMessageChunks } from "./lib/telegramApi";
import { splitMessage } from "./lib/telegramFormat";
import { MAX_SEND_ATTEMPTS } from "./lib/telegramCore";
import type { CardKeyboard } from "./lib/telegramNotifications";
import {
  REPORT_CAP,
  atLocal,
  formatEveningReport,
  formatMorningReport,
  isWeekend,
  localDateKey,
  localParts,
  type EveningData,
  type MorningData,
  type ReportData,
  type ReportTask,
} from "./lib/executiveReport";

const kindValidator = v.union(v.literal("morning"), v.literal("evening"));
const triggerValidator = v.union(v.literal("cron"), v.literal("command"));

/** Page of the cron tick (links). */
export const REPORTS_TICK_PAGE_SIZE = 100;
/** Spacing between scheduled sends in one tick page (≤ ~3 msg/s, far below the 30/s bot limit). */
export const REPORTS_JITTER_MS = 300;
/** Raw rows read per section before in-memory scope filters (documented caps). */
const SCAN = 200;
/** `agentRuns` read for today's AI cost (§3.7). */
const AI_RUNS_SCAN = 500;

// ---------------------------------------------------------------------------
// Validators of the report data
// ---------------------------------------------------------------------------

const counted = { count: v.number(), capped: v.boolean() };
const handoffItem = v.object({
  id: v.string(),
  leadName: v.string(),
  reason: v.optional(v.string()),
  createdAt: v.number(),
});
const taskItem = v.object({
  id: v.string(),
  title: v.string(),
  dueDate: v.optional(v.number()),
  leadName: v.optional(v.string()),
});

const morningValidator = v.object({
  handoffs: v.object({ ...counted, oldestAt: v.optional(v.number()), items: v.array(handoffItem) }),
  followUps: v.union(
    v.null(),
    v.object({ ...counted, items: v.array(v.object({ leadName: v.string(), dueAt: v.number() })) }),
  ),
  tasksToday: v.object({ ...counted, items: v.array(taskItem) }),
  tasksOverdue: v.object({ ...counted, items: v.array(taskItem) }),
  newLeads: v.object({
    ...counted,
    mine: v.number(),
    sinceLabel: v.string(),
    items: v.array(v.object({ title: v.string(), source: v.optional(v.string()) })),
  }),
  unread: v.object(counted),
  channels: v.object({ total: v.number(), down: v.array(v.string()) }),
});

const eveningValidator = v.object({
  newLeads: v.object(counted),
  won: v.object({ ...counted, value: v.number() }),
  lost: v.object(counted),
  tasksCompleted: v.object(counted),
  tasksPending: v.object(counted),
  ownerlessHandoffs: v.object({ ...counted, items: v.array(handoffItem) }),
  ai: v.union(
    v.null(),
    v.object({ runsToday: v.object(counted), costTodayUsd: v.number(), costMonthUsd: v.number() }),
  ),
  tomorrowTasks: v.object({ ...counted, items: v.array(taskItem) }),
});

const reportDataValidator = v.object({
  scope: v.union(v.literal("org"), v.literal("own")),
  canReply: v.boolean(),
  morning: v.optional(morningValidator),
  evening: v.optional(eveningValidator),
});

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * A section count. `rawCapped` = the index read hit its `.take` limit, so an
 * in-memory filter over that page may undercount: the section renders "N+"
 * (review F2 #3), never a bare N that could be wrong.
 */
const count = <T>(rows: T[], rawCapped = false): { count: number; capped: boolean } => ({
  count: Math.min(rows.length, REPORT_CAP),
  capped: rows.length > REPORT_CAP || rawCapped,
});

type Db = QueryCtx["db"];
type Page<T> = { rows: T[]; capped: boolean };

async function take<T>(q: { take: (n: number) => Promise<T[]> }, n = SCAN): Promise<Page<T>> {
  const rows = await q.take(n + 1);
  return { rows: rows.slice(0, n), capped: rows.length > n };
}

async function leadTitle(db: Db, orgId: Id<"organizations">, leadId: Id<"leads"> | undefined): Promise<string | undefined> {
  const lead = await getLeadRef(db, leadId);
  return lead && lead.organizationId === orgId ? lead.title : undefined;
}

async function taskItems(db: Db, orgId: Id<"organizations">, tasks: Doc<"tasks">[], max: number): Promise<ReportTask[]> {
  const out: ReportTask[] = [];
  for (const t of tasks.slice(0, max)) {
    out.push({
      id: t._id,
      title: t.title,
      ...(t.dueDate !== undefined ? { dueDate: t.dueDate } : {}),
      ...(t.leadId ? { leadName: await leadTitle(db, orgId, t.leadId) } : {}),
    });
  }
  return out;
}

const OPEN_TASK_STATUSES = ["pending", "in_progress"] as const;

/**
 * Open tasks due in [from, to): the status + due-date index range (exact for
 * the window), optionally filtered to the member's primary `assignedTo`.
 * Secondary assignees (`assigneeIds`) are not covered: no index, and the app's
 * own lists filter the same way.
 */
async function openTasksDue(
  db: Db,
  orgId: Id<"organizations">,
  from: number,
  to: number,
  memberId?: Id<"teamMembers">,
): Promise<Page<Doc<"tasks">>> {
  const rows: Doc<"tasks">[] = [];
  let capped = false;
  for (const status of OPEN_TASK_STATUSES) {
    const page = await take(
      db
        .query("tasks")
        .withIndex("by_organization_and_status_and_due_date", (q) =>
          q.eq("organizationId", orgId).eq("status", status).gte("dueDate", from).lt("dueDate", to),
        ),
    );
    rows.push(...(memberId ? page.rows.filter((t) => t.assignedTo === memberId) : page.rows));
    capped = capped || page.capped;
  }
  rows.sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0));
  return { rows, capped };
}

/** Overdue tasks of the member (assignee index; due before `before`), bounded. */
async function overdueTasksOf(db: Db, orgId: Id<"organizations">, memberId: Id<"teamMembers">, before: number) {
  const rows: Doc<"tasks">[] = [];
  let capped = false;
  for (const status of OPEN_TASK_STATUSES) {
    const page = await take(
      db
        .query("tasks")
        .withIndex("by_organization_and_assigned_and_status", (q) =>
          q.eq("organizationId", orgId).eq("assignedTo", memberId).eq("status", status),
        ),
    );
    rows.push(...page.rows.filter((t) => t.dueDate !== undefined && t.dueDate < before));
    capped = capped || page.capped;
  }
  rows.sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0));
  return { rows, capped };
}

async function pendingHandoffs(db: Db, orgId: Id<"organizations">): Promise<Page<Doc<"handoffs">>> {
  // Ascending by creation: the first row is the oldest.
  return await take(
    db.query("handoffs").withIndex("by_organization_and_status", (q) => q.eq("organizationId", orgId).eq("status", "pending")),
  );
}

async function handoffItems(db: Db, orgId: Id<"organizations">, rows: Doc<"handoffs">[], max: number) {
  const out: { id: string; leadName: string; reason?: string; createdAt: number }[] = [];
  for (const h of rows.slice(0, max)) {
    out.push({
      id: h._id,
      leadName: (await leadTitle(db, orgId, h.leadId)) ?? h.subjectLabel ?? "Contato",
      ...(h.reason ? { reason: h.reason } : {}),
      createdAt: h.createdAt,
    });
  }
  return out;
}

const DOWN_BRIDGE_STATES = new Set(["disconnected", "banned", "logged_out", "qr"]);

/**
 * Start of the "new leads" window of the morning report: the previous REPORT
 * day at 18:00 local. With weekends off, Monday looks back to Friday 18:00 so
 * leads of Friday night/Saturday/Sunday are not missed (review F2 #5).
 */
export function morningLeadsSince(now: number, tz: string, weekends: boolean): { since: number; label: string } {
  const monday = localParts(now, tz).weekday === 1;
  if (!weekends && monday) return { since: atLocal(now, tz, -3, 18), label: "sexta 18h" };
  return { since: atLocal(now, tz, -1, 18), label: "ontem 18h" };
}

type Scope = { scope: "org" | "own"; inboxScope: "org" | "own"; seesAi: boolean };

async function buildMorning(
  db: Db,
  org: Doc<"organizations">,
  member: Doc<"teamMembers">,
  { scope, inboxScope }: Scope,
  now: number,
  tz: string,
  weekends: boolean,
): Promise<MorningData> {
  const orgId = org._id;
  const dayStart = atLocal(now, tz, 0, 0);
  const dayEnd = atLocal(now, tz, 1, 0);

  // Repasses: the org's pending ones; an agent sees broadcast + addressed to them.
  const pendingPage = await pendingHandoffs(db, orgId);
  const pending = pendingPage.rows.filter(
    (h) => inboxScope === "org" || h.toMemberId === undefined || h.toMemberId === member._id,
  );

  // Follow-ups da IA hoje (org scope). `by_status_and_due` is deployment-wide
  // (no org), so: org + status index, due-day filter, raw cap propagated.
  let followUps: MorningData["followUps"] = null;
  if (scope === "org") {
    const due: Doc<"aiFollowUps">[] = [];
    let capped = false;
    for (const status of ["scheduled", "queued"] as const) {
      const page = await take(
        db.query("aiFollowUps").withIndex("by_organization_and_status", (q) => q.eq("organizationId", orgId).eq("status", status)),
      );
      due.push(...page.rows.filter((f) => f.dueAt >= dayStart && f.dueAt < dayEnd));
      capped = capped || page.capped;
    }
    due.sort((a, b) => a.dueAt - b.dueAt);
    const items: { leadName: string; dueAt: number }[] = [];
    for (const f of due.slice(0, 3)) {
      items.push({ leadName: (await leadTitle(db, orgId, f.leadId)) ?? "Contato", dueAt: f.dueAt });
    }
    followUps = { ...count(due, capped), items };
  }

  // Minhas tarefas (always personal, §4.7 "Suas tarefas"): today by the
  // due-date range (exact window), overdue by the assignee index.
  const today = await openTasksDue(db, orgId, dayStart, dayEnd, member._id);
  const overdue = await overdueTasksOf(db, orgId, member._id, dayStart);

  // Leads novos desde o último dia de relatório às 18h (local).
  const { since, label } = morningLeadsSince(now, tz, weekends);
  const createdPage = await take(
    db.query("leads").withIndex("by_organization_and_created", (q) => q.eq("organizationId", orgId).gt("createdAt", since)),
  );
  const created = createdPage.rows.filter((l) => l.archivedAt === undefined);
  const mineLeads = created.filter((l) => l.assignedTo === member._id);
  const leadsInScope = scope === "org" ? created : mineLeads;
  const leadItems = [...mineLeads, ...created.filter((l) => l.assignedTo !== member._id)]
    .filter((l) => scope === "org" || l.assignedTo === member._id)
    .slice(0, 3)
    .map((l) => ({ title: l.title }));

  // Conversas não lidas (ativas). Agent: own subset of the org page (raw cap → "N+").
  const unreadPage = await take(
    db
      .query("conversations")
      .withIndex("by_organization_and_archived_and_unread", (q) =>
        q.eq("organizationId", orgId).eq("archivedAt", undefined).gt("unreadCount", 0),
      ),
  );
  const unreadRows = unreadPage.rows.filter((c) => inboxScope === "org" || c.assignedTo === member._id);

  // Canais fora do ar.
  const configs = (
    await db
      .query("channelConfigs")
      .withIndex("by_organization", (q) => q.eq("organizationId", orgId))
      .take(50)
  ).filter((c) => c.status !== "disabled");
  const down = configs
    .filter((c) => c.status === "error" || (c.bridgeSessionState !== undefined && DOWN_BRIDGE_STATES.has(c.bridgeSessionState)))
    .map((c) => c.displayName ?? c.channel);

  return {
    handoffs: {
      ...count(pending, pendingPage.capped),
      ...(pending[0] ? { oldestAt: pending[0].createdAt } : {}),
      items: await handoffItems(db, orgId, pending, 3),
    },
    followUps,
    tasksToday: { ...count(today.rows, today.capped), items: await taskItems(db, orgId, today.rows, 5) },
    tasksOverdue: { ...count(overdue.rows, overdue.capped), items: await taskItems(db, orgId, overdue.rows, 3) },
    newLeads: {
      ...count(leadsInScope, createdPage.capped),
      mine: Math.min(mineLeads.length, REPORT_CAP),
      sinceLabel: label,
      items: leadItems,
    },
    unread: count(unreadRows, unreadPage.capped),
    channels: { total: configs.length, down },
  };
}

async function buildEvening(
  db: Db,
  org: Doc<"organizations">,
  member: Doc<"teamMembers">,
  { scope, seesAi }: Scope,
  now: number,
  tz: string,
): Promise<EveningData> {
  const orgId = org._id;
  const dayStart = atLocal(now, tz, 0, 0);
  const dayEnd = atLocal(now, tz, 1, 0);
  const tomorrowEnd = atLocal(now, tz, 2, 0);
  const own = <T extends { assignedTo?: Id<"teamMembers"> }>(rows: T[]) =>
    scope === "org" ? rows : rows.filter((r) => r.assignedTo === member._id);

  const createdPage = await take(
    db.query("leads").withIndex("by_organization_and_created", (q) => q.eq("organizationId", orgId).gte("createdAt", dayStart)),
  );
  const created = own(createdPage.rows.filter((l) => l.archivedAt === undefined));
  const closedPage = await take(
    db.query("leads").withIndex("by_organization_and_closed", (q) => q.eq("organizationId", orgId).gte("closedAt", dayStart)),
  );
  const closed = own(closedPage.rows);
  const won = closed.filter((l) => l.closedType === "won");
  const lost = closed.filter((l) => l.closedType === "lost");

  const completedPage = await take(
    db
      .query("tasks")
      .withIndex("by_organization_and_completed_at", (q) => q.eq("organizationId", orgId).gte("completedAt", dayStart)),
  );
  const completed = own(completedPage.rows.filter((t) => t.status === "completed"));

  // Due today and still open: org = the whole range; own = the same range, filtered.
  const pendingToday = await openTasksDue(db, orgId, dayStart, dayEnd, scope === "org" ? undefined : member._id);

  const pendingPage = await pendingHandoffs(db, orgId);
  const ownerless = pendingPage.rows.filter((h) => h.toMemberId === undefined);

  let ai: EveningData["ai"] = null;
  if (seesAi) {
    const runs = await db
      .query("agentRuns")
      .withIndex("by_organization_and_started", (q) => q.eq("organizationId", orgId).gte("startedAt", dayStart))
      .take(AI_RUNS_SCAN + 1);
    const counted = runs.slice(0, AI_RUNS_SCAN);
    const month = await db
      .query("aiUsageMonthly")
      .withIndex("by_organization_and_month", (q) => q.eq("organizationId", orgId).eq("month", monthKeyUtc(now)))
      .first();
    ai = {
      runsToday: { count: counted.length, capped: runs.length > AI_RUNS_SCAN },
      costTodayUsd: counted.reduce((sum, r) => sum + (r.costUsdEstimate ?? 0), 0),
      costMonthUsd: (month?.costUsdMicros ?? 0) / 1_000_000,
    };
  }

  // Tomorrow (personal): due-date range of tomorrow, one read.
  const tomorrow = await openTasksDue(db, orgId, dayEnd, tomorrowEnd, member._id);

  return {
    newLeads: count(created, createdPage.capped),
    won: { ...count(won, closedPage.capped), value: won.reduce((sum, l) => sum + (l.value ?? 0), 0) },
    lost: count(lost, closedPage.capped),
    tasksCompleted: count(completed, completedPage.capped),
    tasksPending: count(pendingToday.rows, pendingToday.capped),
    ownerlessHandoffs: { ...count(ownerless, pendingPage.capped), items: await handoffItems(db, orgId, ownerless, 3) },
    ai,
    tomorrowTasks: { ...count(tomorrow.rows, tomorrow.capped), items: await taskItems(db, orgId, tomorrow.rows, 4) },
  };
}

/**
 * Scope from RESOLVED permissions (custom permissions honored), the same
 * helper as the F2 command lists (`lib/telegramLinks.scopeOf`): leads/tasks
 * lists follow `leads`, conversations/handoffs follow `inbox`. The AI cost
 * block needs `settings:view`, the gate of the app's AI usage (review F2 #4).
 */
function reportScopeOf(member: Doc<"teamMembers">): Scope & { perms: Permissions } {
  const perms = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
  const s = viewerScopeOf(perms);
  return { scope: s.leads, inboxScope: s.inbox, seesAi: hasPermission(perms, "settings", "view"), perms };
}

/**
 * The report data (ONE query, `now` passed in). Caps: 200 raw rows per index
 * read (a full read renders "N+"), counts shown up to 50 ("50+"), 500
 * `agentRuns` for today's AI cost. Names only (no e-mail/phone).
 */
export const internalBuildReportData = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"),
    kind: kindValidator,
    now: v.number(),
    /** The link's `reports.weekends` (Monday window). Absent = false. */
    weekends: v.optional(v.boolean()),
  },
  returns: v.union(v.null(), reportDataValidator),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    const member = await ctx.db.get(args.memberId);
    if (!org || !member || member.organizationId !== org._id) return null;
    const tz = safeTimezone(org.settings.timezone);
    const sc = reportScopeOf(member);
    const base = { scope: sc.scope, canReply: hasPermission(sc.perms, "inbox", "reply") };
    if (args.kind === "morning") {
      return { ...base, morning: await buildMorning(ctx.db, org, member, sc, args.now, tz, args.weekends === true) };
    }
    return { ...base, evening: await buildEvening(ctx.db, org, member, sc, args.now, tz) };
  },
});

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

const targetValidator = v.object({
  chatId: v.number(),
  organizationId: v.id("organizations"),
  memberId: v.id("teamMembers"),
  memberName: v.string(),
  orgName: v.string(),
  timezone: v.string(),
  currency: v.string(),
  discreet: v.boolean(),
  protectContent: v.boolean(),
  appBaseUrl: v.string(),
  usdBrlRate: v.number(),
  weekends: v.boolean(),
});

/**
 * Who receives the report, or null. Same gate as F1 `deliverableLink`: active
 * link, live member, module on, `inbox:view_own` (reports carry conversation
 * data). Cron sends also need `reports.enabled` and no mute; `/hoje` does not.
 */
export const internalGetReportTarget = internalQuery({
  args: { linkId: v.id("telegramLinks"), now: v.number(), trigger: triggerValidator },
  returns: v.union(v.null(), targetValidator),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link || link.status !== "active") return null;
    if (args.trigger === "cron") {
      if (!link.reports.enabled) return null;
      if (link.mutedUntil !== undefined && link.mutedUntil > args.now) return null;
    }
    const member = await ctx.db.get(link.teamMemberId);
    if (!member || !isLinkMemberAlive(link, member)) return null;
    const perms = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
    if (!hasPermission(perms, "inbox", "view_own")) return null;
    const org = await ctx.db.get(link.organizationId);
    if (!org || !modulesOf(org).telegram) return null;
    return {
      chatId: link.chatId,
      organizationId: org._id,
      memberId: member._id,
      memberName: member.name,
      orgName: org.name,
      timezone: safeTimezone(org.settings.timezone),
      currency: org.settings.currency || "BRL",
      discreet: org.settings.telegram?.discreet === true,
      protectContent: org.settings.telegram?.protectContent === true,
      appBaseUrl: appUrl(),
      usdBrlRate: resolveSpendCap(org.settings.aiConfig?.spendCap).usdBrlRate,
      weekends: link.reports.weekends === true,
    };
  },
});

export const internalRecordReport = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    linkId: v.id("telegramLinks"),
    chatId: v.number(),
    messageId: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("telegramDeliveries", {
      organizationId: args.organizationId,
      linkId: args.linkId,
      chatId: args.chatId,
      messageId: args.messageId,
      kind: "report",
      sentAt: Date.now(),
    });
    return null;
  },
});

const keyboardValidator = v.array(
  v.array(
    v.union(
      v.object({ text: v.string(), url: v.string() }),
      v.object({ text: v.string(), callback_data: v.string() }),
    ),
  ),
);
const chunksValidator = v.object({
  organizationId: v.id("organizations"),
  linkId: v.id("telegramLinks"),
  chatId: v.number(),
  chunks: v.array(v.string()),
  keyboard: keyboardValidator,
  protectContent: v.boolean(),
});
type Chunks = {
  organizationId: Id<"organizations">;
  linkId: Id<"telegramLinks">;
  chatId: number;
  chunks: string[];
  keyboard: CardKeyboard;
  protectContent: boolean;
};

async function deliverChunks(ctx: ActionCtx, r: Chunks, attempt: number): Promise<void> {
  if (r.chunks.length === 0) return;
  const res = await sendMessageChunks({
    chatId: r.chatId,
    chunks: r.chunks,
    replyMarkup: { inline_keyboard: r.keyboard },
    protectContent: r.protectContent,
  });
  if (res.ok) {
    const last = res.result[res.result.length - 1];
    if (last) {
      await ctx.runMutation(internal.telegramReports.internalRecordReport, {
        organizationId: r.organizationId,
        linkId: r.linkId,
        chatId: r.chatId,
        messageId: last.message_id,
      });
    }
    return;
  }
  if (res.kind === "blocked") {
    await ctx.runMutation(internal.telegram.internalMarkChatBlocked, { chatId: r.chatId });
    return;
  }
  if (res.kind === "rate_limited" && attempt < MAX_SEND_ATTEMPTS) {
    const delayMs = Math.min(Math.max(res.retryAfterSeconds ?? 1, 1), 300) * 1000;
    await ctx.scheduler.runAfter(delayMs, internal.telegramReports.internalDeliverReportChunks, {
      report: { ...r, chunks: r.chunks.slice(res.sentCount) },
      attempt: attempt + 1,
    });
  }
}

/** 429 resume: only the chunks not yet delivered. */
export const internalDeliverReportChunks = internalAction({
  args: { report: chunksValidator, attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deliverChunks(ctx, args.report, args.attempt);
    return null;
  },
});

/** `/hoje` at most once a minute per link (review F2 #2). */
export const COMMAND_REPORT_MIN_INTERVAL_MS = 60_000;
export const COMMAND_REPORT_TOO_SOON = "⏳ Acabei de mandar o relatório; peça de novo em 1 min.";

/**
 * Claims a command-triggered report: false when the last one went out less
 * than a minute ago. Stamped BEFORE sending so two quick taps never both send.
 */
export const internalClaimCommandReport = internalMutation({
  args: { linkId: v.id("telegramLinks"), now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) return false;
    if (link.lastCommandReportAt !== undefined && args.now - link.lastCommandReportAt < COMMAND_REPORT_MIN_INTERVAL_MS) {
      return false;
    }
    await ctx.db.patch(link._id, { lastCommandReportAt: args.now });
    return true;
  },
});

/**
 * Sends one report. Contract with `/hoje` (commands): `trigger:"command"`
 * sends now, regardless of `reports.enabled`/mute, and NEVER stamps
 * `lastMorningReportDate` (only the tick stamps, before scheduling).
 */
export const internalSendReport = internalAction({
  args: { linkId: v.id("telegramLinks"), kind: kindValidator, trigger: triggerValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const target: {
      chatId: number;
      organizationId: Id<"organizations">;
      memberId: Id<"teamMembers">;
      memberName: string;
      orgName: string;
      timezone: string;
      currency: string;
      discreet: boolean;
      protectContent: boolean;
      appBaseUrl: string;
      usdBrlRate: number;
      weekends: boolean;
    } | null = await ctx.runQuery(internal.telegramReports.internalGetReportTarget, {
      linkId: args.linkId,
      now,
      trigger: args.trigger,
    });
    if (!target) return null;
    if (args.trigger === "command") {
      const claimed: boolean = await ctx.runMutation(internal.telegramReports.internalClaimCommandReport, {
        linkId: args.linkId,
        now,
      });
      if (!claimed) {
        await deliverChunks(
          ctx,
          {
            organizationId: target.organizationId,
            linkId: args.linkId,
            chatId: target.chatId,
            chunks: [COMMAND_REPORT_TOO_SOON],
            keyboard: [],
            protectContent: target.protectContent,
          },
          1,
        );
        return null;
      }
    }
    const data: ReportData | null = await ctx.runQuery(internal.telegramReports.internalBuildReportData, {
      organizationId: target.organizationId,
      memberId: target.memberId,
      kind: args.kind,
      now,
      weekends: target.weekends,
    });
    if (!data) return null;
    const options = { ...target, now };
    const out = args.kind === "morning" ? formatMorningReport(data, options) : formatEveningReport(data, options);
    await deliverChunks(
      ctx,
      {
        organizationId: target.organizationId,
        linkId: args.linkId,
        chatId: target.chatId,
        chunks: splitMessage(out.text),
        keyboard: out.keyboard,
        protectContent: target.protectContent,
      },
      1,
    );
    return null;
  },
});

// ---------------------------------------------------------------------------
// Cron tick
// ---------------------------------------------------------------------------

/**
 * Hourly tick (crons.ts, minute 5). Stamp-then-schedule in ONE transaction:
 * idempotent under a double run in the same hour and after a restart.
 * `now` is fixed on the first page and propagated so all pages agree on the hour.
 */
export const internalReportsTick = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), now: v.optional(v.number()) },
  returns: v.object({
    skipped: v.optional(v.literal("crons_disabled")),
    scanned: v.number(),
    scheduled: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (cronsDisabled()) return { skipped: "crons_disabled" as const, scanned: 0, scheduled: 0, isDone: true };
    const now = args.now ?? Date.now();
    const page = await ctx.db
      .query("telegramLinks")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .paginate({ numItems: REPORTS_TICK_PAGE_SIZE, cursor: args.cursor ?? null });

    const orgs = new Map<Id<"organizations">, Doc<"organizations"> | null>();
    let scheduled = 0;
    for (const link of page.page) {
      if (!link.reports.enabled) continue;
      if (!orgs.has(link.organizationId)) orgs.set(link.organizationId, await ctx.db.get(link.organizationId));
      const org = orgs.get(link.organizationId);
      if (!org || !modulesOf(org).telegram) continue;
      const tz = safeTimezone(org.settings.timezone);
      if (!link.reports.weekends && isWeekend(now, tz)) continue;
      const hour = localParts(now, tz).hour;
      const dateKey = localDateKey(now, tz);
      for (const kind of ["morning", "evening"] as const) {
        const due = kind === "morning" ? link.reports.morningHour : link.reports.eveningHour;
        if (hour !== due) continue;
        const stamp = kind === "morning" ? link.lastMorningReportDate : link.lastEveningReportDate;
        if (stamp === dateKey) continue;
        await ctx.db.patch(
          link._id,
          kind === "morning" ? { lastMorningReportDate: dateKey } : { lastEveningReportDate: dateKey },
        );
        await ctx.scheduler.runAfter(scheduled * REPORTS_JITTER_MS, internal.telegramReports.internalSendReport, {
          linkId: link._id,
          kind,
          trigger: "cron",
        });
        scheduled++;
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.telegramReports.internalReportsTick, {
        cursor: page.continueCursor,
        now,
      });
    }
    return { scanned: page.page.length, scheduled, isDone: page.isDone };
  },
});
