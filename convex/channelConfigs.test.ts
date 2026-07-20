/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { configProvider } from "./channelConfigs";

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

const BRIDGE_CONFIG_ARGS = {
  channel: "whatsapp" as const,
  provider: "bridge" as const,
  displayName: "Bridge number",
  bridgeBaseUrl: "https://wuzapi.example.com",
  bridgeInstanceId: "inst_fake_01",
  bridgeToken: "tok_fake_wxyz",
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
    expect(stored!.accessTokenEncrypted!.startsWith("v1:")).toBe(true);
    expect(stored!.appSecretEncrypted!.startsWith("v1:")).toBe(true);
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

describe("channelConfigs bridge provider", () => {
  test("admin creates a bridge config; token encrypted at rest and masked in queries", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...BRIDGE_CONFIG_ARGS,
    });

    // At rest: bridge token encrypted with v1: prefix, no Meta fields, plaintext nowhere
    const stored = await t.run(async (ctx) => ctx.db.get(configId));
    expect(stored!.provider).toBe("bridge");
    expect(stored!.bridgeBaseUrl).toBe(BRIDGE_CONFIG_ARGS.bridgeBaseUrl);
    expect(stored!.bridgeInstanceId).toBe(BRIDGE_CONFIG_ARGS.bridgeInstanceId);
    expect(stored!.bridgeTokenEncrypted!.startsWith("v1:")).toBe(true);
    expect(stored!.accessTokenEncrypted).toBeUndefined();
    expect(stored!.phoneNumberId).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(BRIDGE_CONFIG_ARGS.bridgeToken);

    // Client reads: masked bridge token, correct last4 + provider, no *Encrypted
    const configs = await asAdmin.query(api.channelConfigs.getChannelConfigs, { organizationId });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      provider: "bridge",
      displayName: "Bridge number",
      bridgeBaseUrl: BRIDGE_CONFIG_ARGS.bridgeBaseUrl,
      bridgeInstanceId: BRIDGE_CONFIG_ARGS.bridgeInstanceId,
      bridgeTokenMasked: "…wxyz",
      hasBridgeToken: true,
      phoneNumberId: null,
      hasToken: false,
      status: "active",
    });
    expect("bridgeTokenEncrypted" in configs[0]).toBe(false);
    expect(JSON.stringify(configs)).not.toContain(BRIDGE_CONFIG_ARGS.bridgeToken);
  });

  test("decrypts bridge credentials server-side only", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });
    const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...BRIDGE_CONFIG_ARGS,
    });

    const creds = await t.action(internal.channelConfigs.internalGetBridgeCredentials, { configId });
    expect(creds).toEqual({
      baseUrl: BRIDGE_CONFIG_ARGS.bridgeBaseUrl,
      instanceId: BRIDGE_CONFIG_ARGS.bridgeInstanceId,
      token: BRIDGE_CONFIG_ARGS.bridgeToken,
    });
  });

  test("legacy config without provider reads as meta", async () => {
    const t = setup();
    const { organizationId } = await seedOrgWithMembers(t);

    // Insert a row the way pre-provider code did — no `provider` field
    const legacyId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("channelConfigs", {
        organizationId,
        channel: "whatsapp",
        displayName: "Legacy number",
        phoneNumberId: "999000999000999",
        wabaId: "888000888000888",
        verifyToken: "legacy-token",
        appSecretEncrypted: "v1:legacy:legacy",
        accessTokenEncrypted: "v1:legacy:legacy",
        appSecretLast4: "1234",
        accessTokenLast4: "5678",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    });

    const resolved = await t.query(internal.channelConfigs.internalGetDefaultActiveConfig, {
      organizationId,
      channel: "whatsapp",
    });
    expect(resolved!._id).toEqual(legacyId);
    expect(resolved!.provider).toBeUndefined();
    expect(configProvider(resolved!)).toBe("meta");
  });

  test("rejects duplicate bridgeInstanceId", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...BRIDGE_CONFIG_ARGS,
    });
    await expect(
      asAdmin.action(api.channelConfigs.createChannelConfig, {
        organizationId,
        ...BRIDGE_CONFIG_ARGS,
        displayName: "Another bridge",
      })
    ).rejects.toThrow(/instância do bridge/);
  });

  test("rejects bridge config missing required fields", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    await expect(
      asAdmin.action(api.channelConfigs.createChannelConfig, {
        organizationId,
        channel: "whatsapp",
        provider: "bridge",
        displayName: "Incomplete bridge",
        bridgeBaseUrl: "https://wuzapi.example.com",
        // bridgeInstanceId + bridgeToken missing
      })
    ).rejects.toThrow(/bridge exige/);
  });

  test("rejects an invalid bridgeBaseUrl", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    await expect(
      asAdmin.action(api.channelConfigs.createChannelConfig, {
        organizationId,
        ...BRIDGE_CONFIG_ARGS,
        bridgeBaseUrl: "not-a-url",
      })
    ).rejects.toThrow(/bridgeBaseUrl/);
  });

  test("non-admin cannot create a bridge config", async () => {
    const t = setup();
    const { organizationId, agentUserId } = await seedOrgWithMembers(t);
    const asAgent = t.withIdentity({ subject: `${agentUserId}|session1` });

    await expect(
      asAgent.action(api.channelConfigs.createChannelConfig, {
        organizationId,
        ...BRIDGE_CONFIG_ARGS,
      })
    ).rejects.toThrow(/Permissão insuficiente/);
  });

  test("cannot patch Meta fields onto a bridge config", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });
    const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...BRIDGE_CONFIG_ARGS,
    });

    await expect(
      asAdmin.action(api.channelConfigs.updateChannelConfig, {
        configId,
        phoneNumberId: "111000111000111",
      })
    ).rejects.toThrow(/não se aplicam a um canal bridge/);

    // Updating a bridge field is allowed and re-masks correctly
    await asAdmin.action(api.channelConfigs.updateChannelConfig, {
      configId,
      bridgeToken: "tok_fake_9999",
    });
    const configs = await asAdmin.query(api.channelConfigs.getChannelConfigs, { organizationId });
    expect(configs[0].bridgeTokenMasked).toBe("…9999");
  });

  test("checkChannelHealth on a connected bridge marks it active + records the state", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });
    const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...BRIDGE_CONFIG_ARGS,
    });

    // GET /session/status → connected + logged in
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { Connected: true, LoggedIn: true, Jid: "15550000000@s.whatsapp.net" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const result = await asAdmin.action(api.channelConfigs.checkChannelHealth, { configId });
    expect(result.ok).toBe(true);
    expect(result.bridgeSessionState).toBe("connected");
    expect(result.displayPhoneNumber).toBe("+15550000000");

    const stored = await t.run(async (ctx) => ctx.db.get(configId));
    expect(stored!.status).toBe("active");
    expect(stored!.bridgeSessionState).toBe("connected");
    expect(stored!.displayPhoneNumber).toBe("+15550000000");
    expect(stored!.healthDetail).toContain("15550000000");
  });

  test("checkChannelHealth on a logged-out bridge marks it errored (disconnected)", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });
    const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...BRIDGE_CONFIG_ARGS,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { Connected: false, LoggedIn: false } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const result = await asAdmin.action(api.channelConfigs.checkChannelHealth, { configId });
    expect(result.ok).toBe(false);
    expect(result.bridgeSessionState).toBe("disconnected");

    const stored = await t.run(async (ctx) => ctx.db.get(configId));
    expect(stored!.status).toBe("error");
    expect(stored!.bridgeSessionState).toBe("disconnected");
  });

  test("getBridgeQrCode returns the QR when the instance is not yet paired", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });
    const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...BRIDGE_CONFIG_ARGS,
    });

    // status → not logged in; connect → ok; qr → QRCode
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/session/status")) {
        return new Response(JSON.stringify({ success: true, data: { Connected: false, LoggedIn: false } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/session/connect")) {
        return new Response(JSON.stringify({ success: true, data: { details: "Connected!" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // /session/qr
      return new Response(
        JSON.stringify({ success: true, data: { QRCode: "data:image/png;base64,iVBORw0KGgo=" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await asAdmin.action(api.channelConfigs.getBridgeQrCode, { configId });
    expect(result.state).toBe("qr");
    expect(result.qrCode).toBe("data:image/png;base64,iVBORw0KGgo=");

    const stored = await t.run(async (ctx) => ctx.db.get(configId));
    expect(stored!.bridgeSessionState).toBe("qr");
  });

  test("getBridgeQrCode short-circuits to connected when already paired", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });
    const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...BRIDGE_CONFIG_ARGS,
    });

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, data: { Connected: true, LoggedIn: true, Jid: "15550000000@s.whatsapp.net" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await asAdmin.action(api.channelConfigs.getBridgeQrCode, { configId });
    expect(result.state).toBe("connected");
    expect(result.qrCode).toBeUndefined();
    // Only the status probe was needed — no connect/qr calls.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("provisionBridgeChannel creates a bridge config on gateway success", async () => {
    process.env.WA_BRIDGE_HMAC_SECRET = "fake-hmac-secret-with-at-least-32-chars!";
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    let provisionedToken = "";
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://wuzapi.example.com/admin/users") {
        expect((init.headers as Record<string, string>).Authorization).toBe("admin_fake_token");
        const body = JSON.parse(init.body as string);
        expect(body.webhook).toBe("https://deploy.convex.site/webhooks/bridge");
        expect(typeof body.token).toBe("string");
        provisionedToken = body.token;
        // Confirmado no piloto: sem hmacKey na criação, webhooks saem sem assinatura
        expect(body.hmacKey).toBe("fake-hmac-secret-with-at-least-32-chars!");
        return new Response(JSON.stringify({ id: 7 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Segunda chamada: ativação do HMAC no cache vivo do gateway (bug upstream)
      expect(url).toBe("https://wuzapi.example.com/session/hmac/config");
      expect((init.headers as Record<string, string>).token).toBe(provisionedToken);
      expect(JSON.parse(init.body as string)).toEqual({
        hmac_key: "fake-hmac-secret-with-at-least-32-chars!",
      });
      return new Response(JSON.stringify({ Details: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const configId = await asAdmin.action(api.channelConfigs.provisionBridgeChannel, {
      organizationId,
      displayName: "Provisioned bridge",
      bridgeBaseUrl: "https://wuzapi.example.com",
      adminToken: "admin_fake_token",
      webhookUrl: "https://deploy.convex.site/webhooks/bridge",
    });

    const stored = await t.run(async (ctx) => ctx.db.get(configId));
    expect(stored!.provider).toBe("bridge");
    expect(stored!.bridgeBaseUrl).toBe("https://wuzapi.example.com");
    expect(stored!.bridgeInstanceId).toMatch(/^org_/);
    expect(stored!.bridgeTokenEncrypted!.startsWith("v1:")).toBe(true);
    // The ADMIN token is ephemeral — it must never be persisted anywhere.
    expect(JSON.stringify(stored)).not.toContain("admin_fake_token");
  });

  test("provisionBridgeChannel surfaces a gateway error and creates nothing", async () => {
    process.env.WA_BRIDGE_HMAC_SECRET = "fake-hmac-secret-with-at-least-32-chars!";
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithMembers(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 401 }))
    );

    await expect(
      asAdmin.action(api.channelConfigs.provisionBridgeChannel, {
        organizationId,
        displayName: "Provisioned bridge",
        bridgeBaseUrl: "https://wuzapi.example.com",
        adminToken: "wrong_admin_token",
        webhookUrl: "https://deploy.convex.site/webhooks/bridge",
      })
    ).rejects.toThrow(/admin token/i);

    const configs = await t.run(async (ctx) =>
      ctx.db.query("channelConfigs").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect()
    );
    expect(configs).toHaveLength(0);
  });

  test("non-admin cannot provision a bridge channel", async () => {
    const t = setup();
    const { organizationId, agentUserId } = await seedOrgWithMembers(t);
    const asAgent = t.withIdentity({ subject: `${agentUserId}|session1` });

    // No gateway call should even be reached — guard rejects first.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      asAgent.action(api.channelConfigs.provisionBridgeChannel, {
        organizationId,
        displayName: "Provisioned bridge",
        bridgeBaseUrl: "https://wuzapi.example.com",
        adminToken: "admin_fake_token",
        webhookUrl: "https://deploy.convex.site/webhooks/bridge",
      })
    ).rejects.toThrow(/Permissão insuficiente/);
    expect(fetchMock).not.toHaveBeenCalled();
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
