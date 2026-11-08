/// <reference types="vite/client" />
/**
 * Fios soltos de integração das notificações (pós v0.79): resolução por todos
 * os caminhos, índices novos, push × renotify, preferências.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { createNotification } from "./lib/notify";

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
    const mkMember = async (name: string, role: "admin" | "agent") => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId, name, role, type: "human", status: "active", createdAt: now, updatedAt: now,
      });
      return { userId, memberId };
    };
    const admin = await mkMember("Admin", "admin");
    const seller = await mkMember("Vendedor", "agent");
    const third = await mkMember("Terceiro", "agent");
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
      organizationId, leadId, channel: "whatsapp", status: "active", lastInboundAt: now,
      messageCount: 0, createdAt: now, updatedAt: now,
    });
    const taskId = await ctx.db.insert("tasks", {
      organizationId, title: "Ligar", type: "task", status: "pending", priority: "medium",
      assignedTo: seller.memberId, createdBy: admin.memberId, createdAt: now, updatedAt: now,
    } as any);
    return { organizationId, admin, seller, third, boardId, stageId, contactId, leadId, conversationId, taskId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

const asUser = (t: T, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });
const all = (t: T) => t.run(async (ctx) => ctx.db.query("notifications").collect());

async function notify(
  t: T,
  s: Seed,
  memberId: Id<"teamMembers">,
  type: Parameters<typeof createNotification>[1]["type"],
  extra: Partial<Parameters<typeof createNotification>[1]> = {}
) {
  await t.run(async (ctx) => {
    await createNotification(ctx, { organizationId: s.organizationId, memberId, type, title: `t ${type}`, ...extra });
  });
}

describe("2. excluir lead resolve avisos de conversa e repasse", () => {
  test("deleteLead + cascata", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const handoffId = await t.run(async (ctx) =>
      ctx.db.insert("handoffs", {
        organizationId: s.organizationId, leadId: s.leadId, conversationId: s.conversationId,
        fromMemberId: s.admin.memberId, reason: "x", suggestedActions: [], status: "pending", createdAt: Date.now(),
      } as any)
    );
    await notify(t, s, s.seller.memberId, "new_message", { conversationId: s.conversationId });
    await notify(t, s, s.third.memberId, "handoff_requested", { handoffId, conversationId: s.conversationId });
    const before = await all(t);
    expect(before.every((n) => n.readAt === undefined)).toBe(true);
    await asUser(t, s.admin.userId).mutation(api.leads.deleteLead, { leadId: s.leadId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await all(t);
    expect(rows.length).toBeGreaterThan(0);
    for (const n of rows) {
      expect(n.readAt).toBeDefined();
      expect(n.data?.resolvedReason).toBe("lead_deleted");
    }
  });
});

describe("6. excluir tarefa resolve a menção em comentário; concluir não", () => {
  test("deleteTask x updateTask(completed)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await notify(t, s, s.third.memberId, "task_comment_mention", { taskId: s.taskId });
    await asUser(t, s.admin.userId).mutation(api.tasks.updateTask, { taskId: s.taskId, status: "completed" });
    expect((await all(t)).find((n) => n.type === "task_comment_mention")?.readAt).toBeUndefined();
    await asUser(t, s.admin.userId).mutation(api.tasks.deleteTask, { taskId: s.taskId });
    const n = (await all(t)).find((x) => x.type === "task_comment_mention")!;
    expect(n.readAt).toBeDefined();
    expect(n.data?.resolvedReason).toBe("task_deleted");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});

describe("1. updateTask por status resolve os avisos", () => {
  for (const status of ["completed", "cancelled"] as const) {
    test(`status -> ${status}`, async () => {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      await notify(t, s, s.seller.memberId, "task_due_soon", { taskId: s.taskId });
      await notify(t, s, s.seller.memberId, "task_overdue", { taskId: s.taskId });
      await asUser(t, s.admin.userId).mutation(api.tasks.updateTask, { taskId: s.taskId, status });
      const rows = (await all(t)).filter((n) => n.taskId === s.taskId);
      expect(rows.length).toBeGreaterThan(0);
      for (const n of rows) {
        expect(n.readAt).toBeDefined();
        expect(n.data?.resolvedReason).toBe(status === "completed" ? "task_completed" : "task_cancelled");
        expect(n.data?.resolvedBy).toBe(s.admin.memberId);
      }
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    });
  }
});
