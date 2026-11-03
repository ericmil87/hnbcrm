/**
 * Copilot tools for customer service (D18, Telegram F3) — available in the web
 * Copilot AND on Telegram. Called from `copilot.ts`'s read/write executors
 * AFTER `assertAgentCan` (RBAC of the human the Copilot acts as).
 *
 * Addressing: the model never passes `conversationId`/`taskId`
 * (`INJECTED_PARAM_NAMES`). A conversation is the lead's latest 1:1
 * conversation (`leadId` from a result the model saw) or the Telegram focus
 * (`scope.focusConversationId`, injected by the server). Tasks are addressed
 * by their NUMBER in `listMyOpenTasks` (same ordering re-resolved here).
 *
 * Two-phase (pendingActions): `sendCustomerReply` ALWAYS; `instructAttendant`
 * when the attendant is in `autopilot` (its reply goes straight to the
 * customer, P8). Everything else runs the domain core directly, `via:"copilot"`.
 */
import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { acceptHandoffCore, rejectHandoffWithInstructionCore } from "../handoffs";
import { requestAiDraftCore, returnToAiCore } from "../attendant";
import { internalSendMessageCore } from "../conversations";
import { applyTaskCompletion, snoozeTaskCore } from "./taskOps";
import { syncFollowUpForTask } from "./followUpOps";
import { getLeadRef } from "./leadRef";
import { otherHumanHolder } from "./conversationHolder";
import { formatTime } from "./telegramNotifications";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./permissions";
import { safeTimezone } from "./promptDateTime";
import { atLocal } from "./executiveReport";

export type AttendantToolScope = {
  organizationId: Id<"organizations">;
  member: Doc<"teamMembers">;
  threadId?: Id<"copilotThreads">;
  /** Telegram: the chat's conversation in focus (D17), < 6 h old. Never from the model. */
  focusConversationId?: Id<"conversations">;
  pendingActionTtlMs: number;
  /** Audit marker: "copilot" (web/Telegram) or "telegram_auto" (assistant in automatic mode). */
  via?: "copilot" | "telegram_auto";
  /** D22: the automatic turn's run; undo steps are keyed by it. */
  agentRunId?: Id<"agentRuns">;
  /** Ordinal rule: task numbers resolve against the list as of the turn start. */
  turnStartedAt?: number;
};

const READ_TOOLS = ["getConversationHistory", "listMyOpenTasks"] as const;
const WRITE_TOOLS = [
  "instructAttendant",
  "regenerateAiReply",
  "acceptHandoff",
  "completeTask",
  "snoozeTask",
  "sendCustomerReply",
] as const;
/** pendingActions tools executed by `executeAttendantPendingAction`. */
export const ATTENDANT_PENDING_TOOLS = ["instructAttendant", "sendCustomerReply", "acceptHandoff", "regenerateAiReply"] as const;

export const isAttendantCopilotReadTool = (name: string) => (READ_TOOLS as readonly string[]).includes(name);
export const isAttendantCopilotWriteTool = (name: string) => (WRITE_TOOLS as readonly string[]).includes(name);
export const isAttendantPendingTool = (tool: string) => (ATTENDANT_PENDING_TOOLS as readonly string[]).includes(tool);

const INSTRUCTION_MAX = 2000;
const REPLY_MAX = 4096;
const HISTORY_SIZE = 20;
const TEXT_MAX = 300;
const OPEN_TASKS_SHOWN = 20;
const NO_CONVERSATION = "Diga de qual conversa: passe o lead (leadId) de um resultado que você viu.";

type Db = QueryCtx["db"];

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The conversation the tool acts on: the lead's latest 1:1 conversation, or the focus. */
export async function resolveToolConversation(
  db: Db,
  scope: Pick<AttendantToolScope, "organizationId" | "focusConversationId">,
  leadIdRaw: unknown,
): Promise<{ conversation: Doc<"conversations">; lead: Doc<"leads"> | null } | null> {
  if (typeof leadIdRaw === "string" && leadIdRaw.trim()) {
    const leadId = db.normalizeId("leads", leadIdRaw.trim());
    const lead = leadId ? await db.get(leadId) : null;
    if (!lead || lead.organizationId !== scope.organizationId) return null;
    const conversations = (
      await db
        .query("conversations")
        .withIndex("by_lead", (q) => q.eq("leadId", lead._id))
        .take(20)
    ).filter((c) => c.organizationId === scope.organizationId && c.kind !== "group");
    conversations.sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
    return conversations[0] ? { conversation: conversations[0], lead } : null;
  }
  if (scope.focusConversationId) {
    const conversation = await db.get(scope.focusConversationId);
    if (!conversation || conversation.organizationId !== scope.organizationId) return null;
    return { conversation, lead: await getLeadRef(db, conversation.leadId) };
  }
  return null;
}

/** The attendant's mode for this conversation: the lead's AI owner, else the org's first attendant. */
export async function attendantModeFor(
  db: Db,
  organizationId: Id<"organizations">,
  lead: Doc<"leads"> | null,
): Promise<"suggest" | "autopilot" | null> {
  if (lead?.assignedTo) {
    const owner = await db.get(lead.assignedTo);
    if (owner && owner.type === "ai" && owner.agentProfile?.kind === "attendant") return owner.agentProfile.mode;
  }
  const ais = await db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", organizationId).eq("type", "ai"))
    .take(20);
  const attendant = ais.find((m) => m.agentProfile?.kind === "attendant" && m.status !== "inactive");
  return attendant?.agentProfile?.mode ?? null;
}

async function pendingHandoffOf(db: Db, conversationId: Id<"conversations">) {
  return await db
    .query("handoffs")
    .withIndex("by_conversation_and_status", (q) => q.eq("conversationId", conversationId).eq("status", "pending"))
    .first();
}

async function pendingDraftOf(db: Db, conversationId: Id<"conversations">) {
  const recent = await db
    .query("messages")
    .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversationId))
    .order("desc")
    .take(30);
  return recent.find((m) => (m.metadata?.aiDraft as { status?: string } | undefined)?.status === "pending") ?? null;
}

/** Open tasks of the member, in the order shown by `listMyOpenTasks` (due first, then undated). */
/**
 * The member's open tasks, numbered by due date. With `turnStartedAt` the list
 * is the one AS OF the turn start (ai-pipeline ordinal rule): tasks created
 * later are left out and tasks completed during the turn stay in place, so
 * `completeTask(1)` then `completeTask(2)` hits the original #2.
 */
export async function myOpenTasks(
  db: Db,
  organizationId: Id<"organizations">,
  memberId: Id<"teamMembers">,
  turnStartedAt?: number,
) {
  const rows: Doc<"tasks">[] = [];
  for (const status of ["pending", "in_progress"] as const) {
    rows.push(
      ...(await db
        .query("tasks")
        .withIndex("by_organization_and_assigned_and_status", (q) =>
          q.eq("organizationId", organizationId).eq("assignedTo", memberId).eq("status", status),
        )
        .take(100)),
    );
  }
  if (turnStartedAt !== undefined) {
    const doneDuringTurn = await db
      .query("tasks")
      .withIndex("by_organization_and_completed_at", (q) =>
        q.eq("organizationId", organizationId).gte("completedAt", turnStartedAt),
      )
      .take(50);
    rows.push(...doneDuringTurn.filter((t) => t.assignedTo === memberId && t.status === "completed"));
    const asOfStart = rows.filter((t) => t._creationTime <= turnStartedAt);
    rows.length = 0;
    rows.push(...asOfStart);
  }
  rows.sort((a, b) => (a.dueDate ?? Number.MAX_SAFE_INTEGER) - (b.dueDate ?? Number.MAX_SAFE_INTEGER) || a._creationTime - b._creationTime);
  return rows.slice(0, OPEN_TASKS_SHOWN);
}

function cut(text: string, max = TEXT_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function historyLine(db: Db, m: Doc<"messages">): Promise<string> {
  const caption = m.content?.trim() ?? "";
  if (m.contentType === "image") {
    const desc = m.imageDescription ? cut(m.imageDescription, 200) : "sem descrição";
    return `[imagem: ${desc}]${caption ? ` ${cut(caption)}` : ""}`;
  }
  if (m.contentType === "audio") return `[áudio: ${m.transcriptText ? cut(m.transcriptText) : "sem transcrição"}]`;
  if (m.contentType === "file") {
    const file = m.attachments?.[0] ? await db.get(m.attachments[0]) : null;
    return `[📎 ${file?.name ?? "arquivo"}]${caption && caption !== file?.name ? ` ${cut(caption)}` : ""}`;
  }
  return cut(caption);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function runAttendantCopilotReadTool(
  ctx: { db: Db },
  name: string,
  args: Record<string, unknown>,
  scope: Pick<AttendantToolScope, "organizationId" | "member" | "focusConversationId" | "turnStartedAt">,
): Promise<Record<string, unknown>> {
  const db = ctx.db;
  if (name === "listMyOpenTasks") {
    const tasks = await myOpenTasks(db, scope.organizationId, scope.member._id, scope.turnStartedAt);
    const out = [];
    for (const [i, t] of tasks.entries()) {
      const lead = await getLeadRef(db, t.leadId);
      out.push({
        number: i + 1,
        title: t.title,
        dueDate: t.dueDate ?? null,
        status: t.status,
        lead: lead && lead.organizationId === scope.organizationId ? lead.title : null,
      });
    }
    return { tasks: out };
  }

  // getConversationHistory
  const found = await resolveToolConversation(db, scope, args.leadId);
  if (!found) return { status: "sem_conversa", message: NO_CONVERSATION };
  const { conversation, lead } = found;
  const recent = await db
    .query("messages")
    .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversation._id))
    .order("desc")
    .take(60);
  const visible = recent.filter((m) => !m.isInternal && m.direction !== "internal").slice(0, HISTORY_SIZE).reverse();
  const names = new Map<string, string>();
  const messages = [];
  for (const m of visible) {
    let author = "cliente";
    if (m.direction === "outbound") {
      if (m.senderType === "ai") author = "IA";
      else if (m.senderId) {
        if (!names.has(m.senderId)) names.set(m.senderId, (await db.get(m.senderId))?.name ?? "equipe");
        author = names.get(m.senderId)!;
      } else author = "equipe (aparelho)";
    }
    messages.push({ direction: m.direction, author, at: m.createdAt, text: await historyLine(db, m) });
  }
  const draft = await pendingDraftOf(db, conversation._id);
  const handoff = await pendingHandoffOf(db, conversation._id);
  return {
    status: "ok",
    lead: lead ? { title: lead.title } : null,
    channel: conversation.channel,
    attendantMode: (await attendantModeFor(db, scope.organizationId, lead)) ?? "sem_atendente",
    pendingDraft: draft ? cut(draft.content, 500) : null,
    handoff: handoff ? { reason: cut(handoff.reason, 200), origin: handoff.origin ?? null } : null,
    messages,
  };
}

// ---------------------------------------------------------------------------
// Automatic-mode undo steps (D22)
// ---------------------------------------------------------------------------

/**
 * In an automatic turn (`via:"telegram_auto"`), every write leaves a step
 * with the state BEFORE it, read back by the record card's "Desfazer"
 * (`lib/telegramActions.undoAutoRecord`). No-op for the web/Telegram Copilot.
 */
export async function recordAutoStep(
  ctx: MutationCtx,
  scope: Pick<AttendantToolScope, "organizationId" | "threadId" | "via" | "agentRunId">,
  kind: string,
  refId: string,
  before: Record<string, unknown>,
  /** State right after the step (call AFTER the core): undo skips the step if it changed since. */
  after?: Record<string, unknown>,
): Promise<void> {
  if (scope.via !== "telegram_auto" || !scope.threadId || !scope.agentRunId) return;
  await ctx.db.insert("telegramAutoSteps", {
    organizationId: scope.organizationId,
    threadId: scope.threadId,
    kind,
    refId,
    before,
    ...(after ? { after } : {}),
    runId: scope.agentRunId,
    createdAt: Date.now(),
  });
}

/**
 * Post-step state of a conversation step (read in the same transaction, after
 * the core): undo compares it with the live state and skips on drift.
 */
export async function conversationAfter(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  handoffId: Id<"handoffs"> | undefined,
) {
  const conversation = await ctx.db.get(conversationId);
  const lead = conversation ? await getLeadRef(ctx.db, conversation.leadId) : null;
  const handoff = handoffId ? await ctx.db.get(handoffId) : null;
  const now = Date.now();
  return {
    ...(handoff ? { handoffStatus: handoff.status, handoffResolvedBy: handoff.resolvedBy ?? null } : {}),
    ...(lead ? { leadAssignedTo: lead.assignedTo ?? null } : {}),
    aiPaused: conversation?.aiPausedUntil !== undefined && conversation.aiPausedUntil > now,
  };
}

/** What `instructAttendant`/`acceptHandoff` change, to put back on undo. */
async function conversationBefore(ctx: MutationCtx, conversation: Doc<"conversations">, lead: Doc<"leads"> | null) {
  const handoff = await pendingHandoffOf(ctx.db, conversation._id);
  return {
    ...(handoff ? { handoffId: handoff._id } : {}),
    ...(lead ? { leadId: lead._id, leadAssignedTo: lead.assignedTo ?? null, leadHandoffState: lead.handoffState ?? null } : {}),
    aiPausedUntil: conversation.aiPausedUntil ?? null,
    notesCount: (conversation.aiTeamNotes ?? []).length,
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

async function proposal(
  ctx: MutationCtx,
  scope: AttendantToolScope,
  tool: string,
  args: Record<string, unknown>,
  preview: string,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const pendingActionId = await ctx.db.insert("pendingActions", {
    organizationId: scope.organizationId,
    requestedBy: scope.member._id,
    threadId: scope.threadId,
    tool,
    // `via` travels with the proposal so the confirmation audits the same origin.
    args: { ...args, ...(scope.via === "telegram_auto" ? { via: "telegram_auto" } : {}) },
    preview,
    status: "pending",
    expiresAt: now + scope.pendingActionTtlMs,
    createdAt: now,
  });
  return { status: "confirmacao_necessaria", pendingActionId, preview };
}

const leadLabel = (lead: Doc<"leads"> | null) => lead?.title ?? "o contato";

export async function runAttendantCopilotWriteTool(
  ctx: MutationCtx,
  name: string,
  args: Record<string, unknown>,
  scope: AttendantToolScope,
): Promise<Record<string, unknown>> {
  const via = scope.via ?? "copilot";

  if (name === "completeTask" || name === "snoozeTask") {
    const n = typeof args.taskNumber === "number" ? Math.floor(args.taskNumber) : NaN;
    const tasks = await myOpenTasks(ctx.db, scope.organizationId, scope.member._id, scope.turnStartedAt);
    const task = Number.isFinite(n) && n >= 1 ? tasks[n - 1] : undefined;
    if (!task) return { error: "Tarefa não encontrada: use o número mostrado em listMyOpenTasks." };
    if (task.status === "completed") return { error: `A tarefa ${n} já foi concluída neste turno.` };
    const now = Date.now();
    if (name === "completeTask") {
      await applyTaskCompletion(ctx, task, scope.member, now, undefined, via);
      await syncFollowUpForTask(ctx, task._id);
      await recordAutoStep(
        ctx, scope, "complete_task", task._id,
        { status: task.status, ...(task.columnId ? { columnId: task.columnId } : {}) },
        { completedAt: now },
      );
      return { status: "ok", message: "Tarefa concluída", title: task.title };
    }
    const org = await ctx.db.get(scope.organizationId);
    const tz = safeTimezone(org?.settings.timezone);
    const until = args.until === "1h" ? now + 60 * 60 * 1000 : args.until === "amanha_9h" ? atLocal(now, tz, 1, 9) : NaN;
    if (!Number.isFinite(until)) return { error: 'until deve ser "1h" ou "amanha_9h"' };
    await snoozeTaskCore(ctx, task, scope.member, until, now, { via });
    await syncFollowUpForTask(ctx, task._id);
    await recordAutoStep(ctx, scope, "snooze_task", task._id, { snoozedUntil: task.snoozedUntil ?? null }, { snoozedUntil: until });
    return { status: "ok", message: "Tarefa adiada", title: task.title, snoozedUntil: until };
  }

  const found = await resolveToolConversation(ctx.db, scope, args.leadId);
  if (!found) return { error: NO_CONVERSATION };
  const { conversation, lead } = found;

  if (name === "acceptHandoff") {
    const handoff = await pendingHandoffOf(ctx.db, conversation._id);
    if (!handoff) return { error: "Não há repasse pendente nesta conversa." };
    const before = await conversationBefore(ctx, conversation, lead);
    await acceptHandoffCore(ctx, { handoff, member: scope.member, via });
    await recordAutoStep(ctx, scope, "accept_handoff", handoff._id, before, await conversationAfter(ctx, conversation._id, handoff._id));
    return { status: "ok", message: `Repasse de ${leadLabel(lead)} aceito: a conversa é sua e a IA pausou.` };
  }

  if (name === "regenerateAiReply") {
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!reason) return { error: "Diga o motivo da nova versão." };
    if (reason.length > INSTRUCTION_MAX) return { error: `Motivo muito longo (máx. ${INSTRUCTION_MAX} caracteres).` };
    const draft = await pendingDraftOf(ctx.db, conversation._id);
    await recordAutoStep(ctx, scope, "regenerate", conversation._id, {});
    await requestAiDraftCore(ctx, { conversation, member: scope.member, instruction: reason, sourceDraftId: draft?._id, via });
    return { status: "ok", message: "Pedi uma nova versão ao Atendente; o rascunho chega em instantes." };
  }

  if (name === "sendCustomerReply") {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return { error: "Texto vazio." };
    if (text.length > REPLY_MAX) return { error: `Texto muito longo (máx. ${REPLY_MAX} caracteres).` };
    return await proposal(
      ctx,
      scope,
      "sendCustomerReply",
      { conversationId: conversation._id, text },
      `Enviar para ${leadLabel(lead)} (${conversation.channel}): "${cut(text, 500)}"`,
    );
  }

  // instructAttendant
  const instruction = typeof args.instruction === "string" ? args.instruction.trim() : "";
  if (!instruction) return { error: "Diga a instrução para a IA." };
  if (instruction.length > INSTRUCTION_MAX) return { error: `Instrução muito longa (máx. ${INSTRUCTION_MAX} caracteres).` };
  const mode = await attendantModeFor(ctx.db, scope.organizationId, lead);
  // Another live human holds the conversation: instructing takes it back to the AI → always confirm.
  const holder = await otherHumanHolder(ctx.db, {
    organizationId: scope.organizationId,
    actorId: scope.member._id,
    conversation,
    now: Date.now(),
  });
  if (holder) {
    return await proposal(
      ctx,
      scope,
      "instructAttendant",
      { conversationId: conversation._id, instruction, ackHolderId: holder.member._id },
      `Instruir a IA na conversa com ${leadLabel(lead)}: "${cut(instruction, 500)}" (${await holderNotice(ctx, scope.organizationId, holder)} Instruir devolve a conversa à IA.)`,
    );
  }
  if (mode === "autopilot") {
    return await proposal(
      ctx,
      scope,
      "instructAttendant",
      { conversationId: conversation._id, instruction },
      `Instruir a IA na conversa com ${leadLabel(lead)}: "${cut(instruction, 500)}" (o Atendente está em autopilot: a resposta sai direto ao cliente)`,
    );
  }
  const before = await conversationBefore(ctx, conversation, lead);
  await instructNow(ctx, scope.member, conversation, instruction, via);
  await recordAutoStep(
    ctx, scope, "instruct", conversation._id, before,
    await conversationAfter(ctx, conversation._id, before.handoffId),
  );
  return {
    status: "ok",
    message:
      mode === "suggest"
        ? "Instrução enviada: o Atendente responde como rascunho para você revisar."
        : "Instrução enviada ao Atendente de IA.",
  };
}

/** Plain-text "Ana assumiu esta conversa às 14:05." (the Telegram layer adds ⚠️ and escapes). */
async function holderNotice(ctx: { db: Db }, organizationId: Id<"organizations">, holder: { member: Doc<"teamMembers">; at?: number }) {
  const org = await ctx.db.get(organizationId);
  const tz = safeTimezone(org?.settings.timezone);
  return `${holder.member.name} assumiu esta conversa${holder.at ? ` às ${formatTime(holder.at, tz)}` : ""}.`;
}

/** Pending handoff → reject with instruction (back to the AI); otherwise `returnToAiCore`. */
async function instructNow(
  ctx: MutationCtx,
  member: Doc<"teamMembers">,
  conversation: Doc<"conversations">,
  instruction: string,
  via: "copilot" | "telegram" | "telegram_auto",
) {
  const handoff = await pendingHandoffOf(ctx.db, conversation._id);
  if (handoff) await rejectHandoffWithInstructionCore(ctx, { handoff, member, instruction, via });
  else await returnToAiCore(ctx, { conversation, member, instruction, via });
}

/**
 * Confirmation of a D18 pendingAction (`internalConfirmPendingAction` routes
 * here for `ATTENDANT_PENDING_TOOLS`). The caller already checked requester,
 * TTL and status; permission and org are re-checked HERE (the role may have
 * changed since the proposal).
 */
export async function executeAttendantPendingAction(
  ctx: MutationCtx,
  pa: Doc<"pendingActions">,
  member: Doc<"teamMembers">,
  /** Where the confirmation came from: a bot tap marks the action as `via:"telegram"` (D23 draft origin). */
  confirmedVia: "copilot" | "telegram" = "copilot",
): Promise<{ ok: boolean; message: string }> {
  const perms = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
  if (!hasPermission(perms, "inbox", "reply")) return { ok: false, message: "Permissão insuficiente (inbox:reply)." };
  const conversationId =
    typeof pa.args.conversationId === "string" ? ctx.db.normalizeId("conversations", pa.args.conversationId) : null;
  const conversation = conversationId ? await ctx.db.get(conversationId) : null;
  if (!conversation || conversation.organizationId !== pa.organizationId || conversation.organizationId !== member.organizationId) {
    return { ok: false, message: "Conversa não encontrada." };
  }
  const via = pa.args.via === "telegram_auto" ? "telegram_auto" : confirmedVia;
  if (pa.tool === "sendCustomerReply") {
    const text = typeof pa.args.text === "string" ? pa.args.text : "";
    if (!text) return { ok: false, message: "Texto vazio." };
    await internalSendMessageCore(ctx, { conversationId: conversation._id, content: text, teamMemberId: member._id, via });
    return { ok: true, message: "Mensagem enviada." };
  }
  if (pa.tool === "instructAttendant") {
    const instruction = typeof pa.args.instruction === "string" ? pa.args.instruction : "";
    if (!instruction) return { ok: false, message: "Instrução vazia." };
    // Takeover since the proposal (e.g. "Aplicar sugestão" after Ana took it in the app): refuse,
    // unless the proposal itself already showed THIS holder and the member confirmed knowing it.
    const holder = await otherHumanHolder(ctx.db, {
      organizationId: conversation.organizationId,
      actorId: member._id,
      conversation,
      now: Date.now(),
    });
    if (holder && pa.args.ackHolderId !== holder.member._id) {
      return { ok: false, message: await holderNotice(ctx, conversation.organizationId, holder) };
    }
    await instructNow(ctx, member, conversation, instruction, via);
    return { ok: true, message: "Instrução enviada ao Atendente de IA." };
  }
  if (pa.tool === "acceptHandoff") {
    const handoff = await pendingHandoffOf(ctx.db, conversation._id);
    if (!handoff) return { ok: false, message: "Este repasse já foi resolvido." };
    await acceptHandoffCore(ctx, { handoff, member, via });
    return { ok: true, message: "Repasse aceito: a conversa é sua." };
  }
  if (pa.tool === "regenerateAiReply") {
    const reason = typeof pa.args.reason === "string" ? pa.args.reason : "";
    if (!reason) return { ok: false, message: "Motivo vazio." };
    const draft = await pendingDraftOf(ctx.db, conversation._id);
    await requestAiDraftCore(ctx, { conversation, member, instruction: reason, sourceDraftId: draft?._id, via });
    return { ok: true, message: "Pedi uma nova versão ao Atendente." };
  }
  return { ok: false, message: `Ação desconhecida: ${pa.tool}` };
}
