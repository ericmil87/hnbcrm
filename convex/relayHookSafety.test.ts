/// <reference types="vite/client" />
/**
 * Review B2: o gancho do sino/Telegram no ingest 1:1 nunca derruba o inbound.
 * `maybeBufferInboundForRelay` é trocado por uma versão que lança; a mensagem
 * tem que ser gravada e o log só leva o nome do erro (sem PII).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

vi.mock("./lib/telegramRelay", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/telegramRelay")>();
  return {
    ...real,
    maybeBufferInboundForRelay: vi.fn(async () => {
      throw new TypeError("boom com dado do cliente 5511987654321");
    }),
  };
});

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("gancho que lança não derruba internalReceiveMessage", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const t = convexTest(schema, modules);
  const s = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Acme", slug: "acme", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "ana@acme.test" });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Ana", role: "agent", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Principal", phoneNumberId: "pn-x",
      status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false,
      createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Maria", whatsappNumber: "5511987654321", tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Maria", contactId, boardId, stageId, assignedTo: memberId, value: 0, currency: "BRL",
      priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    return { organizationId, configId, leadId };
  });

  await t.mutation(internal.conversations.internalReceiveMessage, {
    organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: s.configId,
    content: "oi", skipAiEnqueue: true,
  });

  const messages = await t.run((ctx) => ctx.db.query("messages").collect());
  expect(messages.map((m) => m.content)).toContain("oi");
  const logged = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[relay]"));
  expect(logged).toEqual(["[relay] buffer da mensagem nova: TypeError"]);
  expect(logged.join(" ")).not.toMatch(/5511|boom/);
});
