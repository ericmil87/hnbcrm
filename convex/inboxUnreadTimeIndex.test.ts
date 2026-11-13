/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "o", slug: "o", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "B", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "S", color: "#000", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    } as any);
    return { organizationId, userId, boardId, stageId, now };
  });
}

const mkConv = (t: TestConvex<typeof schema>, organizationId: Id<"organizations">, i: number, extra: Record<string, unknown> = {}) =>
  t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert("conversations", {
      organizationId, channel: "whatsapp", status: "active", messageCount: 1,
      lastMessageAt: now - i * 1000, createdAt: now - i * 1000, updatedAt: now, ...extra,
    } as any);
  });

const list = async (t: TestConvex<typeof schema>, userId: Id<"users">, args: Record<string, unknown>) =>
  (await t.withIdentity({ subject: `${userId}|s1` }).query(api.conversations.getConversations, args as any)) as any[];

describe("chip Não lidas por tempo (INBOX_UNREAD_TIME_INDEX)", () => {
  test("com a env ligada e mais não lidas que o limite, saem as mais recentes (contador 1) e o lote cheio indica mais", async () => {
    vi.stubEnv("INBOX_UNREAD_TIME_INDEX", "1");
    const t = convexTest(schema, modules);
    const { organizationId, userId } = await seed(t);
    // 5 antigas com contador gigante e 3 recentes com contador 1; limit 3.
    for (let i = 0; i < 5; i++) await mkConv(t, organizationId, 1000 + i, { unreadCount: 500, hasUnread: true });
    const recent = [];
    for (let i = 0; i < 3; i++) recent.push(await mkConv(t, organizationId, i, { unreadCount: 1, hasUnread: true }));
    await mkConv(t, organizationId, 0, {}); // lida
    const rows = await list(t, userId, { organizationId, unreadOnly: true, limit: 3 });
    expect(rows.map((c) => c._id)).toEqual(recent);
    expect(rows).toHaveLength(3); // lote cheio = há mais
    const all = await list(t, userId, { organizationId, unreadOnly: true, limit: 50 });
    expect(all).toHaveLength(8);
    const times = all.map((c) => c.lastMessageAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  test("com a env desligada o ramo antigo (por contador) segue valendo", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, userId } = await seed(t);
    // Sem a flag: só o ramo por contador as enxerga.
    const a = await mkConv(t, organizationId, 1, { unreadCount: 2 });
    const rows = await list(t, userId, { organizationId, unreadOnly: true });
    expect(rows.map((c) => c._id)).toEqual([a]);
  });

  test("transições 0 -> 1 -> 0, arquivar e grupo mantêm a flag", async () => {
    vi.stubEnv("INBOX_UNREAD_TIME_INDEX", "1");
    const t = convexTest(schema, modules);
    const { organizationId, userId, boardId, stageId } = await seed(t);
    const leadId = await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "C", tags: [], customFields: {}, createdAt: now, updatedAt: now } as any);
      return ctx.db.insert("leads", {
        organizationId, boardId, stageId, contactId, title: "L", value: 0, currency: "BRL", priority: "medium",
        temperature: "cold", tags: [], customFields: {}, conversationStatus: "new", lastActivityAt: now,
        createdAt: now, updatedAt: now,
      } as any);
    });
    const messageId = await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId, leadId, channel: "whatsapp", content: "oi", externalId: "w1",
    });
    const conversationId = await t.run(async (ctx) => (await ctx.db.get(messageId!))!.conversationId);
    const flag = () => t.run(async (ctx) => (await ctx.db.get(conversationId))!.hasUnread ?? null);
    expect(await flag()).toBe(true);
    expect((await list(t, userId, { organizationId, unreadOnly: true })).map((c) => c._id)).toEqual([conversationId]);

    const as = t.withIdentity({ subject: `${userId}|s1` });
    await as.mutation(api.conversations.markConversationRead, { conversationId });
    expect(await flag()).toBeNull();
    expect(await list(t, userId, { organizationId, unreadOnly: true })).toEqual([]);

    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId, leadId, channel: "whatsapp", content: "de novo", externalId: "w2",
    });
    expect(await flag()).toBe(true);
    await as.mutation(api.conversations.setConversationArchived, { conversationId, archived: true });
    expect(await flag()).toBeNull();
    await as.mutation(api.conversations.setConversationArchived, { conversationId, archived: false });
    expect(await flag()).toBeNull();
    expect(await list(t, userId, { organizationId, unreadOnly: true })).toEqual([]);
  });

  test("backfill: dry run não escreve; real grava e limpa órfã; segunda execução não escreve", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seed(t);
    const unread = await mkConv(t, organizationId, 1, { unreadCount: 3 });
    const orphan = await mkConv(t, organizationId, 2, { unreadCount: 0, hasUnread: true });
    const read = await mkConv(t, organizationId, 3, {});
    const flags = () =>
      t.run(async (ctx) =>
        Promise.all([unread, orphan, read].map(async (id) => (await ctx.db.get(id))!.hasUnread ?? null)));

    const dry = await t.mutation(internal.opsUnreadIndex.internalBackfillHasUnread, {});
    expect(dry).toMatchObject({ dryRun: true, wouldSet: 1, wouldClear: 1, written: 0 });
    expect(await flags()).toEqual([null, true, null]);

    const real = await t.mutation(internal.opsUnreadIndex.internalBackfillHasUnread, { dryRun: false });
    expect(real).toMatchObject({ wouldSet: 1, wouldClear: 1, written: 2 });
    expect(await flags()).toEqual([true, null, null]);

    const again = await t.mutation(internal.opsUnreadIndex.internalBackfillHasUnread, { dryRun: false });
    expect(again).toMatchObject({ wouldSet: 0, wouldClear: 0, written: 0 });
  });
});

describe("filtro por etapa por índice de leads", () => {
  test("acha conversa antiga fora das 200 mais recentes da org", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, userId, boardId, stageId } = await seed(t);
    const other = await t.run(async (ctx) => {
      const now = Date.now();
      return ctx.db.insert("stages", {
        organizationId, boardId, name: "Outra", color: "#000", order: 1, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
      } as any);
    });
    const mk = (stage: Id<"stages">) =>
      t.run(async (ctx) => {
        const now = Date.now();
        const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "C", tags: [], customFields: {}, createdAt: now, updatedAt: now } as any);
        return ctx.db.insert("leads", {
          organizationId, boardId, stageId: stage, contactId, title: "L", value: 0, currency: "BRL", priority: "medium",
          temperature: "cold", tags: [], customFields: {}, conversationStatus: "new", lastActivityAt: now,
          createdAt: now, updatedAt: now,
        } as any);
      });
    const oldLead = await mk(stageId);
    const oldConv = await mkConv(t, organizationId, 99999, { leadId: oldLead });
    const otherLead = await mk(other);
    for (let i = 0; i < 210; i++) await mkConv(t, organizationId, i, { leadId: otherLead });
    const rows = await list(t, userId, { organizationId, stageId });
    expect(rows.map((c) => c._id)).toEqual([oldConv]);
    expect(rows[0].lead._id).toBe(oldLead);
  });
});
