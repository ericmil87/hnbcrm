/// <reference types="vite/client" />
/**
 * Portas únicas de configuração do atendente (lib/attendantConfigOps.ts):
 * conta sem e-mail recusada nas mutations, `via` no audit, validação de
 * follow-up preservada, rename e `getPlatformCapabilities` sem vazar env.
 */
import { expect, test, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  patchChannelTranscriptionCore,
  setFeatureTogglesCore,
  updateAgentProfileCore,
} from "./lib/attendantConfigOps";

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
    const adminUserId = await ctx.db.insert("users", { email: "admin@teste.com" });
    const anonUserId = await ctx.db.insert("users", {});
    const agentUserId = await ctx.db.insert("users", { email: "agente@teste.com" });
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Config",
      slug: "org-config",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("teamMembers", {
      organizationId, userId: anonUserId, name: "Anon", role: "admin",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("teamMembers", {
      organizationId, userId: agentUserId, name: "Agente", role: "agent",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const aiId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" },
      createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta",
      displayName: "Principal", phoneNumberId: "555000111",
      status: "active", createdAt: now, updatedAt: now,
    });
    return { organizationId, adminUserId, anonUserId, agentUserId, adminId, aiId, configId };
  });
}

const as = (t: TestConvex<typeof schema>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|s1` });

test("updateAgentProfile recusa conta sem e-mail", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await expect(
    as(t, s.anonUserId).mutation(api.aiSettings.updateAgentProfile, {
      agentMemberId: s.aiId,
      patch: { language: "en" },
    })
  ).rejects.toThrow(/e-mail/);
  await as(t, s.adminUserId).mutation(api.aiSettings.updateAgentProfile, {
    agentMemberId: s.aiId,
    patch: { language: "en" },
  });
});

test("setFeatureToggles recusa conta sem e-mail", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await expect(
    as(t, s.anonUserId).mutation(api.aiSettings.setFeatureToggles, {
      organizationId: s.organizationId,
      visionEnabled: true,
    })
  ).rejects.toThrow(/e-mail/);
  await as(t, s.adminUserId).mutation(api.aiSettings.setFeatureToggles, {
    organizationId: s.organizationId,
    visionEnabled: true,
  });
  const org = await t.run((ctx) => ctx.db.get(s.organizationId));
  expect(org?.settings.aiConfig?.visionEnabled).toBe(true);
});

test("agente sem settings:manage é recusado", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const agent = as(t, s.agentUserId);
  await expect(
    agent.mutation(api.aiSettings.updateAgentProfile, { agentMemberId: s.aiId, patch: {} })
  ).rejects.toThrow();
  await expect(
    agent.mutation(api.aiSettings.setFeatureToggles, { organizationId: s.organizationId })
  ).rejects.toThrow();
  await expect(
    agent.mutation(api.aiSettings.createAttendantOneClick, { organizationId: s.organizationId })
  ).rejects.toThrow();
});

test("core grava via no audit", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await t.run(async (ctx) => {
    const agent = (await ctx.db.get(s.aiId))!;
    const member = (await ctx.db.get(s.adminId))!;
    await updateAgentProfileCore(ctx, { agent, member, patch: { language: "es" }, via: "copilot" });
    const org = (await ctx.db.get(s.organizationId))!;
    await setFeatureTogglesCore(ctx, { org, member, toggles: { copilotEnabled: false }, via: "wizard" });
    const config = (await ctx.db.get(s.configId))!;
    await patchChannelTranscriptionCore(ctx, { config, member, enabled: true, via: "copilot" });
  });
  const logs = await t.run((ctx) =>
    ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect()
  );
  const vias = logs.map((l) => `${l.entityType}:${(l.metadata as { via?: string })?.via}`).sort();
  expect(vias).toEqual(["channelConfig:copilot", "organization:wizard", "teamMember:copilot"]);
  const config = await t.run((ctx) => ctx.db.get(s.configId));
  expect(config?.autoTranscribeAudio).toBe(true);
});

test("core preserva validação de follow-up", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await expect(
    t.run(async (ctx) => {
      const agent = (await ctx.db.get(s.aiId))!;
      const member = (await ctx.db.get(s.adminId))!;
      await updateAgentProfileCore(ctx, {
        agent,
        member,
        patch: { followUps: { mode: "send", quietStartHour: 20, quietEndHour: 8 } },
      });
    })
  ).rejects.toThrow(/janela de envio/);
});

test("core rename muda teamMembers.name e audita", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await t.run(async (ctx) => {
    const agent = (await ctx.db.get(s.aiId))!;
    const member = (await ctx.db.get(s.adminId))!;
    await updateAgentProfileCore(ctx, { agent, member, patch: {}, rename: "  Bia  ", via: "copilot" });
  });
  const ai = await t.run((ctx) => ctx.db.get(s.aiId));
  expect(ai?.name).toBe("Bia");
  const logs = await t.run((ctx) =>
    ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect()
  );
  const log = logs.find((l) => l.entityType === "teamMember")!;
  expect(log.changes?.before).toMatchObject({ name: "Ana (IA)" });
  expect(log.changes?.after).toMatchObject({ name: "Bia" });
});

test("getPlatformCapabilities reflete envs sem vazar valores", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const admin = as(t, s.adminUserId);
  for (const k of [
    "WA_BRIDGE_DEFAULT_URL", "WA_BRIDGE_ADMIN_TOKEN", "WA_BRIDGE_HMAC_SECRET", "WHISPER_SERVICE_URL",
    "OPENROUTER_API_KEY", "OPENCODE_GO_API", "META_MESSAGING_APP_ID", "META_MESSAGING_APP_SECRET",
    "META_MESSAGING_LOGIN_CONFIG_ID",
  ]) vi.stubEnv(k, "");
  const none = await admin.query(api.onboarding.getPlatformCapabilities, { organizationId: s.organizationId });
  expect(none).toEqual({ managedBridge: false, transcription: false, llm: false, metaMessaging: false });

  vi.stubEnv("WA_BRIDGE_DEFAULT_URL", "https://bridge.fake.test");
  vi.stubEnv("WA_BRIDGE_ADMIN_TOKEN", "fake-admin-token-xyz");
  vi.stubEnv("WA_BRIDGE_HMAC_SECRET", "curto");
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-000");
  vi.stubEnv("WHISPER_SERVICE_URL", "https://whisper.fake.test");
  const short = await admin.query(api.onboarding.getPlatformCapabilities, { organizationId: s.organizationId });
  expect(short).toEqual({ managedBridge: false, transcription: true, llm: true, metaMessaging: false });

  vi.stubEnv("WA_BRIDGE_HMAC_SECRET", "fake-hmac-secret-".padEnd(40, "x"));
  vi.stubEnv("META_MESSAGING_APP_ID", "123");
  vi.stubEnv("META_MESSAGING_APP_SECRET", "fake-meta-secret");
  vi.stubEnv("META_MESSAGING_LOGIN_CONFIG_ID", "456");
  const all = await admin.query(api.onboarding.getPlatformCapabilities, { organizationId: s.organizationId });
  expect(all).toEqual({ managedBridge: true, transcription: true, llm: true, metaMessaging: true });
  const serialized = JSON.stringify(all);
  expect(serialized).not.toMatch(/fake|bridge\.|whisper|sk-test/);
});
