/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { buildTemplate } from "./emailTemplates";
import { buildTaskSearchText } from "./lib/taskSearchText";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  return convexTest(schema, modules);
}

async function seedOrgWithMembers(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Test Org",
      slug: "test-org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const adminMemberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const agentUserId = await ctx.db.insert("users", {});
    const agentMemberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: agentUserId,
      name: "Agent",
      role: "agent",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminUserId, adminMemberId, agentUserId, agentMemberId };
  });
}

async function insertTask(
  t: TestConvex<typeof schema>,
  args: {
    organizationId: any;
    createdBy: any;
    title?: string;
    projectId?: any;
    columnId?: any;
    order?: number;
    labelIds?: any[];
    status?: "pending" | "in_progress" | "completed" | "cancelled";
  }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const title = args.title ?? "Test task";
    // Espelha o que tasks.ts faz na criação real: resolve nomes de labels/projeto
    // para o searchText inicial, senão os testes de busca não têm nada pra achar.
    const labels = await Promise.all((args.labelIds ?? []).map((id) => ctx.db.get(id)));
    const project = args.projectId ? await ctx.db.get(args.projectId) : null;
    const searchText = buildTaskSearchText({
      title,
      labelNames: labels.filter((l): l is any => l != null).map((l: any) => l.name),
      projectName: project ? (project as any).name : undefined,
    });
    return await ctx.db.insert("tasks", {
      organizationId: args.organizationId,
      title,
      type: "task",
      status: args.status ?? "pending",
      priority: "medium",
      createdBy: args.createdBy,
      projectId: args.projectId,
      columnId: args.columnId,
      order: args.order,
      labelIds: args.labelIds,
      searchText,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("taskProjects", () => {
  test("createProject cria 3 colunas default com uma done column", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const projectId = await asAdmin.mutation(api.taskProjects.createProject, {
      organizationId,
      name: "Projeto X",
    });

    const columns = await asAdmin.query(api.taskProjects.getColumns, { projectId });
    expect(columns).toHaveLength(3);
    expect(columns.map((c: any) => c.name)).toEqual(["A fazer", "Em andamento", "Concluído"]);
    const doneColumns = columns.filter((c: any) => c.isDoneColumn);
    expect(doneColumns).toHaveLength(1);
    expect(doneColumns[0].name).toBe("Concluído");

    const projects = await asAdmin.query(api.taskProjects.getProjects, { organizationId });
    expect(projects).toHaveLength(1);
    expect(projects[0].openTaskCount).toBe(0);
    expect(projects[0].columns).toHaveLength(3);
  });

  test("agent não pode criar projeto (admin/manager apenas)", async () => {
    const t = setup();
    const { organizationId, agentUserId } = await seedOrgWithMembers(t);
    const asAgent = t.withIdentity({ subject: `${agentUserId}|session1` });

    await expect(
      asAgent.mutation(api.taskProjects.createProject, { organizationId, name: "Nope" })
    ).rejects.toThrow();
  });

  test("agent com override tasks:full consegue criar projeto (RBAC por membro)", async () => {
    const t = setup();
    const { organizationId, agentUserId, agentMemberId } = await seedOrgWithMembers(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(agentMemberId, {
        permissions: {
          leads: "edit_own",
          contacts: "edit",
          inbox: "reply",
          tasks: "full",
          reports: "view",
          team: "none",
          settings: "none",
          auditLogs: "none",
          apiKeys: "none",
        },
      });
    });
    const asAgent = t.withIdentity({ subject: `${agentUserId}|session1` });

    const projectId = await asAgent.mutation(api.taskProjects.createProject, {
      organizationId,
      name: "Projeto do agente",
    });
    expect(projectId).toBeDefined();
  });

  test("manager com override tasks:view_all não consegue deletar projeto (RBAC por membro)", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const managerUserId = await t.run(async (ctx) => {
      const now = Date.now();
      const managerUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("teamMembers", {
        organizationId,
        userId: managerUserId,
        name: "Manager rebaixado",
        role: "manager",
        type: "human",
        status: "active",
        permissions: {
          leads: "edit_all",
          contacts: "edit",
          inbox: "full",
          tasks: "view_all",
          reports: "view",
          team: "view",
          settings: "view",
          auditLogs: "view",
          apiKeys: "manage",
        },
        createdAt: now,
        updatedAt: now,
      });
      return managerUserId;
    });
    const asManager = t.withIdentity({ subject: `${managerUserId}|session1` });

    const projectId = await asAdmin.mutation(api.taskProjects.createProject, {
      organizationId,
      name: "Projeto protegido",
    });

    await expect(
      asManager.mutation(api.taskProjects.deleteProject, { projectId })
    ).rejects.toThrow();
  });

  test("getProjects conta só tasks pending/in_progress como abertas", async () => {
    const t = setup();
    const { organizationId, adminUserId, adminMemberId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const projectId = await asAdmin.mutation(api.taskProjects.createProject, {
      organizationId,
      name: "Projeto Contagem",
    });

    await insertTask(t, { organizationId, createdBy: adminMemberId, projectId, status: "pending" });
    await insertTask(t, { organizationId, createdBy: adminMemberId, projectId, status: "in_progress" });
    await insertTask(t, { organizationId, createdBy: adminMemberId, projectId, status: "completed" });
    await insertTask(t, { organizationId, createdBy: adminMemberId, projectId, status: "cancelled" });

    const projects = await asAdmin.query(api.taskProjects.getProjects, { organizationId });
    const project = projects.find((p: any) => p._id === projectId)!;
    expect(project.openTaskCount).toBe(2);
  });

  test("deleteProject remove o nome do projeto do searchText das tasks", async () => {
    const t = setup();
    const { organizationId, adminUserId, adminMemberId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const projectId = await asAdmin.mutation(api.taskProjects.createProject, {
      organizationId,
      name: "Projeto Zeppelin",
    });
    const columns = await asAdmin.query(api.taskProjects.getColumns, { projectId });
    const aFazer = columns.find((c: any) => c.name === "A fazer")!;

    await insertTask(t, {
      organizationId,
      createdBy: adminMemberId,
      projectId,
      columnId: aFazer._id,
      order: 1000,
    });

    const beforeDelete = await asAdmin.query(api.tasks.searchTasks, {
      organizationId,
      searchText: "Zeppelin",
    });
    expect(beforeDelete.length).toBeGreaterThan(0);

    await asAdmin.mutation(api.taskProjects.deleteProject, { projectId });

    const afterDelete = await asAdmin.query(api.tasks.searchTasks, {
      organizationId,
      searchText: "Zeppelin",
    });
    expect(afterDelete.length).toBe(0);
  });

  test("updateColumn garante no máximo uma done column por projeto", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const projectId = await asAdmin.mutation(api.taskProjects.createProject, {
      organizationId,
      name: "Projeto Y",
    });
    const columns = await asAdmin.query(api.taskProjects.getColumns, { projectId });
    const aFazer = columns.find((c: any) => c.name === "A fazer")!;
    const concluido = columns.find((c: any) => c.name === "Concluído")!;

    await asAdmin.mutation(api.taskProjects.updateColumn, {
      columnId: aFazer._id,
      isDoneColumn: true,
    });

    const updated = await asAdmin.query(api.taskProjects.getColumns, { projectId });
    const doneNow = updated.filter((c: any) => c.isDoneColumn);
    expect(doneNow).toHaveLength(1);
    expect(doneNow[0]._id).toBe(aFazer._id);

    const oldDone = updated.find((c: any) => c._id === concluido._id)!;
    expect(oldDone.isDoneColumn).toBeFalsy();
  });

  test("deleteColumn move tasks para a coluna default e proíbe deletar a última coluna", async () => {
    const t = setup();
    const { organizationId, adminUserId, adminMemberId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const projectId = await asAdmin.mutation(api.taskProjects.createProject, {
      organizationId,
      name: "Projeto Z",
    });
    const columns = await asAdmin.query(api.taskProjects.getColumns, { projectId });
    const emAndamento = columns.find((c: any) => c.name === "Em andamento")!;
    const aFazer = columns.find((c: any) => c.name === "A fazer")!;

    const taskId = await insertTask(t, {
      organizationId,
      createdBy: adminMemberId,
      projectId,
      columnId: emAndamento._id,
      order: 1000,
    });

    await asAdmin.mutation(api.taskProjects.deleteColumn, { columnId: emAndamento._id });

    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task!.columnId).toBe(aFazer._id);

    const remaining = await asAdmin.query(api.taskProjects.getColumns, { projectId });
    expect(remaining).toHaveLength(2);

    // Deletar mais uma é permitido (sobra 1); deletar a última não.
    const concluido = remaining.find((c: any) => c.name === "Concluído")!;
    await asAdmin.mutation(api.taskProjects.deleteColumn, { columnId: concluido._id });

    const lastOne = await asAdmin.query(api.taskProjects.getColumns, { projectId });
    expect(lastOne).toHaveLength(1);

    await expect(
      asAdmin.mutation(api.taskProjects.deleteColumn, { columnId: lastOne[0]._id })
    ).rejects.toThrow("última coluna");
  });

  test("deleteProject limpa projectId/columnId/order das tasks e apaga as colunas", async () => {
    const t = setup();
    const { organizationId, adminUserId, adminMemberId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const projectId = await asAdmin.mutation(api.taskProjects.createProject, {
      organizationId,
      name: "Projeto W",
    });
    const columns = await asAdmin.query(api.taskProjects.getColumns, { projectId });
    const aFazer = columns.find((c: any) => c.name === "A fazer")!;

    const taskId = await insertTask(t, {
      organizationId,
      createdBy: adminMemberId,
      projectId,
      columnId: aFazer._id,
      order: 1000,
    });

    await asAdmin.mutation(api.taskProjects.deleteProject, { projectId });

    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task!.projectId).toBeUndefined();
    expect(task!.columnId).toBeUndefined();
    expect(task!.order).toBeUndefined();

    const project = await t.run(async (ctx) => ctx.db.get(projectId));
    expect(project).toBeNull();

    const remainingColumns = await t.run(async (ctx) =>
      ctx.db
        .query("taskColumns")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect()
    );
    expect(remainingColumns).toHaveLength(0);
  });
});

describe("taskLabels", () => {
  test("nome único por organização (case-insensitive) e qualquer membro pode criar", async () => {
    const t = setup();
    const { organizationId, agentUserId } = await seedOrgWithMembers(t);
    const asAgent = t.withIdentity({ subject: `${agentUserId}|session1` });

    await asAgent.mutation(api.taskLabels.createLabel, {
      organizationId,
      name: "Urgente",
      color: "#ef4444",
    });

    await expect(
      asAgent.mutation(api.taskLabels.createLabel, {
        organizationId,
        name: "urgente",
        color: "#ef4444",
      })
    ).rejects.toThrow();

    const labels = await asAgent.query(api.taskLabels.getLabels, { organizationId });
    expect(labels).toHaveLength(1);
  });

  test("deleteLabel remove o id de tasks.labelIds", async () => {
    const t = setup();
    const { organizationId, adminUserId, adminMemberId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const labelId = await asAdmin.mutation(api.taskLabels.createLabel, {
      organizationId,
      name: "Bug",
      color: "#f97316",
    });

    const taskId = await insertTask(t, {
      organizationId,
      createdBy: adminMemberId,
      labelIds: [labelId],
    });

    await asAdmin.mutation(api.taskLabels.deleteLabel, { labelId });

    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task!.labelIds).toEqual([]);

    const labels = await asAdmin.query(api.taskLabels.getLabels, { organizationId });
    expect(labels).toHaveLength(0);
  });

  test("updateLabel reflete o rename no searchText das tasks (acha pelo nome novo, não pelo antigo)", async () => {
    const t = setup();
    const { organizationId, adminUserId, adminMemberId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const labelId = await asAdmin.mutation(api.taskLabels.createLabel, {
      organizationId,
      name: "Bug",
      color: "#f97316",
    });
    await insertTask(t, {
      organizationId,
      createdBy: adminMemberId,
      labelIds: [labelId],
    });

    const beforeRename = await asAdmin.query(api.tasks.searchTasks, {
      organizationId,
      searchText: "Bug",
    });
    expect(beforeRename.length).toBeGreaterThan(0);

    await asAdmin.mutation(api.taskLabels.updateLabel, { labelId, name: "Defeito" });

    const foundByNewName = await asAdmin.query(api.tasks.searchTasks, {
      organizationId,
      searchText: "Defeito",
    });
    expect(foundByNewName.length).toBeGreaterThan(0);

    const foundByOldName = await asAdmin.query(api.tasks.searchTasks, {
      organizationId,
      searchText: "Bug",
    });
    expect(foundByOldName.length).toBe(0);
  });
});

describe("savedViews de tasks", () => {
  test("salva e lista uma view com filtros de tarefas", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const viewId = await asAdmin.mutation(api.savedViews.createSavedView, {
      organizationId,
      name: "Minhas tarefas urgentes",
      entityType: "tasks",
      filters: {
        statuses: ["pending", "in_progress"],
        priorities: ["urgent"],
        dueFilter: "overdue",
      },
      isShared: true,
    });
    expect(viewId).toBeDefined();

    const views = await asAdmin.query(api.savedViews.getSavedViews, {
      organizationId,
      entityType: "tasks",
    });
    expect(views).toHaveLength(1);
    expect(views[0].filters.statuses).toEqual(["pending", "in_progress"]);
    expect(views[0].filters.dueFilter).toBe("overdue");

    // Views de leads continuam funcionando normalmente (sem quebra).
    const leadViewId = await asAdmin.mutation(api.savedViews.createSavedView, {
      organizationId,
      name: "Leads quentes",
      entityType: "leads",
      filters: { temperature: "hot" },
    });
    expect(leadViewId).toBeDefined();
    const leadViews = await asAdmin.query(api.savedViews.getSavedViews, {
      organizationId,
      entityType: "leads",
    });
    expect(leadViews).toHaveLength(1);
  });
});

describe("email templates P1", () => {
  test("taskCommentMention e taskDueSoon retornam subject/html", () => {
    const mention = buildTemplate("taskCommentMention", {
      authorName: "Fulano",
      taskTitle: "Ligar para cliente",
      taskId: "abc123",
      excerpt: "@fulano confere isso aqui",
    });
    expect(mention.subject).toContain("Fulano");
    expect(mention.html).toContain("Ligar para cliente");
    expect(mention.html).toContain("abc123");

    const dueSoon = buildTemplate("taskDueSoon", {
      taskTitle: "Enviar proposta",
      taskId: "def456",
      dueDate: "13/08/2026",
      minutesBefore: 30,
    });
    expect(dueSoon.subject).toContain("Enviar proposta");
    expect(dueSoon.html).toContain("Enviar proposta");
    expect(dueSoon.html).toContain("13/08/2026");

    // taskUrl explícito tem precedência sobre taskId construído
    const withUrl = buildTemplate("taskDueSoon", {
      taskTitle: "Com URL",
      taskUrl: "https://app.hnbcrm.com.br/app/tarefas?task=xyz",
      dueDate: "14/08/2026",
    });
    expect(withUrl.html).toContain("task=xyz");
  });
});
