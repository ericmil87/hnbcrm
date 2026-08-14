import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requirePermission } from "./lib/auth";
import { buildTaskSearchText } from "./lib/taskSearchText";

// Gestão de projetos/colunas (create/update/archive/delete) exige tasks:edit_all
// via RBAC (defaults: admin=full, manager=edit_all, agent/ai=edit_own — sempre
// sobrescrevível por membro). Leitura é aberta a qualquer membro autenticado
// da organização.

function labelNamesFor(task: Doc<"tasks">, labelNameById: Map<Id<"taskLabels">, string>): string[] {
  return (task.labelIds ?? [])
    .map((id) => labelNameById.get(id))
    .filter((n): n is string => !!n);
}

// ────────────────────────────────────────────────────────────
// Queries
// ────────────────────────────────────────────────────────────

export const getProjects = query({
  args: {
    organizationId: v.id("organizations"),
    includeArchived: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const projects = await ctx.db
      .query("taskProjects")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    const visible = args.includeArchived
      ? projects
      : projects.filter((p) => p.archivedAt === undefined);
    visible.sort((a, b) => a.order - b.order);

    // Conta só tasks abertas (pending/in_progress) via by_project_and_status,
    // em paralelo por projeto — evita coletar o projeto inteiro (incl.
    // completed/cancelled) e reduz o escopo de invalidação reativa a essas
    // duas fatias por projeto. Cap alto por segurança (não deveria haver mais
    // de OPEN_TASKS_CAP tasks abertas num único projeto).
    const OPEN_TASKS_CAP = 5000;
    const result = await Promise.all(
      visible.map(async (project) => {
        const [columns, pending, inProgress] = await Promise.all([
          ctx.db
            .query("taskColumns")
            .withIndex("by_project_and_order", (q) => q.eq("projectId", project._id))
            .collect(),
          ctx.db
            .query("tasks")
            .withIndex("by_project_and_status", (q) =>
              q.eq("projectId", project._id).eq("status", "pending")
            )
            .take(OPEN_TASKS_CAP),
          ctx.db
            .query("tasks")
            .withIndex("by_project_and_status", (q) =>
              q.eq("projectId", project._id).eq("status", "in_progress")
            )
            .take(OPEN_TASKS_CAP),
        ]);
        return { ...project, columns, openTaskCount: pending.length + inProgress.length };
      })
    );

    return result;
  },
});

export const getProject = query({
  args: { projectId: v.id("taskProjects") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;
    await requireAuth(ctx, project.organizationId);
    return project;
  },
});

export const getColumns = query({
  args: { projectId: v.id("taskProjects") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Projeto não encontrado");
    await requireAuth(ctx, project.organizationId);

    return await ctx.db
      .query("taskColumns")
      .withIndex("by_project_and_order", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

// ────────────────────────────────────────────────────────────
// Project mutations
// ────────────────────────────────────────────────────────────

export const createProject = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  returns: v.id("taskProjects"),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "tasks", "edit_all");

    const name = args.name.trim();
    if (!name) throw new Error("Nome do projeto é obrigatório");

    const existing = await ctx.db
      .query("taskProjects")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    const maxOrder = Math.max(0, ...existing.map((p) => p.order));
    const now = Date.now();

    const projectId = await ctx.db.insert("taskProjects", {
      organizationId: args.organizationId,
      name,
      description: args.description,
      color: args.color,
      order: maxOrder + 1000,
      createdBy: userMember._id,
      createdAt: now,
      updatedAt: now,
    });

    const defaultColumns: Array<{ name: string; order: number; isDoneColumn?: boolean }> = [
      { name: "A fazer", order: 1000 },
      { name: "Em andamento", order: 2000 },
      { name: "Concluído", order: 3000, isDoneColumn: true },
    ];
    for (const col of defaultColumns) {
      await ctx.db.insert("taskColumns", {
        organizationId: args.organizationId,
        projectId,
        name: col.name,
        order: col.order,
        isDoneColumn: col.isDoneColumn,
        createdAt: now,
        updatedAt: now,
      });
    }

    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "taskProject",
      entityId: projectId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name },
      description: `Criou o projeto de tarefas '${name}'`,
      severity: "medium",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "task_project.created",
      payload: { projectId, name },
    });

    return projectId;
  },
});

export const updateProject = mutation({
  args: {
    projectId: v.id("taskProjects"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Projeto não encontrado");
    const userMember = await requirePermission(ctx, project.organizationId, "tasks", "edit_all");

    const changes: Record<string, any> = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Nome do projeto é obrigatório");
      changes.name = name;
    }
    if (args.description !== undefined) changes.description = args.description;
    if (args.color !== undefined) changes.color = args.color;

    if (Object.keys(changes).length === 0) return null;

    const now = Date.now();
    await ctx.db.patch(args.projectId, { ...changes, updatedAt: now });

    // Nome mudou: searchText das tasks do projeto ficaria com o nome antigo
    // até a task ser editada de novo.
    if (changes.name !== undefined && changes.name !== project.name) {
      const [orgLabels, tasks] = await Promise.all([
        ctx.db
          .query("taskLabels")
          .withIndex("by_organization", (q) => q.eq("organizationId", project.organizationId))
          .collect(),
        ctx.db
          .query("tasks")
          .withIndex("by_organization_and_project", (q) =>
            q.eq("organizationId", project.organizationId).eq("projectId", args.projectId)
          )
          .collect(),
      ]);
      const labelNameById = new Map(orgLabels.map((l) => [l._id, l.name] as const));
      for (const task of tasks) {
        await ctx.db.patch(task._id, {
          searchText: buildTaskSearchText({
            title: task.title,
            description: task.description,
            tags: task.tags,
            labelNames: labelNamesFor(task, labelNameById),
            projectName: changes.name,
          }),
        });
      }
    }

    await ctx.db.insert("auditLogs", {
      organizationId: project.organizationId,
      entityType: "taskProject",
      entityId: args.projectId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: { before: { name: project.name }, after: changes },
      description: `Atualizou o projeto de tarefas '${project.name}'`,
      severity: "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: project.organizationId,
      event: "task_project.updated",
      payload: { projectId: args.projectId, changes },
    });

    return null;
  },
});

export const archiveProject = mutation({
  args: { projectId: v.id("taskProjects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Projeto não encontrado");
    const userMember = await requirePermission(ctx, project.organizationId, "tasks", "edit_all");
    if (project.archivedAt !== undefined) return null;

    const now = Date.now();
    await ctx.db.patch(args.projectId, { archivedAt: now, updatedAt: now });

    await ctx.db.insert("auditLogs", {
      organizationId: project.organizationId,
      entityType: "taskProject",
      entityId: args.projectId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: project.name, archived: true },
      description: `Arquivou o projeto de tarefas '${project.name}'`,
      severity: "medium",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: project.organizationId,
      event: "task_project.archived",
      payload: { projectId: args.projectId },
    });

    return null;
  },
});

export const unarchiveProject = mutation({
  args: { projectId: v.id("taskProjects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Projeto não encontrado");
    const userMember = await requirePermission(ctx, project.organizationId, "tasks", "edit_all");
    if (project.archivedAt === undefined) return null;

    const now = Date.now();
    await ctx.db.patch(args.projectId, { archivedAt: undefined, updatedAt: now });

    await ctx.db.insert("auditLogs", {
      organizationId: project.organizationId,
      entityType: "taskProject",
      entityId: args.projectId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: project.name, archived: false },
      description: `Reativou o projeto de tarefas '${project.name}'`,
      severity: "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: project.organizationId,
      event: "task_project.updated",
      payload: { projectId: args.projectId, unarchived: true },
    });

    return null;
  },
});

export const reorderProject = mutation({
  args: { projectId: v.id("taskProjects"), order: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Projeto não encontrado");
    const userMember = await requirePermission(ctx, project.organizationId, "tasks", "edit_all");
    await ctx.db.patch(args.projectId, { order: args.order, updatedAt: Date.now() });
    return null;
  },
});

export const deleteProject = mutation({
  args: { projectId: v.id("taskProjects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Projeto não encontrado");
    const userMember = await requirePermission(ctx, project.organizationId, "tasks", "edit_all");

    const now = Date.now();

    // Tasks do projeto continuam existindo, apenas soltas do kanban. O nome
    // do projeto sai do searchText junto (senão a busca continua achando o
    // projeto excluído pelo nome).
    const [orgLabels, tasks] = await Promise.all([
      ctx.db
        .query("taskLabels")
        .withIndex("by_organization", (q) => q.eq("organizationId", project.organizationId))
        .collect(),
      ctx.db
        .query("tasks")
        .withIndex("by_organization_and_project", (q) =>
          q.eq("organizationId", project.organizationId).eq("projectId", args.projectId)
        )
        .collect(),
    ]);
    const labelNameById = new Map(orgLabels.map((l) => [l._id, l.name] as const));
    for (const task of tasks) {
      await ctx.db.patch(task._id, {
        projectId: undefined,
        columnId: undefined,
        order: undefined,
        searchText: buildTaskSearchText({
          title: task.title,
          description: task.description,
          tags: task.tags,
          labelNames: labelNamesFor(task, labelNameById),
        }),
        updatedAt: now,
      });
    }

    const columns = await ctx.db
      .query("taskColumns")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const column of columns) {
      await ctx.db.delete(column._id);
    }

    await ctx.db.insert("auditLogs", {
      organizationId: project.organizationId,
      entityType: "taskProject",
      entityId: args.projectId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: project.name, taskCount: tasks.length },
      description: `Excluiu o projeto de tarefas '${project.name}'`,
      severity: "high",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: project.organizationId,
      event: "task_project.deleted",
      payload: { projectId: args.projectId, name: project.name },
    });

    await ctx.db.delete(args.projectId);

    return null;
  },
});

// ────────────────────────────────────────────────────────────
// Column mutations — colunas pertencem a um projeto; eventos de webhook
// disparam "task_project.updated" (não há evento taskColumn.* dedicado).
// ────────────────────────────────────────────────────────────

export const createColumn = mutation({
  args: {
    projectId: v.id("taskProjects"),
    name: v.string(),
    color: v.optional(v.string()),
    wipLimit: v.optional(v.number()),
  },
  returns: v.id("taskColumns"),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Projeto não encontrado");
    const userMember = await requirePermission(ctx, project.organizationId, "tasks", "edit_all");

    const name = args.name.trim();
    if (!name) throw new Error("Nome da coluna é obrigatório");

    const columns = await ctx.db
      .query("taskColumns")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const maxOrder = Math.max(0, ...columns.map((c) => c.order));
    const now = Date.now();

    const columnId = await ctx.db.insert("taskColumns", {
      organizationId: project.organizationId,
      projectId: args.projectId,
      name,
      order: maxOrder + 1000,
      color: args.color,
      wipLimit: args.wipLimit,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: project.organizationId,
      entityType: "taskColumn",
      entityId: columnId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name, projectId: args.projectId },
      description: `Criou a coluna '${name}' no projeto '${project.name}'`,
      severity: "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: project.organizationId,
      event: "task_project.updated",
      payload: { projectId: args.projectId, columnId, columnEvent: "created" },
    });

    return columnId;
  },
});

export const updateColumn = mutation({
  args: {
    columnId: v.id("taskColumns"),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    wipLimit: v.optional(v.number()),
    isDoneColumn: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const column = await ctx.db.get(args.columnId);
    if (!column) throw new Error("Coluna não encontrada");
    const userMember = await requirePermission(ctx, column.organizationId, "tasks", "edit_all");

    const changes: Record<string, any> = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Nome da coluna é obrigatório");
      changes.name = name;
    }
    if (args.color !== undefined) changes.color = args.color;
    if (args.wipLimit !== undefined) changes.wipLimit = args.wipLimit;
    if (args.isDoneColumn !== undefined) changes.isDoneColumn = args.isDoneColumn;

    if (Object.keys(changes).length === 0) return null;

    const now = Date.now();

    // No máximo uma done column por projeto: promover esta a done limpa a anterior.
    if (args.isDoneColumn === true) {
      const siblings = await ctx.db
        .query("taskColumns")
        .withIndex("by_project", (q) => q.eq("projectId", column.projectId))
        .collect();
      for (const sibling of siblings) {
        if (sibling._id !== args.columnId && sibling.isDoneColumn) {
          await ctx.db.patch(sibling._id, { isDoneColumn: false, updatedAt: now });
        }
      }
    }

    await ctx.db.patch(args.columnId, { ...changes, updatedAt: now });

    await ctx.db.insert("auditLogs", {
      organizationId: column.organizationId,
      entityType: "taskColumn",
      entityId: args.columnId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: { before: { name: column.name }, after: changes },
      description: `Atualizou a coluna '${column.name}'`,
      severity: "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: column.organizationId,
      event: "task_project.updated",
      payload: { projectId: column.projectId, columnId: args.columnId, columnEvent: "updated" },
    });

    return null;
  },
});

export const deleteColumn = mutation({
  args: { columnId: v.id("taskColumns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const column = await ctx.db.get(args.columnId);
    if (!column) throw new Error("Coluna não encontrada");
    const userMember = await requirePermission(ctx, column.organizationId, "tasks", "edit_all");

    const siblings = await ctx.db
      .query("taskColumns")
      .withIndex("by_project", (q) => q.eq("projectId", column.projectId))
      .collect();
    const remaining = siblings.filter((c) => c._id !== args.columnId);
    if (remaining.length === 0) {
      throw new Error("Não é possível excluir a última coluna do projeto.");
    }

    // Coluna default = menor order que não seja done; se todas restantes forem
    // done, cai para a de menor order geral.
    const nonDone = remaining.filter((c) => !c.isDoneColumn);
    const pool = nonDone.length > 0 ? nonDone : remaining;
    const defaultColumn = pool.reduce((min, c) => (c.order < min.order ? c : min), pool[0]);

    const now = Date.now();

    const tasksInColumn = await ctx.db
      .query("tasks")
      .withIndex("by_column", (q) => q.eq("columnId", args.columnId))
      .collect();

    if (tasksInColumn.length > 0) {
      const tasksInDefault = await ctx.db
        .query("tasks")
        .withIndex("by_column", (q) => q.eq("columnId", defaultColumn._id))
        .collect();
      let runningOrder = Math.max(0, ...tasksInDefault.map((t) => t.order ?? 0));
      for (const task of tasksInColumn) {
        runningOrder += 1000;
        await ctx.db.patch(task._id, {
          columnId: defaultColumn._id,
          order: runningOrder,
          updatedAt: now,
        });
      }
    }

    await ctx.db.delete(args.columnId);

    await ctx.db.insert("auditLogs", {
      organizationId: column.organizationId,
      entityType: "taskColumn",
      entityId: args.columnId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: {
        name: column.name,
        projectId: column.projectId,
        movedTaskCount: tasksInColumn.length,
      },
      description: `Excluiu a coluna '${column.name}'`,
      severity: "medium",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: column.organizationId,
      event: "task_project.updated",
      payload: { projectId: column.projectId, columnId: args.columnId, columnEvent: "deleted" },
    });

    return null;
  },
});

export const reorderColumn = mutation({
  args: { columnId: v.id("taskColumns"), order: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const column = await ctx.db.get(args.columnId);
    if (!column) throw new Error("Coluna não encontrada");
    const userMember = await requirePermission(ctx, column.organizationId, "tasks", "edit_all");
    await ctx.db.patch(args.columnId, { order: args.order, updatedAt: Date.now() });
    return null;
  },
});
