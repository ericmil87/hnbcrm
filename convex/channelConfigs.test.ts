/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

// base64 of 32 bytes — deterministic test key, not a real secret
const TEST_KEY = btoa("A".repeat(32));

beforeEach(() => {
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  return convexTest(schema, modules);
}

async function seedOrgWithMembers(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Test Org",
      slug: "test-org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const agentUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId: agentUserId,
      name: "Agent",
      role: "agent",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminUserId, agentUserId };
  });
}

const CONFIG_ARGS = {
  channel: "whatsapp" as const,
  displayName: "Main number",
  phoneNumberId: "111000111000111",
  wabaId: "222000222000222",
  verifyToken: "test-verify-token",
  appSecret: "fake-app-secret-abcd",
  accessToken: "EAAFakeAccessToken9876",
};

describe("channelConfigs create + masked reads", () => {
  test("admin creates a config; secrets are encrypted at rest and masked in queries", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...CONFIG_ARGS,
    });

    // At rest: encrypted with v1: prefix, plaintext nowhere
    const stored = await t.run(async (ctx) => ctx.db.get(configId));
    expect(stored!.accessTokenEncrypted.startsWith("v1:")).toBe(true);
    expect(stored!.appSecretEncrypted.startsWith("v1:")).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(CONFIG_ARGS.accessToken);
    expect(JSON.stringify(stored)).not.toContain(CONFIG_ARGS.appSecret);

    // Client reads: masked values only, encrypted fields never returned
    const configs = await asAdmin.query(api.channelConfigs.getChannelConfigs, { organizationId });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      displayName: "Main number",
      phoneNumberId: CONFIG_ARGS.phoneNumberId,
      accessTokenMasked: "…9876",
      appSecretMasked: "…abcd",
      hasToken: true,
      status: "active",
    });
    expect("accessTokenEncrypted" in configs[0]).toBe(false);
    expect("appSecretEncrypted" in configs[0]).toBe(false);
    expect(JSON.stringify(configs)).not.toContain(CONFIG_ARGS.accessToken);

    // Audit log records field metadata but no secret values
    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "channelConfig").eq("entityId", configId))
        .collect()
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(CONFIG_ARGS.accessToken);
    expect(JSON.stringify(audits)).not.toContain(CONFIG_ARGS.appSecret);
  });

  test("rejects duplicate phoneNumberId", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    await asAdmin.action(api.channelConfigs.createChannelConfig, { organizationId, ...CONFIG_ARGS });
    await expect(
      asAdmin.action(api.channelConfigs.createChannelConfig, {
        organizationId,
        ...CONFIG_ARGS,
        verifyToken: "another-token",
      })
    ).rejects.toThrow(/phone number ID/);
  });
});

describe("channelConfigs admin-only enforcement", () => {
  test("non-admin member cannot create or list configs", async () => {
    const t = setup();
    const { organizationId, agentUserId } = await seedOrgWithMembers(t);
    const asAgent = t.withIdentity({ subject: `${agentUserId}|session1` });

    await expect(
      asAgent.action(api.channelConfigs.createChannelConfig, { organizationId, ...CONFIG_ARGS })
    ).rejects.toThrow(/Permissão insuficiente/);

    await expect(
      asAgent.query(api.channelConfigs.getChannelConfigs, { organizationId })
    ).rejects.toThrow(/Permissão insuficiente/);
  });

  test("unauthenticated caller is rejected", async () => {
    const t = setup();
    const { organizationId } = await seedOrgWithMembers(t);

    await expect(
      t.action(api.channelConfigs.createChannelConfig, { organizationId, ...CONFIG_ARGS })
    ).rejects.toThrow(/Not authenticated/);
  });
});

describe("checkChannelHealth", () => {
  async function createConfig(t: TestConvex<typeof schema>) {
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });
    const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...CONFIG_ARGS,
    });
    return { organizationId, asAdmin, configId };
  }

  test("happy path stores verified number and keeps config active", async () => {
    const t = setup();
    const { asAdmin, configId } = await createConfig(t);

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ display_phone_number: "+1 555-000-0000", verified_name: "Test Business" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await asAdmin.action(api.channelConfigs.checkChannelHealth, { configId });

    expect(result).toMatchObject({
      ok: true,
      displayPhoneNumber: "+1 555-000-0000",
      verifiedName: "Test Business",
    });

    // Graph API called with the DECRYPTED token
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/${CONFIG_ARGS.phoneNumberId}?fields=`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${CONFIG_ARGS.accessToken}`
    );

    const stored = await t.run(async (ctx) => ctx.db.get(configId));
    expect(stored!.status).toBe("active");
    expect(stored!.displayPhoneNumber).toBe("+1 555-000-0000");
    expect(stored!.lastHealthCheckAt).toBeTypeOf("number");
    expect(stored!.healthDetail).toContain("Test Business");
  });

  test("error path marks the config as errored with detail", async () => {
    const t = setup();
    const { asAdmin, configId } = await createConfig(t);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { message: "Invalid OAuth access token" } }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const result = await asAdmin.action(api.channelConfigs.checkChannelHealth, { configId });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid OAuth");

    const stored = await t.run(async (ctx) => ctx.db.get(configId));
    expect(stored!.status).toBe("error");
    expect(stored!.healthDetail).toContain("Invalid OAuth");
  });
});

describe("internalGetDefaultActiveConfig", () => {
  test("returns the org's active whatsapp config, skipping disabled ones", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const disabledId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...CONFIG_ARGS,
    });
    await asAdmin.mutation(api.channelConfigs.setChannelConfigStatus, {
      configId: disabledId,
      status: "disabled",
    });
    const activeId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...CONFIG_ARGS,
      phoneNumberId: "333000333000333",
      verifyToken: "second-token",
    });

    const resolved = await t.query(internal.channelConfigs.internalGetDefaultActiveConfig, {
      organizationId,
      channel: "whatsapp",
    });
    expect(resolved!._id).toEqual(activeId);
  });
});
