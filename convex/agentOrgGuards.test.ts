/// <reference types="vite/client" />
/**
 * Guardas de org nas internal.* agentáveis (gate F0): leitura cross-tenant
 * responde como inexistente; escrita cross-tenant lança. Cobre o IDOR apontado
 * na revisão v2 (C9) — antes, essas funções confiavam cegamente no chamador.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  return convexTest(schema, modules);
}

// Duas orgs completas — a A com lead/conversa/mensagem, a B só com um membro.
async function seedTwoOrgs(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();

    const orgA = await ctx.db.insert("organizations", {
      name: "Org A",
      slug: "org-a",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const orgB = await ctx.db.insert("organizations", {
      name: "Org B",
      slug: "org-b",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });

    const memberA = await ctx.db.insert("teamMembers", {
      organizationId: orgA,
      name: "Agente A",
      role: "ai",
      type: "ai",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const memberB = await ctx.db.insert("teamMembers", {
      organizationId: orgB,
      name: "Agente B",
      role: "ai",
      type: "ai",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const boardA = await ctx.db.insert("boards", {
      organizationId: orgA,
      name: "Board A",
      color: "#6366f1",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageA = await ctx.db.insert("stages", {
      organizationId: orgA,
      boardId: boardA,
      name: "Novo",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    const contactA = await ctx.db.insert("contacts", {
      organizationId: orgA,
      firstName: "Cliente",
      phone: "5511999990000",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    const leadA = await ctx.db.insert("leads", {
      organizationId: orgA,
      title: "Lead A",
      contactId: contactA,
      boardId: boardA,
      stageId: stageA,
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
    const conversationA = await ctx.db.insert("conversations", {
      organizationId: orgA,
      leadId: leadA,
      channel: "whatsapp",
      status: "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    return { orgA, orgB, memberA, memberB, boardA, stageA, contactA, leadA, conversationA };
  });
}

describe("guardas de org nas internal.* (F0)", () => {
  test("internalGetLead: lead de outra org responde null", async () => {
    const t = setup();
    const { orgA, orgB, leadA } = await seedTwoOrgs(t);

    const own = await t.query(internal.leads.internalGetLead, {
      leadId: leadA,
      organizationId: orgA,
    });
    expect(own?._id).toEqual(leadA);

    const crossTenant = await t.query(internal.leads.internalGetLead, {
      leadId: leadA,
      organizationId: orgB,
    });
    expect(crossTenant).toBeNull();
  });

  test("internalGetContact: contato de outra org responde null", async () => {
    const t = setup();
    const { orgB, contactA } = await seedTwoOrgs(t);

    const crossTenant = await t.query(internal.contacts.internalGetContact, {
      contactId: contactA,
      organizationId: orgB,
    });
    expect(crossTenant).toBeNull();
  });

  test("internalGetMessages: conversa de outra org responde vazia", async () => {
    const t = setup();
    const { orgA, orgB, conversationA, memberA } = await seedTwoOrgs(t);

    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId: conversationA,
      content: "mensagem da org A",
      teamMemberId: memberA,
    });

    const own = await t.query(internal.conversations.internalGetMessages, {
      conversationId: conversationA,
      organizationId: orgA,
    });
    expect(own).toHaveLength(1);

    const crossTenant = await t.query(internal.conversations.internalGetMessages, {
      conversationId: conversationA,
      organizationId: orgB,
    });
    expect(crossTenant).toHaveLength(0);
  });

  test("internalSendMessage: ator de outra org é recusado", async () => {
    const t = setup();
    const { conversationA, memberB } = await seedTwoOrgs(t);

    await expect(
      t.mutation(internal.conversations.internalSendMessage, {
        conversationId: conversationA,
        content: "invasão cross-tenant",
        teamMemberId: memberB,
      })
    ).rejects.toThrow(/não pertence à organização/);
  });

  test("internalRequestHandoff: ator de outra org é recusado", async () => {
    const t = setup();
    const { leadA, memberB } = await seedTwoOrgs(t);

    await expect(
      t.mutation(internal.handoffs.internalRequestHandoff, {
        leadId: leadA,
        reason: "teste",
        suggestedActions: [],
        teamMemberId: memberB,
      })
    ).rejects.toThrow(/não pertence à organização/);
  });

  test("internalRequestHandoff: segundo handoff com um pendente é recusado (anti-DoS)", async () => {
    const t = setup();
    const { leadA, memberA } = await seedTwoOrgs(t);

    await t.mutation(internal.handoffs.internalRequestHandoff, {
      leadId: leadA,
      reason: "cliente pediu humano",
      summary: "resumo",
      suggestedActions: [],
      teamMemberId: memberA,
    });

    await expect(
      t.mutation(internal.handoffs.internalRequestHandoff, {
        leadId: leadA,
        reason: "de novo",
        suggestedActions: [],
        teamMemberId: memberA,
      })
    ).rejects.toThrow(/repasse pendente/);
  });

  test("internalUpdateLead / internalDeleteLead: ator de outra org é recusado", async () => {
    const t = setup();
    const { leadA, memberB } = await seedTwoOrgs(t);

    await expect(
      t.mutation(internal.leads.internalUpdateLead, {
        leadId: leadA,
        title: "hackeado",
        teamMemberId: memberB,
      })
    ).rejects.toThrow(/não pertence à organização/);

    await expect(
      t.mutation(internal.leads.internalDeleteLead, {
        leadId: leadA,
        teamMemberId: memberB,
      })
    ).rejects.toThrow(/não pertence à organização/);
  });
});
