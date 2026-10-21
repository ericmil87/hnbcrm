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
import { generateNextRecurrenceSafely } from "./lib/taskOps";

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
const DAY = 24 * HOUR;

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

// ===== Lembrete no prazo (job por task) =====

async function triggerReminderJobsFor(taskId: Id<"tasks">) {
  const jobs = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
  return jobs.filter(
    (j) =>
      j.state.kind === "pending" &&
      j.name.includes("triggerReminder") &&
      !j.name.includes("PreDue") &&
      (j.args[0] as { taskId?: string })?.taskId === taskId
  );
}

describe("lembrete no prazo agendado por task", () => {
  test("recorrência de reminder concluída agenda triggerReminder para a nova instância", async () => {
    const org = await seedOrg("org-rem-rec");
    const asAdmin = t.withIdentity({ subject: `${org.userId}|s1` });
    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: org.organizationId,
      title: "Lembrete diário",
      type: "reminder",
      priority: "medium",
      dueDate: Date.now() + HOUR,
      recurrence: { pattern: "daily" },
    });

    await asAdmin.mutation(api.tasks.completeTask, { taskId });

    const [next] = await successorsOf(taskId);
    expect(next).toBeDefined();
    const jobs = await triggerReminderJobsFor(next._id);
    expect(jobs.length).toBe(1);
    expect(jobs[0].scheduledTime).toBeGreaterThanOrEqual(next.dueDate! - 1000);
  });

  test("updateTask e internalUpdateTask mudando o prazo de reminder agendam triggerReminder", async () => {
    const org = await seedOrg("org-rem-upd");
    const asAdmin = t.withIdentity({ subject: `${org.userId}|s1` });
    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: org.organizationId,
      title: "Lembrete",
      type: "reminder",
      priority: "medium",
      dueDate: Date.now() + HOUR,
    });
    expect((await triggerReminderJobsFor(taskId)).length).toBe(1);

    await asAdmin.mutation(api.tasks.updateTask, { taskId, dueDate: Date.now() + 2 * HOUR });
    expect((await triggerReminderJobsFor(taskId)).length).toBe(2);

    await t.mutation(internal.tasks.internalUpdateTask, {
      taskId,
      dueDate: Date.now() + 3 * HOUR,
      teamMemberId: org.memberId,
    });
    expect((await triggerReminderJobsFor(taskId)).length).toBe(3);

    // task comum não ganha triggerReminder
    const plainId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: org.organizationId,
      title: "Comum",
      type: "task",
      priority: "low",
      dueDate: Date.now() + HOUR,
    });
    await asAdmin.mutation(api.tasks.updateTask, { taskId: plainId, dueDate: Date.now() + 2 * HOUR });
    expect((await triggerReminderJobsFor(plainId)).length).toBe(0);
  });

  test("job de prazo antigo não dispara lembrete cujo prazo foi adiado", async () => {
    const org = await seedOrg("org-rem-stale");
    const taskId = await insertTask(org, { dueDate: Date.now() + 2 * HOUR });
    await t.mutation(internal.tasks.triggerReminder, { taskId });
    expect((await getTask(taskId))?.reminderTriggered).toBeUndefined();
  });
});

// ===== Recorrência que falha no resgate =====

describe("resgate de recorrência com falha", () => {
  test("stampOnFailure carimba lastGeneratedAt sem gerar instância", async () => {
    const org = await seedOrg("org-rec-falha");
    const taskId = await insertTask(org, {
      type: "task",
      status: "completed",
      completedAt: Date.now() - HOUR,
      recurrence: { pattern: "daily" },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await t.run(async (ctx) => {
      const doc = (await ctx.db.get(taskId))!;
      // título inválido faz o insert da instância lançar
      await generateNextRecurrenceSafely(ctx, { ...doc, title: 42 as unknown as string }, Date.now(), {
        stampOnFailure: true,
      });
    });
    expect(errors.mock.calls.some((c) => String(c[0]).includes("taskRecurrenceFailed"))).toBe(true);
    errors.mockRestore();
    expect((await successorsOf(taskId)).length).toBe(0);
    expect((await getTask(taskId))?.recurrence?.lastGeneratedAt).toBeDefined();
  });
});

// ===== Ops do backlog =====

describe("ops do backlog dos crons", () => {
  async function seedBacklog() {
    const org = await seedOrg("org-backlog");
    const now = Date.now();
    const ids = {
      reminderOld: await insertTask(org, { dueDate: now - 40 * DAY }),
      reminderMid: await insertTask(org, { dueDate: now - 10 * DAY, reminderTriggered: false }),
      reminderRecent: await insertTask(org, { dueDate: now - HOUR }),
      reminderSnoozed: await insertTask(org, {
        dueDate: now - 40 * DAY, reminderTriggered: false, snoozedUntil: now + HOUR,
      }),
      recurringOld: await insertTask(org, {
        type: "task", status: "completed", completedAt: now - 40 * DAY, recurrence: { pattern: "weekly" },
      }),
      recurringRecent: await insertTask(org, {
        type: "task", status: "completed", completedAt: now - HOUR, recurrence: { pattern: "daily" },
      }),
    };
    return { org, ids };
  }

  test("internalCountCronBacklog conta pelos ranges dos crons, por idade e por org", async () => {
    const { org } = await seedBacklog();
    const r = await t.query(internal.opsTasks.internalCountCronBacklog, {});
    expect(r.reminders.total).toEqual({ count: 4, olderThan7d: 3, olderThan30d: 2 });
    expect(r.reminders.byOrganization).toEqual([
      { organizationId: org.organizationId, count: 4, olderThan7d: 3, olderThan30d: 2 },
    ]);
    const pendingFalse = r.reminders.ranges.find(
      (x) => x.status === "pending" && x.reminderTriggered === "false"
    )!;
    expect(pendingFalse.snoozed).toBe(1);
    expect(r.reminders.ranges.every((x) => !x.truncated)).toBe(true);
    expect(r.recurrences.total).toEqual({ count: 2, olderThan7d: 1, olderThan30d: 1 });
  });

  test("dryRun não escreve; real carimba só o que passou do corte e o cron ignora o carimbado", async () => {
    const { ids } = await seedBacklog();

    const plan = await t.mutation(internal.opsTasks.internalStampLegacyCronBacklog, {});
    expect(plan.dryRun).toBe(true);
    expect(plan.reminders.byOrganization[0].taskIds.sort()).toEqual([ids.reminderOld, ids.reminderMid].sort());
    expect(plan.recurrences.byOrganization[0].taskIds).toEqual([ids.recurringOld]);
    expect((await getTask(ids.reminderOld))?.reminderTriggered).toBeUndefined();
    expect((await getTask(ids.recurringOld))?.recurrence?.lastGeneratedAt).toBeUndefined();

    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const real = await t.mutation(internal.opsTasks.internalStampLegacyCronBacklog, { dryRun: false });
    logs.mockRestore();
    expect(real.reminders.count).toBe(2);
    expect(real.recurrences.count).toBe(1);
    expect((await getTask(ids.reminderOld))?.reminderTriggered).toBe(true);
    expect((await getTask(ids.reminderMid))?.reminderTriggered).toBe(true);
    expect((await getTask(ids.reminderSnoozed))?.reminderTriggered).toBe(false);
    expect((await getTask(ids.recurringOld))?.recurrence?.lastGeneratedAt).toBeDefined();
    expect(await t.run(async (ctx) => await ctx.db.query("notifications").collect())).toEqual([]);

    await t.mutation(internal.tasks.processOverdueReminders, {});
    await t.mutation(internal.tasks.processRecurringTasks, {});

    const notified = (await t.run(async (ctx) => await ctx.db.query("notifications").collect())).map(
      (n) => n.taskId
    );
    expect(notified).toEqual([ids.reminderRecent]);
    expect((await successorsOf(ids.recurringOld)).length).toBe(0);
    expect((await successorsOf(ids.recurringRecent)).length).toBe(1);
  });
});
