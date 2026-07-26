/// <reference types="vite/client" />
/**
 * /resetme (reset de teste via WhatsApp) — prova os três gates e o hard delete:
 *  - sem a env WA_TEST_RESET_PHONES, "/resetme" é mensagem comum (persiste);
 *  - telefone fora da allowlist → mensagem comum;
 *  - telefone na allowlist → NADA persiste e o reset é agendado;
 *  - o reset apaga contato/lead/conversas/mensagens/fila/atividades/handoffs.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const PHONE = "558181392929";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function setup() {
  return convexTest(schema, modules);
}

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Reset", slug: "org-reset",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Default", color: "#111", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#111", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Eric", phone: PHONE, whatsappNumber: PHONE,
      tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Eric", contactId, boardId, stageId, value: 0,
      currency: "BRL", priority: "medium", temperature: "warm", tags: [],
      customFields: {}, conversationStatus: "active", lastActivityAt: now,
      createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", status: "active",
      lastInboundAt: now, messageCount: 2, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("messages", {
      organizationId, conversationId, leadId, direction: "inbound",
      senderType: "contact", content: "oi", contentType: "text",
      isInternal: false, createdAt: now,
    });
    await ctx.db.insert("activities", {
      organizationId, leadId, type: "created", actorType: "system",
      content: "x", createdAt: now,
    });
    return { organizationId, contactId, leadId, conversationId };
  });
}

async function counts(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => ({
    contacts: (await ctx.db.query("contacts").collect()).length,
    leads: (await ctx.db.query("leads").collect()).length,
    conversations: (await ctx.db.query("conversations").collect()).length,
    messages: (await ctx.db.query("messages").collect()).length,
    activities: (await ctx.db.query("activities").collect()).length,
  }));
}

describe("/resetme — gates", () => {
  test("sem env: '/resetme' é persistido como mensagem comum", async () => {
    const t = setup();
    const s = await seed(t);
    const id = await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp",
      content: "/resetme",
    });
    expect(id).not.toBeNull();
    expect((await counts(t)).messages).toBe(2);
  });

  test("telefone fora da allowlist: mensagem comum", async () => {
    const t = setup();
    vi.stubEnv("WA_TEST_RESET_PHONES", "5599000000000");
    const s = await seed(t);
    const id = await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp",
      content: "/resetme",
    });
    expect(id).not.toBeNull();
  });

  test("telefone na allowlist: nada persiste e o reset é agendado", async () => {
    const t = setup();
    vi.stubEnv("WA_TEST_RESET_PHONES", `+55 (81) 8139-2929`); // normalização por dígitos
    const s = await seed(t);
    const id = await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp",
      content: "  /ResetMe  ", // trim + case-insensitive
    });
    expect(id).toBeNull();
    expect((await counts(t)).messages).toBe(1); // só a seed — comando não persistiu
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) =>
        f.name.includes("internalHardResetByPhone")
      )
    );
    expect(scheduled).toHaveLength(1);
  });
});

describe("internalHardResetByPhone — hard delete", () => {
  test("apaga contato, leads, conversas, mensagens, fila, atividades e handoffs", async () => {
    const t = setup();
    const s = await seed(t);
    // extras: item de fila + handoff + task ligados ao lead
    await t.run(async (ctx) => {
      const now = Date.now();
      const agentId = await ctx.db.insert("teamMembers", {
        organizationId: s.organizationId, name: "IA", role: "ai", type: "ai",
        status: "active", createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("aiReplyQueue", {
        organizationId: s.organizationId, conversationId: s.conversationId,
        triggerMessageId: (await ctx.db.query("messages").first())!._id,
        agentMemberId: agentId, status: "done", attempts: 0,
        nextAttemptAt: now, createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("handoffs", {
        organizationId: s.organizationId, leadId: s.leadId, fromMemberId: agentId,
        reason: "x", suggestedActions: [], status: "pending", createdAt: now,
      });
      await ctx.db.insert("tasks", {
        organizationId: s.organizationId, title: "t", type: "task",
        status: "pending", priority: "medium", leadId: s.leadId,
        createdBy: agentId, createdAt: now, updatedAt: now,
      });
    });

    const deleted = await t.mutation(internal.testReset.internalHardResetByPhone, {
      organizationId: s.organizationId,
      phone: PHONE,
    });
    expect(deleted).toMatchObject({
      contacts: 1, leads: 1, conversations: 1, messages: 1,
      aiReplyQueue: 1, handoffs: 1, tasks: 1,
    });

    const after = await counts(t);
    expect(after).toMatchObject({
      contacts: 0, leads: 0, conversations: 0, messages: 0, activities: 0,
    });
  });

  test("número sem dados: no-op com contadores zerados", async () => {
    const t = setup();
    const s = await seed(t);
    const deleted = await t.mutation(internal.testReset.internalHardResetByPhone, {
      organizationId: s.organizationId,
      phone: "5511999990000",
    });
    expect(deleted.contacts).toBe(0);
    expect((await counts(t)).contacts).toBe(1); // dados de outro número intactos
  });
});
