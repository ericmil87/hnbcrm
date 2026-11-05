/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { isUiTheme } from "./lib/uiTheme";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const org = async (slug: string) =>
      await ctx.db.insert("organizations", {
        name: slug, slug,
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now, updatedAt: now,
      });
    const orgA = await org("a");
    const orgB = await org("b");
    const orgC = await org("c");
    const orgD = await org("d");
    const user = await ctx.db.insert("users", {});
    const other = await ctx.db.insert("users", {});
    const mk = async (organizationId: any, userId: any, extra: object = {}) =>
      await ctx.db.insert("teamMembers", {
        organizationId, userId, name: "M", role: "admin", type: "human",
        status: "active", createdAt: now, updatedAt: now, ...extra,
      });
    const mA = await mk(orgA, user);
    const mB = await mk(orgB, user);
    const mRemoved = await mk(orgC, user, { removedAt: now });
    const mOther = await mk(orgA, other);
    const mAi = await ctx.db.insert("teamMembers", {
      organizationId: orgA, name: "IA", role: "ai", type: "ai",
      status: "active", createdAt: now, updatedAt: now,
    });
    return { orgA, orgB, orgC, orgD, user, mA, mB, mRemoved, mOther, mAi };
  });
}

describe("setMyUiTheme", () => {
  test("grava e getCurrentTeamMember devolve; replica nas duas orgs", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const as = t.withIdentity({ subject: `${s.user}|s1` });
    await as.mutation(api.teamMembers.setMyUiTheme, { organizationId: s.orgA, theme: "whatsapp" });
    expect((await as.query(api.teamMembers.getCurrentTeamMember, { organizationId: s.orgA }))?.uiTheme).toBe("whatsapp");
    expect((await as.query(api.teamMembers.getCurrentTeamMember, { organizationId: s.orgB }))?.uiTheme).toBe("whatsapp");
  });

  test("não altera removida, IA nem outro usuário", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const as = t.withIdentity({ subject: `${s.user}|s1` });
    await as.mutation(api.teamMembers.setMyUiTheme, { organizationId: s.orgA, theme: "light" });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(s.mRemoved))?.uiTheme).toBeUndefined();
      expect((await ctx.db.get(s.mAi))?.uiTheme).toBeUndefined();
      expect((await ctx.db.get(s.mOther))?.uiTheme).toBeUndefined();
      expect((await ctx.db.get(s.mA))?.uiTheme).toBe("light");
    });
  });

  test("sem autenticação lança", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(
      t.mutation(api.teamMembers.setMyUiTheme, { organizationId: s.orgA, theme: "dark" }),
    ).rejects.toThrow();
  });

  test("org da qual não é membro lança", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const as = t.withIdentity({ subject: `${s.user}|s1` });
    await expect(
      as.mutation(api.teamMembers.setMyUiTheme, { organizationId: s.orgD, theme: "dark" }),
    ).rejects.toThrow();
  });

  test("literal inválido é rejeitado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const as = t.withIdentity({ subject: `${s.user}|s1` });
    await expect(
      as.mutation(api.teamMembers.setMyUiTheme, { organizationId: s.orgA, theme: "neon" as any }),
    ).rejects.toThrow();
    expect(isUiTheme("neon")).toBe(false);
    expect(isUiTheme("dark")).toBe(true);
  });
});

describe("setMyUiTheme idempotência", () => {
  test("gravar o mesmo tema não altera updatedAt", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const as = t.withIdentity({ subject: `${s.user}|s1` });
    await as.mutation(api.teamMembers.setMyUiTheme, { organizationId: s.orgA, theme: "light" });
    const before = await t.run(async (ctx) => (await ctx.db.get(s.mA))?.updatedAt);
    vi.advanceTimersByTime(60_000);
    await as.mutation(api.teamMembers.setMyUiTheme, { organizationId: s.orgA, theme: "light" });
    const after = await t.run(async (ctx) => (await ctx.db.get(s.mA))?.updatedAt);
    expect(after).toBe(before);
  });
});
