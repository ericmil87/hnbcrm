/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Chip "Não lidas" (celular): `getConversations({ unreadOnly: true })` precisa
 * achar conversas não lidas ANTIGAS (fora do lote das N mais recentes); antes
 * o filtro era só de tela e mostrava "Nenhuma conversa não lida" com não lidas
 * mais abaixo.
 */
async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const otherOrgId = await ctx.db.insert("organizations", {
      name: "Outra",
      slug: "outra",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });

    const insert = async (
      org: Id<"organizations">,
      i: number,
      extra: { unreadCount?: number; archivedAt?: number; channel?: "whatsapp" | "instagram" } = {}
    ) =>
      ctx.db.insert("conversations", {
        organizationId: org,
        channel: extra.channel ?? "whatsapp",
        status: "active",
        messageCount: 1,
        lastMessageAt: now - i * 60_000,
        createdAt: now - i * 60_000,
        updatedAt: now,
        ...(extra.unreadCount !== undefined ? { unreadCount: extra.unreadCount } : {}),
        ...(extra.archivedAt !== undefined ? { archivedAt: extra.archivedAt } : {}),
      });

    // 60 lidas recentes (enchem o lote de 50) e 3 não lidas mais antigas.
    for (let i = 0; i < 60; i++) await insert(organizationId, i, { unreadCount: i % 2 === 0 ? 0 : undefined });
    const oldUnread = [
      await insert(organizationId, 100, { unreadCount: 2 }),
      await insert(organizationId, 101, { unreadCount: 7, channel: "instagram" }),
      await insert(organizationId, 102, { unreadCount: 1 }),
    ];
    // Não lida arquivada e não lida de outra org nunca entram.
    await insert(organizationId, 103, { unreadCount: 4, archivedAt: now });
    await insert(otherOrgId, 1, { unreadCount: 9 });
    return { organizationId, userId, oldUnread };
  });
}

describe("getConversations unreadOnly", () => {
  test("acha não lidas fora do lote das mais recentes, só ativas e da org", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, userId, oldUnread } = await seed(t);
    const as = t.withIdentity({ subject: `${userId}|s1` });

    const plain = await as.query(api.conversations.getConversations, { organizationId, limit: 50 });
    expect(plain.filter((c) => (c?.unreadCount ?? 0) > 0)).toHaveLength(0);

    const unread = await as.query(api.conversations.getConversations, { organizationId, limit: 50, unreadOnly: true });
    expect(unread.map((c) => c!._id).sort()).toEqual([...oldUnread].sort());
    // Ordem da lista: última mensagem primeiro.
    expect(unread.map((c) => c!._id)).toEqual(oldUnread);
  });

  test("lote cheio continua sinalizando 'há mais' (limit respeitado)", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, userId } = await seed(t);
    const as = t.withIdentity({ subject: `${userId}|s1` });
    const page = await as.query(api.conversations.getConversations, { organizationId, limit: 2, unreadOnly: true });
    expect(page).toHaveLength(2);
  });

  test("combina com canal (pós-filtro) e com arquivadas", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, userId, oldUnread } = await seed(t);
    const as = t.withIdentity({ subject: `${userId}|s1` });
    const ig = await as.query(api.conversations.getConversations, {
      organizationId,
      channel: "instagram",
      unreadOnly: true,
    });
    expect(ig.map((c) => c!._id)).toEqual([oldUnread[1]]);
    const archived = await as.query(api.conversations.getConversations, {
      organizationId,
      archived: true,
      unreadOnly: true,
    });
    expect(archived).toHaveLength(1);
    expect(archived[0]!.unreadCount).toBe(4);
  });
});
