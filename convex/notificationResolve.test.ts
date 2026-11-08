/// <reference types="vite/client" />
/**
 * B1 — "Lidas certas": porta `resolveEntityNotifications`, broadcast resolvido,
 * dedupe do rascunho, destinatário vivo e retenção de não lidas.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { createNotification } from "./lib/notify";
import {
  resolveEntityNotifications,
  draftNotificationAlreadyPending,
  reopenEntityNotifications,
} from "./lib/notificationResolve";

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
        name: slug,
        slug,
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now,
        updatedAt: now,
      });
    const organizationId = await mkOrg("org-a");
    const otherOrgId = await mkOrg("org-b");
    const mkMember = async (orgId: Id<"organizations">, name: string, role: "admin" | "agent") => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId: orgId, userId, name, role, type: "human", status: "active",
        createdAt: now, updatedAt: now,
      });
      return { userId, memberId };
    };
    const admin = await mkMember(organizationId, "Admin", "admin");
    const seller = await mkMember(organizationId, "Vendedor", "agent");
    const third = await mkMember(organizationId, "Terceiro", "agent");
    const outsider = await mkMember(otherOrgId, "Fora", "admin");
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" }, createdAt: now, updatedAt: now,
    });
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
    return {
      organizationId, otherOrgId, agentId, admin, seller, third, outsider, leadId, conversationId, taskId,
    };
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

describe("broadcast do pedido de ajuda", () => {
  test("um aceita -> os 3 destinatários ficam lidos com resolvedBy", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const handoffId = await t.mutation(internal.handoffs.internalRequestHandoff, {
      leadId: s.leadId,
      conversationId: s.conversationId,
      reason: "Cliente pediu humano",
      suggestedActions: [],
      origin: "ai_tool",
      teamMemberId: s.agentId,
    });
    let rows = (await all(t)).filter((n) => n.type === "handoff_requested");
    expect(rows).toHaveLength(3);
    expect(rows.every((n) => n.readAt === undefined)).toBe(true);

    await asUser(t, s.seller.userId).mutation(api.handoffs.acceptHandoff, { handoffId });

    rows = (await all(t)).filter((n) => n.type === "handoff_requested");
    for (const n of rows) {
      expect(n.readAt).toBeDefined();
      expect(n.data?.resolvedBy).toBe(s.seller.memberId);
      expect(n.data?.resolvedReason).toBe("handoff_accepted");
    }
  });

  test("porta direta: 3 membros, todos resolvidos; org B intocada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const handoffId = await t.run(async (ctx) =>
      ctx.db.insert("handoffs", {
        organizationId: s.organizationId, leadId: s.leadId, conversationId: s.conversationId,
        fromMemberId: s.agentId, reason: "x", suggestedActions: [], status: "pending", createdAt: Date.now(),
      } as any)
    );
    for (const m of [s.admin, s.seller, s.third]) {
      await notify(t, s, m.memberId, "handoff_requested", { handoffId });
    }
    // Linha de outra org apontando para o MESMO handoff: a porta não toca.
    await t.run(async (ctx) => {
      await ctx.db.insert("notifications", {
        organizationId: s.otherOrgId, memberId: s.outsider.memberId, type: "handoff_requested",
        title: "b", handoffId, createdAt: Date.now(),
      });
    });
    const n = await t.run(async (ctx) =>
      resolveEntityNotifications(ctx, {
        organizationId: s.organizationId, target: { handoffId }, resolvedByMemberId: s.seller.memberId, reason: "r",
      })
    );
    expect(n).toBe(3);
    const rows = await all(t);
    expect(rows.filter((r) => r.organizationId === s.organizationId).every((r) => r.readAt !== undefined)).toBe(true);
    expect(rows.find((r) => r.organizationId === s.otherOrgId)!.readAt).toBeUndefined();
  });
});

describe("abrir conversa", () => {
  test("limpa só os avisos do próprio membro e só dos tipos da conversa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await notify(t, s, s.admin.memberId, "new_message", { conversationId: s.conversationId });
    await notify(t, s, s.admin.memberId, "conversation_transferred", { conversationId: s.conversationId });
    await notify(t, s, s.seller.memberId, "new_message", { conversationId: s.conversationId });
    await notify(t, s, s.admin.memberId, "handoff_requested", { conversationId: s.conversationId });

    await asUser(t, s.admin.userId).mutation(api.conversations.markConversationRead, {
      conversationId: s.conversationId,
    });

    const rows = await all(t);
    const unread = rows.filter((n) => n.readAt === undefined);
    expect(unread.map((n) => `${n.memberId}:${n.type}`).sort()).toEqual(
      [`${s.seller.memberId}:new_message`, `${s.admin.memberId}:handoff_requested`].sort()
    );
  });
});

describe("rascunho da IA", () => {
  async function draft(t: T, s: Seed, status: string) {
    return await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId,
        direction: "internal", senderId: s.admin.memberId, senderType: "ai", content: "oi",
        contentType: "text", isInternal: true, metadata: { aiDraft: { status } }, createdAt: Date.now(),
      } as any)
    );
  }

  test("descartar resolve o aviso; o próximo rascunho volta a notificar", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const d1 = await draft(t, s, "pending");
    await notify(t, s, s.seller.memberId, "ai_draft_pending", { conversationId: s.conversationId });

    const d2 = await draft(t, s, "pending");
    // não lido + outro rascunho pendente -> dedupe
    expect(
      await t.run((ctx) =>
        draftNotificationAlreadyPending(ctx, {
          memberId: s.seller.memberId, conversationId: s.conversationId, excludeMessageId: d2,
        })
      )
    ).toBe(true);

    await asUser(t, s.admin.userId).mutation(api.attendant.discardAiDraft, { draftMessageId: d1 });
    const [n] = (await all(t)).filter((x) => x.type === "ai_draft_pending");
    expect(n.readAt).toBeDefined();
    expect(n.data?.resolvedReason).toBe("draft_discarded");
    expect(
      await t.run((ctx) =>
        draftNotificationAlreadyPending(ctx, {
          memberId: s.seller.memberId, conversationId: s.conversationId, excludeMessageId: d2,
        })
      )
    ).toBe(false);
  });

  test("não lido mas rascunho já revisado -> não deduplica", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await draft(t, s, "revised");
    await notify(t, s, s.seller.memberId, "ai_draft_pending", { conversationId: s.conversationId });
    const fresh = await draft(t, s, "pending");
    expect(
      await t.run((ctx) =>
        draftNotificationAlreadyPending(ctx, {
          memberId: s.seller.memberId, conversationId: s.conversationId, excludeMessageId: fresh,
        })
      )
    ).toBe(false);
  });
});

describe("tarefa", () => {
  test("concluir limpa atrasada/vence/atribuída; excluir também", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    for (const type of ["task_overdue", "task_due_soon", "task_assigned"] as const) {
      await notify(t, s, s.seller.memberId, type, { taskId: s.taskId });
    }
    await notify(t, s, s.seller.memberId, "task_comment_mention", { taskId: s.taskId });
    await asUser(t, s.admin.userId).mutation(api.tasks.completeTask, { taskId: s.taskId });
    let rows = await all(t);
    expect(rows.filter((n) => n.type !== "task_comment_mention").every((n) => n.readAt !== undefined)).toBe(true);
    expect(rows.find((n) => n.type === "task_overdue")!.data?.resolvedBy).toBe(s.admin.memberId);
    expect(rows.find((n) => n.type === "task_comment_mention")!.readAt).toBeUndefined();

    const task2 = await t.run(async (ctx) =>
      ctx.db.insert("tasks", {
        organizationId: s.organizationId, title: "Outra", type: "task", status: "pending", priority: "medium",
        assignedTo: s.seller.memberId, createdBy: s.admin.memberId, createdAt: Date.now(), updatedAt: Date.now(),
      } as any)
    );
    await notify(t, s, s.seller.memberId, "task_overdue", { taskId: task2 });
    await asUser(t, s.admin.userId).mutation(api.tasks.deleteTask, { taskId: task2 });
    rows = (await all(t)).filter((n) => n.taskId === task2);
    expect(rows[0].readAt).toBeDefined();
    expect(rows[0].data?.resolvedReason).toBe("task_deleted");
    expect(rows[0].data?.resolvedBy).toBe(s.admin.memberId);
  });
});

describe("canal", () => {
  test("reconectar resolve channel_session_lost pelo índice do canal", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const channelId = await t.run(async (ctx) =>
      ctx.db.insert("channelConfigs", {
        organizationId: s.organizationId, channel: "whatsapp", provider: "bridge", displayName: "N",
        status: "active", createdAt: Date.now(), updatedAt: Date.now(),
      } as any)
    );
    await notify(t, s, s.admin.memberId, "channel_session_lost", { channelConfigId: channelId });
    await t.run(async (ctx) => {
      await resolveEntityNotifications(ctx, {
        organizationId: s.organizationId, target: { channelId }, reason: "channel_reconnected",
      });
    });
    const [n] = await all(t);
    expect(n.readAt).toBeDefined();
    expect(n.channelConfigId).toBe(channelId);
  });
});

describe("destinatário vivo", () => {
  test("removido não recebe; remover marca como lidas as pendentes; sem userId não recebe", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await notify(t, s, s.seller.memberId, "new_message", { conversationId: s.conversationId });
    expect((await all(t)).filter((n) => n.readAt === undefined)).toHaveLength(1);

    await asUser(t, s.admin.userId).mutation(api.teamMembers.removeTeamMember, {
      teamMemberId: s.seller.memberId,
    } as any);
    let rows = await all(t);
    expect(rows[0].readAt).toBeDefined();
    expect(rows[0].data?.resolvedReason).toBe("member_removed");

    await notify(t, s, s.seller.memberId, "new_message", { conversationId: s.conversationId });
    expect(await all(t)).toHaveLength(1);

    const pendingId = await t.run(async (ctx) =>
      ctx.db.insert("teamMembers", {
        organizationId: s.organizationId, name: "Pendente", role: "agent", type: "human",
        status: "active", createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    await notify(t, s, pendingId, "new_message");
    rows = await all(t);
    expect(rows).toHaveLength(1);
  });
});

describe("retenção de não lidas", () => {
  test("não lidas > 30 d viram lidas; recentes e org B seguem como estão", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const ids = await t.run(async (ctx) => {
      const mk = (orgId: Id<"organizations">, memberId: Id<"teamMembers">, ageDays: number) =>
        ctx.db.insert("notifications", {
          organizationId: orgId, memberId, type: "new_message", title: "x", createdAt: now - ageDays * DAY,
        });
      return { old: await mk(s.organizationId, s.admin.memberId, 31), fresh: await mk(s.organizationId, s.admin.memberId, 5), oldB: await mk(s.otherOrgId, s.outsider.memberId, 40) };
    });
    await t.mutation(internal.retention.internalRunRetention, { table: "notifications", onlyTable: true, manual: true });
    const get = (id: Id<"notifications">) => t.run(async (ctx) => ctx.db.get(id));
    expect((await get(ids.old))!.readAt).toBeDefined();
    expect((await get(ids.old))!.data?.resolvedReason).toBe("expired_unread");
    expect((await get(ids.fresh))!.readAt).toBeUndefined();
    // Retenção é deployment-wide: a org B também expira (mesma regra), sem apagar nada.
    expect((await get(ids.oldB))!.readAt).toBeDefined();
  });
});

describe("conversa com muitas não lidas", () => {
  const pendingDraft = (t: T, s: Seed) =>
    t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId,
        direction: "internal", senderId: s.admin.memberId, senderType: "ai", content: "oi",
        contentType: "text", isInternal: true, metadata: { aiDraft: { status: "pending" } }, createdAt: Date.now(),
      } as any)
    );

  test("dedupe acha o ai_draft_pending recente entre 11 new_message não lidas", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await pendingDraft(t, s);
    for (let i = 0; i < 11; i++) {
      await notify(t, s, s.seller.memberId, "new_message", { conversationId: s.conversationId });
    }
    await notify(t, s, s.seller.memberId, "ai_draft_pending", { conversationId: s.conversationId });
    const fresh = await pendingDraft(t, s);
    expect(
      await t.run((ctx) =>
        draftNotificationAlreadyPending(ctx, {
          memberId: s.seller.memberId, conversationId: s.conversationId, excludeMessageId: fresh,
        })
      )
    ).toBe(true);
  });

  test("aprovar/descartar limpa o aviso mesmo com mais de 200 não lidas na conversa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const d1 = await pendingDraft(t, s);
    await notify(t, s, s.seller.memberId, "ai_draft_pending", { conversationId: s.conversationId });
    await t.run(async (ctx) => {
      for (let i = 0; i < 205; i++) {
        await ctx.db.insert("notifications", {
          organizationId: s.organizationId, memberId: s.third.memberId, type: "new_message",
          title: "x", conversationId: s.conversationId, createdAt: Date.now(),
        });
      }
    });
    await asUser(t, s.admin.userId).mutation(api.attendant.discardAiDraft, { draftMessageId: d1 });
    const draftNotif = (await all(t)).find((n) => n.type === "ai_draft_pending")!;
    expect(draftNotif.readAt).toBeDefined();
    // os new_message (outro tipo) seguem não lidos
    expect((await all(t)).filter((n) => n.type === "new_message" && n.readAt === undefined)).toHaveLength(205);
  });
});

describe("desfazer (reabrir avisos)", () => {
  test("handoff aceito e desfeito: avisos voltam a não lidos; outras razões e outra org ficam", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const handoffId = await t.run(async (ctx) =>
      ctx.db.insert("handoffs", {
        organizationId: s.organizationId, leadId: s.leadId, conversationId: s.conversationId,
        fromMemberId: s.agentId, reason: "x", suggestedActions: [], status: "pending", createdAt: Date.now(),
      } as any)
    );
    await notify(t, s, s.admin.memberId, "handoff_requested", { handoffId });
    await notify(t, s, s.seller.memberId, "handoff_requested", { handoffId });
    await t.run(async (ctx) => {
      await resolveEntityNotifications(ctx, {
        organizationId: s.organizationId, target: { handoffId }, resolvedByMemberId: s.seller.memberId,
        reason: "handoff_accepted",
      });
    });
    expect((await all(t)).every((n) => n.readAt !== undefined)).toBe(true);
    // razão diferente não reabre
    const other = await t.run(async (ctx) =>
      ctx.db.insert("notifications", {
        organizationId: s.organizationId, memberId: s.third.memberId, type: "handoff_requested", title: "z",
        handoffId, readAt: 1, data: { resolvedReason: "handoff_rejected" }, createdAt: Date.now(),
      })
    );
    const n = await t.run((ctx) =>
      reopenEntityNotifications(ctx, {
        organizationId: s.organizationId, target: { handoffId }, reasons: ["handoff_accepted"],
      })
    );
    expect(n).toBe(2);
    const rows = await all(t);
    for (const r of rows.filter((x) => x._id !== other)) {
      expect(r.readAt).toBeUndefined();
      expect(r.data?.resolvedBy).toBeUndefined();
      expect(r.data?.resolvedReason).toBeUndefined();
    }
    expect(rows.find((x) => x._id === other)!.readAt).toBe(1);
  });

  test("tarefa concluída e reaberta: aviso de atraso volta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await notify(t, s, s.seller.memberId, "task_overdue", { taskId: s.taskId });
    await asUser(t, s.admin.userId).mutation(api.tasks.completeTask, { taskId: s.taskId });
    expect((await all(t))[0].readAt).toBeDefined();
    await t.run(async (ctx) => {
      await reopenEntityNotifications(ctx, {
        organizationId: s.organizationId, target: { taskId: s.taskId }, reasons: ["task_completed"],
      });
    });
    expect((await all(t))[0].readAt).toBeUndefined();
  });
});

describe("tarefa cancelada", () => {
  const mkTask = (t: T, s: Seed, title: string) =>
    t.run(async (ctx) =>
      ctx.db.insert("tasks", {
        organizationId: s.organizationId, title, type: "task", status: "pending", priority: "medium",
        assignedTo: s.seller.memberId, createdBy: s.admin.memberId, createdAt: Date.now(), updatedAt: Date.now(),
      } as any)
    );

  test("cancelTask e bulkUpdateTasks(cancel) resolvem os avisos da tarefa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const a = await mkTask(t, s, "A");
    const b = await mkTask(t, s, "B");
    await notify(t, s, s.seller.memberId, "task_overdue", { taskId: a });
    await notify(t, s, s.seller.memberId, "task_due_soon", { taskId: b });
    const admin = asUser(t, s.admin.userId);
    await admin.mutation(api.tasks.cancelTask, { taskId: a });
    await admin.mutation(api.tasks.bulkUpdateTasks, { taskIds: [b], action: "cancel" } as any);
    const rows = await all(t);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.readAt).toBeDefined();
      expect(r.data?.resolvedReason).toBe("task_cancelled");
      expect(r.data?.resolvedBy).toBe(s.admin.memberId);
    }
  });
});

describe("retenção: muitas não lidas", () => {
  test("mais de 1000 a expirar reagenda a tabela; dryRun informa a contagem", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 1005; i++) {
        await ctx.db.insert("notifications", {
          organizationId: s.organizationId, memberId: s.admin.memberId, type: "new_message", title: "x",
          createdAt: now - 40 * DAY,
        });
      }
    });
    const plan = await t.mutation(internal.retention.internalRunRetentionNow, { table: "notifications" });
    expect(plan.dryRun).toBe(true);
    expect(plan.plan[0].unreadToExpire).toBe(1000);

    const res = await t.mutation(internal.retention.internalRunRetention, {
      table: "notifications", onlyTable: true, manual: true,
    });
    expect(res.status).toBe("continuing");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = (await all(t)).filter((n) => n.readAt === undefined);
    expect(left).toHaveLength(0);
  });
});
