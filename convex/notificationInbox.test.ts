/// <reference types="vite/client" />
/**
 * D1 (back) — sino como caixa de entrada: unreadOnly, grupos, markAllRead em
 * lotes, markUnread, markSeen/unreadSummary, contagens multi-org e badges do
 * menu com `inbox:view_own`.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { createNotification } from "./lib/notify";
import { NOTIFICATION_TYPE_GROUP, NOTIFICATION_GROUPS, groupOfType } from "./lib/notificationGroups";
import { DEFAULT_PERMISSIONS } from "./lib/permissions";
import { MARK_ALL_READ_BATCH } from "./notifications";

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
    const mkOrg = async (slug: string) =>
      ctx.db.insert("organizations", {
        name: `Org ${slug}`, slug, settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now, updatedAt: now,
      });
    const orgA = await mkOrg("a");
    const orgB = await mkOrg("b");
    const mk = async (
      organizationId: Id<"organizations">, name: string, role: "admin" | "agent",
      userId?: Id<"users">, permissions?: any
    ) => {
      const uid = userId ?? (await ctx.db.insert("users", {}));
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId: uid, name, role, type: "human", status: "active",
        ...(permissions ? { permissions } : {}), createdAt: now, updatedAt: now,
      });
      return { userId: uid, memberId };
    };
    const ana = await mk(orgA, "Ana", "admin");
    const anaB = await mk(orgB, "Ana", "admin", ana.userId); // mesma pessoa, org B
    const bob = await mk(orgA, "Bob", "agent");
    const own = await mk(orgA, "Só Meu", "agent", undefined, { ...DEFAULT_PERMISSIONS.agent, inbox: "view_own" });
    const boardId = await ctx.db.insert("boards", {
      organizationId: orgA, name: "V", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId: orgA, boardId, name: "N", color: "#000", order: 0, isClosedWon: false, isClosedLost: false,
      createdAt: now, updatedAt: now,
    });
    return { orgA, orgB, ana, anaB, bob, own, boardId, stageId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

function helpersFor(t: T, s: Seed) {
  const { orgA, boardId, stageId } = s;
  const mkLead = (assignedTo?: Id<"teamMembers">) =>
    t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", {
        organizationId: orgA, firstName: "C", tags: [], createdAt: now, updatedAt: now,
      });
      return ctx.db.insert("leads", {
        organizationId: orgA, title: "L", contactId, boardId, stageId, value: 0, currency: "BRL",
        priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
        lastActivityAt: now, createdAt: now, updatedAt: now, ...(assignedTo ? { assignedTo } : {}),
      });
    });
  const mkConv = (leadId: Id<"leads">, unreadCount: number, assignedTo?: Id<"teamMembers">) =>
    t.run(async (ctx) => {
      const now = Date.now();
      return ctx.db.insert("conversations", {
        organizationId: orgA, leadId, channel: "whatsapp", status: "active", lastInboundAt: now,
        messageCount: 0, unreadCount, createdAt: now, updatedAt: now, ...(assignedTo ? { assignedTo } : {}),
      } as any);
    });
  return { mkLead, mkConv };
}

const asUser = (t: T, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });
const page = { numItems: 50, cursor: null };

async function notify(t: T, organizationId: Id<"organizations">, memberId: Id<"teamMembers">, type: any, extra: any = {}) {
  await t.run(async (ctx) => {
    await createNotification(ctx, { organizationId, memberId, type, title: `t ${type}`, ...extra });
  });
}
const drain = async (t: T) => {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
};
const unreadOf = (t: T, memberId: Id<"teamMembers">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("notifications")
        .withIndex("by_member_and_read", (q) => q.eq("memberId", memberId).eq("readAt", undefined))
        .collect()
    ).length
  );

describe("grupos", () => {
  test("todo tipo do schema tem exatamente um grupo válido", () => {
    const types = (schema.tables.notifications.validator as any).fields.type.members.map((m: any) => m.value) as string[];
    expect(Object.keys(NOTIFICATION_TYPE_GROUP).sort()).toEqual([...types].sort());
    for (const ty of types) expect(NOTIFICATION_GROUPS).toContain(groupOfType(ty));
  });
});

describe("list", () => {
  test("unreadOnly e group filtram; item traz group, leadId e resolvedByName", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { mkLead } = helpersFor(t, s);
    const leadId = await mkLead();
    await notify(t, s.orgA, s.ana.memberId, "lead_assigned", { data: { leadId } });
    await notify(t, s.orgA, s.ana.memberId, "task_overdue");
    await notify(t, s.orgA, s.ana.memberId, "campaign_paused");
    await notify(t, s.orgA, s.bob.memberId, "task_overdue"); // de outro membro
    const a = asUser(t, s.ana.userId);
    const rows = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    const task = rows.find((n) => n.type === "task_overdue" && n.memberId === s.ana.memberId)!;
    await t.run(async (ctx) => {
      await ctx.db.patch(task._id, { readAt: 1, data: { resolvedBy: s.bob.memberId, resolvedReason: "task_completed" } });
    });

    const all = await a.query(api.notifications.list, { organizationId: s.orgA, paginationOpts: page });
    expect(all.page).toHaveLength(3);
    const lead = all.page.find((n: any) => n.type === "lead_assigned")!;
    expect(lead.leadId).toBe(leadId);
    expect(lead.group).toBe("atendimento");
    expect(all.page.find((n: any) => n._id === task._id)!.resolvedByName).toBe("Bob");

    const unread = await a.query(api.notifications.list, { organizationId: s.orgA, paginationOpts: page, unreadOnly: true });
    expect(unread.page.map((n: any) => n.type).sort()).toEqual(["campaign_paused", "lead_assigned"]);

    const tarefas = await a.query(api.notifications.list, { organizationId: s.orgA, paginationOpts: page, group: "tarefas" });
    expect(tarefas.page.map((n: any) => n._id)).toEqual([task._id]);
    const tarefasUnread = await a.query(api.notifications.list, {
      organizationId: s.orgA, paginationOpts: page, group: "tarefas", unreadOnly: true,
    });
    expect(tarefasUnread.page).toHaveLength(0);
  });

  test("resolvedByName de membro de outra org não vaza", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await notify(t, s.orgA, s.ana.memberId, "handoff_requested");
    await t.run(async (ctx) => {
      const n = (await ctx.db.query("notifications").collect())[0];
      await ctx.db.patch(n._id, { readAt: 1, data: { resolvedBy: s.anaB.memberId } });
    });
    const r = await asUser(t, s.ana.userId).query(api.notifications.list, { organizationId: s.orgA, paginationOpts: page });
    expect(r.page[0].resolvedByName).toBeNull();
  });

  test("multi-tenant: não lê a caixa de outra org nem de outro membro", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await notify(t, s.orgA, s.bob.memberId, "task_assigned");
    await expect(
      asUser(t, s.bob.userId).query(api.notifications.list, { organizationId: s.orgB, paginationOpts: page })
    ).rejects.toThrow();
    const mine = await asUser(t, s.ana.userId).query(api.notifications.list, { organizationId: s.orgA, paginationOpts: page });
    expect(mine.page).toHaveLength(0);
  });
});

describe("markAllRead em lotes", () => {
  async function bulk(t: T, s: Seed, n: number, type: string, memberId: Id<"teamMembers">) {
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("notifications", {
          organizationId: s.orgA, memberId, type: type as any, title: "x", createdAt: now - 1_000_000 + i,
        });
      }
    });
  }

  test("mais de um lote: tudo lido, outro membro intocado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const total = MARK_ALL_READ_BATCH * 2 + 30;
    await bulk(t, s, total, "task_assigned", s.ana.memberId);
    await bulk(t, s, 5, "task_assigned", s.bob.memberId);
    await asUser(t, s.ana.userId).mutation(api.notifications.markAllRead, { organizationId: s.orgA });
    expect(await unreadOf(t, s.ana.memberId)).toBe(total - MARK_ALL_READ_BATCH); // só o 1º lote foi síncrono
    await drain(t);
    expect(await unreadOf(t, s.ana.memberId)).toBe(0);
    expect(await unreadOf(t, s.bob.memberId)).toBe(5);
  });

  test("com grupo: só marca o grupo, atravessando lotes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await bulk(t, s, MARK_ALL_READ_BATCH + 10, "task_assigned", s.ana.memberId);
    await bulk(t, s, MARK_ALL_READ_BATCH + 10, "campaign_paused", s.ana.memberId);
    await asUser(t, s.ana.userId).mutation(api.notifications.markAllRead, { organizationId: s.orgA, group: "tarefas" });
    await drain(t);
    const rows = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    expect(rows.filter((n) => n.type === "task_assigned" && n.readAt === undefined)).toHaveLength(0);
    expect(rows.filter((n) => n.type === "campaign_paused" && n.readAt === undefined)).toHaveLength(MARK_ALL_READ_BATCH + 10);
  });
});

describe("markUnread", () => {
  test("reabre lida comum; resolvida por outra pessoa não volta; alheia falha", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await notify(t, s.orgA, s.ana.memberId, "task_assigned");
    await notify(t, s.orgA, s.ana.memberId, "handoff_requested");
    const rows = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    const plain = rows.find((n) => n.type === "task_assigned")!;
    const resolved = rows.find((n) => n.type === "handoff_requested")!;
    const a = asUser(t, s.ana.userId);
    expect(await a.mutation(api.notifications.markUnread, { organizationId: s.orgA, notificationId: plain._id })).toBe(false); // já não lida
    await a.mutation(api.notifications.markRead, { organizationId: s.orgA, notificationId: plain._id });
    expect(await a.mutation(api.notifications.markUnread, { organizationId: s.orgA, notificationId: plain._id })).toBe(true);
    expect((await t.run(async (ctx) => ctx.db.get(plain._id)))!.readAt).toBeUndefined();

    await t.run(async (ctx) => {
      await ctx.db.patch(resolved._id, { readAt: 5, data: { resolvedBy: s.bob.memberId, resolvedReason: "handoff_accepted" } });
    });
    expect(await a.mutation(api.notifications.markUnread, { organizationId: s.orgA, notificationId: resolved._id })).toBe(false);
    expect((await t.run(async (ctx) => ctx.db.get(resolved._id)))!.readAt).toBe(5);

    await expect(
      asUser(t, s.bob.userId).mutation(api.notifications.markUnread, { organizationId: s.orgA, notificationId: plain._id })
    ).rejects.toThrow();
  });
});

describe("markSeen e unreadSummary", () => {
  test("badge conta só o que chegou depois do visto; visto não é lido", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const a = asUser(t, s.ana.userId);
    await notify(t, s.orgA, s.ana.memberId, "task_assigned");
    await notify(t, s.orgA, s.ana.memberId, "campaign_paused");
    expect(await a.query(api.notifications.unreadSummary, { organizationId: s.orgA })).toEqual({ unread: 2, unseen: 2, seenAt: null });
    vi.setSystemTime(Date.now() + 1000);
    await a.mutation(api.notifications.markSeen, { organizationId: s.orgA });
    const after = await a.query(api.notifications.unreadSummary, { organizationId: s.orgA });
    expect(after.unread).toBe(2);
    expect(after.unseen).toBe(0);
    vi.setSystemTime(Date.now() + 1000);
    await notify(t, s.orgA, s.ana.memberId, "task_overdue");
    expect(await a.query(api.notifications.unreadSummary, { organizationId: s.orgA })).toMatchObject({ unread: 3, unseen: 1 });
    await a.mutation(api.notifications.markSeen, { organizationId: s.orgA });
    expect(await t.run(async (ctx) => (await ctx.db.query("notificationSeen").collect()).length)).toBe(1); // upsert
    expect(await asUser(t, s.bob.userId).query(api.notifications.unreadSummary, { organizationId: s.orgA })).toMatchObject({
      unread: 0,
      unseen: 0,
    });
  });
});

describe("unreadCountsByUser", () => {
  test("uma contagem por org ativa, só as minhas; removido e anônimo fora", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await notify(t, s.orgA, s.ana.memberId, "task_assigned");
    await notify(t, s.orgA, s.ana.memberId, "task_overdue");
    await notify(t, s.orgB, s.anaB.memberId, "campaign_paused");
    await notify(t, s.orgA, s.bob.memberId, "task_assigned"); // de outra pessoa
    const a = asUser(t, s.ana.userId);
    const r = await a.query(api.notifications.unreadCountsByUser, {});
    const byOrg = Object.fromEntries(r.map((x) => [x.organizationId, x]));
    expect(r).toHaveLength(2);
    expect(byOrg[s.orgA]).toMatchObject({ organizationName: "Org a", unread: 2, unseen: 2 });
    expect(byOrg[s.orgB]).toMatchObject({ organizationName: "Org b", unread: 1 });

    await t.run(async (ctx) => ctx.db.patch(s.anaB.memberId, { removedAt: Date.now() }));
    expect((await a.query(api.notifications.unreadCountsByUser, {})).map((x) => x.organizationId)).toEqual([s.orgA]);
    expect(await t.query(api.notifications.unreadCountsByUser, {})).toEqual([]);
  });
});

describe("badges do menu com inbox:view_own", () => {
  test("conversas: view_own conta só as suas; admin e agent padrão contam a org", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { mkLead, mkConv } = helpersFor(t, s);
    const mine = await mkLead(s.own.memberId);
    const others = await mkLead(s.bob.memberId);
    const viaConv = await mkLead(s.bob.memberId);
    await mkConv(mine, 2); // lead meu, mas sem responsável de conversa: não é "Minhas"
    await mkConv(others, 7); // lead do Bob
    await mkConv(viaConv, 4, s.own.memberId); // responsável da conversa sou eu
    const archived = await mkConv(viaConv, 9, s.own.memberId);
    await t.run(async (ctx) => ctx.db.patch(archived, { archivedAt: Date.now() }));
    const q = (u: Id<"users">) => asUser(t, u).query(api.conversations.getInboxUnreadCount, { organizationId: s.orgA });
    expect(await q(s.own.userId)).toBe(4);
    expect(await q(s.ana.userId)).toBe(13);
    expect(await q(s.bob.userId)).toBe(13); // agent padrão (reply) vê a org
  });

  test("repasses: view_own conta só os dirigidos a mim (broadcast e de outros ficam fora)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const lead = await helpersFor(t, s).mkLead();
    await t.run(async (ctx) => {
      const now = Date.now();
      const mk = (toMemberId?: Id<"teamMembers">) =>
        ctx.db.insert("handoffs", {
          organizationId: s.orgA, leadId: lead, fromMemberId: s.ana.memberId, reason: "r", status: "pending",
          summary: "s", suggestedActions: [], createdAt: now, ...(toMemberId ? { toMemberId } : {}),
        } as any);
      await mk(s.own.memberId);
      await mk(undefined);
      await mk(s.bob.memberId);
    });
    const q = (u: Id<"users">) => asUser(t, u).query(api.handoffs.getPendingHandoffCount, { organizationId: s.orgA });
    expect(await q(s.own.userId)).toBe(1);
    expect(await q(s.ana.userId)).toBe(3);
  });
});

describe("D1 correções do review", () => {
  test("unseen olha as mais NOVAS: 101 antigas + 1 nova após markSeen => unseen 1", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const a = asUser(t, s.ana.userId);
    await t.run(async (ctx) => {
      for (let i = 0; i < 101; i++) {
        await ctx.db.insert("notifications", { organizationId: s.orgA, memberId: s.ana.memberId, type: "task_assigned", title: "x", createdAt: 1000 + i });
      }
    });
    vi.setSystemTime(Date.now() + 5000);
    await a.mutation(api.notifications.markSeen, { organizationId: s.orgA });
    vi.setSystemTime(Date.now() + 5000);
    await notify(t, s.orgA, s.ana.memberId, "task_overdue");
    expect(await a.query(api.notifications.unreadSummary, { organizationId: s.orgA })).toMatchObject({ unread: 100, unseen: 1 });
  });

  test("unreadOnly: item agrupado renovado sobe ao topo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const a = asUser(t, s.ana.userId);
    await notify(t, s.orgA, s.ana.memberId, "task_assigned");
    vi.setSystemTime(Date.now() + 1000);
    await notify(t, s.orgA, s.ana.memberId, "campaign_paused");
    const old = (await t.run(async (ctx) => ctx.db.query("notifications").collect())).find((n) => n.type === "task_assigned")!;
    vi.setSystemTime(Date.now() + 1000);
    await t.run(async (ctx) => ctx.db.patch(old._id, { createdAt: Date.now() })); // renovado pelo B2
    const r = await a.query(api.notifications.list, { organizationId: s.orgA, paginationOpts: page, unreadOnly: true });
    expect(r.page.map((n: any) => n.type)).toEqual(["task_assigned", "campaign_paused"]);
  });

  test("markAllRead não apaga aviso renovado depois do clique (nem em lote seguinte)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < MARK_ALL_READ_BATCH + 5; i++) {
        await ctx.db.insert("notifications", { organizationId: s.orgA, memberId: s.ana.memberId, type: "task_assigned", title: "x", createdAt: 1 + i });
      }
    });
    const last = (await t.run(async (ctx) => ctx.db.query("notifications").order("asc").first()))!;
    await t.run(async (ctx) => ctx.db.patch(last._id, { createdAt: Date.now() + 60_000 })); // "do futuro" = depois do clique
    await asUser(t, s.ana.userId).mutation(api.notifications.markAllRead, { organizationId: s.orgA });
    await drain(t);
    expect(await unreadOf(t, s.ana.memberId)).toBe(1);
  });

  test("unreadCountsByUser tem teto 20 por org", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert("notifications", { organizationId: s.orgA, memberId: s.ana.memberId, type: "task_assigned", title: "x", createdAt: 1 + i });
      }
    });
    const r = await asUser(t, s.ana.userId).query(api.notifications.unreadCountsByUser, {});
    expect(r.find((x) => x.organizationId === s.orgA)).toMatchObject({ unread: 20, unseen: 20 });
  });

  test("markUnread reabre expired_unread, mas não outros resolvidos", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ids = await t.run(async (ctx) => {
      const mk = (reason: string) =>
        ctx.db.insert("notifications", {
          organizationId: s.orgA, memberId: s.ana.memberId, type: "task_overdue", title: "x", createdAt: 1, readAt: 2,
          data: { resolvedAt: 2, resolvedReason: reason },
        });
      return { exp: await mk("expired_unread"), done: await mk("task_completed") };
    });
    const a = asUser(t, s.ana.userId);
    expect(await a.mutation(api.notifications.markUnread, { organizationId: s.orgA, notificationId: ids.exp })).toBe(true);
    expect(await a.mutation(api.notifications.markUnread, { organizationId: s.orgA, notificationId: ids.done })).toBe(false);
  });

  test("purge de organização inclui notificationSeen", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("./opsPurge.ts", import.meta.url), "utf8");
    expect(src).toContain('table: "notificationSeen"');
  });
});
