/// <reference types="vite/client" />
import { expect, test, describe } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

async function seedOrg(t: TestConvex<typeof schema>, slug: string, emails: string[]) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: slug,
      slug,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: false, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const people: { userId: Id<"users">; memberId: Id<"teamMembers"> }[] = [];
    for (const email of emails) {
      const userId = await ctx.db.insert("users", { email });
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name: email,
        email,
        role: "admin",
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      people.push({ userId, memberId });
    }
    return { organizationId, people };
  });
}

describe("copilot: thread de outro usuário", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "org-a", ["dono@example.com", "outro@example.com"]);
    const b = await seedOrg(t, "org-b", ["fora@example.com"]);
    const threadId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("copilotThreads", {
        organizationId: a.organizationId,
        memberId: a.people[0].memberId,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("copilotMessages", {
        threadId: id,
        organizationId: a.organizationId,
        role: "user",
        content: "segredo do dono",
        createdAt: now,
      });
      return id;
    });
    const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });
    return { t, a, b, threadId, as };
  }

  test("dono recebe as mensagens", async () => {
    const { a, threadId, as } = await setup();
    const msgs = await as(a.people[0].userId).query(api.copilot.getThreadMessages, { threadId });
    expect(msgs).toHaveLength(1);
    expect(msgs![0].content).toBe("segredo do dono");
  });

  test("outro membro da mesma org recebe null, sem mensagens", async () => {
    const { a, threadId, as } = await setup();
    const res = await as(a.people[1].userId).query(api.copilot.getThreadMessages, { threadId });
    expect(res).toBeNull();
  });

  test("membro de outra org recebe null", async () => {
    const { b, threadId, as } = await setup();
    const res = await as(b.people[0].userId).query(api.copilot.getThreadMessages, { threadId });
    expect(res).toBeNull();
  });

  test("thread apagada devolve null", async () => {
    const { t, a, threadId, as } = await setup();
    await t.run(async (ctx) => ctx.db.delete(threadId));
    const res = await as(a.people[0].userId).query(api.copilot.getThreadMessages, { threadId });
    expect(res).toBeNull();
  });

  test("deleteThread de thread alheia é no-op", async () => {
    const { t, a, threadId, as } = await setup();
    const res = await as(a.people[1].userId).mutation(api.copilot.deleteThread, { threadId });
    expect(res).toBeNull();
    const still = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(still).not.toBeNull();
  });
});
