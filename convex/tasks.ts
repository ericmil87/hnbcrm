import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation, type QueryCtx, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAuth } from "./lib/auth";
import { batchGet } from "./lib/batchGet";
import { buildAuditDescription } from "./lib/auditDescription";
import { createNotification, filterMembersOfOrg } from "./lib/notify";
import { buildTaskSearchText } from "./lib/taskSearchText";
import { parseCursor, buildCursorFromCreationTime, paginateResults } from "./lib/cursor";

// Espaçamento entre tasks numa coluna do kanban (permite inserir no meio sem renumerar).
const ORDER_STEP = 1000;

// Caminho indexado por responsável primário: cobre TODAS as tasks onde o membro
// é o assignedTo. A membership secundária (`assigneeIds`) não tem índice — vem
// da varredura org-scoped abaixo, que é limitada por definição.
const ASSIGNEE_INDEX_LIMIT = 500;
const ORG_SCAN_LIMIT = 1000;

// Teto da contagem de comentários em getTask (acima disso a UI mostra "100+").
const COMMENT_COUNT_CAP = 100;

// `assigneeIds` é a fonte de verdade; `assignedTo` é o espelho legado (= assigneeIds[0]).
function readAssignees(task: {
  assigneeIds?: Id<"teamMembers">[];
  assignedTo?: Id<"teamMembers">;
}): Id<"teamMembers">[] {
  if (task.assigneeIds && task.assigneeIds.length > 0) return task.assigneeIds;
  return task.assignedTo ? [task.assignedTo] : [];
}

function dedupeIds<T extends string>(ids: T[]): T[] {
  return [...new Set(ids)];
}

function appUrl(): string {
  return process.env.APP_URL ?? "https://app.hnbcrm.com.br";
}

function taskDeepLink(taskId: Id<"tasks">): string {
  return `${appUrl()}/app/tarefas?task=${taskId}`;
}

function formatDate(ts?: number): string | undefined {
  return ts ? new Date(ts).toLocaleDateString("pt-BR") : undefined;
}

// ===== Helpers: projeto / colunas =====

async function validateProject(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"taskProjects">
): Promise<Doc<"taskProjects">> {
  const project = await ctx.db.get(projectId);
  if (!project || project.organizationId !== organizationId) throw new Error("Projeto não encontrado");
  return project;
}

async function validateColumn(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  columnId: Id<"taskColumns">,
  projectId?: Id<"taskProjects">
): Promise<Doc<"taskColumns">> {
  const column = await ctx.db.get(columnId);
  if (!column || column.organizationId !== organizationId) throw new Error("Coluna não encontrada");
  if (projectId && column.projectId !== projectId) {
    throw new Error("A coluna não pertence ao projeto informado");
  }
  return column;
}

async function columnsOfProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"taskProjects">
): Promise<Doc<"taskColumns">[]> {
  const columns = await ctx.db
    .query("taskColumns")
    .withIndex("by_project_and_order", (q) => q.eq("projectId", projectId))
    .collect();
  return columns.sort((a, b) => a.order - b.order);
}

// Coluna default de um projeto: a de menor `order` que não seja done column.
async function defaultColumnForProject(ctx: QueryCtx | MutationCtx, projectId: Id<"taskProjects">) {
  const columns = await columnsOfProject(ctx, projectId);
  return columns.find((c) => !c.isDoneColumn) ?? columns[0] ?? null;
}

async function doneColumnForProject(ctx: QueryCtx | MutationCtx, projectId: Id<"taskProjects">) {
  const columns = await columnsOfProject(ctx, projectId);
  return columns.find((c) => c.isDoneColumn) ?? null;
}

async function nextOrderInColumn(ctx: QueryCtx | MutationCtx, columnId: Id<"taskColumns">): Promise<number> {
  // O índice já ordena por `order`: a última linha é o maior valor da coluna.
  const last = await ctx.db
    .query("tasks")
    .withIndex("by_column_and_order", (q) => q.eq("columnId", columnId))
    .order("desc")
    .first();
  return (last?.order ?? 0) + ORDER_STEP;
}

// ===== Helpers: hierarquia, dependências, responsáveis =====

async function validateParentTask(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  taskId: Id<"tasks"> | null,
  parentTaskId: Id<"tasks">
): Promise<void> {
  if (taskId && parentTaskId === taskId) {
    throw new Error("Uma tarefa não pode ser subtarefa dela mesma");
  }
  const parent = await ctx.db.get(parentTaskId);
  if (!parent || parent.organizationId !== organizationId) {
    throw new Error("Tarefa-pai não encontrada");
  }
  // Sobe a cadeia de ancestrais: a própria task não pode aparecer nela.
  let cursor: Id<"tasks"> | undefined = parent.parentTaskId;
  let depth = 0;
  while (cursor && depth < 50) {
    if (taskId && cursor === taskId) {
      throw new Error("Uma subtarefa não pode ser ancestral dela mesma");
    }
    const node: Doc<"tasks"> | null = await ctx.db.get(cursor);
    if (!node) break;
    cursor = node.parentTaskId;
    depth++;
  }
}

async function normalizeBlockedBy(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  taskId: Id<"tasks"> | null,
  blockedBy: Id<"tasks">[]
): Promise<Id<"tasks">[]> {
  const unique = dedupeIds(blockedBy).filter((id) => id !== taskId);
  for (const id of unique) {
    const blocker = await ctx.db.get(id);
    if (!blocker || blocker.organizationId !== organizationId) {
      throw new Error("Tarefa bloqueadora não encontrada");
    }
  }
  return unique;
}

async function normalizeAssignees(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  memberIds: Id<"teamMembers">[]
): Promise<Id<"teamMembers">[]> {
  const unique = dedupeIds(memberIds);
  for (const id of unique) {
    const member = await ctx.db.get(id);
    if (!member || member.organizationId !== organizationId) {
      throw new Error("Responsável não encontrado nesta organização");
    }
  }
  return unique;
}

async function normalizeLabelIds(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  labelIds: Id<"taskLabels">[]
): Promise<Id<"taskLabels">[]> {
  const unique = dedupeIds(labelIds);
  for (const id of unique) {
    const label = await ctx.db.get(id);
    if (!label || label.organizationId !== organizationId) {
      throw new Error("Label não encontrada nesta organização");
    }
  }
  return unique;
}

// searchText inclui nomes de labels + nome do projeto (resolvidos na escrita).
async function resolveSearchExtras(
  ctx: QueryCtx | MutationCtx,
  opts: { labelIds?: Id<"taskLabels">[]; projectId?: Id<"taskProjects"> }
): Promise<{ labelNames: string[]; projectName?: string }> {
  const labels = await Promise.all((opts.labelIds ?? []).map((id) => ctx.db.get(id)));
  const project = opts.projectId ? await ctx.db.get(opts.projectId) : null;
  return {
    labelNames: labels.filter((l): l is Doc<"taskLabels"> => l != null).map((l) => l.name),
    projectName: project?.name,
  };
}

// Notifica (in-app + e-mail) só os responsáveis NOVOS, nunca o ator.
async function notifyNewAssignees(
  ctx: MutationCtx,
  opts: {
    task: { _id: Id<"tasks">; title: string; dueDate?: number; organizationId: Id<"organizations"> };
    assignees: Id<"teamMembers">[];
    previousAssignees: Id<"teamMembers">[];
    actor: Doc<"teamMembers">;
  }
): Promise<void> {
  const previous = new Set(opts.previousAssignees);
  // Ids podem vir do cliente (API/MCP): só notifica membros da org da task —
  // o e-mail não tem gate de org em dispatchNotification.
  const allowed = await filterMembersOfOrg(ctx, opts.task.organizationId, opts.assignees);

  for (const memberId of allowed) {
    if (previous.has(memberId)) continue;
    if (memberId === opts.actor._id) continue;

    await createNotification(ctx, {
      organizationId: opts.task.organizationId,
      memberId,
      type: "task_assigned",
      title: "Nova tarefa atribuída a você",
      body: opts.task.title,
      taskId: opts.task._id,
      actorId: opts.actor._id,
    });

    await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
      organizationId: opts.task.organizationId,
      recipientMemberId: memberId,
      eventType: "taskAssigned",
      templateData: {
        taskTitle: opts.task.title,
        dueDate: formatDate(opts.task.dueDate),
        assignedByName: opts.actor.name,
        leadTitle: undefined,
        taskUrl: taskDeepLink(opts.task._id),
      },
    });
  }
}

// Lembrete antecipado: agenda o disparo para dueDate - minutos.
async function schedulePreDueReminder(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  dueDate?: number,
  reminderMinutesBefore?: number
): Promise<void> {
  if (!dueDate || !reminderMinutesBefore || reminderMinutesBefore <= 0) return;
  const fireAt = dueDate - reminderMinutesBefore * 60_000;
  const delay = Math.max(0, fireAt - Date.now());
  // `expectedMinutes` viaja junto para o trigger detectar agendamento obsoleto
  // (usuário desligou o lembrete ou trocou a antecedência depois de agendado).
  await ctx.scheduler.runAfter(delay, internal.tasks.triggerPreDueReminder, {
    taskId,
    expectedDueDate: dueDate,
    expectedMinutes: reminderMinutesBefore,
  });
}

// Fluxo único de conclusão (usado por completeTask, internalCompleteTask e moveTaskToColumn).
async function applyCompletion(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  actor: Doc<"teamMembers">,
  now: number,
  placement?: { columnId: Id<"taskColumns">; order: number }
): Promise<void> {
  const patch: Record<string, any> = { status: "completed", completedAt: now, updatedAt: now };

  if (placement) {
    patch.columnId = placement.columnId;
    patch.order = placement.order;
  } else if (task.projectId) {
    const doneColumn = await doneColumnForProject(ctx, task.projectId);
    if (doneColumn && task.columnId !== doneColumn._id) {
      patch.columnId = doneColumn._id;
      patch.order = await nextOrderInColumn(ctx, doneColumn._id);
    }
  }

  await ctx.db.patch(task._id, patch);

  // Recorrência: gera a próxima instância
  if (task.recurrence) {
    await ctx.scheduler.runAfter(0, internal.tasks.processRecurringTasks);
  }

  await ctx.db.insert("auditLogs", {
    organizationId: task.organizationId,
    entityType: "task",
    entityId: task._id,
    action: "update",
    actorId: actor._id,
    actorType: actor.type === "ai" ? "ai" : "human",
    changes: { before: { status: task.status }, after: { status: "completed" } },
    metadata: { title: task.title },
    description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before: { status: task.status }, after: { status: "completed" } } }),
    severity: "medium",
    createdAt: now,
  });

  if (task.leadId) {
    await ctx.db.insert("activities", {
      organizationId: task.organizationId,
      leadId: task.leadId,
      type: "task_completed",
      actorId: actor._id,
      actorType: actor.type === "ai" ? "ai" : "human",
      content: `Task "${task.title}" completed`,
      metadata: { taskId: task._id },
      createdAt: now,
    });
  }

  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: task.organizationId,
    event: "task.completed",
    payload: { taskId: task._id, title: task.title },
  });
}

// Antes de deletar: órfã as subtarefas e limpa as tasks de dependências alheias.
// Recebe o LOTE inteiro para que o bulk delete faça uma varredura de org só
// (uma por task deletada custava 50 varreduras num lote de 50).
async function unlinkTaskReferences(ctx: MutationCtx, tasks: Doc<"tasks">[]): Promise<void> {
  if (tasks.length === 0) return;
  const now = Date.now();
  const deleted = new Set<Id<"tasks">>(tasks.map((t) => t._id));

  for (const task of tasks) {
    const children = await ctx.db
      .query("tasks")
      .withIndex("by_parent_task", (q) => q.eq("parentTaskId", task._id))
      .collect();
    for (const child of children) {
      if (deleted.has(child._id)) continue;
      await ctx.db.patch(child._id, { parentTaskId: undefined, updatedAt: now });
    }
  }

  const organizationIds = [...new Set(tasks.map((t) => t.organizationId))];
  for (const organizationId of organizationIds) {
    const orgTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .take(2000);
    for (const other of orgTasks) {
      if (deleted.has(other._id)) continue;
      if (!other.blockedBy?.some((id) => deleted.has(id))) continue;
      await ctx.db.patch(other._id, {
        blockedBy: other.blockedBy.filter((id) => !deleted.has(id)),
        updatedAt: now,
      });
    }
  }
}

// ===== Helpers: tasks de um responsável (primário + secundário) =====

type ActiveStatus = "pending" | "in_progress";
const ACTIVE_STATUSES: ActiveStatus[] = ["pending", "in_progress"];

// Tasks ativas da org (varredura limitada — base dos contadores agregados).
async function scanActiveOrgTasks(
  ctx: QueryCtx,
  organizationId: Id<"organizations">
): Promise<Doc<"tasks">[]> {
  const pages = await Promise.all(
    ACTIVE_STATUSES.map((status) =>
      ctx.db
        .query("tasks")
        .withIndex("by_organization_and_status", (q) =>
          q.eq("organizationId", organizationId).eq("status", status)
        )
        .take(ORG_SCAN_LIMIT)
    )
  );
  return pages.flat();
}

// União do caminho indexado (responsável primário) com a membership secundária
// encontrada na varredura, deduplicada por id.
function mergeAssigneeTasks(
  memberId: Id<"teamMembers">,
  indexed: Doc<"tasks">[],
  scanned: Doc<"tasks">[]
): Doc<"tasks">[] {
  const byId = new Map<Id<"tasks">, Doc<"tasks">>();
  for (const task of indexed) byId.set(task._id, task);
  for (const task of scanned) {
    if (readAssignees(task).includes(memberId)) byId.set(task._id, task);
  }
  return [...byId.values()];
}

// Tasks ativas do membro (recebe a varredura da org já feita pelo chamador).
async function collectMyActiveTasks(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  memberId: Id<"teamMembers">,
  orgActive: Doc<"tasks">[]
): Promise<Doc<"tasks">[]> {
  const indexed = (
    await Promise.all(
      ACTIVE_STATUSES.map((status) =>
        ctx.db
          .query("tasks")
          .withIndex("by_organization_and_assigned_and_status", (q) =>
            q.eq("organizationId", organizationId).eq("assignedTo", memberId).eq("status", status)
          )
          .take(ASSIGNEE_INDEX_LIMIT)
      )
    )
  ).flat();

  return mergeAssigneeTasks(memberId, indexed, orgActive);
}

// Variante para a API REST: qualquer status (ou todos).
async function collectTasksForAssignee(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  memberId: Id<"teamMembers">,
  status?: Doc<"tasks">["status"]
): Promise<Doc<"tasks">[]> {
  const indexed = status
    ? await ctx.db
        .query("tasks")
        .withIndex("by_organization_and_assigned_and_status", (q) =>
          q.eq("organizationId", organizationId).eq("assignedTo", memberId).eq("status", status)
        )
        .take(ASSIGNEE_INDEX_LIMIT)
    : await ctx.db
        .query("tasks")
        .withIndex("by_organization_and_assigned", (q) =>
          q.eq("organizationId", organizationId).eq("assignedTo", memberId)
        )
        .take(ASSIGNEE_INDEX_LIMIT);

  const scanned = status
    ? await ctx.db
        .query("tasks")
        .withIndex("by_organization_and_status", (q) =>
          q.eq("organizationId", organizationId).eq("status", status)
        )
        .take(ORG_SCAN_LIMIT)
    : await ctx.db
        .query("tasks")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .take(ORG_SCAN_LIMIT);

  return mergeAssigneeTasks(memberId, indexed, scanned);
}

// Enriquecimento padrão de listas de tasks (assignees múltiplos + labels + relações).
async function enrichTasks(ctx: QueryCtx, tasks: Doc<"tasks">[]) {
  const memberIds: (string | undefined)[] = [];
  const labelIds: string[] = [];
  for (const task of tasks) {
    memberIds.push(task.assignedTo);
    for (const id of readAssignees(task)) memberIds.push(id);
    for (const id of task.labelIds ?? []) labelIds.push(id);
  }

  const [memberMap, leadMap, contactMap, labelMap] = await Promise.all([
    batchGet(ctx.db, memberIds),
    batchGet(ctx.db, tasks.map((t) => t.leadId)),
    batchGet(ctx.db, tasks.map((t) => t.contactId)),
    batchGet(ctx.db, labelIds),
  ]);

  return tasks.map((task) => ({
    ...task,
    assignee: task.assignedTo ? memberMap.get(task.assignedTo) ?? null : null,
    assignees: readAssignees(task).map((id) => memberMap.get(id)).filter(Boolean),
    labels: (task.labelIds ?? [])
      .map((id) => labelMap.get(id))
      .filter(Boolean)
      .map((l: any) => ({ _id: l._id, name: l.name, color: l.color })),
    lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
    contact: task.contactId ? contactMap.get(task.contactId) ?? null : null,
  }));
}

// A API REST/MCP passa ids de task crus (o membro vem da API key): a task TEM
// que ser da org de quem age, senão um tenant alcança as tasks do outro por id.
async function requireTaskOfMember(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  member: Doc<"teamMembers">
): Promise<Doc<"tasks">> {
  const task = await ctx.db.get(taskId);
  if (!task || task.organizationId !== member.organizationId) throw new Error("Task not found");
  return task;
}

// Página da API REST: resolve as relações rasas (assignee/lead/contact).
async function withTaskRelations(
  ctx: QueryCtx,
  tasks: Doc<"tasks">[],
  nextCursor: string | null,
  hasMore: boolean
) {
  const [assigneeMap, leadMap, contactMap] = await Promise.all([
    batchGet(ctx.db, tasks.map(t => t.assignedTo)),
    batchGet(ctx.db, tasks.map(t => t.leadId)),
    batchGet(ctx.db, tasks.map(t => t.contactId)),
  ]);

  return {
    tasks: tasks.map(task => ({
      ...task,
      assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
      lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
      contact: task.contactId ? contactMap.get(task.contactId) ?? null : null,
    })),
    nextCursor,
    hasMore,
  };
}

// Shared validators
const taskTypeValidator = v.union(v.literal("task"), v.literal("reminder"));
const taskStatusValidator = v.union(v.literal("pending"), v.literal("in_progress"), v.literal("completed"), v.literal("cancelled"));
const taskPriorityValidator = v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"));
const activityTypeValidator = v.union(
  v.literal("todo"), v.literal("call"), v.literal("email"),
  v.literal("follow_up"), v.literal("meeting"), v.literal("research")
);
const recurrenceValidator = v.object({
  pattern: v.union(v.literal("daily"), v.literal("weekly"), v.literal("biweekly"), v.literal("monthly")),
  endDate: v.optional(v.number()),
  lastGeneratedAt: v.optional(v.number()),
});
const checklistItemValidator = v.object({
  id: v.string(),
  title: v.string(),
  completed: v.boolean(),
});

// Priority order for sorting
const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

// ===== Public Queries =====

// Get tasks with filters
export const getTasks = query({
  args: {
    organizationId: v.id("organizations"),
    status: v.optional(taskStatusValidator),
    priority: v.optional(taskPriorityValidator),
    assignedTo: v.optional(v.id("teamMembers")),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    type: v.optional(taskTypeValidator),
    activityType: v.optional(activityTypeValidator),
    dueBefore: v.optional(v.number()),
    dueAfter: v.optional(v.number()),
    search: v.optional(v.string()),
    // P1: projeto / kanban / labels / multi-assignee
    projectId: v.optional(v.id("taskProjects")),
    columnId: v.optional(v.id("taskColumns")),
    labelIds: v.optional(v.array(v.id("taskLabels"))),
    assigneeId: v.optional(v.id("teamMembers")),
    sortBy: v.optional(v.string()),
    sortOrder: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const limit = args.limit ?? 200;

    // Filtros P1 aplicados em JS (valem para os dois caminhos)
    const matchesP1Filters = (t: Doc<"tasks">) => {
      if (args.projectId && t.projectId !== args.projectId) return false;
      if (args.columnId && t.columnId !== args.columnId) return false;
      if (args.labelIds && args.labelIds.length > 0) {
        const labels = t.labelIds ?? [];
        if (!args.labelIds.some((id) => labels.includes(id))) return false;
      }
      if (args.assigneeId && !readAssignees(t).includes(args.assigneeId)) return false;
      return true;
    };

    // Full-text search path
    if (args.search) {
      let results = await ctx.db
        .query("tasks")
        .withSearchIndex("search_tasks", (q) =>
          q.search("searchText", args.search!).eq("organizationId", args.organizationId)
        )
        .take(limit);

      // Apply JS filters on search results
      if (args.status) results = results.filter(t => t.status === args.status);
      if (args.priority) results = results.filter(t => t.priority === args.priority);
      if (args.assignedTo) results = results.filter(t => t.assignedTo === args.assignedTo);
      if (args.type) results = results.filter(t => t.type === args.type);
      if (args.activityType) results = results.filter(t => t.activityType === args.activityType);
      if (args.leadId) results = results.filter(t => t.leadId === args.leadId);
      if (args.contactId) results = results.filter(t => t.contactId === args.contactId);
      results = results.filter(matchesP1Filters);

      return await enrichTasks(ctx, results);
    }

    // Index-based query path — pick best index
    let q;
    if (args.columnId) {
      q = ctx.db.query("tasks").withIndex("by_column", (idx) =>
        idx.eq("columnId", args.columnId!)
      );
    } else if (args.projectId) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_project", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("projectId", args.projectId!)
      );
    } else if (args.assignedTo && args.status) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_assigned_and_status", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("assignedTo", args.assignedTo!).eq("status", args.status!)
      );
    } else if (args.assignedTo) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_assigned", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("assignedTo", args.assignedTo!)
      );
    } else if (args.status) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_status", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("status", args.status!)
      );
    } else if (args.type) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_type", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("type", args.type!)
      );
    } else if (args.leadId) {
      q = ctx.db.query("tasks").withIndex("by_lead", (idx) =>
        idx.eq("leadId", args.leadId!)
      );
    } else if (args.contactId) {
      q = ctx.db.query("tasks").withIndex("by_contact", (idx) =>
        idx.eq("contactId", args.contactId!)
      );
    } else {
      q = ctx.db.query("tasks").withIndex("by_organization", (idx) =>
        idx.eq("organizationId", args.organizationId)
      );
    }

    let tasks = await q.order("desc").take(limit * 3);

    // `by_column` / `by_lead` / `by_contact` não são escopados por org — reforce aqui.
    tasks = tasks.filter(t => t.organizationId === args.organizationId);

    // Filtros restantes em JS (idempotentes quando o índice já cobriu o campo)
    if (args.status) tasks = tasks.filter(t => t.status === args.status);
    if (args.assignedTo) tasks = tasks.filter(t => t.assignedTo === args.assignedTo);
    if (args.type) tasks = tasks.filter(t => t.type === args.type);
    if (args.leadId) tasks = tasks.filter(t => t.leadId === args.leadId);
    if (args.contactId) tasks = tasks.filter(t => t.contactId === args.contactId);
    if (args.priority) tasks = tasks.filter(t => t.priority === args.priority);
    if (args.activityType) tasks = tasks.filter(t => t.activityType === args.activityType);
    if (args.dueBefore) tasks = tasks.filter(t => t.dueDate != null && t.dueDate <= args.dueBefore!);
    if (args.dueAfter) tasks = tasks.filter(t => t.dueDate != null && t.dueDate >= args.dueAfter!);
    tasks = tasks.filter(matchesP1Filters);

    // Sort
    if (args.sortBy === "dueDate") {
      tasks.sort((a, b) => {
        const da = a.dueDate ?? Infinity;
        const db = b.dueDate ?? Infinity;
        return args.sortOrder === "desc" ? db - da : da - db;
      });
    } else if (args.sortBy === "priority") {
      tasks.sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority] ?? 99;
        const pb = PRIORITY_ORDER[b.priority] ?? 99;
        return args.sortOrder === "desc" ? pb - pa : pa - pb;
      });
    } else if (args.sortBy === "order") {
      // Ordem manual do kanban
      tasks.sort((a, b) => {
        const oa = a.order ?? Infinity;
        const ob = b.order ?? Infinity;
        return args.sortOrder === "desc" ? ob - oa : oa - ob;
      });
    }

    tasks = tasks.slice(0, limit);

    return await enrichTasks(ctx, tasks);
  },
});

// Get single task by ID
export const getTask = query({
  args: { taskId: v.id("tasks") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;

    await requireAuth(ctx, task.organizationId);

    const assigneeIds = readAssignees(task);

    const [assignee, lead, contact, creator, commentsCount, assignees, labels, project, column, subtasks, blockerDocs] =
      await Promise.all([
        task.assignedTo ? ctx.db.get(task.assignedTo) : null,
        task.leadId ? ctx.db.get(task.leadId) : null,
        task.contactId ? ctx.db.get(task.contactId) : null,
        ctx.db.get(task.createdBy),
        // Contagem capada: a UI mostra "100+" a partir do teto, então não vale
        // ler a thread inteira só para contar.
        ctx.db.query("taskComments")
          .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
          .take(COMMENT_COUNT_CAP + 1)
          .then(c => c.length),
        Promise.all(assigneeIds.map((id) => ctx.db.get(id))),
        Promise.all((task.labelIds ?? []).map((id) => ctx.db.get(id))),
        task.projectId ? ctx.db.get(task.projectId) : null,
        task.columnId ? ctx.db.get(task.columnId) : null,
        ctx.db.query("tasks")
          .withIndex("by_parent_task", (q) => q.eq("parentTaskId", args.taskId))
          .collect(),
        Promise.all((task.blockedBy ?? []).map((id) => ctx.db.get(id))),
      ]);

    return {
      ...task,
      assignee,
      lead,
      contact,
      creator,
      commentsCount,
      assignees: assignees.filter(Boolean),
      labels: labels
        .filter((l): l is Doc<"taskLabels"> => l != null)
        .map((l) => ({ _id: l._id, name: l.name, color: l.color })),
      project: project ? { _id: project._id, name: project.name, color: project.color } : null,
      column: column
        ? { _id: column._id, name: column.name, isDoneColumn: column.isDoneColumn ?? false }
        : null,
      subtaskProgress: {
        total: subtasks.length,
        completed: subtasks.filter((s) => s.status === "completed").length,
      },
      blockers: blockerDocs
        .filter((b): b is Doc<"tasks"> => b != null)
        .map((b) => ({ _id: b._id, title: b.title, status: b.status })),
    };
  },
});

// Subtarefas de uma task (hierarquia via parentTaskId) + progresso
export const getSubtasks = query({
  args: { taskId: v.id("tasks") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return { subtasks: [], total: 0, completed: 0 };

    await requireAuth(ctx, task.organizationId);

    const subtasks = await ctx.db
      .query("tasks")
      .withIndex("by_parent_task", (q) => q.eq("parentTaskId", args.taskId))
      .collect();

    const enriched = await enrichTasks(ctx, subtasks);

    return {
      subtasks: enriched,
      total: subtasks.length,
      completed: subtasks.filter((s) => s.status === "completed").length,
    };
  },
});

// Get my tasks (assigned to current user)
export const getMyTasks = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const orgActive = await scanActiveOrgTasks(ctx, args.organizationId);
    const allTasks = await collectMyActiveTasks(
      ctx,
      args.organizationId,
      userMember._id,
      orgActive
    );

    // Sort: overdue first, then due today, then by priority
    const now = Date.now();
    const startOfDay = new Date().setHours(0, 0, 0, 0);
    const endOfDay = new Date().setHours(23, 59, 59, 999);

    allTasks.sort((a, b) => {
      const aOverdue = a.dueDate != null && a.dueDate < now ? 1 : 0;
      const bOverdue = b.dueDate != null && b.dueDate < now ? 1 : 0;
      if (aOverdue !== bOverdue) return bOverdue - aOverdue; // overdue first

      const aDueToday = a.dueDate != null && a.dueDate >= startOfDay && a.dueDate <= endOfDay ? 1 : 0;
      const bDueToday = b.dueDate != null && b.dueDate >= startOfDay && b.dueDate <= endOfDay ? 1 : 0;
      if (aDueToday !== bDueToday) return bDueToday - aDueToday; // due today second

      return (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
    });

    return await enrichTasks(ctx, allTasks);
  },
});

// Get tasks by lead
export const getTasksByLead = query({
  args: { leadId: v.id("leads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) return [];

    await requireAuth(ctx, lead.organizationId);

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_lead", (q) => q.eq("leadId", args.leadId))
      .order("desc")
      .take(200);

    const assigneeMap = await batchGet(ctx.db, tasks.map(t => t.assignedTo));

    return tasks.map(task => ({
      ...task,
      assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
    }));
  },
});

// Get tasks by contact
export const getTasksByContact = query({
  args: { contactId: v.id("contacts") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return [];

    await requireAuth(ctx, contact.organizationId);

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .order("desc")
      .take(200);

    const assigneeMap = await batchGet(ctx.db, tasks.map(t => t.assignedTo));

    return tasks.map(task => ({
      ...task,
      assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
    }));
  },
});

// Get task counts for sidebar badges / dashboard
export const getTaskCounts = query({
  args: {
    organizationId: v.id("organizations"),
    now: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const startOfDay = new Date(args.now).setHours(0, 0, 0, 0);
    const endOfDay = new Date(args.now).setHours(23, 59, 59, 999);

    // Agregados da org vêm da varredura limitada; o contador do próprio usuário
    // usa também o caminho indexado, para não sumir numa org grande.
    const allActive = await scanActiveOrgTasks(ctx, args.organizationId);
    const myTasks = await collectMyActiveTasks(
      ctx,
      args.organizationId,
      userMember._id,
      allActive
    );

    let overdue = 0;
    let dueToday = 0;
    let unassigned = 0;

    for (const task of allActive) {
      if (task.dueDate != null && task.dueDate < args.now && task.status !== "completed") {
        overdue++;
      }
      if (task.dueDate != null && task.dueDate >= startOfDay && task.dueDate <= endOfDay) {
        dueToday++;
      }
      if (readAssignees(task).length === 0) {
        unassigned++;
      }
    }

    const myPending = myTasks.length;

    return { overdue, dueToday, myPending, unassigned };
  },
});

// Search tasks (full-text)
export const searchTasks = query({
  args: {
    organizationId: v.id("organizations"),
    searchText: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const results = await ctx.db
      .query("tasks")
      .withSearchIndex("search_tasks", (q) =>
        q.search("searchText", args.searchText).eq("organizationId", args.organizationId)
      )
      .take(args.limit ?? 50);

    return await enrichTasks(ctx, results);
  },
});

// ===== Public Mutations =====

// Create task
export const createTask = mutation({
  args: {
    organizationId: v.id("organizations"),
    title: v.string(),
    type: taskTypeValidator,
    priority: taskPriorityValidator,
    activityType: v.optional(activityTypeValidator),
    description: v.optional(v.string()),
    dueDate: v.optional(v.number()),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    assignedTo: v.optional(v.id("teamMembers")),
    recurrence: v.optional(recurrenceValidator),
    checklist: v.optional(v.array(checklistItemValidator)),
    tags: v.optional(v.array(v.string())),
    // P1
    projectId: v.optional(v.id("taskProjects")),
    columnId: v.optional(v.id("taskColumns")),
    order: v.optional(v.number()),
    labelIds: v.optional(v.array(v.id("taskLabels"))),
    assigneeIds: v.optional(v.array(v.id("teamMembers"))),
    parentTaskId: v.optional(v.id("tasks")),
    blockedBy: v.optional(v.array(v.id("tasks"))),
    reminderMinutesBefore: v.optional(v.number()),
  },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const now = Date.now();

    // Responsáveis: assigneeIds é a fonte, assignedTo o espelho (backfill nos dois sentidos)
    const assigneeIds = await normalizeAssignees(
      ctx,
      args.organizationId,
      args.assigneeIds ?? (args.assignedTo ? [args.assignedTo] : [])
    );
    const assignedTo = assigneeIds[0];

    // Projeto / coluna / ordem
    let projectId = args.projectId;
    let columnId = args.columnId;
    let order = args.order;
    if (projectId) await validateProject(ctx, args.organizationId, projectId);
    if (columnId) {
      const column = await validateColumn(ctx, args.organizationId, columnId, projectId);
      projectId = column.projectId;
    } else if (projectId) {
      const column = await defaultColumnForProject(ctx, projectId);
      columnId = column?._id;
    }
    if (columnId && order === undefined) {
      order = await nextOrderInColumn(ctx, columnId);
    }

    if (args.parentTaskId) {
      await validateParentTask(ctx, args.organizationId, null, args.parentTaskId);
    }
    const blockedBy = args.blockedBy
      ? await normalizeBlockedBy(ctx, args.organizationId, null, args.blockedBy)
      : undefined;
    const labelIds = args.labelIds
      ? await normalizeLabelIds(ctx, args.organizationId, args.labelIds)
      : undefined;

    const searchExtras = await resolveSearchExtras(ctx, { labelIds, projectId });

    const taskId = await ctx.db.insert("tasks", {
      organizationId: args.organizationId,
      title: args.title,
      description: args.description,
      type: args.type,
      status: "pending",
      priority: args.priority,
      activityType: args.activityType,
      dueDate: args.dueDate,
      leadId: args.leadId,
      contactId: args.contactId,
      assignedTo,
      assigneeIds,
      createdBy: userMember._id,
      recurrence: args.recurrence,
      parentTaskId: args.parentTaskId,
      projectId,
      columnId,
      order,
      labelIds,
      blockedBy,
      reminderMinutesBefore: args.reminderMinutesBefore,
      checklist: args.checklist,
      tags: args.tags,
      searchText: buildTaskSearchText({
        title: args.title,
        description: args.description,
        tags: args.tags,
        labelNames: searchExtras.labelNames,
        projectName: searchExtras.projectName,
      }),
      createdAt: now,
      updatedAt: now,
    });

    // Schedule reminder if type=reminder and dueDate
    if (args.type === "reminder" && args.dueDate) {
      const delay = Math.max(0, args.dueDate - now);
      await ctx.scheduler.runAfter(delay, internal.tasks.triggerReminder, { taskId });
    }

    // Lembrete antecipado (dueDate - reminderMinutesBefore)
    await schedulePreDueReminder(ctx, taskId, args.dueDate, args.reminderMinutesBefore);

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "task",
      entityId: taskId,
      action: "create",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: { title: args.title, type: args.type },
      description: buildAuditDescription({ action: "create", entityType: "task", metadata: { title: args.title } }),
      severity: "medium",
      createdAt: now,
    });

    // Log activity if task is linked to a lead
    if (args.leadId) {
      await ctx.db.insert("activities", {
        organizationId: args.organizationId,
        leadId: args.leadId,
        type: "task_created",
        actorId: userMember._id,
        actorType: userMember.type === "ai" ? "ai" : "human",
        content: `Task "${args.title}" created`,
        metadata: { taskId, type: args.type },
        createdAt: now,
      });
    }

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "task.created",
      payload: { taskId, title: args.title, type: args.type, priority: args.priority, dueDate: args.dueDate, assignedTo, assigneeIds, projectId, columnId },
    });

    // Notificação (in-app + e-mail) para cada responsável, exceto o ator
    await notifyNewAssignees(ctx, {
      task: { _id: taskId, title: args.title, dueDate: args.dueDate, organizationId: args.organizationId },
      assignees: assigneeIds,
      previousAssignees: [],
      actor: userMember,
    });

    return taskId;
  },
});

// Update task
export const updateTask = mutation({
  args: {
    taskId: v.id("tasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    priority: v.optional(taskPriorityValidator),
    activityType: v.optional(activityTypeValidator),
    dueDate: v.optional(v.number()),
    // `null` limpa o vínculo com lead/contato
    leadId: v.optional(v.union(v.id("leads"), v.null())),
    contactId: v.optional(v.union(v.id("contacts"), v.null())),
    status: v.optional(taskStatusValidator),
    tags: v.optional(v.array(v.string())),
    recurrence: v.optional(recurrenceValidator),
    // P1 — `null` limpa o vínculo (projeto / subtarefa)
    projectId: v.optional(v.union(v.id("taskProjects"), v.null())),
    columnId: v.optional(v.id("taskColumns")),
    order: v.optional(v.number()),
    labelIds: v.optional(v.array(v.id("taskLabels"))),
    assigneeIds: v.optional(v.array(v.id("teamMembers"))),
    assignedTo: v.optional(v.union(v.id("teamMembers"), v.null())),
    parentTaskId: v.optional(v.union(v.id("tasks"), v.null())),
    blockedBy: v.optional(v.array(v.id("tasks"))),
    reminderMinutesBefore: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    const fields = ["title", "description", "priority", "activityType", "dueDate", "status", "tags", "recurrence", "reminderMinutesBefore"] as const;
    for (const field of fields) {
      if (args[field] !== undefined && JSON.stringify(args[field]) !== JSON.stringify((task as any)[field])) {
        changes[field] = args[field];
        before[field] = (task as any)[field];
      }
    }

    // Lead/contato: `null` limpa o vínculo; id novo precisa ser da mesma org
    for (const field of ["leadId", "contactId"] as const) {
      const value = args[field];
      if (value === null) {
        if ((task as any)[field] !== undefined) {
          before[field] = (task as any)[field];
          changes[field] = undefined;
        }
      } else if (value !== undefined && value !== (task as any)[field]) {
        const linked = await ctx.db.get(value as any);
        if (!linked || (linked as any).organizationId !== task.organizationId) {
          throw new Error(field === "leadId" ? "Lead não encontrado" : "Contato não encontrado");
        }
        before[field] = (task as any)[field];
        changes[field] = value;
      }
    }

    // ---- P1: responsáveis (assigneeIds é a fonte, assignedTo o espelho) ----
    const previousAssignees = readAssignees(task);
    let nextAssignees: Id<"teamMembers">[] | null = null;
    if (args.assigneeIds !== undefined) {
      nextAssignees = await normalizeAssignees(ctx, task.organizationId, args.assigneeIds);
    } else if (args.assignedTo !== undefined) {
      nextAssignees = args.assignedTo
        ? await normalizeAssignees(ctx, task.organizationId, [args.assignedTo])
        : [];
    }
    if (nextAssignees && JSON.stringify(nextAssignees) !== JSON.stringify(previousAssignees)) {
      changes.assigneeIds = nextAssignees;
      changes.assignedTo = nextAssignees[0];
      before.assigneeIds = previousAssignees;
      before.assignedTo = task.assignedTo;
    }

    // ---- P1: labels ----
    if (args.labelIds !== undefined) {
      const labelIds = await normalizeLabelIds(ctx, task.organizationId, args.labelIds);
      if (JSON.stringify(labelIds) !== JSON.stringify(task.labelIds ?? [])) {
        changes.labelIds = labelIds;
        before.labelIds = task.labelIds;
      }
    }

    // ---- P1: dependências ----
    if (args.blockedBy !== undefined) {
      const blockedBy = await normalizeBlockedBy(ctx, task.organizationId, args.taskId, args.blockedBy);
      if (JSON.stringify(blockedBy) !== JSON.stringify(task.blockedBy ?? [])) {
        changes.blockedBy = blockedBy;
        before.blockedBy = task.blockedBy;
      }
    }

    // ---- P1: hierarquia ----
    if (args.parentTaskId !== undefined) {
      if (args.parentTaskId === null) {
        if (task.parentTaskId) {
          changes.parentTaskId = undefined;
          before.parentTaskId = task.parentTaskId;
        }
      } else if (args.parentTaskId !== task.parentTaskId) {
        await validateParentTask(ctx, task.organizationId, args.taskId, args.parentTaskId);
        changes.parentTaskId = args.parentTaskId;
        before.parentTaskId = task.parentTaskId;
      }
    }

    // ---- P1: projeto / coluna / ordem ----
    if (args.projectId === null) {
      if (task.projectId) {
        before.projectId = task.projectId;
        changes.projectId = undefined;
        changes.columnId = undefined;
        changes.order = undefined;
      }
    } else if (args.projectId !== undefined || args.columnId !== undefined) {
      let projectId = args.projectId ?? task.projectId;
      let columnId = args.columnId;
      if (projectId) await validateProject(ctx, task.organizationId, projectId);
      if (columnId) {
        const column = await validateColumn(ctx, task.organizationId, columnId, args.projectId ?? undefined);
        projectId = column.projectId;
      } else if (projectId && projectId !== task.projectId) {
        const column = await defaultColumnForProject(ctx, projectId);
        columnId = column?._id;
      }
      if (projectId !== task.projectId) {
        before.projectId = task.projectId;
        changes.projectId = projectId;
      }
      if (columnId && columnId !== task.columnId) {
        before.columnId = task.columnId;
        changes.columnId = columnId;
        changes.order = args.order ?? (await nextOrderInColumn(ctx, columnId));
      }
    }
    if (args.order !== undefined && !("order" in changes) && args.order !== task.order) {
      before.order = task.order;
      changes.order = args.order;
    }

    if (Object.keys(changes).length === 0) return null;

    // Concluir via status também move para a done column do projeto
    if (changes.status === "completed" && task.status !== "completed") {
      if (changes.completedAt === undefined) changes.completedAt = now;
      const effectiveProjectId = "projectId" in changes ? changes.projectId : task.projectId;
      if (effectiveProjectId && !("columnId" in changes)) {
        const doneColumn = await doneColumnForProject(ctx, effectiveProjectId);
        if (doneColumn && task.columnId !== doneColumn._id) {
          changes.columnId = doneColumn._id;
          changes.order = await nextOrderInColumn(ctx, doneColumn._id);
        }
      }
    }

    // Rebuild searchText if title/description/tags/labels/project changed
    if (changes.title || changes.description || changes.tags || changes.labelIds || "projectId" in changes) {
      const searchExtras = await resolveSearchExtras(ctx, {
        labelIds: changes.labelIds ?? task.labelIds,
        projectId: "projectId" in changes ? changes.projectId : task.projectId,
      });
      changes.searchText = buildTaskSearchText({
        title: changes.title ?? task.title,
        description: changes.description ?? task.description,
        tags: changes.tags ?? task.tags,
        labelNames: searchExtras.labelNames,
        projectName: searchExtras.projectName,
      });
    }

    // Lembrete antecipado: reagenda quando dueDate ou a antecedência mudam
    const reminderChanged = "dueDate" in changes || "reminderMinutesBefore" in changes;
    if (reminderChanged) {
      changes.preDueReminderSentAt = undefined;
    }

    await ctx.db.patch(args.taskId, {
      ...changes,
      updatedAt: now,
    });

    if (reminderChanged) {
      await schedulePreDueReminder(
        ctx,
        args.taskId,
        changes.dueDate ?? task.dueDate,
        changes.reminderMinutesBefore ?? task.reminderMinutesBefore
      );
    }

    if (nextAssignees) {
      await notifyNewAssignees(ctx, {
        task: {
          _id: args.taskId,
          title: changes.title ?? task.title,
          dueDate: changes.dueDate ?? task.dueDate,
          organizationId: task.organizationId,
        },
        assignees: nextAssignees,
        previousAssignees,
        actor: userMember,
      });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before, after: changes },
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before, after: changes } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.updated",
      payload: { taskId: args.taskId, changes },
    });

    return null;
  },
});

// Complete task
export const completeTask = mutation({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    // Fluxo único: patch + done column do projeto + recorrência + side effects
    await applyCompletion(ctx, task, userMember, Date.now());

    return null;
  },
});

// Mover task entre colunas do kanban (done column completa; sair dela reabre)
export const moveTaskToColumn = mutation({
  args: {
    taskId: v.id("tasks"),
    columnId: v.id("taskColumns"),
    order: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const column = await validateColumn(ctx, task.organizationId, args.columnId);
    const now = Date.now();
    const order = args.order ?? (await nextOrderInColumn(ctx, args.columnId));

    const previousColumn = task.columnId ? await ctx.db.get(task.columnId) : null;
    const wasDone = previousColumn?.isDoneColumn === true;
    // Arrastar para/da done column também muda o status: a auditoria registra
    // a transição, não só a coluna.
    let statusAfter: string | undefined;

    if (column.isDoneColumn) {
      // Entrar na done column completa a task (mesmo fluxo do completeTask)
      if (task.projectId !== column.projectId) {
        await ctx.db.patch(args.taskId, { projectId: column.projectId, updatedAt: now });
      }
      const fresh = (await ctx.db.get(args.taskId))!;
      await applyCompletion(ctx, fresh, userMember, now, { columnId: args.columnId, order });
      if (task.status !== "completed") statusAfter = "completed";
    } else {
      const patch: Record<string, any> = {
        columnId: args.columnId,
        projectId: column.projectId,
        order,
        updatedAt: now,
      };
      // Sair da done column reabre a task
      if (wasDone && task.status === "completed") {
        patch.status = "pending";
        patch.completedAt = undefined;
        statusAfter = "pending";
      }
      await ctx.db.patch(args.taskId, patch);
    }

    const auditChanges = {
      before: {
        columnId: task.columnId,
        order: task.order,
        ...(statusAfter ? { status: task.status } : {}),
      },
      after: {
        columnId: args.columnId,
        order,
        ...(statusAfter ? { status: statusAfter } : {}),
      },
    };

    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: auditChanges,
      metadata: { title: task.title, columnName: column.name },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: auditChanges }),
      severity: statusAfter ? "medium" : "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.moved",
      payload: {
        taskId: args.taskId,
        title: task.title,
        fromColumnId: task.columnId,
        toColumnId: args.columnId,
        projectId: column.projectId,
        order,
      },
    });

    return null;
  },
});

// Reordenar manualmente dentro da coluna
export const reorderTask = mutation({
  args: {
    taskId: v.id("tasks"),
    order: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    await requireAuth(ctx, task.organizationId);

    await ctx.db.patch(args.taskId, { order: args.order, updatedAt: Date.now() });

    return null;
  },
});

// Definir os responsáveis (multi-assignee); assignedTo vira o espelho de [0]
export const setAssignees = mutation({
  args: {
    taskId: v.id("tasks"),
    memberIds: v.array(v.id("teamMembers")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const now = Date.now();
    const previousAssignees = readAssignees(task);
    const assignees = await normalizeAssignees(ctx, task.organizationId, args.memberIds);

    await ctx.db.patch(args.taskId, {
      assigneeIds: assignees,
      assignedTo: assignees[0],
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "assign",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: {
        before: { assigneeIds: previousAssignees, assignedTo: task.assignedTo },
        after: { assigneeIds: assignees, assignedTo: assignees[0] },
      },
      metadata: { title: task.title, assigneeCount: assignees.length },
      description: buildAuditDescription({ action: "assign", entityType: "task", metadata: { title: task.title }, changes: { before: { assignedTo: task.assignedTo }, after: { assignedTo: assignees[0] } } }),
      severity: "medium",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.assigned",
      payload: {
        taskId: args.taskId,
        oldAssignedTo: task.assignedTo,
        newAssignedTo: assignees[0],
        assigneeIds: assignees,
      },
    });

    await notifyNewAssignees(ctx, {
      task: { _id: args.taskId, title: task.title, dueDate: task.dueDate, organizationId: task.organizationId },
      assignees,
      previousAssignees,
      actor: userMember,
    });

    return null;
  },
});

// Cancel task
export const cancelTask = mutation({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const now = Date.now();

    await ctx.db.patch(args.taskId, {
      status: "cancelled",
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: task.status }, after: { status: "cancelled" } },
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before: { status: task.status }, after: { status: "cancelled" } } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.cancelled",
      payload: { taskId: args.taskId, title: task.title },
    });

    return null;
  },
});

// Assign task
export const assignTask = mutation({
  args: {
    taskId: v.id("tasks"),
    assignedTo: v.optional(v.id("teamMembers")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const oldAssignedTo = task.assignedTo;
    const now = Date.now();

    // Caso especial de setAssignees: um único responsável (ou nenhum)
    const previousAssignees = readAssignees(task);
    const assignees = args.assignedTo
      ? await normalizeAssignees(ctx, task.organizationId, [args.assignedTo])
      : [];
    const newAssignee = args.assignedTo ? await ctx.db.get(args.assignedTo) : null;

    await ctx.db.patch(args.taskId, {
      assignedTo: assignees[0],
      assigneeIds: assignees,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "assign",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: {
        before: { assignedTo: oldAssignedTo },
        after: { assignedTo: args.assignedTo },
      },
      metadata: { title: task.title, assigneeName: newAssignee?.name },
      description: buildAuditDescription({ action: "assign", entityType: "task", metadata: { title: task.title, assigneeName: newAssignee?.name }, changes: { before: { assignedTo: oldAssignedTo }, after: { assignedTo: args.assignedTo } } }),
      severity: "medium",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.assigned",
      payload: { taskId: args.taskId, oldAssignedTo, newAssignedTo: args.assignedTo, assigneeIds: assignees },
    });

    // Notificação in-app + e-mail (só responsável novo, nunca o ator)
    await notifyNewAssignees(ctx, {
      task: { _id: args.taskId, title: task.title, dueDate: task.dueDate, organizationId: task.organizationId },
      assignees,
      previousAssignees,
      actor: userMember,
    });

    return null;
  },
});

// Snooze task
export const snoozeTask = mutation({
  args: {
    taskId: v.id("tasks"),
    snoozedUntil: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const now = Date.now();

    await ctx.db.patch(args.taskId, {
      snoozedUntil: args.snoozedUntil,
      reminderTriggered: false,
      updatedAt: now,
    });

    // Reschedule reminder
    if (task.type === "reminder") {
      const delay = Math.max(0, args.snoozedUntil - now);
      await ctx.scheduler.runAfter(delay, internal.tasks.triggerReminder, { taskId: args.taskId });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { snoozedUntil: task.snoozedUntil }, after: { snoozedUntil: args.snoozedUntil } },
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before: { snoozedUntil: task.snoozedUntil }, after: { snoozedUntil: args.snoozedUntil } } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.snoozed",
      payload: { taskId: args.taskId, snoozedUntil: args.snoozedUntil },
    });

    return null;
  },
});

// Delete task
export const deleteTask = mutation({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    const now = Date.now();

    // Log audit entry before deletion
    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "delete",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "delete", entityType: "task", metadata: { title: task.title } }),
      severity: "high",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.deleted",
      payload: { taskId: args.taskId, title: task.title },
    });

    // Órfã as subtarefas e limpa a task das dependências alheias
    await unlinkTaskReferences(ctx, [task]);

    // Cascade delete comments
    const comments = await ctx.db
      .query("taskComments")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    for (const comment of comments) {
      await ctx.db.delete(comment._id);
    }

    await ctx.db.delete(args.taskId);

    return null;
  },
});

// Update checklist
export const updateChecklist = mutation({
  args: {
    taskId: v.id("tasks"),
    checklist: v.array(checklistItemValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    await requireAuth(ctx, task.organizationId);

    await ctx.db.patch(args.taskId, {
      checklist: args.checklist,
      updatedAt: Date.now(),
    });

    return null;
  },
});

// Toggle checklist item
export const toggleChecklistItem = mutation({
  args: {
    taskId: v.id("tasks"),
    itemId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    await requireAuth(ctx, task.organizationId);

    const checklist = (task.checklist || []).map(item =>
      item.id === args.itemId ? { ...item, completed: !item.completed } : item
    );

    await ctx.db.patch(args.taskId, {
      checklist,
      updatedAt: Date.now(),
    });

    return null;
  },
});

// Bulk update tasks
export const bulkUpdateTasks = mutation({
  args: {
    taskIds: v.array(v.id("tasks")),
    action: v.union(v.literal("complete"), v.literal("cancel"), v.literal("assign"), v.literal("delete")),
    assignedTo: v.optional(v.id("teamMembers")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.taskIds.length === 0) return null;

    // Auth from first task
    const firstTask = await ctx.db.get(args.taskIds[0]);
    if (!firstTask) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, firstTask.organizationId);
    const organizationId = firstTask.organizationId;
    const now = Date.now();

    const assignees = args.assignedTo
      ? await normalizeAssignees(ctx, organizationId, [args.assignedTo])
      : [];

    const toDelete: Doc<"tasks">[] = [];
    const processedIds: Id<"tasks">[] = [];

    for (const taskId of args.taskIds) {
      const task = await ctx.db.get(taskId);
      // A autorização vale para a org da primeira task: ids de outra org saem
      if (!task || task.organizationId !== organizationId) continue;
      processedIds.push(taskId);

      if (args.action === "complete") {
        // Mesmo fluxo do completeTask: done column, webhook por task, recorrência
        await applyCompletion(ctx, task, userMember, now);
      } else if (args.action === "cancel") {
        await ctx.db.patch(taskId, { status: "cancelled", updatedAt: now });
      } else if (args.action === "assign") {
        await ctx.db.patch(taskId, {
          assignedTo: assignees[0],
          assigneeIds: assignees,
          updatedAt: now,
        });
      } else if (args.action === "delete") {
        toDelete.push(task);
      }
    }

    if (toDelete.length > 0) {
      await unlinkTaskReferences(ctx, toDelete);
      for (const task of toDelete) {
        const comments = await ctx.db.query("taskComments")
          .withIndex("by_task", (q) => q.eq("taskId", task._id))
          .collect();
        for (const comment of comments) {
          await ctx.db.delete(comment._id);
        }
        await ctx.db.delete(task._id);
      }
    }

    if (processedIds.length === 0) return null;

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId,
      entityType: "task",
      entityId: processedIds[0],
      action: args.action === "delete" ? "delete" : "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: { bulkAction: args.action, count: processedIds.length },
      description: `Bulk ${args.action} on ${processedIds.length} tasks`,
      severity: args.action === "delete" ? "high" : "medium",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId,
      event: `task.bulk_${args.action}`,
      payload: { taskIds: processedIds, action: args.action },
    });

    return null;
  },
});

// ===== Internal Functions (for HTTP API) =====

// Internal: Get tasks (paginated)
export const internalGetTasks = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    status: v.optional(taskStatusValidator),
    priority: v.optional(taskPriorityValidator),
    assignedTo: v.optional(v.id("teamMembers")),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    type: v.optional(taskTypeValidator),
    activityType: v.optional(activityTypeValidator),
    dueBefore: v.optional(v.number()),
    dueAfter: v.optional(v.number()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 200, 500);
    const cursor = parseCursor(args.cursor);

    // Filtro por responsável: mesmo critério do app (primário OU secundário),
    // então não dá para delegar a paginação ao índice.
    if (args.assignedTo) {
      const candidates = await collectTasksForAssignee(
        ctx,
        args.organizationId,
        args.assignedTo,
        args.status
      );
      candidates.sort((a, b) => b._creationTime - a._creationTime);

      let filteredByAssignee = cursor
        ? candidates.filter(
            (t) =>
              t._creationTime < cursor.ts ||
              (t._creationTime === cursor.ts && t._id < cursor.id)
          )
        : candidates;

      if (args.type) filteredByAssignee = filteredByAssignee.filter(t => t.type === args.type);
      if (args.leadId) filteredByAssignee = filteredByAssignee.filter(t => t.leadId === args.leadId);
      if (args.contactId) filteredByAssignee = filteredByAssignee.filter(t => t.contactId === args.contactId);
      if (args.priority) filteredByAssignee = filteredByAssignee.filter(t => t.priority === args.priority);
      if (args.activityType) filteredByAssignee = filteredByAssignee.filter(t => t.activityType === args.activityType);
      if (args.dueBefore) filteredByAssignee = filteredByAssignee.filter(t => t.dueDate != null && t.dueDate <= args.dueBefore!);
      if (args.dueAfter) filteredByAssignee = filteredByAssignee.filter(t => t.dueDate != null && t.dueDate >= args.dueAfter!);

      const page = paginateResults(filteredByAssignee, limit, buildCursorFromCreationTime);
      return await withTaskRelations(ctx, page.items, page.nextCursor, page.hasMore);
    }

    let q;
    if (args.status) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_status", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("status", args.status!)
      );
    } else if (args.type) {
      q = ctx.db.query("tasks").withIndex("by_organization_and_type", (idx) =>
        idx.eq("organizationId", args.organizationId).eq("type", args.type!)
      );
    } else if (args.leadId) {
      q = ctx.db.query("tasks").withIndex("by_lead", (idx) =>
        idx.eq("leadId", args.leadId!)
      );
    } else if (args.contactId) {
      q = ctx.db.query("tasks").withIndex("by_contact", (idx) =>
        idx.eq("contactId", args.contactId!)
      );
    } else {
      q = ctx.db.query("tasks").withIndex("by_organization", (idx) =>
        idx.eq("organizationId", args.organizationId)
      );
    }

    const rawTasks = await q.order("desc").take(limit + 1 + (cursor ? limit * 3 : 0));

    // Apply cursor filter
    let filtered = rawTasks;
    if (cursor) {
      filtered = rawTasks.filter(
        (t) =>
          t._creationTime < cursor.ts ||
          (t._creationTime === cursor.ts && t._id < cursor.id)
      );
    }

    // Apply remaining JS filters
    if (args.priority) filtered = filtered.filter(t => t.priority === args.priority);
    if (args.activityType) filtered = filtered.filter(t => t.activityType === args.activityType);
    if (args.dueBefore) filtered = filtered.filter(t => t.dueDate != null && t.dueDate <= args.dueBefore!);
    if (args.dueAfter) filtered = filtered.filter(t => t.dueDate != null && t.dueDate >= args.dueAfter!);

    const page = paginateResults(filtered, limit, buildCursorFromCreationTime);

    return await withTaskRelations(ctx, page.items, page.nextCursor, page.hasMore);
  },
});

// Internal: Get single task
export const internalGetTask = internalQuery({
  args: {
    taskId: v.id("tasks"),
    // Org da API key autenticada — sem isso uma key da Org A leria task da Org B
    organizationId: v.id("organizations"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.organizationId !== args.organizationId) return null;

    const [assignee, lead, contact, creator] = await Promise.all([
      task.assignedTo ? ctx.db.get(task.assignedTo) : null,
      task.leadId ? ctx.db.get(task.leadId) : null,
      task.contactId ? ctx.db.get(task.contactId) : null,
      ctx.db.get(task.createdBy),
    ]);

    return { ...task, assignee, lead, contact, creator };
  },
});

// Internal: Get my tasks (for API — uses teamMemberId)
export const internalGetMyTasks = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    // Mesmo critério do app: responsável primário (índice) + secundário
    // (assigneeIds, via varredura org-scoped).
    const orgActive = await scanActiveOrgTasks(ctx, args.organizationId);
    const allTasks = await collectMyActiveTasks(
      ctx,
      args.organizationId,
      args.teamMemberId,
      orgActive
    );

    const now = Date.now();
    allTasks.sort((a, b) => {
      const aOverdue = a.dueDate != null && a.dueDate < now ? 1 : 0;
      const bOverdue = b.dueDate != null && b.dueDate < now ? 1 : 0;
      if (aOverdue !== bOverdue) return bOverdue - aOverdue;
      return (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
    });

    const [leadMap, contactMap] = await Promise.all([
      batchGet(ctx.db, allTasks.map(t => t.leadId)),
      batchGet(ctx.db, allTasks.map(t => t.contactId)),
    ]);

    return allTasks.map(task => ({
      ...task,
      lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
      contact: task.contactId ? contactMap.get(task.contactId) ?? null : null,
    }));
  },
});

// Internal: Get overdue tasks
export const internalGetOverdueTasks = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 200, 500);
    const cursor = parseCursor(args.cursor);
    const now = Date.now();

    const rawTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_due_date", (q) =>
        q.eq("organizationId", args.organizationId).lt("dueDate", now)
      )
      .order("desc")
      .take(limit + 1 + (cursor ? limit * 3 : 0));

    // Only pending/in_progress
    let filtered = rawTasks.filter(t => t.status === "pending" || t.status === "in_progress");

    if (cursor) {
      filtered = filtered.filter(
        (t) =>
          t._creationTime < cursor.ts ||
          (t._creationTime === cursor.ts && t._id < cursor.id)
      );
    }

    const { items: tasks, nextCursor, hasMore } = paginateResults(
      filtered, limit, buildCursorFromCreationTime
    );

    const [assigneeMap, leadMap] = await Promise.all([
      batchGet(ctx.db, tasks.map(t => t.assignedTo)),
      batchGet(ctx.db, tasks.map(t => t.leadId)),
    ]);

    const tasksWithData = tasks.map(task => ({
      ...task,
      assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
      lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
    }));

    return { tasks: tasksWithData, nextCursor, hasMore };
  },
});

// Internal: Search tasks
export const internalSearchTasks = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    searchText: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("tasks")
      .withSearchIndex("search_tasks", (q) =>
        q.search("searchText", args.searchText).eq("organizationId", args.organizationId)
      )
      .take(args.limit ?? 50);

    const [assigneeMap, leadMap, contactMap] = await Promise.all([
      batchGet(ctx.db, results.map(t => t.assignedTo)),
      batchGet(ctx.db, results.map(t => t.leadId)),
      batchGet(ctx.db, results.map(t => t.contactId)),
    ]);

    return results.map(task => ({
      ...task,
      assignee: task.assignedTo ? assigneeMap.get(task.assignedTo) ?? null : null,
      lead: task.leadId ? leadMap.get(task.leadId) ?? null : null,
      contact: task.contactId ? contactMap.get(task.contactId) ?? null : null,
    }));
  },
});

// Internal: Create task
export const internalCreateTask = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    title: v.string(),
    type: taskTypeValidator,
    priority: taskPriorityValidator,
    activityType: v.optional(activityTypeValidator),
    description: v.optional(v.string()),
    dueDate: v.optional(v.number()),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    assignedTo: v.optional(v.id("teamMembers")),
    recurrence: v.optional(recurrenceValidator),
    checklist: v.optional(v.array(checklistItemValidator)),
    tags: v.optional(v.array(v.string())),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");
    if (teamMember.organizationId !== args.organizationId) {
      throw new Error("Team member not found");
    }

    const now = Date.now();

    // O responsável vem do cliente da API: tem que ser da org da task
    const assigneeIds = args.assignedTo
      ? await normalizeAssignees(ctx, args.organizationId, [args.assignedTo])
      : [];

    const taskId = await ctx.db.insert("tasks", {
      organizationId: args.organizationId,
      title: args.title,
      description: args.description,
      type: args.type,
      status: "pending",
      priority: args.priority,
      activityType: args.activityType,
      dueDate: args.dueDate,
      leadId: args.leadId,
      contactId: args.contactId,
      assignedTo: assigneeIds[0],
      assigneeIds,
      createdBy: args.teamMemberId,
      recurrence: args.recurrence,
      checklist: args.checklist,
      tags: args.tags,
      searchText: buildTaskSearchText({ title: args.title, description: args.description, tags: args.tags }),
      createdAt: now,
      updatedAt: now,
    });

    // Schedule reminder
    if (args.type === "reminder" && args.dueDate) {
      const delay = Math.max(0, args.dueDate - now);
      await ctx.scheduler.runAfter(delay, internal.tasks.triggerReminder, { taskId });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "task",
      entityId: taskId,
      action: "create",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: { title: args.title, type: args.type },
      description: buildAuditDescription({ action: "create", entityType: "task", metadata: { title: args.title } }),
      severity: "medium",
      createdAt: now,
    });

    // Log activity if linked to lead
    if (args.leadId) {
      await ctx.db.insert("activities", {
        organizationId: args.organizationId,
        leadId: args.leadId,
        type: "task_created",
        actorId: teamMember._id,
        actorType: teamMember.type === "ai" ? "ai" : "human",
        content: `Task "${args.title}" created`,
        metadata: { taskId, type: args.type },
        createdAt: now,
      });
    }

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "task.created",
      payload: { taskId, title: args.title, type: args.type, priority: args.priority, dueDate: args.dueDate, assignedTo: args.assignedTo },
    });

    // Notificação (in-app + e-mail) para o responsável, exceto o ator
    if (assigneeIds.length > 0) {
      await notifyNewAssignees(ctx, {
        task: { _id: taskId, title: args.title, dueDate: args.dueDate, organizationId: args.organizationId },
        assignees: assigneeIds,
        previousAssignees: [],
        actor: teamMember,
      });
    }

    return taskId;
  },
});

// Internal: Update task
export const internalUpdateTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    priority: v.optional(taskPriorityValidator),
    activityType: v.optional(activityTypeValidator),
    dueDate: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const task = await requireTaskOfMember(ctx, args.taskId, teamMember);

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    const fields = ["title", "description", "priority", "activityType", "dueDate", "tags"] as const;
    for (const field of fields) {
      if (args[field] !== undefined && JSON.stringify(args[field]) !== JSON.stringify((task as any)[field])) {
        changes[field] = args[field];
        before[field] = (task as any)[field];
      }
    }

    if (Object.keys(changes).length === 0) return null;

    if (changes.title || changes.description || changes.tags) {
      const searchExtras = await resolveSearchExtras(ctx, {
        labelIds: task.labelIds,
        projectId: task.projectId,
      });
      changes.searchText = buildTaskSearchText({
        title: changes.title ?? task.title,
        description: changes.description ?? task.description,
        tags: changes.tags ?? task.tags,
        labelNames: searchExtras.labelNames,
        projectName: searchExtras.projectName,
      });
    }

    // Mudou a data: o lembrete antecipado agendado vira obsoleto e é reagendado
    if ("dueDate" in changes) {
      changes.preDueReminderSentAt = undefined;
    }

    await ctx.db.patch(args.taskId, { ...changes, updatedAt: now });

    if ("dueDate" in changes) {
      await schedulePreDueReminder(ctx, args.taskId, changes.dueDate, task.reminderMinutesBefore);
    }

    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before, after: changes },
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before, after: changes } }),
      severity: "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.updated",
      payload: { taskId: args.taskId, changes },
    });

    return null;
  },
});

// Internal: Complete task
export const internalCompleteTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const task = await requireTaskOfMember(ctx, args.taskId, teamMember);

    await applyCompletion(ctx, task, teamMember, Date.now());

    return null;
  },
});

// Internal: Delete task
export const internalDeleteTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const task = await requireTaskOfMember(ctx, args.taskId, teamMember);

    const now = Date.now();

    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "delete",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "delete", entityType: "task", metadata: { title: task.title } }),
      severity: "high",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.deleted",
      payload: { taskId: args.taskId, title: task.title },
    });

    await unlinkTaskReferences(ctx, [task]);

    const comments = await ctx.db.query("taskComments")
      .withIndex("by_task", (q) => q.eq("taskId", args.taskId))
      .collect();
    for (const comment of comments) {
      await ctx.db.delete(comment._id);
    }

    await ctx.db.delete(args.taskId);

    return null;
  },
});

// Internal: Assign task
export const internalAssignTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    assignedTo: v.optional(v.id("teamMembers")),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const task = await requireTaskOfMember(ctx, args.taskId, teamMember);

    const oldAssignedTo = task.assignedTo;
    const previousAssignees = readAssignees(task);
    const now = Date.now();
    // O responsável vem do cliente da API: tem que ser da org da task
    const assignees = args.assignedTo
      ? await normalizeAssignees(ctx, task.organizationId, [args.assignedTo])
      : [];
    const newAssignee = assignees[0] ? await ctx.db.get(assignees[0]) : null;

    await ctx.db.patch(args.taskId, {
      assignedTo: assignees[0],
      assigneeIds: assignees,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "assign",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before: { assignedTo: oldAssignedTo }, after: { assignedTo: args.assignedTo } },
      metadata: { title: task.title, assigneeName: newAssignee?.name },
      description: buildAuditDescription({ action: "assign", entityType: "task", metadata: { title: task.title, assigneeName: newAssignee?.name }, changes: { before: { assignedTo: oldAssignedTo }, after: { assignedTo: args.assignedTo } } }),
      severity: "medium",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.assigned",
      payload: { taskId: args.taskId, oldAssignedTo, newAssignedTo: args.assignedTo },
    });

    // Notificação in-app + e-mail (só responsável novo, nunca o ator)
    if (assignees.length > 0) {
      await notifyNewAssignees(ctx, {
        task: { _id: args.taskId, title: task.title, dueDate: task.dueDate, organizationId: task.organizationId },
        assignees,
        previousAssignees,
        actor: teamMember,
      });
    }

    return null;
  },
});

// Internal: Snooze task
export const internalSnoozeTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    snoozedUntil: v.number(),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const task = await requireTaskOfMember(ctx, args.taskId, teamMember);

    const now = Date.now();

    await ctx.db.patch(args.taskId, {
      snoozedUntil: args.snoozedUntil,
      reminderTriggered: false,
      updatedAt: now,
    });

    if (task.type === "reminder") {
      const delay = Math.max(0, args.snoozedUntil - now);
      await ctx.scheduler.runAfter(delay, internal.tasks.triggerReminder, { taskId: args.taskId });
    }

    await ctx.db.insert("auditLogs", {
      organizationId: task.organizationId,
      entityType: "task",
      entityId: args.taskId,
      action: "update",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before: { snoozedUntil: task.snoozedUntil }, after: { snoozedUntil: args.snoozedUntil } },
      metadata: { title: task.title },
      description: buildAuditDescription({ action: "update", entityType: "task", metadata: { title: task.title }, changes: { before: { snoozedUntil: task.snoozedUntil }, after: { snoozedUntil: args.snoozedUntil } } }),
      severity: "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.snoozed",
      payload: { taskId: args.taskId, snoozedUntil: args.snoozedUntil },
    });

    return null;
  },
});

// Internal: Bulk update
export const internalBulkUpdate = internalMutation({
  args: {
    taskIds: v.array(v.id("tasks")),
    action: v.union(v.literal("complete"), v.literal("cancel"), v.literal("assign"), v.literal("delete")),
    assignedTo: v.optional(v.id("teamMembers")),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    if (args.taskIds.length === 0) return null;

    const now = Date.now();
    // O lote é sempre da org de quem age: ids de outro tenant são ignorados.
    const organizationId = teamMember.organizationId;
    const toDelete: Doc<"tasks">[] = [];
    const processedIds: Id<"tasks">[] = [];

    for (const taskId of args.taskIds) {
      const task = await ctx.db.get(taskId);
      if (!task || task.organizationId !== organizationId) continue;
      processedIds.push(taskId);

      if (args.action === "complete") {
        // Mesmo fluxo do completeTask: done column, webhook por task, recorrência
        await applyCompletion(ctx, task, teamMember, now);
      } else if (args.action === "cancel") {
        await ctx.db.patch(taskId, { status: "cancelled", updatedAt: now });
      } else if (args.action === "assign") {
        const assignees = args.assignedTo
          ? await normalizeAssignees(ctx, task.organizationId, [args.assignedTo])
          : [];
        await ctx.db.patch(taskId, {
          assignedTo: assignees[0],
          assigneeIds: assignees,
          updatedAt: now,
        });
      } else if (args.action === "delete") {
        toDelete.push(task);
      }
    }

    if (toDelete.length > 0) {
      await unlinkTaskReferences(ctx, toDelete);
      for (const task of toDelete) {
        const comments = await ctx.db.query("taskComments")
          .withIndex("by_task", (q) => q.eq("taskId", task._id))
          .collect();
        for (const comment of comments) {
          await ctx.db.delete(comment._id);
        }
        await ctx.db.delete(task._id);
      }
    }

    if (processedIds.length > 0) {
      await ctx.db.insert("auditLogs", {
        organizationId,
        entityType: "task",
        entityId: processedIds[0],
        action: args.action === "delete" ? "delete" : "update",
        actorId: teamMember._id,
        actorType: teamMember.type === "ai" ? "ai" : "human",
        metadata: { bulkAction: args.action, count: processedIds.length },
        description: `Bulk ${args.action} on ${processedIds.length} tasks`,
        severity: args.action === "delete" ? "high" : "medium",
        createdAt: now,
      });

      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId,
        event: `task.bulk_${args.action}`,
        payload: { taskIds: processedIds, action: args.action },
      });
    }

    return null;
  },
});

// Internal: Trigger reminder (idempotent)
export const triggerReminder = internalMutation({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;

    // Idempotent checks
    if (task.status !== "pending" && task.status !== "in_progress") return null;
    if (task.reminderTriggered) return null;

    // Check snooze
    const now = Date.now();
    if (task.snoozedUntil && task.snoozedUntil > now) return null;

    await ctx.db.patch(args.taskId, {
      reminderTriggered: true,
      updatedAt: now,
    });

    // Log activity if linked to lead
    if (task.leadId) {
      await ctx.db.insert("activities", {
        organizationId: task.organizationId,
        leadId: task.leadId,
        type: "task_created",
        actorId: task.createdBy,
        actorType: "system",
        content: `Reminder triggered: "${task.title}"`,
        metadata: { taskId: args.taskId },
        createdAt: now,
      });
    }

    // Fire webhook
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.reminder_triggered",
      payload: { taskId: args.taskId, title: task.title, dueDate: task.dueDate, assignedTo: task.assignedTo },
    });

    return null;
  },
});

// Internal: Lembrete antecipado (dueDate - reminderMinutesBefore), idempotente
export const triggerPreDueReminder = internalMutation({
  args: {
    taskId: v.id("tasks"),
    expectedDueDate: v.number(),
    // Opcional só por compatibilidade com jobs agendados antes deste campo existir.
    expectedMinutes: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;

    // Re-checagens: status ativo, agendamento não obsoleto, ainda não enviado
    if (task.status !== "pending" && task.status !== "in_progress") return null;
    if (task.dueDate !== args.expectedDueDate) return null;
    // O lembrete pode ter sido desligado (0/ausente) ou ter mudado de
    // antecedência depois deste job ser agendado — nos dois casos ele é obsoleto.
    if (!task.reminderMinutesBefore || task.reminderMinutesBefore <= 0) return null;
    if (args.expectedMinutes !== undefined && task.reminderMinutesBefore !== args.expectedMinutes) {
      return null;
    }
    if (task.preDueReminderSentAt) return null;

    const now = Date.now();
    // Snooze cobrindo o horário adia o lembrete (o snooze reagenda o seu próprio)
    if (task.snoozedUntil && task.snoozedUntil > now) return null;

    await ctx.db.patch(args.taskId, { preDueReminderSentAt: now, updatedAt: now });

    const dueDateLabel = formatDate(task.dueDate) ?? "N/A";

    for (const memberId of readAssignees(task)) {
      await createNotification(ctx, {
        organizationId: task.organizationId,
        memberId,
        type: "task_due_soon",
        title: "Tarefa vence em breve",
        body: `${task.title} — vence em ${dueDateLabel}`,
        taskId: args.taskId,
      });

      await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
        organizationId: task.organizationId,
        recipientMemberId: memberId,
        eventType: "taskDueSoon",
        templateData: {
          taskTitle: task.title,
          dueDate: dueDateLabel,
          minutesBefore: task.reminderMinutesBefore,
          taskUrl: taskDeepLink(args.taskId),
        },
      });
    }

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.due_soon",
      payload: {
        taskId: args.taskId,
        title: task.title,
        dueDate: task.dueDate,
        reminderMinutesBefore: task.reminderMinutesBefore,
        assigneeIds: readAssignees(task),
      },
    });

    return null;
  },
});

// Internal: Process overdue reminders (cron sweep)
export const processOverdueReminders = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();

    // Find reminders that are overdue and not yet triggered
    const overdueTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_type")
      .order("asc")
      .take(500);

    for (const task of overdueTasks) {
      if (
        task.type === "reminder" &&
        (task.status === "pending" || task.status === "in_progress") &&
        task.dueDate != null &&
        task.dueDate <= now &&
        !task.reminderTriggered
      ) {
        // Check snooze
        if (task.snoozedUntil && task.snoozedUntil > now) continue;

        await ctx.db.patch(task._id, {
          reminderTriggered: true,
          updatedAt: now,
        });

        await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
          organizationId: task.organizationId,
          event: "task.reminder_triggered",
          payload: { taskId: task._id, title: task.title, dueDate: task.dueDate, assignedTo: task.assignedTo },
        });

        // Notificação in-app + e-mail para todos os responsáveis
        for (const memberId of readAssignees(task)) {
          await createNotification(ctx, {
            organizationId: task.organizationId,
            memberId,
            type: "task_overdue",
            title: "Tarefa atrasada",
            body: task.title,
            taskId: task._id,
          });

          await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
            organizationId: task.organizationId,
            recipientMemberId: memberId,
            eventType: "taskOverdue",
            templateData: {
              taskTitle: task.title,
              dueDate: formatDate(task.dueDate) ?? "N/A",
              taskUrl: taskDeepLink(task._id),
            },
          });
        }
      }
    }

    return null;
  },
});

// Internal: Process recurring tasks
export const processRecurringTasks = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();

    // Find completed tasks with recurrence
    const completedTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_status")
      .order("asc")
      .take(500);

    for (const task of completedTasks) {
      if (task.status !== "completed" || !task.recurrence) continue;

      // Check if already generated child after this completion
      if (task.recurrence.lastGeneratedAt && task.recurrence.lastGeneratedAt >= (task.completedAt || 0)) continue;

      // Check end date
      if (task.recurrence.endDate && now > task.recurrence.endDate) continue;

      // Reabrir e concluir de novo NÃO gera outra instância: se a task já tem
      // sucessor vivo, a linhagem seguiu adiante a partir dele.
      const successors = await ctx.db
        .query("tasks")
        .withIndex("by_recurrence_source", (q) => q.eq("recurrenceSourceId", task._id))
        .take(10);
      if (successors.some((s) => s.status !== "cancelled")) continue;

      // Calculate next due date
      let nextDueDate: number | undefined;
      if (task.dueDate) {
        const d = new Date(task.dueDate);
        switch (task.recurrence.pattern) {
          case "daily": d.setDate(d.getDate() + 1); break;
          case "weekly": d.setDate(d.getDate() + 7); break;
          case "biweekly": d.setDate(d.getDate() + 14); break;
          case "monthly": d.setMonth(d.getMonth() + 1); break;
        }
        nextDueDate = d.getTime();
      }

      // A nova instância entra na coluna default (não-done) do projeto
      let columnId = task.columnId;
      let order = task.order;
      if (task.projectId) {
        const column = await defaultColumnForProject(ctx, task.projectId);
        columnId = column?._id;
        order = columnId ? await nextOrderInColumn(ctx, columnId) : undefined;
      }

      // Nova instância da recorrência — linhagem via recurrenceSourceId
      // (parentTaskId é hierarquia de subtarefa, não recorrência)
      const nextTaskId = await ctx.db.insert("tasks", {
        organizationId: task.organizationId,
        title: task.title,
        description: task.description,
        type: task.type,
        status: "pending",
        priority: task.priority,
        activityType: task.activityType,
        dueDate: nextDueDate,
        leadId: task.leadId,
        contactId: task.contactId,
        assignedTo: task.assignedTo,
        assigneeIds: readAssignees(task),
        createdBy: task.createdBy,
        recurrence: task.recurrence,
        recurrenceSourceId: task._id,
        parentTaskId: task.parentTaskId,
        projectId: task.projectId,
        columnId,
        order,
        labelIds: task.labelIds,
        reminderMinutesBefore: task.reminderMinutesBefore,
        checklist: task.checklist?.map(item => ({ ...item, completed: false })),
        tags: task.tags,
        searchText: task.searchText,
        createdAt: now,
        updatedAt: now,
      });

      // Lembrete antecipado da nova instância (preDueReminderSentAt nasce limpo)
      await schedulePreDueReminder(ctx, nextTaskId, nextDueDate, task.reminderMinutesBefore);

      // Update parent to mark as generated
      await ctx.db.patch(task._id, {
        recurrence: { ...task.recurrence, lastGeneratedAt: now },
        updatedAt: now,
      });
    }

    return null;
  },
});

// Internal: Migração P1 (batches com cursor)
//  - parentTaskId legado é linhagem de recorrência → vira recurrenceSourceId
//  - backfill de assigneeIds a partir de assignedTo
//
// Re-executar é seguro: o remapeamento de parentTaskId só toca tasks COM
// `recurrence` (as instâncias legadas herdavam a recorrência do original), então
// subtarefas de verdade criadas depois do P1 ficam intactas. Para uma garantia
// extra em orgs grandes, passe `createdBefore` com o timestamp do deploy do P1 —
// tasks criadas a partir daí são ignoradas.
export const migrateTasksP1 = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    createdBefore: v.optional(v.number()),
  },
  returns: v.object({
    processed: v.number(),
    migrated: v.number(),
    isDone: v.boolean(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const batchSize = Math.min(args.batchSize ?? 200, 500);

    const page = await ctx.db.query("tasks").paginate({
      numItems: batchSize,
      cursor: args.cursor ?? null,
    });

    const now = Date.now();
    let migrated = 0;

    for (const task of page.page) {
      if (args.createdBefore !== undefined && task.createdAt >= args.createdBefore) continue;

      const patch: Record<string, any> = {};

      if (task.parentTaskId && !task.recurrenceSourceId && task.recurrence) {
        patch.recurrenceSourceId = task.parentTaskId;
        patch.parentTaskId = undefined;
      }
      if (!task.assigneeIds) {
        patch.assigneeIds = task.assignedTo ? [task.assignedTo] : [];
      }

      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(task._id, { ...patch, updatedAt: now });
        migrated++;
      }
    }

    return {
      processed: page.page.length,
      migrated,
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});
