/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { STAGE_FILTER_LEAD_CAP } from "./lib/inboxLimits";

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
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "B", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "S", color: "#000", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    } as any);
    return { organizationId, userId, memberId, boardId, stageId, now };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

const mkLead = (t: TestConvex<typeof schema>, s: Seed, withContact = true) =>
  t.run(async (ctx) => {
    const now = Date.now();
    const contactId = withContact
      ? await ctx.db.insert("contacts", { organizationId: s.organizationId, firstName: "C", tags: [], customFields: {}, createdAt: now, updatedAt: now } as any)
      : undefined;
    return ctx.db.insert("leads", {
      organizationId: s.organizationId, boardId: s.boardId, stageId: s.stageId, ...(contactId ? { contactId } : {}),
      title: "L", value: 0, currency: "BRL", priority: "medium", temperature: "cold", tags: [], customFields: {},
      conversationStatus: "new", lastActivityAt: now, createdAt: now, updatedAt: now,
    } as any);
  });

const mkConv = (t: TestConvex<typeof schema>, organizationId: Id<"organizations">, ageSec: number, extra: Record<string, unknown> = {}) =>
  t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert("conversations", {
      organizationId, channel: "whatsapp", status: "active", messageCount: 1,
      lastMessageAt: now - ageSec * 1000, createdAt: now - ageSec * 1000, updatedAt: now, ...extra,
    } as any);
  });

const list = async (t: TestConvex<typeof schema>, userId: Id<"users">, args: Record<string, unknown>) =>
  (await t.withIdentity({ subject: `${userId}|s1` }).query(api.conversations.getConversations, args as any)) as any[];

describe("getConversations: etapa pequena (caminho exato)", () => {
  test("conversa antiga, fora das 200 mais recentes da org, aparece", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const lead = await mkLead(t, s);
    const old = await mkConv(t, s.organizationId, 100000, { leadId: lead });
    for (let i = 0; i < 205; i++) await mkConv(t, s.organizationId, i, { kind: "group" });
    const rows = await list(t, s.userId, { organizationId: s.organizationId, stageId: s.stageId });
    expect(rows.map((c) => c._id)).toEqual([old]);
    expect(rows[0].contact).not.toBeNull();
  });
});

describe("getConversations: etapa acima do teto (caminho antigo)", () => {
  test("lead antigo (fora dos mais novos) com conversa recente aparece", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const oldest = await mkLead(t, s);
    for (let i = 0; i < STAGE_FILTER_LEAD_CAP; i++) await mkLead(t, s, false);
    const recent = await mkConv(t, s.organizationId, 1, { leadId: oldest });
    const rows = await list(t, s.userId, { organizationId: s.organizationId, stageId: s.stageId });
    expect(rows.map((c) => c._id)).toEqual([recent]);
  });
});

describe("Não lidas por tempo com pós-filtro", () => {
  test("Não lidas + Minhas com a env ligada não encurta a página", async () => {
    vi.stubEnv("INBOX_UNREAD_TIME_INDEX", "1");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    for (let i = 0; i < 5; i++) await mkConv(t, s.organizationId, i, { unreadCount: 1, hasUnread: true });
    const mine: Id<"conversations">[] = [];
    for (let i = 0; i < 3; i++) {
      mine.push(await mkConv(t, s.organizationId, 100 + i, { unreadCount: 1, hasUnread: true, assignedTo: s.memberId }));
    }
    const rows = await list(t, s.userId, { organizationId: s.organizationId, unreadOnly: true, mine: true, limit: 3 });
    expect(rows.map((c) => c._id)).toEqual(mine);
  });
});
