/// <reference types="vite/client" />
/**
 * REST de campanhas (`/api/v1/campaigns/*`, `/api/v1/opt-outs`,
 * `/api/v1/whatsapp/templates`): mesmas regras da UI via os wrappers
 * `internal*` de campaignsInternal.ts — RBAC pela API key (403), escopo de org
 * (campanha alheia = 404), auditoria com `via: "api"`, e o fluxo completo
 * criar → destinatários → lançar → relatório → pausar → cancelar.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
const DAY = 24 * 60 * 60 * 1000;
// Terça 2026-09-08 15:00 BRT (janela 09–20 aberta)
const NOW = Date.UTC(2026, 8, 8, 18);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  // Nenhuma rota destes testes fala com a rede; qualquer fetch é o webhook
  // de saída (best-effort) ou o /user/check do bridge.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ code: 200, data: { Users: [] } }), { status: 200 }))
  );
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

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const ADMIN_KEY = "hnb_test_admin_key_0001";
const AGENT_KEY = "hnb_test_agent_key_0002";
const OTHER_KEY = "hnb_test_other_key_0003";

async function seed(t: TestConvex<typeof schema>) {
  const s = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org API", slug: "org-api",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now, updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Vendedor", role: "agent", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    // Outra org com a própria key
    const otherOrgId = await ctx.db.insert("organizations", {
      name: "Outra", slug: "outra", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now,
    });
    const otherAdminId = await ctx.db.insert("teamMembers", {
      organizationId: otherOrgId, name: "Outro", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    for (const [key, org, member] of [
      [ADMIN_KEY, organizationId, adminId],
      [AGENT_KEY, organizationId, agentId],
      [OTHER_KEY, otherOrgId, otherAdminId],
    ] as const) {
      await ctx.db.insert("apiKeys", {
        organizationId: org, teamMemberId: member, name: key, keyHash: await sha256Hex(key), isActive: true, createdAt: now,
      });
    }
    return { organizationId, adminUserId, adminId, agentId, boardId, otherOrgId };
  });
  const bridgeConfigId = await asUser(t, s.adminUserId).action(api.channelConfigs.createChannelConfig, {
    organizationId: s.organizationId, channel: "whatsapp", provider: "bridge", displayName: "Bridge",
    bridgeBaseUrl: "https://wuzapi.example.com", bridgeInstanceId: "inst_api", bridgeToken: "fake-token-1234",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(bridgeConfigId, { bridgeConnectedAt: Date.now() - 10 * DAY, bridgeSessionState: "connected", status: "active" });
  });
  return { ...s, bridgeConfigId };
}

async function call(
  t: TestConvex<typeof schema>,
  key: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>
) {
  const res = await t.fetch(path, {
    method,
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}

const draftBody = (channelConfigId: string) => ({
  name: "Promo API",
  channelConfigId,
  content: { kind: "text", variants: [{ text: "Oi {{nome}}!" }, { text: "Olá {{nome}}, tudo bem?" }] },
  audience: { source: "manual" },
});

describe("REST /api/v1/campaigns", () => {
  test("fluxo completo: criar → destinatários → lançar → relatório → pausar → cancelar (auditado via api)", async () => {
    const t = setup();
    const s = await seed(t);

    const created = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/create", draftBody(s.bridgeConfigId));
    expect(created.status).toBe(201);
    const campaignId = created.json.campaignId as string;

    const added = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/recipients", {
      campaignId,
      entries: [{ phone: "+55 11 99999-0001", name: "Maria" }, { phone: "5511999990002" }, { phone: "abc" }],
    });
    expect(added.status).toBe(200);
    expect(added.json.added).toBe(2);
    expect(added.json.invalid).toHaveLength(1);

    const list = await call(t, ADMIN_KEY, "GET", "/api/v1/campaigns?status=draft");
    expect(list.status).toBe(200);
    expect(list.json.campaigns).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toMatch(/Encrypted|bridgeToken/i);

    // Sem consentimento: 400 com a mensagem do domínio
    const noAck = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/launch", { campaignId, consentAck: false });
    expect(noAck.status).toBe(400);
    expect(noAck.json.error).toMatch(/consentimento/i);

    const launched = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/launch", {
      campaignId, consentAck: true, bridgeRiskAck: true,
    });
    expect(launched.status).toBe(200);
    expect(launched.json.status).toBe("running");

    const report = await call(t, ADMIN_KEY, "GET", `/api/v1/campaigns/report?campaignId=${campaignId}`);
    expect(report.status).toBe(200);
    expect(report.json.report.stats.total).toBe(2);

    const recipients = await call(t, ADMIN_KEY, "GET", `/api/v1/campaigns/recipients?campaignId=${campaignId}&limit=10`);
    expect(recipients.status).toBe(200);
    expect(recipients.json.recipients).toHaveLength(2);

    const paused = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/pause", { campaignId, reason: "teste" });
    expect(paused.status).toBe(200);
    const canceled = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/cancel", { campaignId });
    expect(canceled.status).toBe(200);

    const { campaign, audits } = await t.run(async (ctx) => ({
      campaign: await ctx.db.get(campaignId as Id<"campaigns">),
      audits: (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityType === "campaign"),
    }));
    expect(campaign?.status).toBe("canceled");
    expect(campaign?.safety.consentAck?.acceptedBy).toBe(s.adminId);
    const launchAudit = audits.find((a) => /Lançou/.test(a.description ?? ""));
    expect(launchAudit?.metadata?.via).toBe("api");
    expect(launchAudit?.actorId).toBe(s.adminId);
  });

  test("RBAC pela key: agent (campaigns:view) lista mas não cria nem lança", async () => {
    const t = setup();
    const s = await seed(t);
    const denied = await call(t, AGENT_KEY, "POST", "/api/v1/campaigns/create", draftBody(s.bridgeConfigId));
    expect(denied.status).toBe(403);
    expect(denied.json).toEqual({ error: "Permissão insuficiente", code: 403 });

    const ok = await call(t, AGENT_KEY, "GET", "/api/v1/campaigns");
    expect(ok.status).toBe(200);
    expect(ok.json.campaigns).toEqual([]);

    const created = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/create", draftBody(s.bridgeConfigId));
    const launch = await call(t, AGENT_KEY, "POST", "/api/v1/campaigns/launch", {
      campaignId: created.json.campaignId, consentAck: true, bridgeRiskAck: true,
    });
    expect(launch.status).toBe(403);
  });

  test("isolamento: campanha de outra org é 404 (get, report, pause)", async () => {
    const t = setup();
    const s = await seed(t);
    const created = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/create", draftBody(s.bridgeConfigId));
    const campaignId = created.json.campaignId as string;

    const get = await call(t, OTHER_KEY, "GET", `/api/v1/campaigns/get?campaignId=${campaignId}`);
    expect(get.status).toBe(404);
    const report = await call(t, OTHER_KEY, "GET", `/api/v1/campaigns/report?campaignId=${campaignId}`);
    expect(report.status).toBe(404);
    const pause = await call(t, OTHER_KEY, "POST", "/api/v1/campaigns/pause", { campaignId });
    expect(pause.status).toBe(404);
    // e o canal alheio não serve para criar campanha
    const cross = await call(t, OTHER_KEY, "POST", "/api/v1/campaigns/create", draftBody(s.bridgeConfigId));
    expect(cross.status).toBe(404);
  });

  test("CSV: dry-run valida sem gravar; commit insere e ignora supressos", async () => {
    const t = setup();
    const s = await seed(t);
    const created = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/create", draftBody(s.bridgeConfigId));
    const campaignId = created.json.campaignId as string;
    const opt = await call(t, ADMIN_KEY, "POST", "/api/v1/opt-outs", { phone: "5511999990009", reason: "pediu" });
    expect(opt.status).toBe(201);

    const csv = "nome,telefone,cidade\nAna,11999990001,SP\nBia,11999990009,RJ\nCaio,xx,BH\n";
    const headers = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/recipients", { campaignId, csv, dryRun: true });
    expect(headers.status).toBe(200);
    expect(headers.json.suggestedMapping.phone).toBe("telefone");

    const mapping = { phone: "telefone", name: "nome", varsColumns: ["cidade"] };
    const dry = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/recipients", { campaignId, csv, mapping, dryRun: true });
    expect(dry.json).toMatchObject({ valid: 1, invalidCount: 1, suppressed: 1 });
    let count = await t.run(async (ctx) =>
      (await ctx.db.query("campaignRecipients").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId as Id<"campaigns">)).collect()).length
    );
    expect(count).toBe(0);

    const commit = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/recipients", { campaignId, csv, mapping, dryRun: false });
    expect(commit.json.added).toBe(1);
    count = await t.run(async (ctx) =>
      (await ctx.db.query("campaignRecipients").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId as Id<"campaigns">)).collect()).length
    );
    expect(count).toBe(1);

    const optOuts = await call(t, ADMIN_KEY, "GET", "/api/v1/opt-outs?search=0009");
    expect(optOuts.json.optOuts).toHaveLength(1);
    const removeDenied = await call(t, AGENT_KEY, "DELETE", `/api/v1/opt-outs?optOutId=${opt.json.optOutId}`);
    expect(removeDenied.status).toBe(403);
    const removed = await call(t, ADMIN_KEY, "DELETE", `/api/v1/opt-outs?optOutId=${opt.json.optOutId}`);
    expect(removed.status).toBe(200);
  });

  test("número bridge recém-conectado: safe-defaults avisa e o launch exige newNumberRiskAck (não trava)", async () => {
    const t = setup();
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.bridgeConfigId, { bridgeConnectedAt: Date.now() }));
    const defaults = await call(t, ADMIN_KEY, "GET", `/api/v1/campaigns/safe-defaults?channelConfigId=${s.bridgeConfigId}`);
    expect(defaults.json.defaults.newNumberRisk).toMatch(/recém-conectado/);

    const created = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/create", draftBody(s.bridgeConfigId));
    const campaignId = created.json.campaignId as string;
    await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/recipients", { campaignId, entries: [{ phone: "5511999990001" }] });

    const noAck = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/launch", { campaignId, consentAck: true, bridgeRiskAck: true });
    expect(noAck.status).toBe(400);
    expect(noAck.json.error).toMatch(/recém-conectado/);

    const launched = await call(t, ADMIN_KEY, "POST", "/api/v1/campaigns/launch", {
      campaignId, consentAck: true, bridgeRiskAck: true, newNumberRiskAck: true,
    });
    expect(launched.status).toBe(200);
    expect(launched.json.status).toBe("running");
    const campaign = await t.run((ctx) => ctx.db.get(campaignId as Id<"campaigns">));
    expect(campaign?.safety.newNumberRiskAck?.acceptedBy).toBe(s.adminId);
  });

  test("safe-defaults e templates respondem para a key da org; canal alheio é 404", async () => {
    const t = setup();
    const s = await seed(t);
    const defaults = await call(t, ADMIN_KEY, "GET", `/api/v1/campaigns/safe-defaults?channelConfigId=${s.bridgeConfigId}`);
    expect(defaults.status).toBe(200);
    expect(defaults.json.defaults.provider).toBe("bridge");
    expect(defaults.json.defaults.warmupDay).toBe(11);
    expect(defaults.json.defaults.newNumberRisk).toBeNull();

    const templates = await call(t, ADMIN_KEY, "GET", `/api/v1/whatsapp/templates?channelConfigId=${s.bridgeConfigId}`);
    expect(templates.status).toBe(200);
    expect(templates.json.templates).toEqual([]);

    const other = await call(t, OTHER_KEY, "GET", `/api/v1/campaigns/safe-defaults?channelConfigId=${s.bridgeConfigId}`);
    expect(other.status).toBe(404);
  });
});
