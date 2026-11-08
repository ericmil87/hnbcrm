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

async function linkDevice(t: T, s: Seed, m: { userId: Id<"users">; memberId: Id<"teamMembers"> }) {
  await t.run(async (ctx) => {
    const subscriptionId = await ctx.db.insert("pushSubscriptions", {
      userId: m.userId, endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "p", auth: "a",
      platform: "android", createdAt: Date.now(),
    });
    await ctx.db.insert("pushSubscriptionMembers", {
      organizationId: s.organizationId, teamMemberId: m.memberId, subscriptionId, createdAt: Date.now(),
    });
  });
}
const pushJobs = (t: T) =>
  t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((j) => j.name.includes("internalDeliverPush")).length;
  });
const mention = (t: T, s: Seed, onlyAfterWindow: boolean) =>
  notify(t, s, s.seller.memberId, "group_mention", {
    conversationId: s.conversationId,
    coalesce: { key: "group_mention:g1", telegramOnPatch: true, pushOnlyAfterRenotifyWindow: onlyAfterWindow },
  });

describe("7/13. push no patch e relógio do renotify", () => {
  test("group_mention: patch dentro de 5 min não empurra push; depois da janela sim", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await linkDevice(t, s, s.seller);
    await mention(t, s, true);
    expect(await pushJobs(t)).toBe(1);
    vi.advanceTimersByTime(60_000);
    await mention(t, s, true);
    expect(await pushJobs(t)).toBe(1);
    vi.advanceTimersByTime(5 * 60_000);
    await mention(t, s, true);
    expect(await pushJobs(t)).toBe(2);
    const rows = await all(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].data?.count).toBe(3);
    expect(rows[0].data?.pushRenotify).toBe(true);
    await t.run(async (ctx) => {
      for (const j of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (j.state.kind === "pending") await ctx.scheduler.cancel(j._id);
      }
    });
    await t.finishInProgressScheduledFunctions();
  });

  test("pausa segura o push: pushRenotifyAt não avança", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await linkDevice(t, s, s.seller);
    await t.run(async (ctx) => {
      const { patchMemberPrefs } = await import("./lib/notificationPrefs");
      await patchMemberPrefs(ctx, s.organizationId, s.seller.memberId, { pausedUntil: Date.now() + 3_600_000 }, Date.now());
    });
    await mention(t, s, false);
    await mention(t, s, false);
    expect(await pushJobs(t)).toBe(0);
    const [n] = await all(t);
    expect(n.data?.pushRenotifyAt).toBeUndefined();
    expect(n.data?.count).toBe(2);
  });
});

describe("4. markConversationRead com inbox:view_own", () => {
  test("resolve os avisos do próprio leitor e não mexe no unreadCount da conversa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.seller.memberId, {
        permissions: {
          leads: "view_own", contacts: "view", inbox: "view_own", tasks: "view_own",
          reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none",
        },
      } as any);
      await ctx.db.patch(s.conversationId, { unreadCount: 3 });
    });
    await notify(t, s, s.seller.memberId, "new_message", { conversationId: s.conversationId });
    await notify(t, s, s.third.memberId, "new_message", { conversationId: s.conversationId });
    await asUser(t, s.seller.userId).mutation(api.conversations.markConversationRead, { conversationId: s.conversationId });
    const rows = await all(t);
    expect(rows.find((n) => n.memberId === s.seller.memberId)?.readAt).toBeDefined();
    expect(rows.find((n) => n.memberId === s.third.memberId)?.readAt).toBeUndefined();
    const conv = await t.run((ctx) => ctx.db.get(s.conversationId));
    expect(conv?.unreadCount).toBe(3);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});

describe("5. responder ao cliente resolve os próprios avisos", () => {
  test("internalSendMessage (Telegram/REST) e sendMessage (app); nota interna não resolve", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const mk = async () => {
      await notify(t, s, s.seller.memberId, "new_message", { conversationId: s.conversationId });
      await notify(t, s, s.seller.memberId, "conversation_transferred", { conversationId: s.conversationId });
      await notify(t, s, s.third.memberId, "new_message", { conversationId: s.conversationId });
    };
    const unreadOf = async (memberId: Id<"teamMembers">) =>
      (await all(t)).filter((n) => n.memberId === memberId && n.readAt === undefined).length;

    await mk();
    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId: s.conversationId, content: "nota", isInternal: true, teamMemberId: s.seller.memberId,
    });
    expect(await unreadOf(s.seller.memberId)).toBe(2);

    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId: s.conversationId, content: "oi", teamMemberId: s.seller.memberId,
    });
    expect(await unreadOf(s.seller.memberId)).toBe(0);
    expect(await unreadOf(s.third.memberId)).toBe(1);
    expect((await all(t)).find((n) => n.memberId === s.seller.memberId)?.data?.resolvedReason).toBe("replied");

    await asUser(t, s.third.userId).mutation(api.conversations.sendMessage, {
      conversationId: s.conversationId, content: "oi",
    });
    expect(await unreadOf(s.third.memberId)).toBe(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});

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
