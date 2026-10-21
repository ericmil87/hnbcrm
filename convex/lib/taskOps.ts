/**
 * Núcleo compartilhado de TAREFAS — conclusão e comentário.
 *
 * Vive em lib/ para não criar ciclo de módulos: o follow-up da IA
 * (`lib/followUpOps.ts`, importado por `tasks.ts`) precisa concluir a tarefa e
 * comentar nela, e `tasks.ts` não pode importar de volta quem o importa. A
 * lógica em si é a MESMA de sempre — `tasks.ts` e `taskComments.ts` delegam
 * para cá, e não existe um segundo caminho de "concluir tarefa" no produto.
 */
import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { buildAuditDescription } from "./auditDescription";
import { createNotification, filterMembersOfOrg } from "./notify";
import { appUrl as resolveAppUrl } from "./appUrl";

/** Espaçamento entre tasks numa coluna do kanban (inserir no meio sem renumerar). */
export const ORDER_STEP = 1000;

const MENTION_EXCERPT_LENGTH = 240;

export function taskDeepLink(taskId: Id<"tasks">): string {
  return `${resolveAppUrl()}/app/tarefas?task=${taskId}`;
}

// ── Colunas do kanban ──

export async function columnsOfProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"taskProjects">
): Promise<Doc<"taskColumns">[]> {
  const columns = await ctx.db
    .query("taskColumns")
    .withIndex("by_project_and_order", (q) => q.eq("projectId", projectId))
    .collect();
  return columns.sort((a, b) => a.order - b.order);
}

export async function doneColumnForProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"taskProjects">
) {
  const columns = await columnsOfProject(ctx, projectId);
  return columns.find((c) => c.isDoneColumn) ?? null;
}

export async function nextOrderInColumn(
  ctx: QueryCtx | MutationCtx,
  columnId: Id<"taskColumns">
): Promise<number> {
  // O índice já ordena por `order`: a última linha é o maior valor da coluna.
  const last = await ctx.db
    .query("tasks")
    .withIndex("by_column_and_order", (q) => q.eq("columnId", columnId))
    .order("desc")
    .first();
  return (last?.order ?? 0) + ORDER_STEP;
}

/** Coluna default de um projeto: a de menor `order` que não seja done column. */
export async function defaultColumnForProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"taskProjects">
) {
  const columns = await columnsOfProject(ctx, projectId);
  return columns.find((c) => !c.isDoneColumn) ?? columns[0] ?? null;
}

// ── Responsáveis e lembretes ──

/** `assigneeIds` é a fonte de verdade; `assignedTo` é o espelho legado (= assigneeIds[0]). */
export function readTaskAssignees(task: {
  assigneeIds?: Id<"teamMembers">[];
  assignedTo?: Id<"teamMembers">;
}): Id<"teamMembers">[] {
  if (task.assigneeIds && task.assigneeIds.length > 0) return task.assigneeIds;
  return task.assignedTo ? [task.assignedTo] : [];
}

/** Lembrete antecipado: agenda o disparo para dueDate - minutos. */
export async function schedulePreDueReminder(
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

// ── Recorrência (núcleo ÚNICO) ──

export type RecurrenceOutcome =
  | "generated"
  | "not_recurring"
  | "already_generated"
  | "ended"
  | "has_successor";

/** Próximo prazo de uma recorrência (sem prazo na origem → sem prazo na próxima). */
export function nextRecurrenceDueDate(
  dueDate: number | undefined,
  pattern: NonNullable<Doc<"tasks">["recurrence"]>["pattern"]
): number | undefined {
  if (!dueDate) return undefined;
  const d = new Date(dueDate);
  switch (pattern) {
    case "daily": d.setDate(d.getDate() + 1); break;
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "biweekly": d.setDate(d.getDate() + 14); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
  }
  return d.getTime();
}

/**
 * Gera a próxima instância de uma tarefa recorrente CONCLUÍDA. Chamado na
 * própria conclusão (`applyTaskCompletion`, `updateTask` com status) e pelo
 * cron `processRecurringTasks`, que virou só rede de segurança indexada.
 *
 * Idempotente: pula se já gerou depois desta conclusão (`lastGeneratedAt >=
 * completedAt`) ou se a linhagem já tem sucessor vivo (reabrir e concluir de
 * novo não duplica). Nos pulos por `endDate` vencido ou sucessor existente,
 * grava `recurrence.lastGeneratedAt` mesmo assim — sem efeito visível, mas tira
 * a origem do range do índice do cron, que só lê quem nunca gerou.
 */
export async function generateNextRecurrence(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  now: number
): Promise<RecurrenceOutcome> {
  const recurrence = task.recurrence;
  if (task.status !== "completed" || !recurrence) return "not_recurring";

  if (recurrence.lastGeneratedAt && recurrence.lastGeneratedAt >= (task.completedAt || 0)) {
    return "already_generated";
  }

  const markGenerated = async () => {
    await ctx.db.patch(task._id, { recurrence: { ...recurrence, lastGeneratedAt: now } });
  };

  if (recurrence.endDate && now > recurrence.endDate) {
    await markGenerated();
    return "ended";
  }

  const successors = await ctx.db
    .query("tasks")
    .withIndex("by_recurrence_source", (q) => q.eq("recurrenceSourceId", task._id))
    .take(10);
  if (successors.some((s) => s.status !== "cancelled")) {
    await markGenerated();
    return "has_successor";
  }

  const nextDueDate = nextRecurrenceDueDate(task.dueDate, recurrence.pattern);

  // A nova instância entra na coluna default (não-done) do projeto
  let columnId = task.columnId;
  let order = task.order;
  if (task.projectId) {
    const column = await defaultColumnForProject(ctx, task.projectId);
    columnId = column?._id;
    order = columnId ? await nextOrderInColumn(ctx, columnId) : undefined;
  }

  // Nova instância — linhagem via recurrenceSourceId (parentTaskId é hierarquia
  // de subtarefa). `lastGeneratedAt` NÃO é copiado: a instância nova nunca gerou
  // nada, e é isso que a deixa visível ao índice do cron quando for concluída.
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
    assigneeIds: readTaskAssignees(task),
    createdBy: task.createdBy,
    recurrence: { pattern: recurrence.pattern, endDate: recurrence.endDate },
    recurrenceSourceId: task._id,
    parentTaskId: task.parentTaskId,
    projectId: task.projectId,
    columnId,
    order,
    labelIds: task.labelIds,
    reminderMinutesBefore: task.reminderMinutesBefore,
    checklist: task.checklist?.map((item) => ({ ...item, completed: false })),
    tags: task.tags,
    searchText: task.searchText,
    createdAt: now,
    updatedAt: now,
  });

  // Lembrete antecipado da nova instância (preDueReminderSentAt nasce limpo)
  await schedulePreDueReminder(ctx, nextTaskId, nextDueDate, task.reminderMinutesBefore);

  await ctx.db.patch(task._id, {
    recurrence: { ...recurrence, lastGeneratedAt: now },
    updatedAt: now,
  });
  return "generated";
}

/**
 * Wrapper da conclusão: a recorrência nunca derruba a conclusão da tarefa.
 * Falha por dado inesperado é logada e o cron de resgate tenta de novo.
 */
export async function generateNextRecurrenceSafely(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  now: number
): Promise<void> {
  if (!task.recurrence) return;
  try {
    await generateNextRecurrence(ctx, task, now);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "taskRecurrenceFailed",
        taskId: task._id,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

// ── Conclusão (fluxo ÚNICO) ──

/**
 * Concluir uma tarefa: patch + done column do projeto + recorrência + audit +
 * activity + webhook. Usado por completeTask, internalCompleteTask,
 * moveTaskToColumn, o bulk e o follow-up da IA.
 */
export async function applyTaskCompletion(
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

  // Recorrência: a próxima instância nasce NA MESMA transação da conclusão
  // (antes agendava a varredura inteira do cron a cada conclusão).
  if (task.recurrence) {
    await generateNextRecurrenceSafely(ctx, { ...task, ...patch } as Doc<"tasks">, now);
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
    description: buildAuditDescription({
      action: "update",
      entityType: "task",
      metadata: { title: task.title },
      changes: { before: { status: task.status }, after: { status: "completed" } },
    }),
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

// ── Comentário (núcleo ÚNICO) ──

function excerpt(content: string): string {
  const clean = content.trim();
  return clean.length > MENTION_EXCERPT_LENGTH
    ? `${clean.slice(0, MENTION_EXCERPT_LENGTH)}…`
    : clean;
}

/** Menção em comentário: in-app + e-mail para cada mencionado (menos o autor). */
async function notifyMentions(
  ctx: MutationCtx,
  opts: {
    task: Doc<"tasks">;
    content: string;
    mentionedUserIds?: Id<"teamMembers">[];
    author: Doc<"teamMembers">;
  }
): Promise<void> {
  const requested = [...new Set(opts.mentionedUserIds ?? [])].filter(
    (id) => id !== opts.author._id
  );
  if (requested.length === 0) return;

  // Os ids vêm do cliente: só notifica membros da org DA TASK (o e-mail não tem
  // gate de org em dispatchNotification — a barreira precisa ser aqui).
  const mentioned = await filterMembersOfOrg(ctx, opts.task.organizationId, requested);
  if (mentioned.length === 0) return;

  const snippet = excerpt(opts.content);
  const url = taskDeepLink(opts.task._id);

  for (const memberId of mentioned) {
    await createNotification(ctx, {
      organizationId: opts.task.organizationId,
      memberId,
      type: "task_comment_mention",
      title: `${opts.author.name} mencionou você em um comentário`,
      body: `${opts.task.title}: ${snippet}`,
      taskId: opts.task._id,
      actorId: opts.author._id,
    });

    await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
      organizationId: opts.task.organizationId,
      recipientMemberId: memberId,
      eventType: "taskCommentMention",
      templateData: {
        authorName: opts.author.name,
        taskTitle: opts.task.title,
        taskId: opts.task._id,
        commentExcerpt: snippet,
        taskUrl: url,
      },
    });
  }
}

/**
 * Insere um comentário numa tarefa com os mesmos efeitos colaterais de sempre:
 * activity (quando há lead), webhook e notificação de menção. A AUTORIZAÇÃO é
 * de quem chama — este núcleo confia no `author` recebido.
 */
export async function addTaskCommentCore(
  ctx: MutationCtx,
  opts: {
    task: Doc<"tasks">;
    author: Doc<"teamMembers">;
    content: string;
    mentionedUserIds?: Id<"teamMembers">[];
  }
): Promise<Id<"taskComments">> {
  const { task, author } = opts;
  const now = Date.now();

  const commentId = await ctx.db.insert("taskComments", {
    organizationId: task.organizationId,
    taskId: task._id,
    authorId: author._id,
    authorType: author.type === "ai" ? "ai" : "human",
    content: opts.content,
    mentionedUserIds: opts.mentionedUserIds,
    createdAt: now,
    updatedAt: now,
  });

  if (task.leadId) {
    await ctx.db.insert("activities", {
      organizationId: task.organizationId,
      leadId: task.leadId,
      type: "note",
      actorId: author._id,
      actorType: author.type === "ai" ? "ai" : "human",
      content: `Comment added on task "${task.title}"`,
      metadata: { taskId: task._id, commentId },
      createdAt: now,
    });
  }

  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: task.organizationId,
    event: "task.comment_added",
    payload: { taskId: task._id, commentId, content: opts.content },
  });

  await notifyMentions(ctx, {
    task,
    content: opts.content,
    mentionedUserIds: opts.mentionedUserIds,
    author,
  });

  return commentId;
}
