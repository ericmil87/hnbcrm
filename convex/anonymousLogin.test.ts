/// <reference types="vite/client" />
// @vitest-environment node
/**
 * Login anônimo removido (v0.68.1): teste de build + guarda de e-mail no
 * backend + op de auditoria somente leitura.
 */
import { expect, test, describe } from "vitest";
import { convexTest } from "convex-test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

// Mutations de sucesso agendam webhooks/e-mails (runAfter 0); sem cancelar, o job dispara
// depois do teste terminar e vira "Write outside of transaction" (erro não tratado do vitest).
async function cancelPendingJobs(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
}

describe("build: login anônimo não volta", () => {
  test("convex/auth.ts não importa nem registra o provider Anonymous", () => {
    const src = readFileSync("convex/auth.ts", "utf8");
    expect(src).not.toMatch(/providers\/Anonymous/);
    const providers = src.slice(src.indexOf("providers:"));
    expect(providers).not.toMatch(/\bAnonymous\b/);
  });

  test("nenhum signIn(\"anonymous\") em src/", () => {
    const files = execSync("git ls-files src", { encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));
    expect(files.length).toBeGreaterThan(50);
    const hits = files.filter((f) => /signIn\(\s*["']anonymous["']/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("guarda de e-mail", () => {
  test("createOrganization recusa usuário sem e-mail e aceita com e-mail", async () => {
    const t = convexTest(schema, modules);
    const anon = await t.run((ctx) => ctx.db.insert("users", {}));
    const real = await t.run((ctx) => ctx.db.insert("users", { email: "ok@acme.com.br", name: "Ok" }));

    await expect(
      t.withIdentity({ subject: `${anon}|s1` }).mutation(api.organizations.createOrganization, { name: "Anon", slug: "anon" }),
    ).rejects.toThrow(/conta com e-mail/);
    const orgs = await t.run((ctx) => ctx.db.query("organizations").collect());
    expect(orgs).toHaveLength(0);

    const orgId = await t
      .withIdentity({ subject: `${real}|s1` })
      .mutation(api.organizations.createOrganization, { name: "Real", slug: "real" });
    expect(orgId).toBeTruthy();
    // cancela o e-mail de boas-vindas agendado (o componente Resend não é registrado aqui)
    await cancelPendingJobs(t);
  });

  test("internalRequireSettingsManage barra admin anônimo legado", async () => {
    const t = convexTest(schema, modules);
    const { userId, orgId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const orgId = await ctx.db.insert("organizations", { name: "A", slug: "a", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: Date.now(), updatedAt: Date.now() } as any);
      await ctx.db.insert("teamMembers", { organizationId: orgId, userId, name: "Anon", role: "admin", type: "human", status: "active", createdAt: Date.now(), updatedAt: Date.now() } as any);
      return { userId, orgId };
    });
    await expect(
      t.withIdentity({ subject: `${userId}|s1` }).query(internal.channelConfigs.internalRequireSettingsManage, { organizationId: orgId }),
    ).rejects.toThrow(/conta com e-mail/);
  });
});

describe("internalListAnonymousUsers", () => {
  test("lista anônimo com org e ignora usuário com e-mail", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const anon = await ctx.db.insert("users", {});
      await ctx.db.insert("authAccounts", { userId: anon, provider: "anonymous", providerAccountId: "x" } as any);
      const real = await ctx.db.insert("users", { email: "ok@acme.com.br" });
      const now = Date.now();
      const orgAnon = await ctx.db.insert("organizations", { name: "Org Anon", slug: "org-anon", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now } as any);
      const orgReal = await ctx.db.insert("organizations", { name: "Org Real", slug: "org-real", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now } as any);
      await ctx.db.insert("teamMembers", { organizationId: orgAnon, userId: anon, name: "A", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now } as any);
      await ctx.db.insert("teamMembers", { organizationId: orgReal, userId: real, name: "R", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now } as any);
      return { anon, orgAnon };
    });
    const before = await t.run((ctx) => ctx.db.query("users").collect());
    const res = await t.query(internal.opsAnonymous.internalListAnonymousUsers, {});
    expect(res.total).toBe(1);
    expect(res.users).toHaveLength(1);
    expect(res.users[0].userId).toBe(ids.anon);
    expect(res.users[0].hasAnonymousAccount).toBe(true);
    expect(res.users[0].orgs).toHaveLength(1);
    expect(res.users[0].orgs[0]).toMatchObject({ organizationId: ids.orgAnon, slug: "org-anon", role: "admin", channelConfigs: 0, campaigns: 0, leads: 0, scheduledMessages: 0 });
    // somente leitura
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toEqual(before);
  });
});

describe("outras portas (revisão de segurança)", () => {
  const NOEMAIL = /conta com e-mail/;
  async function seedPair() {
    const t = convexTest(schema, modules);
    const s = await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", { name: "O", slug: "o", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now } as any);
      const anonUserId = await ctx.db.insert("users", {});
      const realUserId = await ctx.db.insert("users", { email: "real@acme.com.br" });
      const mk = (userId: any, name: string) =>
        ctx.db.insert("teamMembers", { organizationId, userId, name, role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now } as any);
      const anonMemberId = await mk(anonUserId, "Anon");
      const realMemberId = await mk(realUserId, "Real");
      const channelConfigId = await ctx.db.insert("channelConfigs", {
        organizationId, channel: "whatsapp", provider: "bridge", displayName: "B",
        bridgeBaseUrl: "https://x", bridgeInstanceId: "i", status: "active", createdAt: now, updatedAt: now,
      } as any);
      await ctx.db.insert("apiKeys", { organizationId, teamMemberId: realMemberId, name: "k1", keyHash: "h1", isActive: true, createdAt: now });
      await ctx.db.insert("apiKeys", { organizationId, teamMemberId: realMemberId, name: "k2", keyHash: "h2", isActive: false, createdAt: now });
      return { organizationId, anonUserId, realUserId, anonMemberId, realMemberId, channelConfigId };
    });
    const as = (u: any) => t.withIdentity({ subject: `${u}|s1` });
    return { t, s, as };
  }

  test("apiKeys.verifyAdmin: anônimo legado não gera API key; admin com e-mail passa", async () => {
    const { s, as } = await seedPair();
    await expect(as(s.anonUserId).query(internal.apiKeys.verifyAdmin, { organizationId: s.organizationId })).rejects.toThrow(NOEMAIL);
    const ok = await as(s.realUserId).query(internal.apiKeys.verifyAdmin, { organizationId: s.organizationId });
    expect(ok?._id).toBe(s.realMemberId);
  });

  test("teamMembers.internalPrepareInvite: anônimo não convida; com e-mail passa", async () => {
    const { s, as } = await seedPair();
    const args = { organizationId: s.organizationId, email: "novo@acme.com.br", role: "agent" as const };
    await expect(as(s.anonUserId).query(internal.teamMembers.internalPrepareInvite, args)).rejects.toThrow(NOEMAIL);
    const ok = await as(s.realUserId).query(internal.teamMembers.internalPrepareInvite, args);
    expect(ok.callerMemberId).toBe(s.realMemberId);
  });

  test("aiSettings: setAiEnabled, activateOneFlow, setBridgeAiAck e setGroupAutopilotAck barram anônimo", async () => {
    const { t, s, as } = await seedPair();
    const a = as(s.anonUserId);
    const organizationId = s.organizationId;
    await expect(a.mutation(api.aiSettings.setAiEnabled, { organizationId, enabled: true, lgpdAck: true })).rejects.toThrow(NOEMAIL);
    await expect(a.mutation(api.aiSettings.activateOneFlow, { organizationId, lgpdAck: true })).rejects.toThrow(NOEMAIL);
    await expect(a.mutation(api.aiSettings.setBridgeAiAck, { organizationId, accept: true, riskAck: true })).rejects.toThrow(NOEMAIL);
    await expect(a.mutation(api.aiSettings.setGroupAutopilotAck, { organizationId, accept: true, riskAck: true })).rejects.toThrow(NOEMAIL);
    // com e-mail a guarda não barra (setAiEnabled liga a IA)
    await as(s.realUserId).mutation(api.aiSettings.setAiEnabled, { organizationId, enabled: true, lgpdAck: true });
    await cancelPendingJobs(t);
  });

  test("campaigns.launchCampaign: wrapper público barra anônimo; caminho interno (REST) com membro segue", async () => {
    const { t, s, as } = await seedPair();
    const campaignId = await as(s.realUserId).mutation(api.campaigns.createCampaign, {
      organizationId: s.organizationId,
      name: "C",
      channelConfigId: s.channelConfigId,
      content: { kind: "text", variants: [{ text: "Oi {{nome}}" }, { text: "Olá {{nome}}" }] },
      audience: { source: "manual" },
    });
    await expect(as(s.anonUserId).mutation(api.campaigns.launchCampaign, { campaignId, consentAck: true })).rejects.toThrow(NOEMAIL);
    // Caminho REST: sem ctx.auth, só actorMemberId. Não pode cair na guarda de e-mail
    // (falha adiante por regra de lançamento, ex.: sem aceite/destinatários).
    let msg = "";
    try {
      await t.mutation(internal.campaignsInternal.internalLaunchCampaign, { campaignId, consentAck: false, actorMemberId: s.realMemberId });
    } catch (e: any) {
      msg = String(e?.data ?? e?.message ?? e);
    }
    expect(msg).not.toMatch(NOEMAIL);
    expect(msg).not.toBe("");
    await cancelPendingJobs(t);
  });

  test("internalListAnonymousUsers: apiKeys e activeApiKeys por org", async () => {
    const { t, s } = await seedPair();
    // põe o anônimo como membro da org que tem 2 keys (1 ativa)
    await t.run(async (ctx) => {
      await ctx.db.insert("apiKeys", { organizationId: s.organizationId, teamMemberId: s.anonMemberId, name: "k3", keyHash: "h3", isActive: true, createdAt: Date.now() });
    });
    const res = await t.query(internal.opsAnonymous.internalListAnonymousUsers, {});
    expect(res.users).toHaveLength(1);
    expect(res.users[0].orgs[0]).toMatchObject({ apiKeys: 3, activeApiKeys: 2, channelConfigs: 1 });
  });
});
