/// <reference types="vite/client" />
/**
 * Copiloto × campanhas: lê (lista/relatório/prévia de público), RASCUNHA
 * (createCampaignDraft, auditado via copilot), pausa/retoma, NUNCA lança
 * (launchCampaign devolve instrução) e cancelar é two-phase (pendingAction →
 * confirmPendingAction re-checa campaigns:full).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { COPILOT_READ_TOOLS, COPILOT_WRITE_TOOLS } from "./lib/agentTools";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 8, 18);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  return convexTest(schema, modules);
}
const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|s1` });

async function seed(t: TestConvex<typeof schema>) {
  const s = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Copiloto", slug: "org-copiloto", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const managerUserId = await ctx.db.insert("users", {});
    const managerId = await ctx.db.insert("teamMembers", {
      organizationId, userId: managerUserId, name: "Gerente", role: "manager", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const stageId = await ctx.db.insert("stages", { organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "Maria", phone: "5511999990001", whatsappNumber: "5511999990001", tags: ["vip"], createdAt: now, updatedAt: now });
    await ctx.db.insert("leads", {
      organizationId, title: "Maria", contactId, boardId, stageId, value: 0, currency: "BRL", priority: "medium", temperature: "hot",
      tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    return { organizationId, adminUserId, adminId, managerUserId, managerId, boardId, stageId };
  });
  const bridgeConfigId = await asUser(t, s.adminUserId).action(api.channelConfigs.createChannelConfig, {
    organizationId: s.organizationId, channel: "whatsapp", provider: "bridge", displayName: "Bridge",
    bridgeBaseUrl: "https://wuzapi.example.com", bridgeInstanceId: "inst_cop", bridgeToken: "fake-token-1234",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(bridgeConfigId, { bridgeConnectedAt: Date.now() - 10 * DAY, bridgeSessionState: "connected", status: "active" });
  });
  return { ...s, bridgeConfigId };
}

const write = (t: TestConvex<typeof schema>, memberId: Id<"teamMembers">, organizationId: Id<"organizations">, name: string, args: unknown) =>
  t.mutation(internal.copilot.internalRunCopilotWriteTool, { name, argsJson: JSON.stringify(args), organizationId, memberId });
const read = (t: TestConvex<typeof schema>, memberId: Id<"teamMembers">, organizationId: Id<"organizations">, name: string, args: unknown) =>
  t.query(internal.copilot.internalRunCopilotReadTool, { name, argsJson: JSON.stringify(args), organizationId, memberId, now: Date.now() }) as Promise<Record<string, any>>;

describe("copiloto × campanhas", () => {
  test("registry: tools de campanha existem com gates certos e cancelar é destrutiva", () => {
    const readNames = COPILOT_READ_TOOLS.map((t) => t.name);
    expect(readNames).toEqual(expect.arrayContaining(["listCampaigns", "getCampaignReport", "previewCampaignAudience"]));
    const cancel = COPILOT_WRITE_TOOLS.find((t) => t.name === "cancelCampaign")!;
    expect(cancel.effect).toBe("destructive");
    expect(cancel.permission).toEqual({ category: "campaigns", level: "full" });
    const draft = COPILOT_WRITE_TOOLS.find((t) => t.name === "createCampaignDraft")!;
    expect(draft.permission).toEqual({ category: "campaigns", level: "manage" });
  });

  test("createCampaignDraft cria rascunho manual (auditado via copilot) e launchCampaign só orienta", async () => {
    const t = setup();
    const s = await seed(t);
    const result = await write(t, s.managerId, s.organizationId, "createCampaignDraft", {
      name: "Promo copiloto",
      variants: ["Oi {{nome}}!", "Olá {{nome}}, tudo bem?"],
      audience: { kind: "manual", phones: ["+55 11 99999-0002", "5511999990003", "xx"] },
    });
    expect(result.status).toBe("rascunho_criado");
    expect(result.recipientsAdded).toBe(2);
    expect(result.invalid).toHaveLength(1);
    expect(result.url).toContain("/app/campanhas?campanha=");

    const { campaign, audits } = await t.run(async (ctx) => ({
      campaign: await ctx.db.get(result.campaignId as Id<"campaigns">),
      audits: (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityType === "campaign"),
    }));
    expect(campaign?.status).toBe("draft");
    expect(campaign?.provider).toBe("bridge");
    expect(audits[0]?.metadata?.via).toBe("copilot");
    expect(audits[0]?.actorId).toBe(s.managerId);

    const launch = await write(t, s.adminId, s.organizationId, "launchCampaign", { campaignId: result.campaignId });
    expect(launch.status).toBe("requer_lancamento_humano");
    expect(launch.instruction).toMatch(/risco do bridge/);
    const still = await t.run((ctx) => ctx.db.get(result.campaignId as Id<"campaigns">));
    expect(still?.status).toBe("draft"); // nada foi lançado
  });

  test("leitura: listCampaigns + previewCampaignAudience por nome de board (telefone mascarado)", async () => {
    const t = setup();
    const s = await seed(t);
    await write(t, s.adminId, s.organizationId, "createCampaignDraft", {
      name: "Seg", variants: ["a", "b"], audience: { kind: "segment", boardName: "Vendas", stageNames: ["Novo"], temperature: "hot" },
    });
    const list = await read(t, s.adminId, s.organizationId, "listCampaigns", {});
    expect(list.campaigns).toHaveLength(1);
    expect(list.campaigns[0].status).toBe("draft");
    expect(JSON.stringify(list)).not.toMatch(/Encrypted|token/i);

    const preview = await read(t, s.adminId, s.organizationId, "previewCampaignAudience", { boardName: "Vendas", temperature: "hot" });
    expect(preview.count).toBe(1);
    expect(preview.sample[0].phone).toMatch(/^5511\*+0001$/);

    const bad = await read(t, s.adminId, s.organizationId, "previewCampaignAudience", { boardName: "Inexistente" });
    expect(bad.error).toMatch(/não existe/);
  });

  test("cancelCampaign é two-phase: pendingAction → confirmação cancela (re-check campaigns:full)", async () => {
    const t = setup();
    const s = await seed(t);
    const draft = await write(t, s.adminId, s.organizationId, "createCampaignDraft", {
      name: "Cancelável", variants: ["a", "b"], audience: { kind: "manual", phones: ["5511999990002"] },
    });
    await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: draft.campaignId as Id<"campaigns">, consentAck: true, bridgeRiskAck: true,
    });
    const paused = await write(t, s.adminId, s.organizationId, "pauseCampaign", { campaignId: draft.campaignId, reason: "teste" });
    expect(paused.status).toBe("pausada");

    // manager tem campaigns:manage, não full → a tool nem passa no gate
    await expect(write(t, s.managerId, s.organizationId, "cancelCampaign", { campaignId: draft.campaignId })).rejects.toThrow(/Permissão insuficiente/);

    const proposed = await write(t, s.adminId, s.organizationId, "cancelCampaign", { campaignId: draft.campaignId });
    expect(proposed.status).toBe("confirmacao_necessaria");
    let campaign = await t.run((ctx) => ctx.db.get(draft.campaignId as Id<"campaigns">));
    expect(campaign?.status).toBe("paused"); // ainda não cancelou

    await asUser(t, s.adminUserId).mutation(api.copilot.confirmPendingAction, {
      pendingActionId: proposed.pendingActionId as Id<"pendingActions">,
    });
    campaign = await t.run((ctx) => ctx.db.get(draft.campaignId as Id<"campaigns">));
    expect(campaign?.status).toBe("canceled");
    const audit = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).find((a) => /Cancelou a campanha/.test(a.description ?? ""))
    );
    expect(audit?.metadata?.via).toBe("copilot");
  });
});
