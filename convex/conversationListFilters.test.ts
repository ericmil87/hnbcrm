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

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const mkOrg = (slug: string) =>
      ctx.db.insert("organizations", {
        name: slug,
        slug,
        settings: {
          timezone: "America/Sao_Paulo",
          currency: "BRL",
          aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
        },
        createdAt: now,
        updatedAt: now,
      });
    const organizationId = await mkOrg("a");
    const otherOrgId = await mkOrg("b");
    const userId = await ctx.db.insert("users", {});
    const humanId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(organizationId, {
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, lgpdAck: { acceptedAt: now, acceptedBy: humanId } },
      },
    });
    const aiId = await ctx.db.insert("teamMembers", {
      organizationId, name: "IA", role: "agent", type: "ai", status: "active", createdAt: now, updatedAt: now,
      agentProfile: { kind: "attendant", mode: "autopilot" } as any,
    });
    const mkBoard = async (org: Id<"organizations">) => {
      const boardId = await ctx.db.insert("boards", {
        organizationId: org, name: "B", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now,
      });
      const mkStage = (name: string, order: number) =>
        ctx.db.insert("stages", {
          organizationId: org, boardId, name, color: "#000", order, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
        } as any);
      return { boardId, s1: await mkStage("S1", 0), s2: await mkStage("S2", 1) };
    };
    const a = await mkBoard(organizationId);
    const b = await mkBoard(otherOrgId);
    const mkLead = async (stageId: Id<"stages">, extra: Record<string, unknown> = {}) => {
      const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "C", tags: [], customFields: {}, createdAt: now, updatedAt: now } as any);
      return ctx.db.insert("leads", {
        organizationId, boardId: a.boardId, stageId, contactId, title: "L", value: 0, currency: "BRL", priority: "medium",
        temperature: "cold", tags: [], customFields: {}, conversationStatus: "new", lastActivityAt: now,
        createdAt: now, updatedAt: now, ...extra,
      } as any);
    };
    const mkConv = (leadId: Id<"leads"> | undefined, i: number, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("conversations", {
        organizationId, channel: "whatsapp", status: "active", messageCount: 1,
        ...(leadId ? { leadId } : {}),
        lastMessageAt: now - i * 1000, createdAt: now - i * 1000, updatedAt: now, ...extra,
      } as any);
    const l1 = await mkLead(a.s1);
    const l2 = await mkLead(a.s2);
    const l3 = await mkLead(a.s1, { assignedTo: humanId });
    const c1 = await mkConv(l1, 1);
    const c2 = await mkConv(l2, 2);
    const c3 = await mkConv(l3, 3);
    const cPaused = await mkConv(l2, 4, { aiPausedUntil: Number.MAX_SAFE_INTEGER });
    const cGroup = await mkConv(undefined, 5, { kind: "group" });
    return { organizationId, userId, aiId, a, b, c1, c2, c3, cPaused, cGroup };
  });
}

const ids = (list: any[]) => list.map((c) => c._id);

describe("getConversations: stageId", () => {
  test("casa só conversas cujo lead está na etapa; outra org e sem arg", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const as = t.withIdentity({ subject: `${s.userId}|s1` });
    const base = { organizationId: s.organizationId };
    const all = await as.query(api.conversations.getConversations, base);
    expect(all).toHaveLength(5);
    const st1 = await as.query(api.conversations.getConversations, { ...base, stageId: s.a.s1 });
    expect(ids(st1)).toEqual([s.c1, s.c3]);
    const st2 = await as.query(api.conversations.getConversations, { ...base, stageId: s.a.s2 });
    expect(ids(st2)).toEqual([s.c2, s.cPaused]);
    const foreign = await as.query(api.conversations.getConversations, { ...base, stageId: s.b.s1 });
    expect(foreign).toEqual([]);
  });
});

describe("getConversations: IA por conversa", () => {
  test("aiMode/aiAttending e filtro ai", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const as = t.withIdentity({ subject: `${s.userId}|s1` });
    const base = { organizationId: s.organizationId };
    const all = await as.query(api.conversations.getConversations, base);
    const byId = new Map(all.map((c: any) => [c._id, c]));
    expect(byId.get(s.c1).aiMode).toBe("auto");
    expect(byId.get(s.c1).aiAttending).toBe(true);
    expect(byId.get(s.c3).aiAttending).toBe(false); // lead de humano
    expect(byId.get(s.cPaused).aiAttending).toBe(false);
    // Grupo fica fora do modelo da lista: sem indicador e fora do filtro.
    expect(byId.get(s.cGroup).aiMode).toBeNull();
    expect(byId.get(s.cGroup).aiAttending).toBeNull();
    const on = await as.query(api.conversations.getConversations, { ...base, ai: "on" });
    expect(ids(on)).toEqual([s.c1, s.c2]);
    const off = await as.query(api.conversations.getConversations, { ...base, ai: "off" });
    expect(ids(off)).toEqual([s.c3, s.cPaused]);
    const one = await as.query(api.conversations.getConversationById, { conversationId: s.c1 });
    expect(one!.aiMode).toBe("auto");
    const paused = await as.query(api.conversations.getConversationById, { conversationId: s.cPaused });
    expect(paused!.aiAttending).toBe(false);
  });
});
