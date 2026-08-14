import { v } from "convex/values";
import { query, mutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requirePermission } from "./lib/auth";
import { buildTaskSearchText } from "./lib/taskSearchText";

const MAX_NAME_LENGTH = 30;
// Cap defensivo para as varreduras org-scoped abaixo (sem índice em labelIds).
const ORG_TASK_SCAN_CAP = 10000;

// Leitura é aberta a qualquer membro autenticado da organização. Escrita exige
// permissão RBAC na categoria "tasks": edit_own para criar/renomear, edit_all
// para excluir (afeta tasks da org inteira). Defaults por papel: admin=full,
// manager=edit_all, agent/ai=edit_own — sempre sobrescrevível por membro.

// searchText de uma task depende do nome das labels e do projeto atuais —
// recalculado aqui sempre que o nome de uma label muda.
async function searchTextFor(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  labelNameById: Map<Id<"taskLabels">, string>
): Promise<string> {
  const labelNames = (task.labelIds ?? [])
    .map((id) => labelNameById.get(id))
    .filter((n): n is string => !!n);
  const project = task.projectId ? await ctx.db.get(task.projectId) : null;
  return buildTaskSearchText({
    title: task.title,
    description: task.description,
    tags: task.tags,
    labelNames,
    projectName: project?.name,
  });
}

export const getLabels = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    const labels = await ctx.db
      .query("taskLabels")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    labels.sort((a, b) => a.name.localeCompare(b.name));
    return labels;
  },
});

export const createLabel = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    color: v.string(),
  },
  returns: v.id("taskLabels"),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "tasks", "edit_own");

    const name = args.name.trim();
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw new Error(`Nome da etiqueta obrigatório (até ${MAX_NAME_LENGTH} caracteres)`);
    }

    const existing = await ctx.db
      .query("taskLabels")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    if (existing.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Etiqueta "${name}" já existe`);
    }

    const now = Date.now();
    const labelId = await ctx.db.insert("taskLabels", {
      organizationId: args.organizationId,
      name,
      color: args.color,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "taskLabel",
      entityId: labelId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name },
      description: `Criou a etiqueta de tarefa '${name}'`,
      severity: "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "task_label.created",
      payload: { labelId, name },
    });

    return labelId;
  },
});

export const updateLabel = mutation({
  args: {
    labelId: v.id("taskLabels"),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const label = await ctx.db.get(args.labelId);
    if (!label) throw new Error("Etiqueta não encontrada");
    const userMember = await requirePermission(ctx, label.organizationId, "tasks", "edit_own");

    const changes: Record<string, any> = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name || name.length > MAX_NAME_LENGTH) {
        throw new Error(`Nome da etiqueta obrigatório (até ${MAX_NAME_LENGTH} caracteres)`);
      }
      const existing = await ctx.db
        .query("taskLabels")
        .withIndex("by_organization", (q) => q.eq("organizationId", label.organizationId))
        .collect();
      if (
        existing.some(
          (l) => l._id !== args.labelId && l.name.toLowerCase() === name.toLowerCase()
        )
      ) {
        throw new Error(`Etiqueta "${name}" já existe`);
      }
      changes.name = name;
    }
    if (args.color !== undefined) changes.color = args.color;

    if (Object.keys(changes).length === 0) return null;

    const now = Date.now();
    await ctx.db.patch(args.labelId, { ...changes, updatedAt: now });

    // Nome mudou: searchText das tasks com essa label ficaria com o nome antigo
    // até a task ser editada de novo. Sem índice em labelIds — varredura por
    // organização + filtro JS (mesmo contrato do P1 usado por deleteLabel).
    if (changes.name !== undefined) {
      const orgLabels = await ctx.db
        .query("taskLabels")
        .withIndex("by_organization", (q) => q.eq("organizationId", label.organizationId))
        .collect();
      const labelNameById = new Map(orgLabels.map((l) => [l._id, l.name] as const));

      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_organization", (q) => q.eq("organizationId", label.organizationId))
        .take(ORG_TASK_SCAN_CAP);
      for (const task of tasks) {
        if (!task.labelIds || !task.labelIds.includes(args.labelId)) continue;
        await ctx.db.patch(task._id, {
          searchText: await searchTextFor(ctx, task, labelNameById),
        });
      }
    }

    await ctx.db.insert("auditLogs", {
      organizationId: label.organizationId,
      entityType: "taskLabel",
      entityId: args.labelId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: { before: { name: label.name }, after: changes },
      description: `Atualizou a etiqueta de tarefa '${label.name}'`,
      severity: "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: label.organizationId,
      event: "task_label.updated",
      payload: { labelId: args.labelId, changes },
    });

    return null;
  },
});

export const deleteLabel = mutation({
  args: { labelId: v.id("taskLabels") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const label = await ctx.db.get(args.labelId);
    if (!label) return null;
    const userMember = await requirePermission(ctx, label.organizationId, "tasks", "edit_all");

    const now = Date.now();

    // Labels remanescentes da org (exclui a que está sendo excluída) para
    // recalcular o searchText das tasks afetadas sem o nome dela.
    const orgLabels = await ctx.db
      .query("taskLabels")
      .withIndex("by_organization", (q) => q.eq("organizationId", label.organizationId))
      .collect();
    const labelNameById = new Map(
      orgLabels.filter((l) => l._id !== args.labelId).map((l) => [l._id, l.name] as const)
    );

    // Sem índice em labelIds — varredura por organização + filtro JS (aceito
    // pelo contrato do P1 para este caso).
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization", (q) => q.eq("organizationId", label.organizationId))
      .take(ORG_TASK_SCAN_CAP);
    for (const task of tasks) {
      if (task.labelIds && task.labelIds.includes(args.labelId)) {
        const newLabelIds = task.labelIds.filter((id) => id !== args.labelId);
        await ctx.db.patch(task._id, {
          labelIds: newLabelIds,
          searchText: await searchTextFor(ctx, { ...task, labelIds: newLabelIds }, labelNameById),
          updatedAt: now,
        });
      }
    }

    await ctx.db.insert("auditLogs", {
      organizationId: label.organizationId,
      entityType: "taskLabel",
      entityId: args.labelId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: label.name },
      description: `Excluiu a etiqueta de tarefa '${label.name}'`,
      severity: "medium",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: label.organizationId,
      event: "task_label.deleted",
      payload: { labelId: args.labelId, name: label.name },
    });

    await ctx.db.delete(args.labelId);

    return null;
  },
});
