/// <reference types="vite/client" />
/**
 * `POST /api/v1/inbound/lead` v0.64: telefone normalizado, `sourceId` validado,
 * roteamento por tag, mensagem do formulário como NOTA interna e boas-vindas
 * automáticas pelo WhatsApp (uma por contato, opt-out respeitado, falha de
 * entrega → repasse humano). Org legada sem nada disso segue idêntica.
 *
 * Nenhuma mensagem real sai: `fetch` é dublado e o dispatch fica agendado
 * (verificado em `_scheduled_functions`).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { leadCapturedContext } from "./attendant";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
const NOW = Date.UTC(2026, 9, 2, 15, 0);
const API_KEY = "hnb_test_inbound_welcome_1";
const OTHER_KEY = "hnb_test_inbound_welcome_2";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 200, success: true, data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    )
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seed(t: TestConvex<typeof schema>) {
  const s = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Inbound",
      slug: "org-inbound",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const eventBoardId = await ctx.db.insert("boards", {
      organizationId, name: "Eventos", color: "#f59e0b", isDefault: false, order: 1, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("stages", {
      organizationId, boardId: eventBoardId, name: "Lead", color: "#f59e0b", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const eventStageId = await ctx.db.insert("stages", {
      organizationId, boardId: eventBoardId, name: "Inscrito", color: "#f59e0b", order: 1, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const sourceId = await ctx.db.insert("leadSources", {
      organizationId, name: "Site", type: "website", isActive: true, createdAt: now,
    });

    const otherOrgId = await ctx.db.insert("organizations", {
      name: "Outra", slug: "outra-inbound", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now,
    });
    const otherUserId = await ctx.db.insert("users", {});
    const otherAdminId = await ctx.db.insert("teamMembers", {
      organizationId: otherOrgId, userId: otherUserId, name: "Outro", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const otherBoardId = await ctx.db.insert("boards", {
      organizationId: otherOrgId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("stages", {
      organizationId: otherOrgId, boardId: otherBoardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const otherSourceId = await ctx.db.insert("leadSources", {
      organizationId: otherOrgId, name: "Site", type: "website", isActive: true, createdAt: now,
    });

    for (const [key, org, member] of [
      [API_KEY, organizationId, adminId],
      [OTHER_KEY, otherOrgId, otherAdminId],
    ] as const) {
      await ctx.db.insert("apiKeys", {
        organizationId: org, teamMemberId: member, name: key, keyHash: await sha256Hex(key), isActive: true, createdAt: now,
      });
    }
    return { organizationId, userId, adminId, boardId, stageId, eventBoardId, eventStageId, sourceId, otherOrgId, otherSourceId };
  });

  const channelConfigId = await t
    .withIdentity({ subject: `${s.userId}|s1` })
    .action(api.channelConfigs.createChannelConfig, {
      organizationId: s.organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "Número do site",
      bridgeBaseUrl: "https://wuzapi.example.com",
      bridgeInstanceId: "inst_inbound",
      bridgeToken: "fake-instance-token",
    });
  await t.run(async (ctx) => {
    await ctx.db.patch(channelConfigId, { bridgeSessionState: "connected", status: "active" });
  });
  return { ...s, channelConfigId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function configure(t: TestConvex<typeof schema>, s: Seed, opts: { routing?: boolean; welcome?: boolean } = {}) {
  return await t.mutation(internal.inboundLeadWelcome.internalSetInboundLeadSettings, {
    organizationId: s.organizationId,
    dryRun: false,
    ...(opts.routing !== false
      ? { routing: { rules: [{ tag: "evento:retiro", boardId: s.eventBoardId, stageId: s.eventStageId }] } }
      : {}),
    ...(opts.welcome !== false
      ? {
          welcome: {
            enabled: true,
            channelConfigId: s.channelConfigId,
            requireAnyTag: ["optin:whatsapp", "contato:inscricao"],
            messages: [
              { matchTag: "evento:retiro", text: "Oi {primeiroNome}! Vi sua inscrição no retiro ({tag:modalidade}). {xpto}" },
              { matchTag: "*", text: "Oi {primeiroNome}, recebemos seu contato!" },
            ],
          },
        }
      : {}),
  });
}

async function post(t: TestConvex<typeof schema>, body: Record<string, unknown>, key = API_KEY) {
  const res = await t.fetch("/api/v1/inbound/lead", {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}

async function messagesOfLead(t: TestConvex<typeof schema>, leadId: Id<"leads">) {
  return await t.run((ctx) => ctx.db.query("messages").withIndex("by_lead", (q) => q.eq("leadId", leadId)).collect());
}

async function dispatchesFor(t: TestConvex<typeof schema>, messageId: Id<"messages">) {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter(
      (j) => j.name.includes("internalDispatchMessage") && (j.args[0] as { messageId?: string })?.messageId === messageId
    );
  });
}

describe("POST /api/v1/inbound/lead — v0.64", () => {
  test("(a) telefone normalizado no contato; segundo lead com o mesmo número reusa o contato", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r1 = await post(t, { title: "Lead 1", contact: { firstName: "Ana", phone: "+55 (11) 98765-4321" } });
    expect(r1.status).toBe(201);
    const contact = await t.run((ctx) => ctx.db.get(r1.json.contactId as Id<"contacts">));
    expect(contact?.phone).toBe("5511987654321");
    expect(contact?.whatsappNumber).toBe("5511987654321");

    const r2 = await post(t, { title: "Lead 2", contact: { phone: "11 98765-4321" } });
    expect(r2.json.contactId).toBe(r1.json.contactId);
    expect(r2.json.leadId).not.toBe(r1.json.leadId);
    expect(r2.json.boardId).toBe(s.boardId);
  });

  test("(b) regra por tag manda o lead ao board/estágio configurado; sem regra → default", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await configure(t, s, { welcome: false });
    const routed = await post(t, { title: "Retiro", tags: ["evento:retiro"] });
    expect(routed.json.routedByTag).toBe("evento:retiro");
    const lead = await t.run((ctx) => ctx.db.get(routed.json.leadId as Id<"leads">));
    expect(lead?.boardId).toBe(s.eventBoardId);
    expect(lead?.stageId).toBe(s.eventStageId);

    const plain = await post(t, { title: "Outro", tags: ["newsletter"] });
    const lead2 = await t.run((ctx) => ctx.db.get(plain.json.leadId as Id<"leads">));
    expect(lead2?.boardId).toBe(s.boardId);
    expect(lead2?.stageId).toBe(s.stageId);
    expect(plain.json.routedByTag).toBeUndefined();

    // Board da regra arquivado depois → cai no default sem quebrar.
    await t.run((ctx) => ctx.db.patch(s.eventBoardId, { archivedAt: Date.now() }));
    const fallback = await post(t, { title: "Retiro 2", tags: ["evento:retiro"] });
    expect(fallback.status).toBe(201);
    expect(fallback.json.boardId).toBe(s.boardId);
  });

  test("(c) boas-vindas: outbound renderizado no canal bridge, tag contato:iniciado, formulário vira nota interna, dispatch agendado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await configure(t, s);
    const r = await post(t, {
      title: "Inscrição retiro",
      contact: { firstName: "Maria Clara", lastName: "Souza", phone: "(11) 98765-4321" },
      tags: ["evento:retiro", "optin:whatsapp", "modalidade:cartao-parcelado"],
      message: "Quero saber do parcelamento",
      sourceId: s.sourceId,
    });
    expect(r.status).toBe(201);
    expect(r.json.welcomeQueued).toBe(true);
    const leadId = r.json.leadId as Id<"leads">;

    const conversation = await t.run((ctx) => ctx.db.get(r.json.conversationId as Id<"conversations">));
    expect(conversation?.channel).toBe("whatsapp");
    expect(conversation?.channelConfigId).toBe(s.channelConfigId);

    const msgs = await messagesOfLead(t, leadId);
    const outbound = msgs.filter((m) => m.direction === "outbound");
    expect(outbound).toHaveLength(1);
    expect(outbound[0].content).toBe("Oi Maria! Vi sua inscrição no retiro (cartao-parcelado).");
    expect(outbound[0].metadata?.inboundWelcome).toEqual({ leadId });
    expect(outbound[0].metadata?.scheduled).toBe(true);
    expect(outbound[0].conversationId).toBe(conversation!._id);

    const notes = msgs.filter((m) => m.isInternal);
    expect(notes).toHaveLength(1);
    expect(notes[0].direction).toBe("internal");
    expect(notes[0].content).toBe("Formulário do site: Quero saber do parcelamento");
    // A nota não dispara nada; só a boas-vindas.
    expect(await dispatchesFor(t, notes[0]._id)).toHaveLength(0);
    expect(await dispatchesFor(t, outbound[0]._id)).toHaveLength(1);

    const lead = await t.run((ctx) => ctx.db.get(leadId));
    expect(lead?.tags).toContain("contato:iniciado");
    expect(lead?.sourceId).toBe(s.sourceId);
    expect(lead?.boardId).toBe(s.eventBoardId);
  });

  test("(d) sem telefone ou sem a tag exigida → nada sai, lead criado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await configure(t, s);
    const noPhone = await post(t, { title: "Sem fone", contact: { email: "a@exemplo.com.br" }, tags: ["optin:whatsapp"] });
    expect(noPhone.status).toBe(201);
    expect(noPhone.json.welcomeQueued).toBe(false);
    expect(await messagesOfLead(t, noPhone.json.leadId)).toHaveLength(0);

    const noTag = await post(t, {
      title: "Sem tag",
      contact: { phone: "11987650000" },
      tags: ["newsletter"],
      message: "olá",
    });
    expect(noTag.status).toBe(201);
    expect(noTag.json.welcomeQueued).toBe(false);
    const msgs = await messagesOfLead(t, noTag.json.leadId);
    // Sem boas-vindas e sem canal whatsapp: legado (webchat outbound) — org com
    // a boas-vindas LIGADA mas que não se aplica a este lead.
    expect(msgs.filter((m) => m.direction === "outbound" && m.metadata?.inboundWelcome)).toHaveLength(0);
  });

  test("(e) telefone em opt-out → pulado com nota", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await configure(t, s);
    await t.run((ctx) =>
      ctx.db.insert("optOuts", { organizationId: s.organizationId, phone: "5511987654321", source: "manual", createdAt: Date.now() })
    );
    const r = await post(t, { title: "Opt-out", contact: { phone: "+55 11 98765-4321" }, tags: ["optin:whatsapp"] });
    expect(r.json.welcomeQueued).toBe(false);
    expect(r.json.welcomeSkippedReason).toBe("opt_out");
    expect((await messagesOfLead(t, r.json.leadId)).filter((m) => m.direction === "outbound")).toHaveLength(0);
    const activities = await t.run((ctx) =>
      ctx.db.query("activities").withIndex("by_lead_and_created", (q) => q.eq("leadId", r.json.leadId)).collect()
    );
    expect(activities.some((a) => a.content?.includes("opt-out"))).toBe(true);
  });

  test("(f) segundo lead do mesmo contato não recebe segunda boas-vindas", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await configure(t, s);
    const r1 = await post(t, { title: "Primeiro", contact: { firstName: "Ana", phone: "11987654321" }, tags: ["optin:whatsapp"] });
    expect(r1.json.welcomeQueued).toBe(true);
    const r2 = await post(t, { title: "Segundo", contact: { firstName: "Ana", phone: "+5511987654321" }, tags: ["optin:whatsapp"] });
    expect(r2.json.contactId).toBe(r1.json.contactId);
    expect(r2.json.welcomeQueued).toBe(false);
    expect(r2.json.welcomeSkippedReason).toBe("ja_contatado");
    expect((await messagesOfLead(t, r2.json.leadId)).filter((m) => m.direction === "outbound")).toHaveLength(0);
  });

  test("(g) falha de entrega da boas-vindas → UM repasse humano", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await configure(t, s);
    const r = await post(t, { title: "Falha", contact: { phone: "11987654321" }, tags: ["optin:whatsapp"] });
    const welcome = (await messagesOfLead(t, r.json.leadId)).find((m) => m.metadata?.inboundWelcome)!;
    await t.mutation(internal.whatsapp.internalMarkDispatchFailed, { messageId: welcome._id, detail: "número inválido" });
    await t.mutation(internal.whatsapp.internalMarkDispatchFailed, { messageId: welcome._id, detail: "de novo" });
    const handoffs = await t.run((ctx) =>
      ctx.db.query("handoffs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect()
    );
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].reason).toBe("Boas-vindas automáticas não entregues");
    expect(handoffs[0].leadId).toBe(r.json.leadId);
    expect(handoffs[0].conversationId).toBe(welcome.conversationId);
  });

  test("(h) sourceId de outra org (ou lixo) → 400 sem criar nada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const cross = await post(t, { title: "X", contact: { phone: "11987654321" }, sourceId: s.otherSourceId });
    expect(cross.status).toBe(400);
    const junk = await post(t, { title: "X", sourceId: "nao-e-id" });
    expect(junk.status).toBe(400);
    const leads = await t.run((ctx) =>
      ctx.db.query("leads").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect()
    );
    expect(leads).toHaveLength(0);
    const contacts = await t.run((ctx) =>
      ctx.db.query("contacts").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect()
    );
    expect(contacts).toHaveLength(0);
  });

  test("(i) org legada sem boas-vindas: mensagem vira outbound no webchat como antes; canal whatsapp → nota", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const r = await post(t, { title: "Legado", contact: { email: "l@exemplo.com.br" }, message: "Olá do site" });
    expect(r.status).toBe(201);
    expect(r.json.welcomeQueued).toBe(false);
    const msgs = await messagesOfLead(t, r.json.leadId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe("outbound");
    expect(msgs[0].content).toBe("Olá do site");
    const conv = await t.run((ctx) => ctx.db.get(msgs[0].conversationId));
    expect(conv?.channel).toBe("webchat");

    const wa = await post(t, { title: "WA", contact: { phone: "11987654321" }, message: "Oi", channel: "whatsapp" });
    const waMsgs = await messagesOfLead(t, wa.json.leadId);
    expect(waMsgs).toHaveLength(1);
    expect(waMsgs[0].isInternal).toBe(true);
    expect(waMsgs[0].content).toBe("Formulário do site: Oi");
    expect(await dispatchesFor(t, waMsgs[0]._id)).toHaveLength(0);
  });

  test("autoAssign escolhe o ATENDENTE ativo, não o copiloto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const attendantId = await t.run(async (ctx) => {
      const now = Date.now();
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, { settings: { ...org.settings, aiConfig: { enabled: false, autoAssign: true, handoffThreshold: 0.5 } } });
      await ctx.db.insert("teamMembers", {
        organizationId: s.organizationId, name: "Copiloto", role: "ai", type: "ai", status: "active",
        agentProfile: { kind: "copilot", mode: "suggest" }, createdAt: now, updatedAt: now,
      });
      return await ctx.db.insert("teamMembers", {
        organizationId: s.organizationId, name: "Atendente", role: "ai", type: "ai", status: "active",
        agentProfile: { kind: "attendant", mode: "suggest" }, createdAt: now, updatedAt: now,
      });
    });
    const r = await post(t, { title: "Auto" });
    const lead = await t.run((ctx) => ctx.db.get(r.json.leadId as Id<"leads">));
    expect(lead?.assignedTo).toBe(attendantId);
  });

  test("op de configuração: dryRun não grava, ids de outra org são recusados, merge preserva settings", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const dry = await t.mutation(internal.inboundLeadWelcome.internalSetInboundLeadSettings, {
      organizationId: s.organizationId,
      routing: { rules: [{ tag: "x", boardId: s.eventBoardId, stageId: s.eventStageId }] },
    });
    expect(dry.dryRun).toBe(true);
    let org = await t.run((ctx) => ctx.db.get(s.organizationId));
    expect(org?.settings.inboundLeadRouting).toBeUndefined();

    await expect(
      t.mutation(internal.inboundLeadWelcome.internalSetInboundLeadSettings, {
        organizationId: s.organizationId,
        routing: { rules: [{ tag: "x", boardId: s.boardId, stageId: s.eventStageId }] },
        dryRun: false,
      })
    ).rejects.toThrow(/estagio_fora_do_board/);

    await configure(t, s);
    org = await t.run((ctx) => ctx.db.get(s.organizationId));
    expect(org?.settings.currency).toBe("BRL");
    expect(org?.settings.inboundLeadWelcome?.enabled).toBe(true);
    expect(org?.settings.inboundLeadRouting?.rules).toHaveLength(1);
  });
});

describe("envelope do atendente: camposCapturados + mensagemDoFormulario", () => {
  test("só chaves de captureFields, valores cortados, nota do formulário mais recente", () => {
    const out = leadCapturedContext(
      { modalidade: "pix", cidade: "Recife", segredo: "x", longo: "a".repeat(300), numero: 3 },
      ["modalidade", "longo", "numero", "inexistente"],
      [
        { isInternal: false, content: "oi" },
        { isInternal: true, content: "Formulário do site: Quero o retiro de outubro" },
        { isInternal: true, content: "Formulário do site: antiga" },
      ]
    );
    expect(out.camposCapturados).toEqual({ modalidade: "pix", longo: "a".repeat(200), numero: "3" });
    expect(out.mensagemDoFormulario).toBe("Quero o retiro de outubro");
  });
  test("nada capturado → objeto vazio (prompt não muda)", () => {
    expect(leadCapturedContext({}, undefined, [])).toEqual({});
  });
});
