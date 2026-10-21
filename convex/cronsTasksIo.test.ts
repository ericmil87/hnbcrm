/// <reference types="vite/client" />
/**
 * Crons de tarefas por índice (perf Convex I/O, fase 1):
 *  - `processOverdueReminders` lê só lembretes vencidos e não disparados
 *    (`by_type_and_status_and_reminder_and_due`), sem janela global;
 *  - a recorrência nasce na conclusão e o cron `processRecurringTasks` só
 *    resgata concluída que nunca gerou (`by_status_and_recurrence_pattern_and_generated`);
 *  - `CRONS_DISABLED=1` desliga os dois handlers em runtime.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;

beforeEach(() => {
  t = convexTest(schema, modules);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // Cancela webhooks/e-mails/lembretes agendados: não interessam aqui e
  // disparariam contra a instância do teste seguinte.
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
});

const HOUR = 60 * 60 * 1000;

async function seedOrg(slug: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: `Org ${slug}`,
      slug,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {});
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, userId, memberId };
  });
}

type Org = Awaited<ReturnType<typeof seedOrg>>;

async function insertTask(
  org: Org,
  fields: Partial<Omit<Doc<"tasks">, "_id" | "_creationTime">>
): Promise<Id<"tasks">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("tasks", {
      organizationId: org.organizationId,
      title: "Tarefa",
      type: "reminder",
      status: "pending",
      priority: "medium",
      createdBy: org.memberId,
      assignedTo: org.memberId,
      assigneeIds: [org.memberId],
      createdAt: now,
      updatedAt: now,
      ...fields,
    });
  });
}

async function getTask(taskId: Id<"tasks">) {
  return await t.run(async (ctx) => await ctx.db.get(taskId));
}

async function overdueNotifications(memberId: Id<"teamMembers">) {
  const rows = await t.run(async (ctx) =>
    await ctx.db
      .query("notifications")
      .withIndex("by_member_and_created", (q) => q.eq("memberId", memberId))
      .collect()
  );
  return rows.filter((n) => n.type === "task_overdue");
}

async function successorsOf(taskId: Id<"tasks">) {
  return await t.run(async (ctx) =>
    await ctx.db
      .query("tasks")
      .withIndex("by_recurrence_source", (q) => q.eq("recurrenceSourceId", taskId))
      .collect()
  );
}

// ===== Lembretes vencidos =====

describe("processOverdueReminders por índice", () => {
  test("dispara só para lembrete ativo, vencido, não disparado e fora de snooze", async () => {
    const org = await seedOrg("org-lembretes");
    const past = Date.now() - HOUR;

    const undefinedFlag = await insertTask(org, { title: "Sem flag", dueDate: past });
    const falseFlag = await insertTask(org, {
      title: "Flag false", status: "in_progress", dueDate: past, reminderTriggered: false,
    });

    const skipped = {
      alreadyTriggered: await insertTask(org, { dueDate: past, reminderTriggered: true }),
      completed: await insertTask(org, { status: "completed", dueDate: past }),
      cancelled: await insertTask(org, { status: "cancelled", dueDate: past }),
      future: await insertTask(org, { dueDate: Date.now() + HOUR }),
      noDueDate: await insertTask(org, {}),
      notReminder: await insertTask(org, { type: "task", dueDate: past }),
      snoozed: await insertTask(org, {
        dueDate: past, reminderTriggered: false, snoozedUntil: Date.now() + HOUR,
      }),
    };

    await t.mutation(internal.tasks.processOverdueReminders, {});

    expect((await getTask(undefinedFlag))?.reminderTriggered).toBe(true);
    expect((await getTask(falseFlag))?.reminderTriggered).toBe(true);

    for (const [label, id] of Object.entries(skipped)) {
      const doc = await getTask(id);
      expect(doc?.reminderTriggered === true, label).toBe(label === "alreadyTriggered");
    }

    const notes = await overdueNotifications(org.memberId);
    expect(notes.map((n) => n.taskId).sort()).toEqual([undefinedFlag, falseFlag].sort());
  });

  test("não há janela global: o lembrete de outra org dispara mesmo com 500+ tasks antes no índice antigo", async () => {
    const orgA = await seedOrg("org-a");
    const orgB = await seedOrg("org-b");
    const past = Date.now() - HOUR;

    // 520 lembretes concluídos e vencidos da org A — a varredura antiga
    // (`by_organization_and_type`, take(500) sem range) parava neles.
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 520; i++) {
        await ctx.db.insert("tasks", {
          organizationId: orgA.organizationId,
          title: `Concluído ${i}`,
          type: "reminder",
          status: "completed",
          priority: "low",
          dueDate: past,
          createdBy: orgA.memberId,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    // ~10 lembretes vencidos ativos da org A
    for (let i = 0; i < 10; i++) {
      await insertTask(orgA, { title: `A ${i}`, dueDate: past - i });
    }
    const reminderB = await insertTask(orgB, { title: "Da org B", dueDate: past });

    await t.mutation(internal.tasks.processOverdueReminders, {});

    expect((await getTask(reminderB))?.reminderTriggered).toBe(true);
    const notesB = await overdueNotifications(orgB.memberId);
    expect(notesB.map((n) => n.taskId)).toEqual([reminderB]);
    expect((await overdueNotifications(orgA.memberId)).length).toBe(10);

    // segunda rodada: nada mais a disparar
    await t.mutation(internal.tasks.processOverdueReminders, {});
    expect((await overdueNotifications(orgB.memberId)).length).toBe(1);
  });
});

// ===== Recorrência =====

describe("recorrência na conclusão + cron de resgate", () => {
  test("completeTask cria a próxima instância na mesma transação, sem o cron", async () => {
    const org = await seedOrg("org-rec");
    const asAdmin = t.withIdentity({ subject: `${org.userId}|s1` });
    const dueDate = Date.now() + HOUR;

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: org.organizationId,
      title: "Diária",
      type: "task",
      priority: "medium",
      dueDate,
      recurrence: { pattern: "daily" },
    });

    await asAdmin.mutation(api.tasks.completeTask, { taskId });

    const successors = await successorsOf(taskId);
    expect(successors.length).toBe(1);
    expect(successors[0].status).toBe("pending");
    expect(successors[0].dueDate).toBe(
      new Date(new Date(dueDate).setDate(new Date(dueDate).getDate() + 1)).getTime()
    );
    // a instância nova não herda o carimbo: fica visível ao resgate quando concluída
    expect(successors[0].recurrence?.lastGeneratedAt).toBeUndefined();
    expect((await getTask(taskId))?.recurrence?.lastGeneratedAt).toBeDefined();

    // concluir de novo (reabrir e concluir) não duplica; o cron também não
    await asAdmin.mutation(api.tasks.updateTask, { taskId, status: "pending" });
    await asAdmin.mutation(api.tasks.completeTask, { taskId });
    await t.mutation(internal.tasks.processRecurringTasks, {});
    expect((await successorsOf(taskId)).length).toBe(1);
  });

  test("updateTask com status completed também gera a próxima instância", async () => {
    const org = await seedOrg("org-rec-upd");
    const asAdmin = t.withIdentity({ subject: `${org.userId}|s1` });

    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: org.organizationId,
      title: "Semanal",
      type: "task",
      priority: "medium",
      dueDate: Date.now() + HOUR,
      recurrence: { pattern: "weekly" },
    });

    await asAdmin.mutation(api.tasks.updateTask, { taskId, status: "completed" });
    expect((await successorsOf(taskId)).length).toBe(1);
  });

  test("cron resgata concluída legada que nunca gerou e não a relê na rodada seguinte", async () => {
    const org = await seedOrg("org-rec-legado");
    const legacyId = await insertTask(org, {
      title: "Legada",
      type: "task",
      status: "completed",
      completedAt: Date.now() - HOUR,
      dueDate: Date.now() - 2 * HOUR,
      recurrence: { pattern: "monthly" },
    });
    const endedId = await insertTask(org, {
      title: "Encerrada",
      type: "task",
      status: "completed",
      completedAt: Date.now() - HOUR,
      recurrence: { pattern: "weekly", endDate: Date.now() - HOUR },
    });

    const pendingRescue = async () =>
      await t.run(async (ctx) =>
        await ctx.db
          .query("tasks")
          .withIndex("by_status_and_recurrence_pattern_and_generated", (q) =>
            q.eq("status", "completed").eq("recurrence.pattern", "monthly").eq("recurrence.lastGeneratedAt", undefined)
          )
          .collect()
      );
    expect((await pendingRescue()).map((x) => x._id)).toEqual([legacyId]);

    await t.mutation(internal.tasks.processRecurringTasks, {});

    expect((await successorsOf(legacyId)).length).toBe(1);
    expect((await getTask(legacyId))?.recurrence?.lastGeneratedAt).toBeDefined();
    // a encerrada não gera, mas sai do range
    expect((await successorsOf(endedId)).length).toBe(0);
    expect((await getTask(endedId))?.recurrence?.lastGeneratedAt).toBeDefined();
    expect(await pendingRescue()).toEqual([]);

    await t.mutation(internal.tasks.processRecurringTasks, {});
    expect((await successorsOf(legacyId)).length).toBe(1);
  });
});

// ===== Guard de dev =====

describe("CRONS_DISABLED", () => {
  test("com CRONS_DISABLED=1 os dois handlers retornam null sem efeito", async () => {
    vi.stubEnv("CRONS_DISABLED", "1");
    const org = await seedOrg("org-guard");
    const reminderId = await insertTask(org, { dueDate: Date.now() - HOUR });
    const legacyId = await insertTask(org, {
      type: "task",
      status: "completed",
      completedAt: Date.now() - HOUR,
      recurrence: { pattern: "daily" },
    });

    expect(await t.mutation(internal.tasks.processOverdueReminders, {})).toBeNull();
    expect(await t.mutation(internal.tasks.processRecurringTasks, {})).toBeNull();

    expect((await getTask(reminderId))?.reminderTriggered).toBeUndefined();
    expect(await overdueNotifications(org.memberId)).toEqual([]);
    expect((await successorsOf(legacyId)).length).toBe(0);
    expect((await getTask(legacyId))?.recurrence?.lastGeneratedAt).toBeUndefined();

    vi.unstubAllEnvs();
    await t.mutation(internal.tasks.processOverdueReminders, {});
    expect((await getTask(reminderId))?.reminderTriggered).toBe(true);
  });
});
