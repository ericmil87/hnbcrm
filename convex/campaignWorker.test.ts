/// <reference types="vite/client" />
/**
 * Worker das campanhas — envio de ponta a ponta no bridge (checagem de número,
 * contato→lead→conversa→mensagem→dispatch), janela, tetos, kill switches,
 * mapa de erros da Meta (131049/131050) e ganchos de inbound (resposta,
 * opt-out por palavra-chave). Template Meta gera components no formato Graph.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 8, 18); // terça 15:00 BRT

beforeEach(() => {
  // shouldAdvanceTime: o dispatch do bridge DORME (setTimeout) dentro da action
  // enquanto o drain do convex-test aguarda a action — sem o relógio andar
  // sozinho seria deadlock. 20ms reais = 5s falsos.
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 5000 });
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
const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

async function seed(t: TestConvex<typeof schema>) {
  const base = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org W", slug: "org-w", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const stageId = await ctx.db.insert("stages", { organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    const stage2Id = await ctx.db.insert("stages", { organizationId, boardId, name: "Campanha", color: "#f59e0b", order: 1, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    return { organizationId, adminUserId, adminId, boardId, stageId, stage2Id };
  });
  const asAdmin = asUser(t, base.adminUserId);
  const bridgeConfigId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: base.organizationId, channel: "whatsapp", provider: "bridge", displayName: "Bridge",
    bridgeBaseUrl: "https://wuzapi.example.com", bridgeInstanceId: "inst_w", bridgeToken: "fake-token-1234",
  });
  const metaConfigId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: base.organizationId, channel: "whatsapp", displayName: "Meta",
    phoneNumberId: "111000111000111", wabaId: "222000222000222", verifyToken: "verify-token",
    appSecret: "fake-app-secret-abcd", accessToken: "EAAFakeAccessToken9876",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(bridgeConfigId, { bridgeConnectedAt: Date.now() - 30 * DAY, bridgeSessionState: "connected", status: "active" });
    await ctx.db.patch(metaConfigId, { status: "active" });
  });
  return { ...base, bridgeConfigId, metaConfigId };
}

type Seed = Awaited<ReturnType<typeof seed>>;

const variants = { kind: "text" as const, variants: [{ text: "Oi {{primeiro_nome|você}}, tudo bem?" }, { text: "Olá! Podemos conversar, {{nome|amigo}}?" }] };

async function launchedBridge(t: TestConvex<typeof schema>, s: Seed, entries: Array<{ phone: string; name?: string }>, opts: { checkNumbers?: boolean } = {}) {
  const id = await asUser(t, s.adminUserId).mutation(api.campaigns.createCampaign, {
    organizationId: s.organizationId, name: "Bridge camp", channelConfigId: s.bridgeConfigId,
    content: variants, audience: { source: "manual", targetStageId: s.stage2Id, targetBoardId: s.boardId, targetTags: ["campanha"] },
    safety: { checkNumbersFirst: opts.checkNumbers ?? true },
  });
  await asUser(t, s.adminUserId).mutation(api.campaigns.addManualRecipients, { campaignId: id, entries });
  await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id, consentAck: true, bridgeRiskAck: true });
  return id;
}

/** fetch fake do wuzapi: /user/check, /chat/presence, /chat/send/* */
function bridgeFetchMock(opts: { notOnWhatsapp?: string[] } = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/user/check")) {
      const users = (body.Phone as string[]).map((p) => ({ Query: p, IsInWhatsapp: !(opts.notOnWhatsapp ?? []).includes(p), JID: `${p}@s.whatsapp.net` }));
      return new Response(JSON.stringify({ code: 200, success: true, data: { Users: users } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/chat/send/")) {
      return new Response(JSON.stringify({ code: 200, success: true, data: { Id: `3EB0${calls.length}`, Details: "Sent" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ code: 200, success: true, data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { fn, calls };
}

async function recipients(t: TestConvex<typeof schema>, id: Id<"campaigns">) {
  return await t.run((ctx) => ctx.db.query("campaignRecipients").withIndex("by_campaign", (q) => q.eq("campaignId", id)).collect());
}

describe("envio de ponta a ponta (bridge)", () => {
  test("3 números novos: checagem, contato/lead/conversa, mensagem com metadata.campaign, dispatch, conclusão", { timeout: 60_000 }, async () => {
    const t = setup();
    const s = await seed(t);
    const mock = bridgeFetchMock({ notOnWhatsapp: ["5511999990003"] });
    vi.stubGlobal("fetch", mock.fn);
    const id = await launchedBridge(t, s, [
      { phone: "11 99999-0001", name: "Ana Lima" },
      { phone: "11 99999-0002" },
      { phone: "11 99999-0003" },
    ]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(campaign.status).toBe("completed");
    expect(campaign.stats).toMatchObject({ total: 3, sent: 2, skipped: 1, pending: 0, queued: 0 });

    const rows = await recipients(t, id);
    const skipped = rows.find((r) => r.phone === "5511999990003")!;
    expect(skipped.status).toBe("skipped");
    expect(skipped.skipReason).toBe("not_on_whatsapp");
    const ana = rows.find((r) => r.phone === "5511999990001")!;
    expect(ana.status).toBe("sent");
    expect(ana.contactId && ana.leadId && ana.conversationId && ana.messageId).toBeTruthy();
    expect(ana.isNewContact).toBe(true);

    const contact = (await t.run((ctx) => ctx.db.get(ana.contactId!)))!;
    expect(contact.firstName).toBe("Ana");
    expect(contact.lastName).toBe("Lima");
    const lead = (await t.run((ctx) => ctx.db.get(ana.leadId!)))!;
    expect(lead.stageId).toBe(s.stage2Id);
    expect(lead.tags).toContain("campanha");
    expect(lead.sourceId).toBeTruthy();
    const source = (await t.run((ctx) => ctx.db.get(lead.sourceId!)))!;
    expect(source.type).toBe("campaign");
    const conversation = (await t.run((ctx) => ctx.db.get(ana.conversationId!)))!;
    expect(conversation.channelConfigId).toBe(s.bridgeConfigId);
    const message = (await t.run((ctx) => ctx.db.get(ana.messageId!)))!;
    expect(message.metadata?.campaign).toEqual({ campaignId: id, recipientId: ana._id });
    expect(message.metadata?.scheduled).toBe(true);
    expect(message.deliveryStatus).toBe("sent");
    expect(message.externalId).toMatch(/^3EB0/);
    expect(["Oi Ana, tudo bem?", "Olá! Podemos conversar, Ana Lima?"]).toContain(message.content);
    // sem nome → fallback
    const two = rows.find((r) => r.phone === "5511999990002")!;
    const msg2 = (await t.run((ctx) => ctx.db.get(two.messageId!)))!;
    expect(["Oi você, tudo bem?", "Olá! Podemos conversar, amigo?"]).toContain(msg2.content);

    // chamadas: 3 checks + 2 envios (+ presence)
    expect(mock.calls.filter((c) => c.url.endsWith("/user/check"))).toHaveLength(3);
    expect(mock.calls.filter((c) => c.url.includes("/chat/send/text"))).toHaveLength(2);

    // contadores do canal com enforcement
    const pacing = await t.run((ctx) => ctx.db.query("channelPacing").withIndex("by_channel_config", (q) => q.eq("channelConfigId", s.bridgeConfigId)).first());
    expect(pacing?.campaignDaily?.sent).toBe(2);
    expect(pacing?.campaignDaily?.newContacts).toBe(2);

    // notificação de conclusão para o criador + activity no lead
    const notifs = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(notifs.some((n) => n.type === "campaign_completed" && n.campaignId === id)).toBe(true);
    const acts = await t.run((ctx) => ctx.db.query("activities").withIndex("by_lead", (q) => q.eq("leadId", ana.leadId!)).collect());
    expect(acts.some((a) => /campanha «Bridge camp» enviada/.test(a.content ?? ""))).toBe(true);
  });

  test("janela fechada reagenda para a próxima abertura sem enviar", async () => {
    vi.setSystemTime(Date.UTC(2026, 8, 12, 15)); // sábado 12:00 BRT
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", bridgeFetchMock().fn);
    const id = await launchedBridge(t, s, [{ phone: "11 99999-0001" }]);
    const launched = (await t.run((ctx) => ctx.db.get(id)))!;
    await t.mutation(internal.campaignWorker.tick, { campaignId: id, tickToken: launched.tickToken! });
    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(campaign.status).toBe("running");
    expect(campaign.stats.pending).toBe(1);
    // segunda 09:00 BRT = 12:00Z
    expect(campaign.nextTickAt).toBe(Date.UTC(2026, 8, 14, 12));
  });

  test("teto diário do canal atingido → reagenda para o próximo dia UTC", async () => {
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", bridgeFetchMock().fn);
    await t.run((ctx) =>
      ctx.db.insert("channelPacing", {
        organizationId: s.organizationId, channelConfigId: s.bridgeConfigId, nextDispatchAt: 0,
        campaignDaily: { day: "2026-09-08", sent: 150, newContacts: 0 },
      })
    );
    const id = await launchedBridge(t, s, [{ phone: "11 99999-0001" }]);
    const launched = (await t.run((ctx) => ctx.db.get(id)))!;
    await t.mutation(internal.campaignWorker.tick, { campaignId: id, tickToken: launched.tickToken! });
    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(campaign.stats.pending).toBe(1);
    expect(campaign.nextTickAt).toBe(Date.UTC(2026, 8, 9));
    expect(campaign.timeline?.some((e) => e.kind === "caps")).toBe(true);
  });

  test("kill switch (falhas consecutivas) pausa, notifica e audita", async () => {
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", bridgeFetchMock().fn);
    const id = await launchedBridge(t, s, [{ phone: "11 99999-0001" }, { phone: "11 99999-0002" }]);
    const campaign0 = (await t.run((ctx) => ctx.db.get(id)))!;
    await t.run((ctx) => ctx.db.patch(id, { stats: { ...campaign0.stats, consecutiveFailures: 5 } }));
    await t.mutation(internal.campaignWorker.tick, { campaignId: id, tickToken: campaign0.tickToken! });
    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(campaign.status).toBe("paused");
    expect(campaign.pausedReason).toMatch(/consecutivas/);
    const notifs = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(notifs.some((n) => n.type === "campaign_paused" && n.memberId === s.adminId)).toBe(true);
    const logs = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(logs.some((l) => l.severity === "high" && /pausada automaticamente/.test(l.description ?? ""))).toBe(true);
    // tick zumbi (token antigo) não faz nada depois do resume
    await asUser(t, s.adminUserId).mutation(api.campaigns.resumeCampaign, { campaignId: id });
    await t.mutation(internal.campaignWorker.tick, { campaignId: id, tickToken: campaign0.tickToken! });
    const after = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(after.status).toBe("running");
    expect(after.stats.queued).toBe(0);
  });

  test("sessão do bridge banida pausa campanhas do canal", async () => {
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", bridgeFetchMock().fn);
    const id = await launchedBridge(t, s, [{ phone: "11 99999-0001" }]);
    await t.mutation(internal.channelConfigs.internalRecordHealthCheck, {
      configId: s.bridgeConfigId, ok: false, healthDetail: "banned", bridgeSessionState: "banned",
    });
    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(campaign.status).toBe("paused");
    expect(campaign.pausedReason).toMatch(/BANIDO/);
  });
});

describe("mapa de erros da Meta e ganchos inbound", () => {
  async function queuedRecipient(t: TestConvex<typeof schema>, s: Seed, status: "queued" | "sent" = "queued") {
    const id = await launchedBridge(t, s, [{ phone: "11 99999-0001" }], { checkNumbers: false });
    await asUser(t, s.adminUserId).mutation(api.campaigns.pauseCampaign, { campaignId: id });
    const r = (await recipients(t, id))[0];
    const { messageId, conversationId, leadId } = await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", { organizationId: s.organizationId, phone: r.phone, whatsappNumber: r.phone, tags: [], createdAt: now, updatedAt: now });
      const leadId = await ctx.db.insert("leads", { organizationId: s.organizationId, title: "L", contactId, boardId: s.boardId, stageId: s.stageId, value: 0, currency: "BRL", priority: "medium", temperature: "cold", tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now });
      const conversationId = await ctx.db.insert("conversations", { organizationId: s.organizationId, leadId, channel: "whatsapp", channelConfigId: s.bridgeConfigId, status: "active", messageCount: 1, createdAt: now, updatedAt: now });
      const messageId = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId, leadId, direction: "outbound", senderId: s.adminId, senderType: "human",
        content: "Oi", contentType: "text", isInternal: false, metadata: { campaign: { campaignId: id, recipientId: r._id }, scheduled: true },
        ...(status === "sent" ? { externalId: "wamid.X", deliveryStatus: "sent" as const } : {}), createdAt: now,
      });
      await ctx.db.patch(r._id, { status, messageId, contactId, leadId, conversationId, ...(status === "sent" ? { sentAt: now } : {}) });
      const c = (await ctx.db.get(id))!;
      await ctx.db.patch(id, { stats: { ...c.stats, pending: 0, [status]: 1 } });
      return { messageId, conversationId, leadId };
    });
    return { id, recipientId: r._id, messageId, conversationId, leadId, phone: r.phone };
  }

  test("131049 → volta à fila com +24h; 2ª vez falha de vez", async () => {
    const t = setup();
    const s = await seed(t);
    const q = await queuedRecipient(t, s);
    await t.mutation(internal.whatsapp.internalMarkDispatchFailed, { messageId: q.messageId, errorCode: 131049, detail: "per-user cap" });
    let r = (await t.run((ctx) => ctx.db.get(q.recipientId)))!;
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(1);
    expect(r.scheduledFor).toBe(Date.now() + DAY);
    expect(r.messageId).toBeUndefined();
    let c = (await t.run((ctx) => ctx.db.get(q.id)))!;
    expect(c.stats).toMatchObject({ pending: 1, queued: 0, failed: 0 });
    // segunda tentativa esgota
    await t.run((ctx) => ctx.db.patch(q.recipientId, { status: "queued", messageId: q.messageId }));
    await t.run(async (ctx) => { const cc = (await ctx.db.get(q.id))!; await ctx.db.patch(q.id, { stats: { ...cc.stats, pending: 0, queued: 1 } }); });
    await t.mutation(internal.whatsapp.internalMarkDispatchFailed, { messageId: q.messageId, errorCode: 131049, detail: "per-user cap" });
    r = (await t.run((ctx) => ctx.db.get(q.recipientId)))!;
    expect(r.status).toBe("failed");
    c = (await t.run((ctx) => ctx.db.get(q.id)))!;
    expect(c.stats.failed).toBe(1);
  });

  test("131050 → opted_out + lista de supressão (meta_131050)", async () => {
    const t = setup();
    const s = await seed(t);
    const q = await queuedRecipient(t, s);
    await t.mutation(internal.whatsapp.internalMarkDispatchFailed, { messageId: q.messageId, errorCode: 131050, detail: "opted out" });
    const r = (await t.run((ctx) => ctx.db.get(q.recipientId)))!;
    expect(r.status).toBe("opted_out");
    const optOut = await t.run((ctx) => ctx.db.query("optOuts").withIndex("by_organization_and_phone", (x) => x.eq("organizationId", s.organizationId).eq("phone", q.phone)).first());
    expect(optOut?.source).toBe("meta_131050");
    const c = (await t.run((ctx) => ctx.db.get(q.id)))!;
    expect(c.stats.optedOut).toBe(1);
  });

  test("131026 → failed sem retry; 131048 congela o canal e pausa; webhook de status delivered/read", async () => {
    const t = setup();
    const s = await seed(t);
    const q = await queuedRecipient(t, s, "sent");
    await t.mutation(internal.conversations.internalUpdateDeliveryStatus, { organizationId: s.organizationId, externalId: "wamid.X", status: "delivered" });
    let r = (await t.run((ctx) => ctx.db.get(q.recipientId)))!;
    expect(r.status).toBe("delivered");
    expect(r.deliveredAt).toBeTruthy();
    await t.mutation(internal.conversations.internalUpdateDeliveryStatus, { organizationId: s.organizationId, externalId: "wamid.X", status: "read" });
    r = (await t.run((ctx) => ctx.db.get(q.recipientId)))!;
    expect(r.status).toBe("read");
    // regressão ignorada
    await t.mutation(internal.conversations.internalUpdateDeliveryStatus, { organizationId: s.organizationId, externalId: "wamid.X", status: "delivered" });
    r = (await t.run((ctx) => ctx.db.get(q.recipientId)))!;
    expect(r.status).toBe("read");

    const q2 = await queuedRecipient(t, s);
    await asUser(t, s.adminUserId).mutation(api.campaigns.resumeCampaign, { campaignId: q2.id });
    await t.mutation(internal.whatsapp.internalMarkDispatchFailed, { messageId: q2.messageId, errorCode: 131048, detail: "spam flag" });
    const r2 = (await t.run((ctx) => ctx.db.get(q2.recipientId)))!;
    expect(r2.status).toBe("failed");
    const c2 = (await t.run((ctx) => ctx.db.get(q2.id)))!;
    expect(c2.status).toBe("paused");
    expect(c2.pausedReason).toMatch(/131048/);
    const pacing = await t.run((ctx) => ctx.db.query("channelPacing").withIndex("by_channel_config", (x) => x.eq("channelConfigId", s.bridgeConfigId)).first());
    expect(pacing?.campaignFrozenUntil).toBe(Date.now() + 30 * 60 * 1000);
  });

  test("inbound: resposta vira replied (+webhook), palavra-chave SAIR vira opt-out", async () => {
    const t = setup();
    const s = await seed(t);
    const q = await queuedRecipient(t, s, "sent");
    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId: s.organizationId, leadId: q.leadId, channel: "whatsapp", channelConfigId: s.bridgeConfigId,
      content: "Oi, quero saber mais", externalId: "in-1",
    });
    let r = (await t.run((ctx) => ctx.db.get(q.recipientId)))!;
    expect(r.status).toBe("replied");
    expect(r.repliedAt).toBeTruthy();
    let c = (await t.run((ctx) => ctx.db.get(q.id)))!;
    expect(c.stats.replied).toBe(1);
    const acts = await t.run((ctx) => ctx.db.query("activities").withIndex("by_lead", (x) => x.eq("leadId", q.leadId)).collect());
    expect(acts.some((a) => /Respondeu à campanha/.test(a.content ?? ""))).toBe(true);

    // opt-out por palavra-chave (com acento/caixa)
    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId: s.organizationId, leadId: q.leadId, channel: "whatsapp", channelConfigId: s.bridgeConfigId,
      content: "  Sair! ", externalId: "in-2",
    });
    const optOut = await t.run((ctx) => ctx.db.query("optOuts").withIndex("by_organization_and_phone", (x) => x.eq("organizationId", s.organizationId).eq("phone", q.phone)).first());
    expect(optOut?.source).toBe("keyword");
    r = (await t.run((ctx) => ctx.db.get(q.recipientId)))!;
    expect(r.status).toBe("opted_out");
    c = (await t.run((ctx) => ctx.db.get(q.id)))!;
    expect(c.stats).toMatchObject({ replied: 0, optedOut: 1 });
  });

  test("palavras-chave da org sobrepõem o default; texto normal não descadastra", async () => {
    const t = setup();
    const s = await seed(t);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, { settings: { ...org.settings, optOutKeywords: ["REMOVER"] } });
    });
    const q = await queuedRecipient(t, s, "sent");
    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId: s.organizationId, leadId: q.leadId, channel: "whatsapp", content: "sair", externalId: "in-3",
    });
    let optOut = await t.run((ctx) => ctx.db.query("optOuts").withIndex("by_organization", (x) => x.eq("organizationId", s.organizationId)).first());
    expect(optOut).toBeNull();
    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId: s.organizationId, leadId: q.leadId, channel: "whatsapp", content: "remover", externalId: "in-4",
    });
    optOut = await t.run((ctx) => ctx.db.query("optOuts").withIndex("by_organization", (x) => x.eq("organizationId", s.organizationId)).first());
    expect(optOut?.source).toBe("keyword");
  });
});

describe("Meta template", () => {
  test("gera metadata.template.components no formato Graph e despacha como template", { timeout: 60_000 }, async () => {
    const t = setup();
    const s = await seed(t);
    const graphCalls: Array<Record<string, any>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        graphCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ messages: [{ id: "wamid.TPL1" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    const id = await asUser(t, s.adminUserId).mutation(api.campaigns.createCampaign, {
      organizationId: s.organizationId, name: "Template", channelConfigId: s.metaConfigId,
      content: {
        kind: "template", variants: [],
        template: {
          name: "promo_setembro", language: "pt_BR", category: "MARKETING", bodyText: "Oi {{1}}, desconto de {{2}}!",
          bodyParams: [{ source: "field", value: "primeiro_nome" }, { source: "const", value: "10%" }],
        },
      },
      audience: { source: "manual" },
      pacing: { minDelaySec: 1, maxDelaySec: 1, batchSize: 0, batchPauseMin: 0, maxPerHour: 100, maxPerDay: 200 },
    });
    await asUser(t, s.adminUserId).mutation(api.campaigns.addManualRecipients, { campaignId: id, entries: [{ phone: "11 99999-0009", name: "Carla Souza" }] });
    const res = await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, { campaignId: id, consentAck: true, tierAtLaunch: "TIER_250" });
    expect(res.estimatedCostUsd).toBeCloseTo(0.0625);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(campaign.status).toBe("completed");
    expect(campaign.tierAtLaunch).toBe("TIER_250");
    const r = (await recipients(t, id))[0];
    expect(r.status).toBe("sent");
    const message = (await t.run((ctx) => ctx.db.get(r.messageId!)))!;
    expect(message.content).toBe("Oi Carla, desconto de 10%!");
    expect(message.metadata?.template).toEqual({
      name: "promo_setembro", languageCode: "pt_BR",
      components: [{ type: "body", parameters: [{ type: "text", text: "Carla" }, { type: "text", text: "10%" }] }],
    });
    const send = graphCalls.find((c) => String(c.url).endsWith("/messages") && c.body?.type === "template");
    expect(send?.body.template).toEqual({
      name: "promo_setembro", language: { code: "pt_BR" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Carla" }, { type: "text", text: "10%" }] }],
    });
    expect(send?.body.to).toBe("5511999990009");
  });
});
