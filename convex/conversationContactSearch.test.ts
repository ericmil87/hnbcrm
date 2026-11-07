/// <reference types="vite/client" />
/**
 * Busca de Conversas por contato (`conversations.searchConversationsByContact`).
 *
 * Protege: casa por nome e por dígitos do telefone (prefixo), nunca devolve
 * outra org, marca arquivada, ignora grupos e tem o MESMO gate de
 * `getConversations` (não membro, membro removido, membro sem inbox).
 */
import { expect, test, describe } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { buildSearchText } from "./lib/searchText";
import { DEFAULT_PERMISSIONS } from "./lib/permissions";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

type T = TestConvex<typeof schema>;

async function seedOrg(t: T, slug: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: slug,
      slug,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: `admin@${slug}.test` });
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
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Default",
      color: "#6366f1",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "Novo",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, userId, memberId, boardId, stageId };
  });
}

type Org = Awaited<ReturnType<typeof seedOrg>>;

async function addContactConversation(
  t: T,
  org: Org,
  contact: { firstName?: string; lastName?: string; phone?: string; city?: string; instagramUsername?: string },
  conv: { lastMessageAt: number; archived?: boolean; preview?: string; unread?: number } = { lastMessageAt: 1000 }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const contactId = await ctx.db.insert("contacts", {
      organizationId: org.organizationId,
      ...contact,
      tags: [],
      searchText: buildSearchText(contact),
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId: org.organizationId,
      title: `Lead ${contact.firstName ?? "sem nome"}`,
      contactId,
      boardId: org.boardId,
      stageId: org.stageId,
      value: 0,
      currency: "BRL",
      priority: "medium",
      temperature: "cold",
      tags: [],
      customFields: {},
      conversationStatus: "new",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId: org.organizationId,
      leadId,
      channel: "whatsapp",
      status: "active",
      messageCount: 1,
      lastMessageAt: conv.lastMessageAt,
      unreadCount: conv.unread ?? 0,
      ...(conv.archived ? { archivedAt: conv.lastMessageAt } : {}),
      lastMessagePreview: conv.preview ?? "Oi",
      lastMessagePreviewAt: conv.lastMessageAt,
      lastMessageDirection: "inbound",
      lastMessageContentType: "text",
      createdAt: now,
      updatedAt: now,
    });
    return { contactId, leadId, conversationId };
  });
}

async function addMember(t: T, org: Org, extra: Record<string, unknown>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", { email: `m${Math.random()}@x.test` });
    await ctx.db.insert("teamMembers", {
      organizationId: org.organizationId,
      userId,
      name: "Membro",
      role: "agent",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
      ...extra,
    } as any);
    return userId;
  });
}

const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return `error:${(e as Error).message.split("\n")[0]}`;
  }
}

describe("searchConversationsByContact", () => {
  test("casa pelo nome e devolve a forma compacta", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-a");
    const maura = await addContactConversation(
      t,
      org,
      { firstName: "Maura", lastName: "Silva", phone: "+5511987651234" },
      { lastMessageAt: 5000, preview: "Combinado", unread: 2 }
    );
    await addContactConversation(t, org, { firstName: "Pedro", phone: "+5521900000000" });

    const rows = await as(t, org.userId).query(api.conversations.searchConversationsByContact, {
      organizationId: org.organizationId,
      searchQuery: "maura",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId: maura.conversationId,
      contactId: maura.contactId,
      contactName: "Maura Silva",
      phoneSuffix: "1234",
      channel: "whatsapp",
      lastMessageAt: 5000,
      lastMessagePreview: "Combinado",
      unreadCount: 2,
      archived: false,
      isGroup: false,
    });
  });

  test("casa pelos dígitos do telefone (prefixo) e marca arquivada", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-b");
    const c = await addContactConversation(
      t,
      org,
      { firstName: "Joana", phone: "5581999887766" },
      { lastMessageAt: 10, archived: true }
    );
    const rows = await as(t, org.userId).query(api.conversations.searchConversationsByContact, {
      organizationId: org.organizationId,
      searchQuery: "558199",
    });
    expect(rows.map((r) => r.conversationId)).toEqual([c.conversationId]);
    expect(rows[0].archived).toBe(true);
  });

  test("menos de 2 letras devolve vazio; grupos ficam de fora", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-c");
    const c = await addContactConversation(t, org, { firstName: "Mariana" });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("conversations", {
        organizationId: org.organizationId,
        leadId: (await ctx.db.get(c.conversationId))!.leadId,
        kind: "group",
        channel: "whatsapp",
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
    const q = (searchQuery: string) =>
      as(t, org.userId).query(api.conversations.searchConversationsByContact, {
        organizationId: org.organizationId,
        searchQuery,
      });
    expect(await q("m")).toEqual([]);
    const rows = await q("mariana");
    expect(rows.map((r) => r.conversationId)).toEqual([c.conversationId]);
  });

  test("outra org nunca aparece", async () => {
    const t = convexTest(schema, modules);
    const orgA = await seedOrg(t, "org-d");
    const orgB = await seedOrg(t, "org-e");
    await addContactConversation(t, orgB, { firstName: "Beatriz" });
    const mine = await addContactConversation(t, orgA, { firstName: "Beatriz" });

    const rows = await as(t, orgA.userId).query(api.conversations.searchConversationsByContact, {
      organizationId: orgA.organizationId,
      searchQuery: "beatriz",
    });
    expect(rows.map((r) => r.conversationId)).toEqual([mine.conversationId]);

    // Membro da org A pedindo a org B: mesmo erro de getConversations.
    expect(
      await outcome(
        as(t, orgA.userId).query(api.conversations.searchConversationsByContact, {
          organizationId: orgB.organizationId,
          searchQuery: "beatriz",
        })
      )
    ).toBe(
      await outcome(
        as(t, orgA.userId).query(api.conversations.getConversations, { organizationId: orgB.organizationId })
      )
    );
  });

  test("mesmo gate de getConversations: não membro, removido, sem inbox", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-f");
    await addContactConversation(t, org, { firstName: "Carla" });
    const outsider = await t.run(async (ctx) => ctx.db.insert("users", { email: "fora@x.test" }));
    const removed = await addMember(t, org, { removedAt: 1 });
    const noInbox = await addMember(t, org, {
      permissions: { ...DEFAULT_PERMISSIONS.agent, inbox: "none" },
    });

    for (const userId of [outsider, removed, noInbox]) {
      const viaSearch = await outcome(
        as(t, userId).query(api.conversations.searchConversationsByContact, {
          organizationId: org.organizationId,
          searchQuery: "carla",
        })
      );
      const viaList = await outcome(
        as(t, userId).query(api.conversations.getConversations, { organizationId: org.organizationId })
      );
      expect(viaSearch).toBe(viaList);
    }
    // Sem identidade: erro, como a lista.
    expect(
      await outcome(
        t.query(api.conversations.searchConversationsByContact, {
          organizationId: org.organizationId,
          searchQuery: "carla",
        })
      )
    ).toMatch(/^error:/);
  });

  test("relevância por contato; dentro do contato, última mensagem primeiro", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-g");
    const c = await addContactConversation(t, org, { firstName: "Renata" }, { lastMessageAt: 100 });
    const newer = await t.run(async (ctx) => {
      const now = Date.now();
      return ctx.db.insert("conversations", {
        organizationId: org.organizationId,
        leadId: c.leadId,
        channel: "instagram",
        status: "active",
        messageCount: 1,
        lastMessageAt: 900,
        createdAt: now,
        updatedAt: now,
      });
    });
    const rows = await as(t, org.userId).query(api.conversations.searchConversationsByContact, {
      organizationId: org.organizationId,
      searchQuery: "renata",
    });
    expect(rows.map((r) => r.conversationId)).toEqual([newer, c.conversationId]);
  });

  test("contato recorrente: acha a conversa do lead MAIS NOVO (6 leads, só o último com conversa)", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-h");
    const { contactId } = await addContactConversation(t, org, { firstName: "Helena" }, { lastMessageAt: 1 });
    // A conversa do 1º lead sai: o cenário é só o último lead ter conversa.
    await t.run(async (ctx) => {
      const convs = await ctx.db.query("conversations").collect();
      for (const c of convs) await ctx.db.delete(c._id);
    });
    const lastConversation = await t.run(async (ctx) => {
      const now = Date.now();
      let leadId: Id<"leads"> | null = null;
      for (let i = 0; i < 5; i++) {
        leadId = await ctx.db.insert("leads", {
          organizationId: org.organizationId,
          title: `Helena ${i}`,
          contactId,
          boardId: org.boardId,
          stageId: org.stageId,
          value: 0,
          currency: "BRL",
          priority: "medium",
          temperature: "cold",
          tags: [],
          customFields: {},
          conversationStatus: "new",
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      return ctx.db.insert("conversations", {
        organizationId: org.organizationId,
        leadId: leadId!,
        channel: "whatsapp",
        status: "active",
        messageCount: 1,
        lastMessageAt: 50,
        createdAt: now,
        updatedAt: now,
      });
    });
    const rows = await as(t, org.userId).query(api.conversations.searchConversationsByContact, {
      organizationId: org.organizationId,
      searchQuery: "helena",
    });
    expect(rows.map((r) => r.conversationId)).toEqual([lastConversation]);
  });

  test("telefone digitado com DDD e traço acha pelo número exato (DDI padrão da org)", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-i");
    const c = await addContactConversation(t, org, { firstName: "Otávio", phone: "5511999998888" });
    await addContactConversation(t, org, { firstName: "Outro", phone: "5511999997777" });
    const q = (searchQuery: string) =>
      as(t, org.userId).query(api.conversations.searchConversationsByContact, {
        organizationId: org.organizationId,
        searchQuery,
      });
    expect((await q("11 99999-8888")).map((r) => r.conversationId)).toEqual([c.conversationId]);
    // Grafia sem o 9º dígito também (variante do número brasileiro).
    expect((await q("(11) 9999-8888")).map((r) => r.conversationId)).toEqual([c.conversationId]);
  });

  test("quem casou pelo nome vem antes de quem só casou pela cidade", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-j");
    const byCity = await addContactConversation(t, org, { firstName: "Ana", city: "Olinda" });
    const byName = await addContactConversation(t, org, { firstName: "Olinda", lastName: "Souza" });
    const rows = await as(t, org.userId).query(api.conversations.searchConversationsByContact, {
      organizationId: org.organizationId,
      searchQuery: "olinda",
    });
    expect(rows.map((r) => r.conversationId)).toEqual([byName.conversationId, byCity.conversationId]);
  });

  test("contato sem nome: @ do Instagram como nome de reserva", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-k");
    await addContactConversation(t, org, { instagramUsername: "maura.ig", phone: "5581988887777" });
    const rows = await as(t, org.userId).query(api.conversations.searchConversationsByContact, {
      organizationId: org.organizationId,
      searchQuery: "81 98888-7777",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].contactName).toBe("");
    expect(rows[0].fallbackName).toBe("@maura.ig");
  });
});

describe("searchMessages kind", () => {
  test("bolha, rascunho da IA e transferência", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-l");
    const { conversationId } = await addContactConversation(t, org, { firstName: "Kelly" });
    await t.run(async (ctx) => {
      const base = {
        organizationId: org.organizationId,
        conversationId,
        contentType: "text" as const,
        senderType: "contact" as const,
        // convex-test exige o campo de cada índice de busca como texto.
        transcriptText: "-",
        imageDescription: "-",
        isInternal: false,
        createdAt: 1,
      };
      await ctx.db.insert("messages", { ...base, direction: "inbound", content: "orcamento bolha" } as any);
      await ctx.db.insert("messages", {
        ...base,
        direction: "internal",
        isInternal: true,
        content: "orcamento rascunho",
        metadata: { aiDraft: { status: "pending" } },
      } as any);
      await ctx.db.insert("messages", {
        ...base,
        direction: "internal",
        isInternal: true,
        content: "orcamento transferido",
        metadata: { kind: "transfer", transfer: { to: "x" } },
      } as any);
    });
    const hits = await as(t, org.userId).query(api.conversations.searchMessages, {
      organizationId: org.organizationId,
      conversationId,
      searchQuery: "orcamento",
    });
    const byContent = Object.fromEntries(hits.map((h) => [h.content, h.kind]));
    expect(byContent).toEqual({
      "orcamento bolha": "message",
      "orcamento rascunho": "ai_draft",
      "orcamento transferido": "transfer",
    });
  });
});
