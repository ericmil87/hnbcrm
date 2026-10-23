/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { assertAnyModule, assertModule } from "./lib/orgModules";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function seed(t: TestConvex<typeof schema>, opts: { metaOn?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        ...(opts.metaOn ? { modules: { metaMessaging: true } } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", { email: "admin@example.test" });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminUserId, adminId };
  });
}

async function seedMetaChannels(
  t: TestConvex<typeof schema>,
  s: { organizationId: Id<"organizations">; adminId: Id<"teamMembers"> },
  authState: "ok" | "reauth_required" | "revoked" = "ok"
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const connectionId = await ctx.db.insert("metaConnections", {
      organizationId: s.organizationId,
      authMethod: "facebook_login",
      tokenKind: "page",
      tokenEncrypted: "v1:fake:fake",
      tokenLast4: "9999",
      pageId: "1000000000000001",
      pageName: "Página Teste",
      igAccountId: "1000000000000003",
      igUsername: "marina_teste",
      scopes: [],
      authState,
      connectedByMemberId: s.adminId,
      createdAt: now,
      updatedAt: now,
    });
    const messengerId = await ctx.db.insert("channelConfigs", {
      organizationId: s.organizationId,
      channel: "messenger",
      displayName: "Página Teste",
      status: "active",
      metaConnectionId: connectionId,
      messengerPageId: "1000000000000001",
      createdAt: now,
      updatedAt: now,
    });
    const instagramId = await ctx.db.insert("channelConfigs", {
      organizationId: s.organizationId,
      channel: "instagram",
      displayName: "@marina_teste",
      status: "active",
      metaConnectionId: connectionId,
      instagramAccountId: "1000000000000003",
      createdAt: now,
      updatedAt: now,
    });
    // Um canal desativado À MÃO: o módulo nunca pode reativá-lo.
    const manualId = await ctx.db.insert("channelConfigs", {
      organizationId: s.organizationId,
      channel: "instagram",
      displayName: "@outro",
      status: "disabled",
      metaConnectionId: connectionId,
      instagramAccountId: "1000000000000013",
      createdAt: now,
      updatedAt: now,
    });
    return { connectionId, messengerId, instagramId, manualId };
  });
}

describe("módulo metaMessaging", () => {
  test("desligado por padrão", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    const m = await asAdmin.query(api.orgModules.getOrgModules, { organizationId: s.organizationId });
    expect(m.metaMessaging).toBe(false);
  });

  test("assertModule falha com ConvexError em startMetaConnect e finalizeMetaSelection", async () => {
    vi.stubEnv("META_MESSAGING_APP_ID", "fake-app");
    vi.stubEnv("META_MESSAGING_LOGIN_CONFIG_ID", "fake-config");
    vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    await expect(
      asAdmin.action(api.metaMessaging.startMetaConnect, { organizationId: s.organizationId })
    ).rejects.toThrow(/Módulo não habilitado/);
    const pendingId = await t.run(async (ctx) => {
      const stateId = await ctx.db.insert("oauthStates", {
        organizationId: s.organizationId,
        memberId: s.adminId,
        provider: "meta",
        nonceHash: "x",
        returnPath: "/",
        expiresAt: Date.now() + 1000,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("metaOAuthPending", {
        organizationId: s.organizationId,
        memberId: s.adminId,
        stateId,
        pages: [],
        scopes: [],
        expiresAt: Date.now() + 1000,
        createdAt: Date.now(),
      });
    });
    await expect(
      asAdmin.action(api.metaMessaging.finalizeMetaSelection, { organizationId: s.organizationId, pendingId, picks: [] })
    ).rejects.toThrow(/Módulo não habilitado/);
  });

  test("metaMessaging não acende assertAnyModule (gate da Central)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    const after = await asAdmin.mutation(api.orgModules.setOrgModules, {
      organizationId: s.organizationId,
      modules: { metaMessaging: true },
    });
    expect(after.metaMessaging).toBe(true);
    expect(after.central).toBe(false);
    await t.run(async (ctx) => {
      await assertModule(ctx, s.organizationId, "metaMessaging");
      await expect(assertAnyModule(ctx, s.organizationId)).rejects.toThrow(/Central/);
    });
  });

  test("desligar desativa só os configs ativos, com marca e audit high; religar reativa só esses", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { metaOn: true });
    const c = await seedMetaChannels(t, s);
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });

    await asAdmin.mutation(api.orgModules.setOrgModules, { organizationId: s.organizationId, modules: { metaMessaging: false } });
    let state = await t.run(async (ctx) => ({
      messenger: await ctx.db.get(c.messengerId),
      instagram: await ctx.db.get(c.instagramId),
      manual: await ctx.db.get(c.manualId),
      audits: await ctx.db.query("auditLogs").collect(),
    }));
    expect(state.messenger?.status).toBe("disabled");
    expect(state.messenger?.disabledByModuleAt).toBeTypeOf("number");
    expect(state.instagram?.status).toBe("disabled");
    expect(state.manual?.disabledByModuleAt).toBeUndefined();
    const high = state.audits.find((a) => a.severity === "high" && a.metadata?.metaMessaging === "disabled");
    expect(high).toBeTruthy();
    expect(high!.metadata!.configIds).toEqual(expect.arrayContaining([c.messengerId, c.instagramId]));
    expect(high!.metadata!.configIds).not.toContain(c.manualId);

    await asAdmin.mutation(api.orgModules.setOrgModules, { organizationId: s.organizationId, modules: { metaMessaging: true } });
    state = await t.run(async (ctx) => ({
      messenger: await ctx.db.get(c.messengerId),
      instagram: await ctx.db.get(c.instagramId),
      manual: await ctx.db.get(c.manualId),
      audits: [],
    }));
    expect(state.messenger?.status).toBe("active");
    expect(state.messenger?.disabledByModuleAt).toBeUndefined();
    expect(state.instagram?.status).toBe("active");
    expect(state.manual?.status).toBe("disabled"); // desativado à mão continua assim
  });

  test("religar não reativa config cuja conexão não está ok", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { metaOn: true });
    const c = await seedMetaChannels(t, s);
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    await asAdmin.mutation(api.orgModules.setOrgModules, { organizationId: s.organizationId, modules: { metaMessaging: false } });
    await t.run(async (ctx) => {
      await ctx.db.patch(c.connectionId, { authState: "reauth_required" });
    });
    await asAdmin.mutation(api.orgModules.setOrgModules, { organizationId: s.organizationId, modules: { metaMessaging: true } });
    const messenger = await t.run(async (ctx) => await ctx.db.get(c.messengerId));
    expect(messenger?.status).toBe("disabled");
    expect(messenger?.disabledByModuleAt).toBeTypeOf("number");
  });

  test("disconnect não exige o módulo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t); // módulo OFF
    const c = await seedMetaChannels(t, s);
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    await asAdmin.mutation(api.metaMessaging.disconnectMetaConnection, {
      organizationId: s.organizationId,
      connectionId: c.connectionId,
    });
    const conn = await t.run(async (ctx) => await ctx.db.get(c.connectionId));
    expect(conn?.authState).toBe("revoked");
    expect(conn?.tokenEncrypted).toBe("");
    expect(conn?.tokenLast4).toBe("");
  });
});
