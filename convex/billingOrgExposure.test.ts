/// <reference types="vite/client" />
/**
 * `billing` não vaza no doc da org devolvido a qualquer membro, e o cadastro
 * nasce em legacy explícito (sem gate, sem plano).
 */
import { expect, test, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { resolveEntitlements } from "./lib/entitlements";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
});

test("createOrganization grava legacy sem plano e sem gate", async () => {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", { email: "dona@acme.com.br", name: "Dona" }));
  const orgId = await t
    .withIdentity({ subject: `${userId}|s1` })
    .mutation(api.organizations.createOrganization, { name: "Nova", slug: "nova-billing" });
  const org = await t.run((ctx) => ctx.db.get(orgId));
  expect(org?.billing?.status).toBe("legacy");
  expect(org?.billing?.plan).toBeUndefined();
  expect(resolveEntitlements(org, Date.now()).gated).toBe(false);
});

test("getUserOrganizations omite billing para qualquer papel", async () => {
  const { userId, agentUserId } = await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("organizations", {
      name: "Org X",
      slug: "org-x",
      settings: { timezone: "UTC", currency: "BRL" },
      billing: { plan: "essencial", status: "active", priceLock: { kind: "frozen", monthlyBrl: 100 }, updatedAt: now },
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (email: string, role: "admin" | "agent") => {
      const u = await ctx.db.insert("users", { email, name: role });
      await ctx.db.insert("teamMembers", {
        organizationId: orgId,
        userId: u,
        name: role,
        role,
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return u;
    };
    return { userId: await mk("adm@acme.com.br", "admin"), agentUserId: await mk("ag@acme.com.br", "agent") };
  });
  for (const u of [userId, agentUserId]) {
    const orgs = (await t.withIdentity({ subject: `${u}|s1` }).query(api.organizations.getUserOrganizations, {})) as Array<Record<string, unknown>>;
    expect(orgs).toHaveLength(1);
    expect(orgs[0].name).toBe("Org X");
    expect(orgs[0]).not.toHaveProperty("billing");
    expect(JSON.stringify(orgs)).not.toContain("priceLock");
  }
});
