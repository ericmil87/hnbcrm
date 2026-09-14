/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  return convexTest(schema, modules);
}
const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", { name: "O", slug: "o", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now });
    const otherOrgId = await ctx.db.insert("organizations", { name: "X", slug: "x", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now });
    const adminUserId = await ctx.db.insert("users", {});
    const agentUserId = await ctx.db.insert("users", {});
    const viewerUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", { organizationId, userId: adminUserId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now });
    await ctx.db.insert("teamMembers", { organizationId, userId: agentUserId, name: "Agente", role: "agent", type: "human", status: "active", createdAt: now, updatedAt: now });
    await ctx.db.insert("teamMembers", {
      organizationId, userId: viewerUserId, name: "Viewer", role: "agent", type: "human", status: "active",
      permissions: { leads: "view_own", contacts: "view", inbox: "view_own", tasks: "view_own", reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none", campaigns: "view" },
      createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "Ana", phone: "5511999990001", tags: [], createdAt: now, updatedAt: now });
    const otherContactId = await ctx.db.insert("contacts", { organizationId: otherOrgId, phone: "5511999990002", tags: [], createdAt: now, updatedAt: now });
    return { organizationId, otherOrgId, adminUserId, agentUserId, viewerUserId, contactId, otherContactId };
  });
}

describe("lista de supressão", () => {
  test("agent (contacts:edit) adiciona pelo contato; viewer não; remover exige full; isolamento", async () => {
    const t = setup();
    const s = await seed(t);
    await expect(asUser(t, s.viewerUserId).mutation(api.optOuts.addOptOut, { organizationId: s.organizationId, contactId: s.contactId })).rejects.toThrow(/Permissão/);
    const id = await asUser(t, s.agentUserId).mutation(api.optOuts.addOptOut, { organizationId: s.organizationId, contactId: s.contactId, reason: "pediu" });
    expect(id).toBeTruthy();
    // idempotente
    const again = await asUser(t, s.agentUserId).mutation(api.optOuts.addOptOut, { organizationId: s.organizationId, phone: "(11) 99999-0001" });
    expect(again).toBe(id);
    const check = await asUser(t, s.viewerUserId).query(api.optOuts.isPhoneOptedOut, { organizationId: s.organizationId, phone: "+55 11 99999-0001" });
    expect(check?.source).toBe("manual");
    const byContact = await asUser(t, s.viewerUserId).query(api.optOuts.isContactOptedOut, { contactId: s.contactId });
    expect(byContact?._id).toBe(id);
    // contato de outra org
    await expect(asUser(t, s.agentUserId).mutation(api.optOuts.addOptOut, { organizationId: s.organizationId, contactId: s.otherContactId })).rejects.toThrow(/não encontrado/);
    const list = await asUser(t, s.viewerUserId).query(api.optOuts.listOptOuts, { organizationId: s.organizationId, paginationOpts: { numItems: 10, cursor: null } });
    expect(list.page).toHaveLength(1);
    await expect(asUser(t, s.agentUserId).mutation(api.optOuts.removeOptOut, { optOutId: id! })).rejects.toThrow(/Permissão/);
    await asUser(t, s.adminUserId).mutation(api.optOuts.removeOptOut, { optOutId: id! });
    const gone = await asUser(t, s.adminUserId).query(api.optOuts.isPhoneOptedOut, { organizationId: s.organizationId, phone: "5511999990001" });
    expect(gone).toBeNull();
    const logs = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(logs.some((l) => l.entityType === "optOut" && l.action === "delete" && l.severity === "high")).toBe(true);
  });
});
