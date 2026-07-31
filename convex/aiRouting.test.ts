/// <reference types="vite/client" />
/**
 * Roteamento de provider LLM por org: ordem da cadeia da plataforma
 * (platformOrder), modo BYO e exposição no getAiStatus. Complementa
 * lib/llm/llm.test.ts (cadeia pura) cobrindo a camada de config da org.
 */
import { expect, test, describe } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { applyPlatformOrder } from "./lib/agentRoutes";
import type { ResolvedRoute } from "./lib/llm";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

function setup() {
  return convexTest(schema, modules);
}

const fakeRoute = (providerId: string) => ({ providerId }) as ResolvedRoute;

describe("applyPlatformOrder (puro)", () => {
  const chain = [fakeRoute("opencode-go"), fakeRoute("openrouter")];

  test("auto/undefined mantém a ordem do env", () => {
    expect(applyPlatformOrder(chain, "auto").map((r) => r.providerId)).toEqual([
      "opencode-go",
      "openrouter",
    ]);
    expect(applyPlatformOrder(chain, undefined)).toEqual(chain);
  });

  test("openrouter-first inverte o primário mantendo o fallback", () => {
    expect(applyPlatformOrder(chain, "openrouter-first").map((r) => r.providerId)).toEqual([
      "openrouter",
      "opencode-go",
    ]);
  });

  test("*-only remove o fallback", () => {
    expect(applyPlatformOrder(chain, "openrouter-only").map((r) => r.providerId)).toEqual([
      "openrouter",
    ]);
    expect(applyPlatformOrder(chain, "opencode-only").map((r) => r.providerId)).toEqual([
      "opencode-go",
    ]);
  });
});

async function seedOrgWithAi(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org IA",
      slug: "org-ia",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.5 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const adminMemberId = await ctx.db.insert("teamMembers", {
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
    return { organizationId, adminUserId, adminMemberId, agentUserId };
  });
}

describe("setPlatformOrder + getAiStatus", () => {
  test("admin troca o roteamento e o status reflete", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithAi(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });

    let status = await asAdmin.query(api.aiSettings.getAiStatus, { organizationId });
    expect(status.providerMode).toBe("platform");
    expect(status.platformOrder).toBe("auto");
    expect(status.byo).toBeNull();

    await asAdmin.mutation(api.aiSettings.setPlatformOrder, {
      organizationId,
      platformOrder: "openrouter-first",
    });
    status = await asAdmin.query(api.aiSettings.getAiStatus, { organizationId });
    expect(status.platformOrder).toBe("openrouter-first");
  });

  test("setModels preserva o platformOrder já escolhido", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithAi(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });

    await asAdmin.mutation(api.aiSettings.setPlatformOrder, {
      organizationId,
      platformOrder: "openrouter-only",
    });
    await asAdmin.mutation(api.aiSettings.setModels, {
      organizationId,
      models: {
        copilot: "kimi-k2.7-code",
        attendant: "deepseek-v4-flash",
        classify: "deepseek-v4-flash",
      },
    });
    const status = await asAdmin.query(api.aiSettings.getAiStatus, { organizationId });
    expect(status.platformOrder).toBe("openrouter-only");
  });

  test("não-admin não troca o roteamento", async () => {
    const t = setup();
    const { organizationId, agentUserId } = await seedOrgWithAi(t);
    const asAgent = t.withIdentity({ subject: `${agentUserId}|s1` });

    await expect(
      asAgent.mutation(api.aiSettings.setPlatformOrder, {
        organizationId,
        platformOrder: "openrouter-first",
      })
    ).rejects.toThrow(/Permissão insuficiente/);
  });
});

describe("setProviderMode (BYO)", () => {
  test("byo com chave da própria org ativa e aparece mascarado no status", async () => {
    const t = setup();
    const { organizationId, adminUserId, adminMemberId } = await seedOrgWithAi(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });

    const secretId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("orgSecrets", {
        organizationId,
        name: "BYO openrouter",
        purpose: "llm-api-key",
        provider: "openrouter",
        encryptedValue: "v1:fake:encrypted",
        last4: "9999",
        createdBy: adminMemberId,
        createdAt: now,
        updatedAt: now,
      });
    });

    await asAdmin.mutation(api.aiSettings.setProviderMode, {
      organizationId,
      mode: "byo",
      byo: { provider: "openrouter", orgSecretId: secretId },
    });

    const status = await asAdmin.query(api.aiSettings.getAiStatus, { organizationId });
    expect(status.providerMode).toBe("byo");
    expect(status.byo).toEqual({ provider: "openrouter", baseUrl: null, keyLast4: "9999" });

    // Voltar ao padrão limpa o BYO.
    await asAdmin.mutation(api.aiSettings.setProviderMode, { organizationId, mode: "platform" });
    const back = await asAdmin.query(api.aiSettings.getAiStatus, { organizationId });
    expect(back.providerMode).toBe("platform");
    expect(back.byo).toBeNull();
  });

  test("chave de outra org é recusada", async () => {
    const t = setup();
    const { organizationId, adminUserId } = await seedOrgWithAi(t);
    const other = await seedOrgWithAi(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });

    const foreignSecretId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("orgSecrets", {
        organizationId: other.organizationId,
        name: "BYO alheio",
        purpose: "llm-api-key",
        encryptedValue: "v1:fake:encrypted",
        last4: "0000",
        createdBy: other.adminMemberId,
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      asAdmin.mutation(api.aiSettings.setProviderMode, {
        organizationId,
        mode: "byo",
        byo: { provider: "openrouter", orgSecretId: foreignSecretId },
      })
    ).rejects.toThrow(/não encontrada/);
  });
});

describe("testOrgConnection (guarda)", () => {
  test("não-admin não roda o teste de conexão", async () => {
    const t = setup();
    const { organizationId, agentUserId } = await seedOrgWithAi(t);
    const asAgent = t.withIdentity({ subject: `${agentUserId}|s1` });

    await expect(
      asAgent.action(api.aiDiagnostics.testOrgConnection, { organizationId })
    ).rejects.toThrow(/Permissão insuficiente/);
  });
});
