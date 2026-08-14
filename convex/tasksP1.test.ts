/// <reference types="vite/client" />
/**
 * P1 de tarefas (backend): multi-assignee, subtarefas, kanban/colunas,
 * lembrete antecipado, menções em comentários e migração de dados.
 *
 * As funções agendadas NÃO são executadas automaticamente aqui — quando um
 * teste precisa do efeito (recorrência, lembrete), a função interna é chamada
 * direto, evitando disparar os e-mails cujos templates são do agente B2.
 */
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTemplate } from "./emailTemplates";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

// Instância compartilhada por teste. O afterEach cancela o que ficou agendado
// (webhooks/e-mails/lembretes) e espera o que já começou: sem isso os timers de
// um teste disparam contra a instância do teste seguinte ("write outside of
// transaction") e os e-mails novos (templates do agente B2) seriam construídos.
let t: TestConvex<typeof schema>;

beforeEach(() => {
  t = convexTest(schema, modules);
});

afterEach(async () => {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
});

async function seedOrg(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Tasks P1",
      slug: "org-tasks-p1",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });

    const mk = async (name: string, role: "admin" | "agent") => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name,
        role,
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return { userId, memberId };
    };

    const admin = await mk("Admin", "admin");
    const ana = await mk("Ana", "agent");
    const bruno = await mk("Bruno", "agent");
    const carla = await mk("Carla", "agent");

    return { organizationId, admin, ana, bruno, carla };
  });
}

async function seedProject(
  t: TestConvex<typeof schema>,
  organizationId: Id<"organizations">,
  createdBy: Id<"teamMembers">
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("taskProjects", {
      organizationId,
      name: "Projeto Alfa",
      order: 0,
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
    const todo = await ctx.db.insert("taskColumns", {
      organizationId, projectId, name: "A fazer", order: 0, createdAt: now, updatedAt: now,
    });
    const doing = await ctx.db.insert("taskColumns", {
      organizationId, projectId, name: "Em andamento", order: 1, createdAt: now, updatedAt: now,
    });
    const done = await ctx.db.insert("taskColumns", {
      organizationId, projectId, name: "Concluído", order: 2, isDoneColumn: true, createdAt: now, updatedAt: now,
    });
    return { projectId, todo, doing, done };
  });
}

async function seedLabels(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const urgente = await ctx.db.insert("taskLabels", {
      organizationId, name: "Urgente", color: "#ef4444", createdAt: now, updatedAt: now,
    });
    const backlog = await ctx.db.insert("taskLabels", {
      organizationId, name: "Backlog", color: "#64748b", createdAt: now, updatedAt: now,
    });
    return { urgente, backlog };
  });
}

async function notificationsOf(t: TestConvex<typeof schema>, memberId: Id<"teamMembers">) {
  return await t.run(async (ctx) =>
    await ctx.db
      .query("notifications")
      .withIndex("by_member_and_created", (q) => q.eq("memberId", memberId))
      .collect()
  );
}

async function getTaskDoc(t: TestConvex<typeof schema>, taskId: Id<"tasks">) {
  return await t.run(async (ctx) => await ctx.db.get(taskId));
}

async function scheduledNamed(t: TestConvex<typeof schema>, needle: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) =>
      f.name.includes(needle)
    )
  );
}

// ===== Multi-assignee =====

describe("multi-assignee", () => {
  test("createTask espelha assignedTo = assigneeIds[0] e notifica cada novo responsável", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId,
      title: "Ligar para o cliente",
      type: "task",
      priority: "high",
      assigneeIds: [s.ana.memberId, s.bruno.memberId],
    });

    const task = await getTaskDoc(t, taskId);
    expect(task?.assigneeIds).toEqual([s.ana.memberId, s.bruno.memberId]);
    expect(task?.assignedTo).toBe(s.ana.memberId);

    expect((await notificationsOf(t, s.ana.memberId)).length).toBe(1);
    expect((await notificationsOf(t, s.bruno.memberId)).length).toBe(1);
    expect((await notificationsOf(t, s.ana.memberId))[0].type).toBe("task_assigned");
    // o ator nunca é notificado
    expect((await notificationsOf(t, s.admin.memberId)).length).toBe(0);
  });

  test("createTask só com assignedTo faz backfill de assigneeIds", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId,
      title: "Backfill",
      type: "task",
      priority: "low",
      assignedTo: s.ana.memberId,
    });

    const task = await getTaskDoc(t, taskId);
    expect(task?.assigneeIds).toEqual([s.ana.memberId]);
  });

  test("setAssignees notifica só os NOVOS e nunca o ator", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId,
      title: "Proposta",
      type: "task",
      priority: "medium",
      assigneeIds: [s.ana.memberId],
    });
    expect((await notificationsOf(t, s.ana.memberId)).length).toBe(1);

    // Ana continua; Carla entra; o admin (ator) também entra e não deve se notificar
    await asAdmin.mutation(api.tasks.setAssignees, {
      taskId,
      memberIds: [s.ana.memberId, s.carla.memberId, s.admin.memberId],
    });

    const task = await getTaskDoc(t, taskId);
    expect(task?.assigneeIds).toEqual([s.ana.memberId, s.carla.memberId, s.admin.memberId]);
    expect(task?.assignedTo).toBe(s.ana.memberId);

    expect((await notificationsOf(t, s.ana.memberId)).length).toBe(1); // não re-notifica
    expect((await notificationsOf(t, s.carla.memberId)).length).toBe(1);
    expect((await notificationsOf(t, s.admin.memberId)).length).toBe(0);
  });

  test("assignTask (compat) continua funcionando e mantém o espelho", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Compat", type: "task", priority: "low",
    });
    await asAdmin.mutation(api.tasks.assignTask, { taskId, assignedTo: s.bruno.memberId });

    const task = await getTaskDoc(t, taskId);
    expect(task?.assignedTo).toBe(s.bruno.memberId);
    expect(task?.assigneeIds).toEqual([s.bruno.memberId]);
    expect((await notificationsOf(t, s.bruno.memberId)).length).toBe(1);
  });

  test("getMyTasks e getTaskCounts enxergam responsável secundário", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const asBruno = t.withIdentity({ subject: `${s.bruno.userId}|s1` });

    await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId,
      title: "Compartilhada",
      type: "task",
      priority: "medium",
      assigneeIds: [s.ana.memberId, s.bruno.memberId],
    });

    const mine = await asBruno.query(api.tasks.getMyTasks, { organizationId: s.organizationId });
    expect(mine.length).toBe(1);
    expect(mine[0].assignees.length).toBe(2);

    const counts = await asBruno.query(api.tasks.getTaskCounts, {
      organizationId: s.organizationId,
      now: Date.now(),
    });
    expect(counts.myPending).toBe(1);
  });
});

// ===== Subtarefas / dependências =====

describe("subtarefas e dependências", () => {
  test("cria subtarefa, getSubtasks reporta progresso e ciclo é proibido", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const parentId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Pai", type: "task", priority: "medium",
    });
    const childId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Filho", type: "task", priority: "low",
      parentTaskId: parentId,
    });

    let subs = await asAdmin.query(api.tasks.getSubtasks, { taskId: parentId });
    expect(subs.total).toBe(1);
    expect(subs.completed).toBe(0);

    await asAdmin.mutation(api.tasks.completeTask, { taskId: childId });
    subs = await asAdmin.query(api.tasks.getSubtasks, { taskId: parentId });
    expect(subs.completed).toBe(1);

    const detail = (await asAdmin.query(api.tasks.getTask, { taskId: parentId }))!;
    expect(detail.subtaskProgress).toEqual({ total: 1, completed: 1 });

    // ciclo: o pai não pode virar subtarefa do próprio filho
    await expect(
      asAdmin.mutation(api.tasks.updateTask, { taskId: parentId, parentTaskId: childId })
    ).rejects.toThrow(/ancestral/i);

    // auto-referência
    await expect(
      asAdmin.mutation(api.tasks.updateTask, { taskId: childId, parentTaskId: childId })
    ).rejects.toThrow(/subtarefa dela mesma/i);
  });

  test("deleteTask órfã as subtarefas e limpa blockedBy alheio", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const parentId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Pai", type: "task", priority: "medium",
    });
    const childId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Filho", type: "task", priority: "low",
      parentTaskId: parentId,
    });
    const blockedId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Bloqueada", type: "task", priority: "low",
      blockedBy: [parentId],
    });

    await asAdmin.mutation(api.tasks.deleteTask, { taskId: parentId });

    const child = await getTaskDoc(t, childId);
    expect(child).not.toBeNull();
    expect(child?.parentTaskId).toBeUndefined();

    const blocked = await getTaskDoc(t, blockedId);
    expect(blocked?.blockedBy).toEqual([]);
  });

  test("getTask lista os bloqueadores com título e status", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const blockerId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Aprovar orçamento", type: "task", priority: "high",
    });
    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Enviar contrato", type: "task", priority: "high",
      blockedBy: [blockerId],
    });

    const detail = (await asAdmin.query(api.tasks.getTask, { taskId }))!;
    expect(detail.blockers).toEqual([
      { _id: blockerId, title: "Aprovar orçamento", status: "pending" },
    ]);

    // blockedBy nunca aponta para a própria task
    await asAdmin.mutation(api.tasks.updateTask, { taskId, blockedBy: [taskId, blockerId] });
    const doc = await getTaskDoc(t, taskId);
    expect(doc?.blockedBy).toEqual([blockerId]);
  });
});

// ===== Kanban =====

describe("kanban", () => {
  test("task com projeto cai na primeira coluna não-done com order = max+1000", async () => {
    const s = await seedOrg(t);
    const p = await seedProject(t, s.organizationId, s.admin.memberId);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const firstId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Primeira", type: "task", priority: "medium",
      projectId: p.projectId,
    });
    const secondId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Segunda", type: "task", priority: "medium",
      projectId: p.projectId,
    });

    const first = await getTaskDoc(t, firstId);
    const second = await getTaskDoc(t, secondId);
    expect(first?.columnId).toBe(p.todo);
    expect(first?.order).toBe(1000);
    expect(second?.order).toBe(2000);
  });

  test("coluna de outro projeto é rejeitada", async () => {
    const s = await seedOrg(t);
    const p1 = await seedProject(t, s.organizationId, s.admin.memberId);
    const p2 = await seedProject(t, s.organizationId, s.admin.memberId);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    await expect(
      asAdmin.mutation(api.tasks.createTask, {
        organizationId: s.organizationId, title: "X", type: "task", priority: "low",
        projectId: p1.projectId, columnId: p2.todo,
      })
    ).rejects.toThrow(/não pertence ao projeto/i);
  });

  test("mover para a done column completa; sair dela reabre", async () => {
    const s = await seedOrg(t);
    const p = await seedProject(t, s.organizationId, s.admin.memberId);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Fluxo", type: "task", priority: "medium",
      projectId: p.projectId,
    });

    await asAdmin.mutation(api.tasks.moveTaskToColumn, { taskId, columnId: p.doing });
    expect((await getTaskDoc(t, taskId))?.columnId).toBe(p.doing);
    expect((await getTaskDoc(t, taskId))?.status).toBe("pending");

    await asAdmin.mutation(api.tasks.moveTaskToColumn, { taskId, columnId: p.done });
    const completed = await getTaskDoc(t, taskId);
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBeGreaterThan(0);
    expect(completed?.columnId).toBe(p.done);

    await asAdmin.mutation(api.tasks.moveTaskToColumn, { taskId, columnId: p.todo });
    const reopened = await getTaskDoc(t, taskId);
    expect(reopened?.status).toBe("pending");
    expect(reopened?.completedAt).toBeUndefined();
    expect(reopened?.columnId).toBe(p.todo);
  });

  test("completeTask move a task do projeto para a done column", async () => {
    const s = await seedOrg(t);
    const p = await seedProject(t, s.organizationId, s.admin.memberId);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Concluir", type: "task", priority: "medium",
      projectId: p.projectId,
    });
    await asAdmin.mutation(api.tasks.completeTask, { taskId });

    const task = await getTaskDoc(t, taskId);
    expect(task?.status).toBe("completed");
    expect(task?.columnId).toBe(p.done);
  });

  test("auditoria do move registra a transição de status", async () => {
    const s = await seedOrg(t);
    const p = await seedProject(t, s.organizationId, s.admin.memberId);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Auditada", type: "task", priority: "low",
      projectId: p.projectId,
    });

    const auditOfMove = async () =>
      await t.run(async (ctx) => {
        const logs = await ctx.db
          .query("auditLogs")
          .withIndex("by_entity", (q) => q.eq("entityType", "task").eq("entityId", taskId))
          .collect();
        return logs.filter((l) => (l.metadata as any)?.columnName != null);
      });

    await asAdmin.mutation(api.tasks.moveTaskToColumn, { taskId, columnId: p.doing });
    const [plainMove] = await auditOfMove();
    expect((plainMove.changes as any)?.after.status).toBeUndefined();

    await asAdmin.mutation(api.tasks.moveTaskToColumn, { taskId, columnId: p.done });
    const completedMove = (await auditOfMove()).at(-1)!;
    expect((completedMove.changes as any)?.before.status).toBe("pending");
    expect((completedMove.changes as any)?.after.status).toBe("completed");

    await asAdmin.mutation(api.tasks.moveTaskToColumn, { taskId, columnId: p.todo });
    const reopenedMove = (await auditOfMove()).at(-1)!;
    expect((reopenedMove.changes as any)?.before.status).toBe("completed");
    expect((reopenedMove.changes as any)?.after.status).toBe("pending");
  });

  test("reorderTask altera só a ordem manual", async () => {
    const s = await seedOrg(t);
    const p = await seedProject(t, s.organizationId, s.admin.memberId);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Ordenar", type: "task", priority: "low",
      projectId: p.projectId,
    });
    await asAdmin.mutation(api.tasks.reorderTask, { taskId, order: 500 });

    const task = await getTaskDoc(t, taskId);
    expect(task?.order).toBe(500);
    expect(task?.columnId).toBe(p.todo);
  });

  test("done column dispara a recorrência: próxima instância usa recurrenceSourceId e coluna default", async () => {
    const s = await seedOrg(t);
    const p = await seedProject(t, s.organizationId, s.admin.memberId);
    const labels = await seedLabels(t, s.organizationId);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const dueDate = Date.now() + 60 * 60 * 1000;
    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId,
      title: "Follow-up semanal",
      type: "task",
      priority: "medium",
      dueDate,
      projectId: p.projectId,
      labelIds: [labels.urgente],
      assigneeIds: [s.ana.memberId],
      reminderMinutesBefore: 30,
      recurrence: { pattern: "weekly" },
    });

    await asAdmin.mutation(api.tasks.moveTaskToColumn, { taskId, columnId: p.done });
    // a geração é agendada; executamos direto para não disparar os e-mails
    await t.mutation(internal.tasks.processRecurringTasks, {});

    const generated = await t.run(async (ctx) =>
      await ctx.db
        .query("tasks")
        .withIndex("by_recurrence_source", (q) => q.eq("recurrenceSourceId", taskId))
        .collect()
    );

    expect(generated.length).toBe(1);
    const next = generated[0];
    expect(next.parentTaskId).toBeUndefined();
    expect(next.status).toBe("pending");
    expect(next.columnId).toBe(p.todo);
    expect(next.projectId).toBe(p.projectId);
    expect(next.labelIds).toEqual([labels.urgente]);
    expect(next.assigneeIds).toEqual([s.ana.memberId]);
    expect(next.reminderMinutesBefore).toBe(30);
    expect(next.preDueReminderSentAt).toBeUndefined();
    expect(next.dueDate).toBe(new Date(new Date(dueDate).setDate(new Date(dueDate).getDate() + 7)).getTime());
  });
});

// ===== Recorrência e ações em lote =====

describe("recorrência e lote", () => {
  async function successorsOf(taskId: Id<"tasks">) {
    return await t.run(async (ctx) =>
      await ctx.db
        .query("tasks")
        .withIndex("by_recurrence_source", (q) => q.eq("recurrenceSourceId", taskId))
        .collect()
    );
  }

  test("reabrir e concluir de novo não duplica a instância da recorrência", async () => {
    const s = await seedOrg(t);
    const p = await seedProject(t, s.organizationId, s.admin.memberId);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Semanal", type: "task", priority: "medium",
      dueDate: Date.now() + 60 * 60 * 1000, projectId: p.projectId,
      recurrence: { pattern: "weekly" },
    });

    await asAdmin.mutation(api.tasks.moveTaskToColumn, { taskId, columnId: p.done });
    await t.mutation(internal.tasks.processRecurringTasks, {});
    expect((await successorsOf(taskId)).length).toBe(1);

    // reabre (sai da done column) e conclui outra vez
    await asAdmin.mutation(api.tasks.moveTaskToColumn, { taskId, columnId: p.todo });
    await asAdmin.mutation(api.tasks.moveTaskToColumn, { taskId, columnId: p.done });
    await t.mutation(internal.tasks.processRecurringTasks, {});

    expect((await successorsOf(taskId)).length).toBe(1);
  });

  test("bulk complete move para a done column e dispara a recorrência", async () => {
    const s = await seedOrg(t);
    const p = await seedProject(t, s.organizationId, s.admin.memberId);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const recurringId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Recorrente", type: "task", priority: "medium",
      dueDate: Date.now() + 60 * 60 * 1000, projectId: p.projectId,
      recurrence: { pattern: "daily" },
    });
    const simpleId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Simples", type: "task", priority: "low",
      projectId: p.projectId,
    });

    await asAdmin.mutation(api.tasks.bulkUpdateTasks, {
      taskIds: [recurringId, simpleId],
      action: "complete",
    });

    expect((await getTaskDoc(t, recurringId))?.columnId).toBe(p.done);
    expect((await getTaskDoc(t, simpleId))?.columnId).toBe(p.done);
    expect((await getTaskDoc(t, simpleId))?.status).toBe("completed");

    await t.mutation(internal.tasks.processRecurringTasks, {});
    expect((await successorsOf(recurringId)).length).toBe(1);
  });

  test("bulk delete limpa blockedBy de quem sobrou", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const mk = (title: string, blockedBy?: Id<"tasks">[]) =>
      asAdmin.mutation(api.tasks.createTask, {
        organizationId: s.organizationId, title, type: "task" as const, priority: "low" as const, blockedBy,
      });

    const blockerA = await mk("Bloqueadora A");
    const blockerB = await mk("Bloqueadora B");
    const dependentId = await mk("Dependente", [blockerA, blockerB]);

    await asAdmin.mutation(api.tasks.bulkUpdateTasks, {
      taskIds: [blockerA, blockerB],
      action: "delete",
    });

    expect(await getTaskDoc(t, blockerA)).toBeNull();
    expect((await getTaskDoc(t, dependentId))?.blockedBy).toEqual([]);
  });
});

// ===== Lembrete antecipado =====

describe("lembrete antecipado", () => {
  test("agenda no create, notifica os assignees e é idempotente", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const dueDate = Date.now() + 60 * 60 * 1000;
    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId,
      title: "Reunião",
      type: "task",
      priority: "high",
      dueDate,
      reminderMinutesBefore: 30,
      assigneeIds: [s.ana.memberId, s.bruno.memberId],
    });

    expect((await scheduledNamed(t, "triggerPreDueReminder")).length).toBe(1);

    await t.mutation(internal.tasks.triggerPreDueReminder, { taskId, expectedDueDate: dueDate });

    const anaDueSoon = (await notificationsOf(t, s.ana.memberId)).filter(
      (n) => n.type === "task_due_soon"
    );
    const brunoDueSoon = (await notificationsOf(t, s.bruno.memberId)).filter(
      (n) => n.type === "task_due_soon"
    );
    expect(anaDueSoon.length).toBe(1);
    expect(brunoDueSoon.length).toBe(1);
    expect((await getTaskDoc(t, taskId))?.preDueReminderSentAt).toBeGreaterThan(0);

    // segunda execução não duplica
    await t.mutation(internal.tasks.triggerPreDueReminder, { taskId, expectedDueDate: dueDate });
    expect(
      (await notificationsOf(t, s.ana.memberId)).filter((n) => n.type === "task_due_soon").length
    ).toBe(1);
  });

  test("mudar dueDate invalida o agendamento antigo e reagenda", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const dueDate = Date.now() + 2 * 60 * 60 * 1000;
    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId,
      title: "Remarcar",
      type: "task",
      priority: "medium",
      dueDate,
      reminderMinutesBefore: 30,
      assigneeIds: [s.ana.memberId],
    });

    const newDueDate = dueDate + 24 * 60 * 60 * 1000;
    await asAdmin.mutation(api.tasks.updateTask, { taskId, dueDate: newDueDate });

    expect((await scheduledNamed(t, "triggerPreDueReminder")).length).toBe(2);

    // o disparo antigo é obsoleto: não notifica nem marca
    await t.mutation(internal.tasks.triggerPreDueReminder, { taskId, expectedDueDate: dueDate });
    expect(
      (await notificationsOf(t, s.ana.memberId)).filter((n) => n.type === "task_due_soon").length
    ).toBe(0);
    expect((await getTaskDoc(t, taskId))?.preDueReminderSentAt).toBeUndefined();

    // o novo disparo vale
    await t.mutation(internal.tasks.triggerPreDueReminder, { taskId, expectedDueDate: newDueDate });
    expect(
      (await notificationsOf(t, s.ana.memberId)).filter((n) => n.type === "task_due_soon").length
    ).toBe(1);
  });

  test("desligar o lembrete invalida o job já agendado", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const dueDate = Date.now() + 3 * 60 * 60 * 1000;
    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Desligar", type: "task", priority: "medium",
      dueDate, reminderMinutesBefore: 30, assigneeIds: [s.ana.memberId],
    });

    await asAdmin.mutation(api.tasks.updateTask, { taskId, reminderMinutesBefore: 0 });

    // job antigo (com e sem expectedMinutes — jobs pré-existentes não têm o campo)
    await t.mutation(internal.tasks.triggerPreDueReminder, {
      taskId, expectedDueDate: dueDate, expectedMinutes: 30,
    });
    await t.mutation(internal.tasks.triggerPreDueReminder, { taskId, expectedDueDate: dueDate });

    expect(
      (await notificationsOf(t, s.ana.memberId)).filter((n) => n.type === "task_due_soon").length
    ).toBe(0);
    expect((await getTaskDoc(t, taskId))?.preDueReminderSentAt).toBeUndefined();
  });

  test("mudar a antecedência invalida o job antigo e o novo vale", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const dueDate = Date.now() + 48 * 60 * 60 * 1000;
    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Antecedência", type: "task", priority: "medium",
      dueDate, reminderMinutesBefore: 1440, assigneeIds: [s.ana.memberId],
    });

    await asAdmin.mutation(api.tasks.updateTask, { taskId, reminderMinutesBefore: 60 });

    await t.mutation(internal.tasks.triggerPreDueReminder, {
      taskId, expectedDueDate: dueDate, expectedMinutes: 1440,
    });
    expect(
      (await notificationsOf(t, s.ana.memberId)).filter((n) => n.type === "task_due_soon").length
    ).toBe(0);

    await t.mutation(internal.tasks.triggerPreDueReminder, {
      taskId, expectedDueDate: dueDate, expectedMinutes: 60,
    });
    expect(
      (await notificationsOf(t, s.ana.memberId)).filter((n) => n.type === "task_due_soon").length
    ).toBe(1);
  });

  test("task concluída não recebe lembrete antecipado", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const dueDate = Date.now() + 60 * 60 * 1000;
    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Feita", type: "task", priority: "low",
      dueDate, reminderMinutesBefore: 15, assigneeIds: [s.ana.memberId],
    });
    await asAdmin.mutation(api.tasks.completeTask, { taskId });

    await t.mutation(internal.tasks.triggerPreDueReminder, { taskId, expectedDueDate: dueDate });
    expect(
      (await notificationsOf(t, s.ana.memberId)).filter((n) => n.type === "task_due_soon").length
    ).toBe(0);
  });
});

// ===== Menções =====

describe("menções em comentários", () => {
  test("addComment cria notificação in-app para cada mencionado, menos o autor", async () => {
    const s = await seedOrg(t);
    const asAna = t.withIdentity({ subject: `${s.ana.userId}|s1` });

    const taskId = await asAna.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Revisar proposta", type: "task", priority: "medium",
    });

    await asAna.mutation(api.taskComments.addComment, {
      taskId,
      content: "@Bruno pode revisar isso hoje?",
      mentionedUserIds: [s.bruno.memberId, s.ana.memberId],
    });

    const brunoMentions = (await notificationsOf(t, s.bruno.memberId)).filter(
      (n) => n.type === "task_comment_mention"
    );
    expect(brunoMentions.length).toBe(1);
    expect(brunoMentions[0].taskId).toBe(taskId);
    expect(brunoMentions[0].body).toContain("Revisar proposta");

    // autor não se auto-notifica
    expect(
      (await notificationsOf(t, s.ana.memberId)).filter((n) => n.type === "task_comment_mention").length
    ).toBe(0);
  });
});

// ===== Filtros e busca =====

describe("filtros de getTasks", () => {
  test("filtra por projeto, coluna, labels (any-match) e responsável secundário", async () => {
    const s = await seedOrg(t);
    const p = await seedProject(t, s.organizationId, s.admin.memberId);
    const labels = await seedLabels(t, s.organizationId);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const inProject = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "No projeto", type: "task", priority: "medium",
      projectId: p.projectId, labelIds: [labels.urgente],
      assigneeIds: [s.ana.memberId, s.bruno.memberId],
    });
    await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Solta", type: "task", priority: "medium",
      labelIds: [labels.backlog],
    });

    const byProject = await asAdmin.query(api.tasks.getTasks, {
      organizationId: s.organizationId, projectId: p.projectId,
    });
    expect(byProject.map((x: any) => x._id)).toEqual([inProject]);

    const byColumn = await asAdmin.query(api.tasks.getTasks, {
      organizationId: s.organizationId, columnId: p.todo,
    });
    expect(byColumn.map((x: any) => x._id)).toEqual([inProject]);

    const byLabel = await asAdmin.query(api.tasks.getTasks, {
      organizationId: s.organizationId, labelIds: [labels.urgente, labels.backlog],
    });
    expect(byLabel.length).toBe(2);

    // responsável secundário (Bruno não é o assignedTo)
    const byAssignee = await asAdmin.query(api.tasks.getTasks, {
      organizationId: s.organizationId, assigneeId: s.bruno.memberId,
    });
    expect(byAssignee.map((x: any) => x._id)).toEqual([inProject]);
    expect(byAssignee[0].labels).toEqual([
      { _id: labels.urgente, name: "Urgente", color: "#ef4444" },
    ]);
    expect(byAssignee[0].assignees.length).toBe(2);
  });

  test("searchText inclui nome da label e do projeto", async () => {
    const s = await seedOrg(t);
    const p = await seedProject(t, s.organizationId, s.admin.memberId);
    const labels = await seedLabels(t, s.organizationId);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Título neutro", type: "task", priority: "low",
      projectId: p.projectId, labelIds: [labels.urgente],
    });

    const task = await getTaskDoc(t, taskId);
    expect(task?.searchText).toContain("Urgente");
    expect(task?.searchText).toContain("Projeto Alfa");

    // e é reconstruído quando as labels mudam
    await asAdmin.mutation(api.tasks.updateTask, { taskId, labelIds: [labels.backlog] });
    const updated = await getTaskDoc(t, taskId);
    expect(updated?.searchText).toContain("Backlog");
    expect(updated?.searchText).not.toContain("Urgente");
  });
});

// ===== Escala =====

describe("org grande", () => {
  test("getMyTasks/getTaskCounts acham a task do usuário além da janela de varredura", async () => {
    const s = await seedOrg(t);

    // A varredura por status devolve as 1000 primeiras por ordem de criação:
    // a task da Ana é criada depois disso, então só o caminho indexado a alcança.
    const mineId = await t.run(async (ctx) => {
      const now = Date.now();
      const base = {
        organizationId: s.organizationId,
        type: "task" as const,
        status: "pending" as const,
        priority: "medium" as const,
        createdBy: s.admin.memberId,
        createdAt: now,
        updatedAt: now,
      };
      for (let i = 0; i < 1001; i++) {
        await ctx.db.insert("tasks", { ...base, title: `Ruído ${i}`, assigneeIds: [] });
      }
      return await ctx.db.insert("tasks", {
        ...base,
        title: "Minha tarefa",
        assignedTo: s.ana.memberId,
        assigneeIds: [s.ana.memberId],
      });
    });

    // Garante que o cenário é mesmo o de truncamento
    const scanWindow = await t.run(async (ctx) =>
      await ctx.db
        .query("tasks")
        .withIndex("by_organization_and_status", (q) =>
          q.eq("organizationId", s.organizationId).eq("status", "pending")
        )
        .take(1000)
    );
    expect(scanWindow.some((task) => task._id === mineId)).toBe(false);

    const asAna = t.withIdentity({ subject: `${s.ana.userId}|s1` });

    const mine = await asAna.query(api.tasks.getMyTasks, { organizationId: s.organizationId });
    expect(mine.map((x: any) => x._id)).toContain(mineId);

    const counts = await asAna.query(api.tasks.getTaskCounts, {
      organizationId: s.organizationId,
      now: Date.now(),
    });
    expect(counts.myPending).toBe(1);

    // a API REST usa o mesmo critério
    const viaApi = await t.query(internal.tasks.internalGetMyTasks, {
      organizationId: s.organizationId,
      teamMemberId: s.ana.memberId,
    });
    expect(viaApi.map((x: any) => x._id)).toContain(mineId);
  });

  test("internalGetMyTasks enxerga responsável secundário (paridade com o app)", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Compartilhada", type: "task", priority: "medium",
      assigneeIds: [s.ana.memberId, s.bruno.memberId],
    });

    const viaApi = await t.query(internal.tasks.internalGetMyTasks, {
      organizationId: s.organizationId,
      teamMemberId: s.bruno.memberId,
    });
    expect(viaApi.map((x: any) => x._id)).toEqual([taskId]);
  });
});

// ===== E-mail de menção =====

describe("template de menção", () => {
  test("o trecho do comentário chega ao HTML", () => {
    const mention = buildTemplate("taskCommentMention", {
      authorName: "Ana",
      taskTitle: "Revisar proposta",
      taskId: "abc123",
      commentExcerpt: "@bruno confere o desconto?",
      taskUrl: "https://app.hnbcrm.com.br/app/tarefas?task=abc123",
    });

    expect(mention.html).toContain("@bruno confere o desconto?");
  });
});

// ===== Migração =====

describe("migrateTasksP1", () => {
  async function seedLegacyTasks(organizationId: Id<"organizations">, s: Awaited<ReturnType<typeof seedOrg>>) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const base = {
        organizationId,
        type: "task" as const,
        status: "pending" as const,
        priority: "medium" as const,
        createdBy: s.admin.memberId,
        createdAt: now,
        updatedAt: now,
      };
      const originalId = await ctx.db.insert("tasks", {
        ...base, title: "Original", assignedTo: s.ana.memberId, recurrence: { pattern: "weekly" as const },
      });
      // Instância legada de recorrência: herdava a recorrência do original
      const instanceId = await ctx.db.insert("tasks", {
        ...base,
        title: "Instância",
        assignedTo: s.ana.memberId,
        parentTaskId: originalId,
        recurrence: { pattern: "weekly" as const },
      });
      // Subtarefa de verdade (P1): mesma forma, mas sem recorrência
      const subtaskId = await ctx.db.insert("tasks", {
        ...base, title: "Subtarefa real", parentTaskId: originalId,
      });
      const soloId = await ctx.db.insert("tasks", { ...base, title: "Sem responsável" });
      return { originalId, instanceId, subtaskId, soloId };
    });
  }

  test("move parentTaskId legado para recurrenceSourceId e faz backfill de assigneeIds", async () => {
    const s = await seedOrg(t);
    const { originalId, instanceId, soloId } = await seedLegacyTasks(s.organizationId, s);

    const result = await t.mutation(internal.tasks.migrateTasksP1, {});
    expect(result.isDone).toBe(true);
    expect(result.migrated).toBe(4);

    const instance = await getTaskDoc(t, instanceId);
    expect(instance?.recurrenceSourceId).toBe(originalId);
    expect(instance?.parentTaskId).toBeUndefined();
    expect(instance?.assigneeIds).toEqual([s.ana.memberId]);

    expect((await getTaskDoc(t, originalId))?.assigneeIds).toEqual([s.ana.memberId]);
    expect((await getTaskDoc(t, soloId))?.assigneeIds).toEqual([]);

    // rodar de novo é no-op
    const again = await t.mutation(internal.tasks.migrateTasksP1, {});
    expect(again.migrated).toBe(0);
  });

  test("subtarefa real (sem recorrência) sobrevive à re-execução", async () => {
    const s = await seedOrg(t);
    const { originalId, subtaskId } = await seedLegacyTasks(s.organizationId, s);

    await t.mutation(internal.tasks.migrateTasksP1, {});
    await t.mutation(internal.tasks.migrateTasksP1, {});

    const subtask = await getTaskDoc(t, subtaskId);
    expect(subtask?.parentTaskId).toBe(originalId);
    expect(subtask?.recurrenceSourceId).toBeUndefined();
  });

  test("createdBefore ignora tasks criadas depois do cutoff", async () => {
    const s = await seedOrg(t);

    const recentId = await t.run(async (ctx) => {
      const now = Date.now();
      const parentId = await ctx.db.insert("tasks", {
        organizationId: s.organizationId, title: "Pai", type: "task", status: "pending",
        priority: "low", createdBy: s.admin.memberId, createdAt: now, updatedAt: now,
      });
      return await ctx.db.insert("tasks", {
        organizationId: s.organizationId, title: "Recente", type: "task", status: "pending",
        priority: "low", createdBy: s.admin.memberId, parentTaskId: parentId,
        recurrence: { pattern: "daily" }, createdAt: now, updatedAt: now,
      });
    });

    const cutoff = (await getTaskDoc(t, recentId))!.createdAt;
    const result = await t.mutation(internal.tasks.migrateTasksP1, { createdBefore: cutoff });
    expect(result.migrated).toBe(0);

    const recent = await getTaskDoc(t, recentId);
    expect(recent?.parentTaskId).toBeDefined();
    expect(recent?.assigneeIds).toBeUndefined();
  });
});

// ===== Isolamento multi-tenant =====

describe("isolamento entre organizações", () => {
  async function seedSecondOrg() {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Outra Org",
        slug: "outra-org",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now,
        updatedAt: now,
      });
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId, name: "Espião", role: "admin", type: "human",
        status: "active", createdAt: now, updatedAt: now,
      });
      return { organizationId, memberId };
    });
  }

  async function emailsScheduledFor(memberId: Id<"teamMembers">) {
    return await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (f) =>
          f.name.includes("dispatchNotification") &&
          (f.args[0] as any)?.recipientMemberId === memberId
      )
    );
  }

  test("mencionar membro de outra org não cria notificação nem agenda e-mail", async () => {
    const s = await seedOrg(t);
    const outsider = await seedSecondOrg();
    const asAna = t.withIdentity({ subject: `${s.ana.userId}|s1` });

    const taskId = await asAna.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Contrato sigiloso", type: "task", priority: "high",
    });

    await asAna.mutation(api.taskComments.addComment, {
      taskId,
      content: "Valor fechado em R$ 250 mil",
      mentionedUserIds: [outsider.memberId, s.bruno.memberId],
    });

    expect((await notificationsOf(t, outsider.memberId)).length).toBe(0);
    expect((await emailsScheduledFor(outsider.memberId)).length).toBe(0);

    // o mencionado legítimo continua sendo notificado
    expect(
      (await notificationsOf(t, s.bruno.memberId)).filter((n) => n.type === "task_comment_mention").length
    ).toBe(1);
    expect((await emailsScheduledFor(s.bruno.memberId)).length).toBe(1);
  });

  test("atribuir tarefa a membro de outra org é rejeitado", async () => {
    const s = await seedOrg(t);
    const outsider = await seedSecondOrg();
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Interna", type: "task", priority: "low",
    });

    await expect(
      asAdmin.mutation(api.tasks.setAssignees, { taskId, memberIds: [outsider.memberId] })
    ).rejects.toThrow(/Responsável não encontrado/i);

    await expect(
      t.mutation(internal.tasks.internalAssignTask, {
        taskId, assignedTo: outsider.memberId, teamMemberId: s.admin.memberId,
      })
    ).rejects.toThrow(/Responsável não encontrado/i);

    expect((await notificationsOf(t, outsider.memberId)).length).toBe(0);
    expect((await emailsScheduledFor(outsider.memberId)).length).toBe(0);
  });

  test("ações em lote ignoram ids de outra organização", async () => {
    const s = await seedOrg(t);
    const outsider = await seedSecondOrg();
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const mineId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Minha", type: "task", priority: "low",
    });
    const foreignId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("tasks", {
        organizationId: outsider.organizationId, title: "Alheia", type: "task", status: "pending",
        priority: "low", createdBy: outsider.memberId, createdAt: now, updatedAt: now,
      });
    });

    await asAdmin.mutation(api.tasks.bulkUpdateTasks, {
      taskIds: [mineId, foreignId],
      action: "delete",
    });

    expect(await getTaskDoc(t, mineId)).toBeNull();
    expect(await getTaskDoc(t, foreignId)).not.toBeNull();

    // pela API REST (membro vem da API key) o mesmo vale
    await t.mutation(internal.tasks.internalBulkUpdate, {
      taskIds: [foreignId],
      action: "complete",
      teamMemberId: s.admin.memberId,
    });
    expect((await getTaskDoc(t, foreignId))?.status).toBe("pending");
  });

  test("mutations internas rejeitam task de outra organização", async () => {
    const s = await seedOrg(t);
    const outsider = await seedSecondOrg();

    const foreignId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("tasks", {
        organizationId: outsider.organizationId, title: "Alheia", type: "task", status: "pending",
        priority: "low", createdBy: outsider.memberId, createdAt: now, updatedAt: now,
      });
    });

    await expect(
      t.mutation(internal.tasks.internalCompleteTask, {
        taskId: foreignId, teamMemberId: s.admin.memberId,
      })
    ).rejects.toThrow(/Task not found/i);

    await expect(
      t.mutation(internal.tasks.internalDeleteTask, {
        taskId: foreignId, teamMemberId: s.admin.memberId,
      })
    ).rejects.toThrow(/Task not found/i);

    await expect(
      t.mutation(internal.taskComments.internalAddComment, {
        taskId: foreignId, content: "oi", teamMemberId: s.admin.memberId,
      })
    ).rejects.toThrow(/Task not found/i);

    expect((await getTaskDoc(t, foreignId))?.status).toBe("pending");
  });
});

// ===== Preferências de notificação =====

describe("preferências de notificação", () => {
  test("opt-out suprime a notificação in-app do tipo desligado", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("notificationPreferences", {
        organizationId: s.organizationId,
        teamMemberId: s.bruno.memberId,
        invite: true,
        handoffRequested: true,
        handoffResolved: true,
        taskOverdue: true,
        taskAssigned: false,
        leadAssigned: true,
        newMessage: true,
        dailyDigest: true,
        createdAt: now,
        updatedAt: now,
      });
    });

    await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId,
      title: "Sem sino para o Bruno",
      type: "task",
      priority: "low",
      assigneeIds: [s.bruno.memberId, s.ana.memberId],
    });

    expect((await notificationsOf(t, s.bruno.memberId)).length).toBe(0);
    // Ana não tem linha de preferências: modelo opt-out mantém tudo ligado
    expect((await notificationsOf(t, s.ana.memberId)).length).toBe(1);
  });
});
