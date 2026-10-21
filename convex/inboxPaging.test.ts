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

/** Canal bridge mínimo (sem credenciais: o teste só olha o AGENDAMENTO do recibo). */
async function seedBridgeConfig(t: T, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "Bridge",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** `externalIds` de cada `internalBridgeMarkRead` agendado (sem drenar a fila). */
async function scheduledMarkReads(t: T): Promise<string[][]> {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs
      .filter((j) => j.name.includes("internalBridgeMarkRead"))
      .map((j) => (j.args[0] as { externalIds: string[] }).externalIds);
  });
}

describe("markConversationRead — marca d'água por _creationTime e recibo do bridge", () => {
  test("inbound gravado DEPOIS da leitura com createdAt (sentAt) antigo recebe recibo na leitura seguinte", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, asAdmin } = await seedOrg(t);
    const configId = await seedBridgeConfig(t, organizationId);
    const t0 = Date.now();
    const conversationId = await t.run(async (ctx) =>
      ctx.db.insert("conversations", {
        organizationId,
        channel: "whatsapp",
        channelConfigId: configId,
        kind: "group",
        externalChatId: "120363000000000001@g.us",
        status: "active",
        messageCount: 0,
        lastMessageAt: t0,
        unreadCount: 1,
        createdAt: t0,
        updatedAt: t0,
      })
    );
    const insertGroupInbound = (externalId: string, createdAt: number) =>
      t.run(async (ctx) => {
        await ctx.db.insert("messages", {
          organizationId,
          conversationId,
          direction: "inbound",
          senderType: "contact",
          senderLid: "111@lid",
          content: externalId,
          contentType: "text",
          isInternal: false,
          externalId,
          createdAt,
        });
      });
    await insertGroupInbound("G1", t0);

    vi.setSystemTime(t0 + 10_000);
    await asAdmin.mutation(api.conversations.markConversationRead, { conversationId });
    expect(await scheduledMarkReads(t)).toEqual([["G1"]]);

    // Chega DEPOIS da leitura (gravação em t0+20s), mas o `sentAt` do WhatsApp
    // é anterior ao `lastReadAt` (mídia lenta / reconexão).
    vi.setSystemTime(t0 + 20_000);
    await insertGroupInbound("G2", t0 + 5_000);
    await t.run(async (ctx) => ctx.db.patch(conversationId, { unreadCount: 1 }));

    vi.setSystemTime(t0 + 30_000);
    await asAdmin.mutation(api.conversations.markConversationRead, { conversationId });
    expect(await scheduledMarkReads(t)).toEqual([["G1"], ["G2"]]);
    const conv = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(conv!.unreadCount).toBe(0);
    expect(conv!.lastReadAt).toBe(t0 + 30_000);
  });

  test("bridge 1 a 1: mensagem com metadata.readAt legado não tem recibo reenviado", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, asAdmin } = await seedOrg(t);
    const configId = await seedBridgeConfig(t, organizationId);
    const t0 = Date.now();
    const conversationId = await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", {
        organizationId,
        firstName: "Cliente",
        phone: "5585999990000",
        whatsappNumber: "5585999990000",
        tags: [],
        createdAt: t0,
        updatedAt: t0,
      });
      const boardId = await ctx.db.insert("boards", {
        organizationId,
        name: "Funil",
        color: "#000000",
        order: 0,
        isDefault: true,
        createdAt: t0,
        updatedAt: t0,
      });
      const stageId = await ctx.db.insert("stages", {
        organizationId,
        boardId,
        name: "Novo",
        order: 0,
        color: "#000000",
        isClosedWon: false,
        isClosedLost: false,
        createdAt: t0,
        updatedAt: t0,
      });
      const leadId = await ctx.db.insert("leads", {
        organizationId,
        title: "Lead",
        contactId,
        boardId,
        stageId,
        value: 0,
        currency: "BRL",
        priority: "medium",
        temperature: "warm",
        tags: [],
        customFields: {},
        conversationStatus: "active",
        lastActivityAt: t0,
        createdAt: t0,
        updatedAt: t0,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId,
        leadId,
        channel: "whatsapp",
        channelConfigId: configId,
        status: "active",
        messageCount: 0,
        lastMessageAt: t0,
        unreadCount: 2,
        createdAt: t0,
        updatedAt: t0,
      });
      // Lida antes da fase 2: tem `metadata.readAt`, conversa sem `lastReadAt`.
      await ctx.db.insert("messages", {
        organizationId,
        conversationId,
        leadId,
        direction: "inbound",
        senderType: "contact",
        content: "antiga",
        contentType: "text",
        isInternal: false,
        externalId: "OLD1",
        metadata: { readAt: t0 },
        createdAt: t0,
      });
      await ctx.db.insert("messages", {
        organizationId,
        conversationId,
        leadId,
        direction: "inbound",
        senderType: "contact",
        content: "nova",
        contentType: "text",
        isInternal: false,
        externalId: "NEW1",
        createdAt: t0,
      });
      return conversationId;
    });

    vi.setSystemTime(t0 + 5_000);
    await asAdmin.mutation(api.conversations.markConversationRead, { conversationId });
    expect(await scheduledMarkReads(t)).toEqual([["NEW1"]]);

    // Repetir sem inbound novo: nenhum recibo a mais.
    vi.setSystemTime(t0 + 10_000);
    await asAdmin.mutation(api.conversations.markConversationRead, { conversationId });
    expect(await scheduledMarkReads(t)).toEqual([["NEW1"]]);
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
