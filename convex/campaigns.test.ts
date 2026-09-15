/// <reference types="vite/client" />
/**
 * Campanhas — CRUD, RBAC, multi-tenant, aceites e validações de lançamento.
 * O worker (envio real) está em campaignWorker.test.ts.
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

export async function seedCampaignOrg(t: TestConvex<typeof schema>, opts: { channelAgeDays?: number } = {}) {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Camp", slug: "org-camp",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now, updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const managerUserId = await ctx.db.insert("users", {});
    const agentUserId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const managerId = await ctx.db.insert("teamMembers", {
      organizationId, userId: managerUserId, name: "Gerente", role: "manager", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, userId: agentUserId, name: "Vendedor", role: "agent", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    // Outra org (isolamento)
    const otherOrgId = await ctx.db.insert("organizations", {
      name: "Outra", slug: "outra", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now,
    });
    const otherConfigId = await ctx.db.insert("channelConfigs", {
      organizationId: otherOrgId, channel: "whatsapp", provider: "bridge", displayName: "Alheio",
      bridgeBaseUrl: "https://x", bridgeInstanceId: "other", status: "active", createdAt: now, updatedAt: now,
    });
    return { organizationId, adminUserId, managerUserId, agentUserId, adminId, managerId, agentId, boardId, stageId, otherOrgId, otherConfigId };
  });
  const asAdmin = asUser(t, seeded.adminUserId);
  const bridgeConfigId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: seeded.organizationId, channel: "whatsapp", provider: "bridge", displayName: "Bridge",
    bridgeBaseUrl: "https://wuzapi.example.com", bridgeInstanceId: "inst_camp", bridgeToken: "fake-token-1234",
  });
  const metaConfigId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: seeded.organizationId, channel: "whatsapp", displayName: "Meta",
    phoneNumberId: "111000111000111", wabaId: "222000222000222", verifyToken: "verify-token",
    appSecret: "fake-app-secret-abcd", accessToken: "EAAFakeAccessToken9876",
  });
  const ageDays = opts.channelAgeDays ?? 10;
  await t.run(async (ctx) => {
    await ctx.db.patch(bridgeConfigId, { bridgeConnectedAt: Date.now() - ageDays * DAY, bridgeSessionState: "connected", status: "active" });
    await ctx.db.patch(metaConfigId, { status: "active" });
  });
  return { ...seeded, bridgeConfigId, metaConfigId };
}

const twoVariants = {
  kind: "text" as const,
  variants: [{ text: "Oi {{nome}}, tudo bem?" }, { text: "Olá {{nome}}! Podemos falar?" }],
};

async function createDraft(
  t: TestConvex<typeof schema>,
  seed: Awaited<ReturnType<typeof seedCampaignOrg>>,
  overrides: Partial<{ channelConfigId: Id<"channelConfigs">; content: typeof twoVariants; userId: Id<"users"> }> = {}
) {
  return await asUser(t, overrides.userId ?? seed.adminUserId).mutation(api.campaigns.createCampaign, {
    organizationId: seed.organizationId,
    name: "Promo setembro",
    channelConfigId: overrides.channelConfigId ?? seed.bridgeConfigId,
    content: overrides.content ?? twoVariants,
    audience: { source: "manual" },
  });
}

function phones(n: number, start = 5511990000000): string[] {
  return Array.from({ length: n }, (_, i) => String(start + i));
}

describe("CRUD e RBAC", () => {
  test("agent (view) não cria; manager cria; defaults seguros por idade do número", async () => {
    const t = setup();
    const seed = await seedCampaignOrg(t);
    await expect(createDraft(t, seed, { userId: seed.agentUserId })).rejects.toThrow(/Permissão insuficiente/);
    const id = await createDraft(t, seed, { userId: seed.managerUserId });
    const campaign = await t.run((ctx) => ctx.db.get(id));
    expect(campaign?.status).toBe("draft");
    expect(campaign?.provider).toBe("bridge");
    // 10 dias → linha 8–14: 120/dia, 30 novos, 30–90s
    expect(campaign?.pacing.maxPerDay).toBe(120);
    expect(campaign?.pacing.maxNewContactsPerDay).toBe(30);
    expect(campaign?.pacing.minDelaySec).toBe(30);
    expect(campaign?.safeMode).toBe(true);
    expect(campaign?.safety.checkNumbersFirst).toBe(true);
    expect(campaign?.safety.stopOnReplyRateBelow).toBe(0.1);
    // agent lê
    const list = await asUser(t, seed.agentUserId).query(api.campaigns.listCampaigns, { organizationId: seed.organizationId });
    expect(list).toHaveLength(1);
    expect(list[0].channel?.provider).toBe("bridge");
    expect(JSON.stringify(list)).not.toMatch(/Encrypted|token/i);
  });

  test("canal de outra org é recusado", async () => {
    const t = setup();
    const seed = await seedCampaignOrg(t);
    await expect(createDraft(t, seed, { channelConfigId: seed.otherConfigId })).rejects.toThrow(/Canal WhatsApp não encontrado/);
  });

  test("template só no canal Meta; texto no Meta exige janela aberta no lançamento", async () => {
    const t = setup();
    const seed = await seedCampaignOrg(t);
    await expect(
      asUser(t, seed.adminUserId).mutation(api.campaigns.createCampaign, {
        organizationId: seed.organizationId, name: "T", channelConfigId: seed.bridgeConfigId,
        content: { kind: "template", variants: [], template: { name: "promo", language: "pt_BR" } },
        audience: { source: "manual" },
      })
    ).rejects.toThrow(/exclusivos da WhatsApp Cloud API/);
    const id = await createDraft(t, seed, { channelConfigId: seed.metaConfigId });
    await asUser(t, seed.adminUserId).mutation(api.campaigns.addManualRecipients, {
      campaignId: id, entries: [{ phone: "11 99999-0001" }],
    });
    await expect(
      asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id, consentAck: true })
    ).rejects.toThrow(/janela de 24h/);
  });

  test("destinatários manuais: normaliza, dedupe, inválidos e supressão", async () => {
    const t = setup();
    const seed = await seedCampaignOrg(t);
    const id = await createDraft(t, seed);
    await t.run((ctx) =>
      ctx.db.insert("optOuts", { organizationId: seed.organizationId, phone: "5511999990003", source: "manual", createdAt: Date.now() })
    );
    const res = await asUser(t, seed.adminUserId).mutation(api.campaigns.addManualRecipients, {
      campaignId: id,
      entries: [
        { phone: "(11) 99999-0001", name: "Ana" },
        { phone: "+55 11 99999-0001" },
        { phone: "abc" },
        { phone: "11 99999-0003" },
        { phone: "11 8888-0002" },
      ],
    });
    expect(res.added).toBe(2);
    expect(res.duplicates).toBe(1);
    expect(res.invalid).toHaveLength(1);
    expect(res.suppressed).toBe(1);
    const rows = await t.run((ctx) => ctx.db.query("campaignRecipients").withIndex("by_campaign", (q) => q.eq("campaignId", id)).collect());
    expect(rows.map((r) => r.phone).sort()).toEqual(["5511988880002", "5511999990001"]);
    const campaign = await t.run((ctx) => ctx.db.get(id));
    expect(campaign?.stats).toMatchObject({ total: 2, pending: 2 });
  });

  test("importação CSV: dry-run e commit em lotes", async () => {
    const t = setup();
    const seed = await seedCampaignOrg(t);
    const id = await createDraft(t, seed);
    const csv = "Nome;Telefone;Cidade\nAna;11 99999-0001;Fortaleza\nBia;(21) 98888-7777;Rio\nRuim;123;X\nAna de novo;5511999990001;Recife\n";
    const detect = await asUser(t, seed.adminUserId).action(api.campaigns.importRecipientsCsv, { campaignId: id, csvText: csv, dryRun: true });
    expect(detect.suggestedMapping).toMatchObject({ phone: "Telefone", name: "Nome" });
    const dry = await asUser(t, seed.adminUserId).action(api.campaigns.importRecipientsCsv, {
      campaignId: id, csvText: csv, dryRun: true,
      mapping: { phone: "Telefone", name: "Nome", varsColumns: ["Cidade"] },
    });
    expect(dry.valid).toBe(2);
    expect(dry.invalidCount).toBe(1);
    expect(dry.duplicates).toBe(1);
    const before = await t.run((ctx) => ctx.db.query("campaignRecipients").withIndex("by_campaign", (q) => q.eq("campaignId", id)).collect());
    expect(before).toHaveLength(0);
    const commit = await asUser(t, seed.adminUserId).action(api.campaigns.importRecipientsCsv, {
      campaignId: id, csvText: csv, dryRun: false,
      mapping: { phone: "Telefone", name: "Nome", varsColumns: ["Cidade"] },
    });
    expect(commit.added).toBe(2);
    const rows = await t.run((ctx) => ctx.db.query("campaignRecipients").withIndex("by_campaign", (q) => q.eq("campaignId", id)).collect());
    expect(rows.find((r) => r.phone === "5511999990001")?.vars).toMatchObject({ nome: "Ana", Cidade: "Fortaleza" });
    // importar não cria contato
    const contacts = await t.run((ctx) => ctx.db.query("contacts").withIndex("by_organization", (q) => q.eq("organizationId", seed.organizationId)).collect());
    expect(contacts).toHaveLength(0);
  });
});

describe("lançamento — aceites e validações", () => {
  async function draftWithRecipients(t: TestConvex<typeof schema>, seed: Awaited<ReturnType<typeof seedCampaignOrg>>, n = 3, content = twoVariants) {
    const id = await createDraft(t, seed, { content });
    await asUser(t, seed.adminUserId).mutation(api.campaigns.addManualRecipients, {
      campaignId: id, entries: phones(n).map((p) => ({ phone: p })),
    });
    return id;
  }

  test("manager (manage) não lança; admin (full) lança com os aceites", async () => {
    const t = setup();
    const seed = await seedCampaignOrg(t);
    const id = await draftWithRecipients(t, seed);
    await expect(
      asUser(t, seed.managerUserId).mutation(api.campaigns.launchCampaign, { campaignId: id, consentAck: true, bridgeRiskAck: true })
    ).rejects.toThrow(/Permissão insuficiente/);
    await expect(
      asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id, consentAck: false, bridgeRiskAck: true })
    ).rejects.toThrow(/consentimento/);
    await expect(
      asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id, consentAck: true })
    ).rejects.toThrow(/banimento/);
    const res = await asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id, consentAck: true, bridgeRiskAck: true });
    expect(res.status).toBe("running");
    const campaign = await t.run((ctx) => ctx.db.get(id));
    expect(campaign?.status).toBe("running");
    expect(campaign?.safety.consentAck?.acceptedBy).toBe(seed.adminId);
    expect(campaign?.safety.bridgeRiskAck?.acceptedBy).toBe(seed.adminId);
    expect(campaign?.safety.newNumberRiskAck).toBeUndefined(); // número de 10 dias
    expect(campaign?.schedulerFnId).toBeTruthy();
    expect(campaign?.tickToken).toBeTruthy();
    const logs = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", seed.organizationId)).collect());
    const launch = logs.find((l) => /Lançou a campanha/.test(l.description ?? ""));
    expect(launch?.severity).toBe("high");
    expect(launch?.changes?.after?.consentAck).toBe(true);
  });

  test("limites acima do modo seguro exigem ENTENDO e ficam travados no teto duro", async () => {
    const t = setup();
    const seed = await seedCampaignOrg(t);
    const id = await draftWithRecipients(t, seed);
    await asUser(t, seed.adminUserId).mutation(api.campaigns.updateCampaign, {
      campaignId: id,
      patch: { pacing: { minDelaySec: 20, maxDelaySec: 40, batchSize: 30, batchPauseMin: 20, maxPerHour: 40, maxPerDay: 999 }, safeMode: false },
    });
    await expect(
      asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id, consentAck: true, bridgeRiskAck: true })
    ).rejects.toThrow(/ENTENDO/);
    await expect(
      asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, {
        campaignId: id, consentAck: true, bridgeRiskAck: true, overrideAck: true, overrideWord: "ok",
      })
    ).rejects.toThrow(/ENTENDO/);
    await asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true, overrideAck: true, overrideWord: "entendo",
    });
    const campaign = await t.run((ctx) => ctx.db.get(id));
    expect(campaign?.pacing.maxPerDay).toBe(200); // teto duro do bridge
    expect(campaign?.safeMode).toBe(false);
    expect(campaign?.overrideAck?.acceptedBy).toBe(seed.adminId);
  });

  test("bridge com menos de 3 dias AVISA e lança com o aceite do risco de número novo", async () => {
    const t = setup();
    const seed = await seedCampaignOrg(t, { channelAgeDays: 1 });
    const defaults = await asUser(t, seed.adminUserId).query(api.campaigns.getSafeDefaults, {
      channelConfigId: seed.bridgeConfigId, now: Date.now(),
    });
    expect(defaults.warmupDay).toBe(2);
    expect(defaults.newNumberRisk).toMatch(/recém-conectado/);
    expect(defaults.safe.maxPerDay).toBe(20);

    const id = await draftWithRecipients(t, seed);
    await expect(
      asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id, consentAck: true, bridgeRiskAck: true })
    ).rejects.toThrow(/recém-conectado/);
    const res = await asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true, newNumberRiskAck: true,
    });
    expect(res.status).toBe("running");
    expect(res.warnings.some((w: string) => /recém-conectado/.test(w))).toBe(true);

    const campaign = await t.run((ctx) => ctx.db.get(id));
    expect(campaign?.safety.newNumberRiskAck?.acceptedBy).toBe(seed.adminId);
    // não trava, mas os limites do aquecimento continuam valendo
    expect(campaign?.safeMode).toBe(true);
    expect(campaign?.pacing.maxPerDay).toBe(20);
    const logs = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", seed.organizationId)).collect());
    const launch = logs.find((l) => /Lançou a campanha/.test(l.description ?? ""));
    expect(launch?.description).toMatch(/RECÉM-CONECTADO/);
    expect(launch?.changes?.after?.newNumberRiskAck).toBe(true);
    expect(launch?.changes?.after?.warmupDay).toBe(2);

    // duplicar não herda o aceite
    const copyId = await asUser(t, seed.adminUserId).mutation(api.campaigns.duplicateCampaign, { campaignId: id });
    const copy = await t.run((ctx) => ctx.db.get(copyId));
    expect(copy?.safety.newNumberRiskAck).toBeUndefined();
  });

  test("bridge: >30 destinatários exigem 2 variantes; link no 1º contato é recusado", async () => {
    const t = setup();
    const seed = await seedCampaignOrg(t);
    const single = { kind: "text" as const, variants: [{ text: "Oi, tudo bem?" }] };
    const id = await draftWithRecipients(t, seed, 31, single);
    await expect(
      asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id, consentAck: true, bridgeRiskAck: true })
    ).rejects.toThrow(/2 variantes/);
    const withLink = { kind: "text" as const, variants: [{ text: "Veja https://promo.com" }, { text: "Olha só: promo.com.br/x" }] };
    const id2 = await draftWithRecipients(t, seed, 3, withLink);
    await expect(
      asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id2, consentAck: true, bridgeRiskAck: true })
    ).rejects.toThrow(/link/i);
    await asUser(t, seed.adminUserId).mutation(api.campaigns.updateCampaign, { campaignId: id2, patch: { safety: { allowLinks: true } } });
    const res = await asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id2, consentAck: true, bridgeRiskAck: true });
    expect(res.status).toBe("running");
  });

  test("pausar/retomar/cancelar: scheduler e status; cancelar pula pendentes", async () => {
    const t = setup();
    const seed = await seedCampaignOrg(t);
    const id = await draftWithRecipients(t, seed);
    await asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id, consentAck: true, bridgeRiskAck: true });
    await asUser(t, seed.managerUserId).mutation(api.campaigns.pauseCampaign, { campaignId: id });
    let campaign = await t.run((ctx) => ctx.db.get(id));
    expect(campaign?.status).toBe("paused");
    expect(campaign?.schedulerFnId).toBeUndefined();
    expect(campaign?.pausedReason).toBe("Pausada manualmente");
    await asUser(t, seed.managerUserId).mutation(api.campaigns.resumeCampaign, { campaignId: id });
    campaign = await t.run((ctx) => ctx.db.get(id));
    expect(campaign?.status).toBe("running");
    expect(campaign?.schedulerFnId).toBeTruthy();
    await expect(asUser(t, seed.managerUserId).mutation(api.campaigns.cancelCampaign, { campaignId: id })).rejects.toThrow(/Permissão/);
    await asUser(t, seed.adminUserId).mutation(api.campaigns.cancelCampaign, { campaignId: id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    campaign = await t.run((ctx) => ctx.db.get(id));
    expect(campaign?.status).toBe("canceled");
    expect(campaign?.stats.skipped).toBe(3);
    expect(campaign?.stats.pending).toBe(0);
    const rows = await t.run((ctx) => ctx.db.query("campaignRecipients").withIndex("by_campaign", (q) => q.eq("campaignId", id)).collect());
    expect(rows.every((r) => r.status === "skipped" && r.skipReason === "canceled")).toBe(true);
  });

  test("segmento: snapshot no lançamento com dedupe e supressão", async () => {
    const t = setup();
    const seed = await seedCampaignOrg(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      const mk = async (phone: string, tags: string[] = []) => {
        const contactId = await ctx.db.insert("contacts", { organizationId: seed.organizationId, firstName: "C" + phone.slice(-2), phone, whatsappNumber: phone, tags: [], createdAt: now, updatedAt: now });
        await ctx.db.insert("leads", { organizationId: seed.organizationId, title: "L", contactId, boardId: seed.boardId, stageId: seed.stageId, value: 0, currency: "BRL", priority: "medium", temperature: "warm", tags, customFields: {}, conversationStatus: "new", lastActivityAt: now, createdAt: now, updatedAt: now });
      };
      await mk("5511999990010", ["vip"]);
      await mk("5511999990011", ["vip"]);
      await mk("5511999990011"); // duplicado (outro lead, mesmo telefone)
      await mk("5511999990012"); // sem a tag
      await mk("5511999990013", ["vip"]); // suprimido
      await ctx.db.insert("optOuts", { organizationId: seed.organizationId, phone: "5511999990013", source: "keyword", createdAt: now });
    });
    const preview = await asUser(t, seed.adminUserId).query(api.campaigns.previewAudience, {
      organizationId: seed.organizationId, filters: { tags: ["vip"] }, now: Date.now(),
    });
    expect(preview.count).toBe(2);
    expect(preview.excluded.opted_out).toBe(1);
    const id = await asUser(t, seed.adminUserId).mutation(api.campaigns.createCampaign, {
      organizationId: seed.organizationId, name: "VIP", channelConfigId: seed.bridgeConfigId,
      content: twoVariants, audience: { source: "segment", filters: { tags: ["vip"] } },
    });
    const res = await asUser(t, seed.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id, consentAck: true, bridgeRiskAck: true });
    expect(res.status).toBe("scheduled");
    // só o snapshot (o tick vai ser cancelado pelo pause antes de enviar)
    await t.mutation(internal.campaigns.internalSnapshotAudience, { campaignId: id });
    let campaign = await t.run((ctx) => ctx.db.get(id));
    expect(campaign?.status).toBe("running");
    expect(campaign?.stats.total).toBe(2);
    expect(campaign?.audience.total).toBe(2);
    expect(campaign?.audience.snapshotAt).toBeTruthy();
    await asUser(t, seed.adminUserId).mutation(api.campaigns.pauseCampaign, { campaignId: id });
    campaign = await t.run((ctx) => ctx.db.get(id));
    expect(campaign?.status).toBe("paused");
  });

  test("relatório e campanhas do lead", async () => {
    const t = setup();
    const seed = await seedCampaignOrg(t);
    const id = await draftWithRecipients(t, seed, 2);
    const leadId = await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", { organizationId: seed.organizationId, phone: "5511990000000", tags: [], createdAt: now, updatedAt: now });
      const leadId = await ctx.db.insert("leads", { organizationId: seed.organizationId, title: "L", contactId, boardId: seed.boardId, stageId: seed.stageId, value: 0, currency: "BRL", priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "new", lastActivityAt: now, createdAt: now, updatedAt: now });
      const rows = await ctx.db.query("campaignRecipients").withIndex("by_campaign", (q) => q.eq("campaignId", id)).collect();
      const r = rows.find((x) => x.phone === "5511990000000")!;
      await ctx.db.patch(r._id, { leadId, status: "replied", sentAt: now, repliedAt: now });
      const c = (await ctx.db.get(id))!;
      await ctx.db.patch(id, { stats: { ...c.stats, pending: 1, replied: 1 } });
      return leadId;
    });
    const report = await asUser(t, seed.agentUserId).query(api.campaigns.getCampaignReport, { campaignId: id });
    expect(report.stats.replied).toBe(1);
    expect(report.rates.replied).toBe(100);
    const forLead = await asUser(t, seed.agentUserId).query(api.campaigns.getCampaignsForLead, { leadId });
    expect(forLead).toHaveLength(1);
    expect(forLead[0]).toMatchObject({ campaignName: "Promo setembro", status: "replied" });
  });
});
