/// <reference types="vite/client" />
// Perf Convex I/O, fase 2: limites da lista do inbox e do thread, marca d'água
// de leitura sem patch por mensagem e teto do badge de não lidas.
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { INBOX_UNREAD_SCAN_CAP } from "./lib/inboxLimits";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type T = TestConvex<typeof schema>;

async function seedOrg(t: T) {
  const { organizationId, adminUserId } = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org-paging",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminUserId };
  });
  return { organizationId, asAdmin: t.withIdentity({ subject: `${adminUserId}|s1` }) };
}

/** Conversas sem lead (como as de grupo) — a lista não precisa de lead. */
async function seedConversations(
  t: T,
  organizationId: Id<"organizations">,
  specs: Array<{ lastMessageAt: number; archivedAt?: number; unreadCount?: number }>
) {
  return await t.run(async (ctx) => {
    const ids: Id<"conversations">[] = [];
    for (const spec of specs) {
      ids.push(
        await ctx.db.insert("conversations", {
          organizationId,
          channel: "webchat",
          status: "active",
          messageCount: 0,
          lastMessageAt: spec.lastMessageAt,
          ...(spec.archivedAt !== undefined ? { archivedAt: spec.archivedAt } : {}),
          ...(spec.unreadCount !== undefined ? { unreadCount: spec.unreadCount } : {}),
          createdAt: spec.lastMessageAt,
          updatedAt: spec.lastMessageAt,
        })
      );
    }
    return ids;
  });
}

async function insertInbound(
  t: T,
  organizationId: Id<"organizations">,
  conversationId: Id<"conversations">,
  externalId: string,
  createdAt: number
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", {
      organizationId,
      conversationId,
      direction: "inbound",
      senderType: "contact",
      content: externalId,
      contentType: "text",
      isInternal: false,
      externalId,
      createdAt,
    });
  });
}

describe("getConversations — limite e arquivadas", () => {
  test("default 50; limit explícito; teto 500", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, asAdmin } = await seedOrg(t);
    const t0 = Date.now();
    await seedConversations(
      t,
      organizationId,
      Array.from({ length: 60 }, (_, i) => ({ lastMessageAt: t0 + i }))
    );

    const byDefault = (await asAdmin.query(api.conversations.getConversations, {
      organizationId,
    })) as any[];
    expect(byDefault).toHaveLength(50);
    // As 50 com atividade mais recente.
    expect(Math.min(...byDefault.map((c) => c.lastMessageAt))).toBe(t0 + 10);

    const sixty = (await asAdmin.query(api.conversations.getConversations, {
      organizationId,
      limit: 60,
    })) as any[];
    expect(sixty).toHaveLength(60);

    // Teto: um limit absurdo não lança e não passa de 500 (aqui, todas as 60).
    const huge = (await asAdmin.query(api.conversations.getConversations, {
      organizationId,
      limit: 100_000,
    })) as any[];
    expect(huge).toHaveLength(60);
  });

  test("arquivadas recentes não comem vagas das ativas; archived:true só arquivadas", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, asAdmin } = await seedOrg(t);
    const t0 = Date.now();
    const active = await seedConversations(
      t,
      organizationId,
      Array.from({ length: 8 }, (_, i) => ({ lastMessageAt: t0 + i }))
    );
    // 3 arquivadas com a última mensagem mais recente que todas as ativas.
    const archived = await seedConversations(t, organizationId, [
      { lastMessageAt: t0 + 100, archivedAt: t0 + 200 },
      { lastMessageAt: t0 + 101, archivedAt: t0 + 202 },
      { lastMessageAt: t0 + 102, archivedAt: t0 + 201 },
    ]);

    const five = (await asAdmin.query(api.conversations.getConversations, {
      organizationId,
      limit: 5,
    })) as any[];
    expect(five).toHaveLength(5);
    expect(five.every((c) => !c.archivedAt)).toBe(true);
    expect(five.map((c) => c._id)).toEqual(active.slice(3).reverse());

    const onlyArchived = (await asAdmin.query(api.conversations.getConversations, {
      organizationId,
      archived: true,
    })) as any[];
    // Ordenadas por última mensagem desc (não pela data de arquivamento).
    expect(onlyArchived.map((c) => c._id)).toEqual([archived[2], archived[1], archived[0]]);
  });
});

describe("getMessages — as mais recentes, em ordem ASC", () => {
  test("default 50 das 60; limit 10; shape inalterado", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, asAdmin } = await seedOrg(t);
    const t0 = Date.now();
    const [conversationId] = await seedConversations(t, organizationId, [{ lastMessageAt: t0 }]);
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("messages", {
          organizationId,
          conversationId,
          direction: i % 2 === 0 ? "inbound" : "outbound",
          senderType: i % 2 === 0 ? "contact" : "human",
          content: `m${i}`,
          contentType: "text",
          isInternal: false,
          createdAt: t0 + i * 1000,
        });
      }
    });

    const msgs = (await asAdmin.query(api.conversations.getMessages, { conversationId })) as any[];
    expect(msgs).toHaveLength(50);
    expect(msgs[0].content).toBe("m10");
    expect(msgs[49].content).toBe("m59");
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].createdAt).toBeGreaterThan(msgs[i - 1].createdAt);
    }
    expect(msgs[0]).toHaveProperty("sender");
    expect(msgs[0]).toHaveProperty("senderContact");
    expect(msgs[0]).toHaveProperty("attachmentFiles");

    const ten = (await asAdmin.query(api.conversations.getMessages, {
      conversationId,
      limit: 10,
    })) as any[];
    expect(ten.map((m) => m.content)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${50 + i}`)
    );
  });
});

describe("markConversationRead — marca d'água na conversa", () => {
  test("não grava metadata.readAt; grava lastReadAt; repetir sem novidade não escreve", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, asAdmin } = await seedOrg(t);
    const t0 = Date.now();
    const [conversationId] = await seedConversations(t, organizationId, [
      { lastMessageAt: t0, unreadCount: 2 },
    ]);
    await insertInbound(t, organizationId, conversationId, "wamid.R1", t0);
    await insertInbound(t, organizationId, conversationId, "wamid.R2", t0);

    vi.setSystemTime(t0 + 5_000);
    await asAdmin.mutation(api.conversations.markConversationRead, { conversationId });

    const after1 = await t.run(async (ctx) => ({
      conversation: await ctx.db.get(conversationId),
      messages: await ctx.db
        .query("messages")
        .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversationId))
        .collect(),
    }));
    expect(after1.conversation!.unreadCount).toBe(0);
    expect(after1.conversation!.lastReadAt).toBe(t0 + 5_000);
    for (const m of after1.messages) expect(m.metadata?.readAt).toBeUndefined();

    // Segunda leitura sem inbound novo: documento idêntico (nada escrito).
    vi.setSystemTime(t0 + 10_000);
    await asAdmin.mutation(api.conversations.markConversationRead, { conversationId });
    const after2 = await t.run(async (ctx) => await ctx.db.get(conversationId));
    expect(after2).toEqual(after1.conversation);

    // Inbound novo depois da leitura volta a contar (mesmo com unreadCount 0).
    await insertInbound(t, organizationId, conversationId, "wamid.R3", t0 + 12_000);
    vi.setSystemTime(t0 + 15_000);
    await asAdmin.mutation(api.conversations.markConversationRead, { conversationId });
    const after3 = await t.run(async (ctx) => await ctx.db.get(conversationId));
    expect(after3!.lastReadAt).toBe(t0 + 15_000);
  });
});

describe("getInboxUnreadCount — arquivar zera e soma tem teto", () => {
  test("arquivar (1 e em lote) zera unreadCount; desarquivar não restaura", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, asAdmin } = await seedOrg(t);
    const t0 = Date.now();
    const [a, b] = await seedConversations(t, organizationId, [
      { lastMessageAt: t0, unreadCount: 2 },
      { lastMessageAt: t0 + 1, unreadCount: 3 },
      { lastMessageAt: t0 + 2, unreadCount: 4 },
    ]);
    expect(await asAdmin.query(api.conversations.getInboxUnreadCount, { organizationId })).toBe(9);

    await asAdmin.mutation(api.conversations.setConversationArchived, {
      conversationId: a,
      archived: true,
    });
    await asAdmin.mutation(api.conversations.bulkSetConversationsArchived, {
      organizationId,
      conversationIds: [b],
      archived: true,
    });
    const docs = await t.run(async (ctx) => [await ctx.db.get(a), await ctx.db.get(b)]);
    for (const d of docs) {
      expect(d!.unreadCount).toBe(0);
      expect(d!.lastReadAt).toBeTypeOf("number");
    }
    expect(await asAdmin.query(api.conversations.getInboxUnreadCount, { organizationId })).toBe(4);

    // Mudança aceita: desarquivar não devolve o contador.
    await asAdmin.mutation(api.conversations.setConversationArchived, {
      conversationId: a,
      archived: false,
    });
    expect(await asAdmin.query(api.conversations.getInboxUnreadCount, { organizationId })).toBe(4);
  });

  test(`soma limitada a ${INBOX_UNREAD_SCAN_CAP} conversas não lidas`, async () => {
    const t = convexTest(schema, modules);
    const { organizationId, asAdmin } = await seedOrg(t);
    const t0 = Date.now();
    await seedConversations(
      t,
      organizationId,
      Array.from({ length: INBOX_UNREAD_SCAN_CAP + 20 }, (_, i) => ({
        lastMessageAt: t0 + i,
        unreadCount: 1,
      }))
    );
    // 120 conversas com 1 não lida cada: o badge lê só 100 (e mostra "99+").
    expect(await asAdmin.query(api.conversations.getInboxUnreadCount, { organizationId })).toBe(
      INBOX_UNREAD_SCAN_CAP
    );
  });
});
