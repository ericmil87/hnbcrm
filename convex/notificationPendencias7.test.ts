/// <reference types="vite/client" />
/**
 * Pendências de notificações (pós v0.79): `data.channel` no aviso e lembrete de
 * tarefa que vira aviso (`task_due_soon` "vence agora").
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createNotification } from "./lib/notify";
import { notificationCopy } from "./lib/notificationCopy";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type T = TestConvex<typeof schema>;

async function seed(t: T) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "org-a",
      slug: "org-a",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (name: string, type: "human" | "ai" = "human", role: "admin" | "agent" = "agent") => {
      const userId = type === "human" ? await ctx.db.insert("users", {}) : undefined;
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId, name, role, type, status: "active", createdAt: now, updatedAt: now,
      } as any);
      return { userId, memberId };
    };
    const admin = await mk("Admin", "human", "admin");
    const seller = await mk("Vendedor");
    const third = await mk("Terceiro");
    const ai = await mk("Atendente", "ai");
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#000", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Cliente", phone: "5511988887777", tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Lead", contactId, boardId, stageId, value: 0, currency: "BRL",
      priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "instagram", status: "active", lastInboundAt: now,
      messageCount: 0, createdAt: now, updatedAt: now,
    } as any);
    return { organizationId, admin, seller, third, ai, conversationId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

const all = (t: T) => t.run(async (ctx) => ctx.db.query("notifications").collect());

describe("data.channel", () => {
  test("grava o canal no insert e o mantém no patch de coalescência", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const send = (channel?: string) =>
      t.run(async (ctx) => {
        await createNotification(ctx, {
          organizationId: s.organizationId,
          memberId: s.seller.memberId,
          type: "new_message",
          title: "x",
          conversationId: s.conversationId,
          ...(channel ? { channel } : {}),
          coalesce: { key: "new_message:c1" },
        });
      });
    await send("instagram");
    await send(); // patch sem canal: mantém o gravado
    let rows = await all(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].data?.channel).toBe("instagram");
    expect(rows[0].data?.count).toBe(2);
    await send("messenger"); // o canal do evento atual vale
    rows = await all(t);
    expect(rows[0].data?.channel).toBe("messenger");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("sem coalescência, preserva o data do chamador", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await createNotification(ctx, {
        organizationId: s.organizationId,
        memberId: s.seller.memberId,
        type: "conversation_transferred",
        title: "x",
        conversationId: s.conversationId,
        channel: "whatsapp",
        data: { a: 1 },
      });
    });
    expect((await all(t))[0].data).toEqual({ a: 1, channel: "whatsapp" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("atribuir a conversa grava o canal da conversa no aviso", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, { settings: { ...org.settings, modules: { departments: true } } } as any);
    });
    await t
      .withIdentity({ subject: `${s.admin.userId}|s1` })
      .mutation(api.conversationRouting.assignConversation, {
        conversationId: s.conversationId,
        memberId: s.seller.memberId,
      });
    const row = (await all(t)).find((n) => n.type === "conversation_transferred")!;
    expect(row.data?.channel).toBe("instagram");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});

describe("triggerReminder avisa os responsáveis", () => {
  async function reminderTask(t: T, s: Seed, extra: Record<string, unknown> = {}) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("tasks", {
        organizationId: s.organizationId, title: "Ligar", type: "reminder", status: "pending", priority: "medium",
        dueDate: now, assignedTo: s.seller.memberId,
        assigneeIds: [s.seller.memberId, s.third.memberId, s.ai.memberId],
        createdBy: s.admin.memberId, createdAt: now, updatedAt: now, ...extra,
      } as any);
    });
  }

  test("task_due_soon 'vence agora' só para humanos vivos, sem duplicar", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const taskId = await reminderTask(t, s);
    await t.mutation(internal.tasks.triggerReminder, { taskId });
    await t.mutation(internal.tasks.triggerReminder, { taskId }); // idempotente
    const rows = await all(t);
    expect(rows.map((r) => r.memberId).sort()).toEqual([s.seller.memberId, s.third.memberId].sort());
    for (const r of rows) {
      expect(r.type).toBe("task_due_soon");
      expect(r.title).toBe("Ligar vence agora");
      expect(r.taskId).toBe(taskId);
    }
    // concluir a tarefa resolve os avisos
    await t.withIdentity({ subject: `${s.admin.userId}|s1` }).mutation(api.tasks.updateTask, { taskId, status: "completed" });
    for (const r of await all(t)) expect(r.data?.resolvedReason).toBe("task_completed");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("não duplica o aviso antecipado ainda não lido; quem já leu recebe", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const taskId = await reminderTask(t, s, { preDueReminderSentAt: Date.now() - 1000, reminderMinutesBefore: 10 });
    await t.run(async (ctx) => {
      for (const memberId of [s.seller.memberId, s.third.memberId]) {
        await createNotification(ctx, {
          organizationId: s.organizationId, memberId, type: "task_due_soon", title: "vence em 10 min", taskId,
        });
      }
      const mine = (await ctx.db.query("notifications").collect()).find((n) => n.memberId === s.third.memberId)!;
      await ctx.db.patch(mine._id, { readAt: Date.now() });
    });
    await t.mutation(internal.tasks.triggerReminder, { taskId });
    const rows = await all(t);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.memberId === s.seller.memberId)).toHaveLength(1);
    expect(rows.filter((r) => r.memberId === s.third.memberId && r.title === "Ligar vence agora")).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});

describe("copy", () => {
  test("dueNow", () => {
    expect(notificationCopy({ type: "task_due_soon", taskTitle: "Ligar", dueAt: 1, dueNow: true }).title).toBe("Ligar vence agora");
  });
});
