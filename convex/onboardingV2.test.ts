/// <reference types="vite/client" />
/**
 * Configuração inicial v2 (backend): perfil do negócio, funil re-executável
 * seguro, adiar o wizard, status e checklist derivados de dados reais.
 */
import { expect, test, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type T = TestConvex<typeof schema>;
const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

async function seed(t: T, opts: { onboardingMeta?: Record<string, unknown> } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", { email: "admin@teste.com" });
    const agentUserId = await ctx.db.insert("users", { email: "agente@teste.com" });
    const managerUserId = await ctx.db.insert("users", { email: "gerente@teste.com" });
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Onboarding",
      slug: "org-onb",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      ...(opts.onboardingMeta ? { onboardingMeta: opts.onboardingMeta } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const member = (userId: Id<"users">, name: string, role: "admin" | "manager" | "agent") =>
      ctx.db.insert("teamMembers", {
        organizationId, userId, name, role, type: "human", status: "active",
        createdAt: now, updatedAt: now,
      });
    const adminId = await member(adminUserId, "Admin", "admin");
    await member(agentUserId, "Agente", "agent");
    await member(managerUserId, "Gerente", "manager");

    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Pipeline de Vendas", color: "#3B82F6", isDefault: true,
      order: 0, createdAt: now, updatedAt: now,
    });
    const stageIds: Id<"stages">[] = [];
    for (let i = 0; i < 5; i++) {
      stageIds.push(
        await ctx.db.insert("stages", {
          organizationId, boardId, name: `Etapa ${i}`, color: "#111111", order: i,
          isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
        }),
      );
    }
    const aiId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: {
        kind: "attendant", mode: "suggest",
        pipelineConfig: { boardId, initialStageId: stageIds[4], qualifiedStageId: stageIds[3] },
      },
      createdAt: now, updatedAt: now,
    });
    return { organizationId, adminUserId, agentUserId, managerUserId, adminId, boardId, stageIds, aiId };
  });
}

const FUNNEL = {
  boardName: "Funil Imobiliária",
  boardColor: "#10B981",
  stages: [
    { name: "Novo contato", color: "#3B82F6" },
    { name: "Visita", color: "#F59E0B" },
    { name: "Fechado", color: "#22C55E", isClosedWon: true },
    { name: "Perdido", color: "#EF4444", isClosedLost: true },
  ],
};

async function addLead(t: T, s: Awaited<ReturnType<typeof seed>>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("leads", {
      organizationId: s.organizationId, title: "Lead", boardId: s.boardId, stageId: s.stageIds[0],
      value: 0, currency: "BRL", priority: "low", temperature: "cold", tags: [], customFields: {},
      conversationStatus: "new", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
  });
}

const orgBoards = (t: T, organizationId: Id<"organizations">) =>
  t.run(async (ctx) =>
    ctx.db.query("boards").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect(),
  );

test("saveBusinessProfile exige settings:manage", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const args = { organizationId: s.organizationId, segment: "saas", offer: "Software" };
  await expect(as(t, s.agentUserId).mutation(api.onboarding.saveBusinessProfile, args)).rejects.toThrow(/Permissão insuficiente/);
  await expect(as(t, s.managerUserId).mutation(api.onboarding.saveBusinessProfile, args)).rejects.toThrow(/Permissão insuficiente/);
  await as(t, s.adminUserId).mutation(api.onboarding.saveBusinessProfile, args);
  const org = await t.run((ctx) => ctx.db.get(s.organizationId));
  expect(org?.onboardingMeta?.industry).toBe("saas");
  expect(org?.onboardingMeta?.steps?.business?.status).toBe("done");
  // Nunca liga a IA nem grava aceite.
  expect(org?.settings.aiConfig).toBeUndefined();
});

test("saveBusinessProfile corta limites", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await as(t, s.adminUserId).mutation(api.onboarding.saveBusinessProfile, {
    organizationId: s.organizationId,
    segment: "financeiro",
    displayName: `  ${"a".repeat(200)}  `,
    offer: "o".repeat(900),
    audience: "q".repeat(900),
    region: "   ",
    tone: "amigavel",
    aiAssisted: true,
  });
  const meta = (await t.run((ctx) => ctx.db.get(s.organizationId)))?.onboardingMeta;
  expect(meta?.industry).toBe("servicos");
  expect(meta?.business?.displayName).toHaveLength(80);
  expect(meta?.business?.offer).toHaveLength(600);
  expect(meta?.business?.audience).toHaveLength(400);
  expect(meta?.business?.region).toBeUndefined();
  expect(meta?.business?.tone).toBe("amigavel");
  expect(meta?.aiAssisted).toBe(true);
  await expect(
    as(t, s.adminUserId).mutation(api.onboarding.saveBusinessProfile, { organizationId: s.organizationId, segment: "xyz" }),
  ).rejects.toThrow(/Segmento/);
});

test("applyFunnelTemplate substitui funil padrão vazio mantendo boardId", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const r = await as(t, s.adminUserId).mutation(api.onboarding.applyFunnelTemplate, { organizationId: s.organizationId, ...FUNNEL });
  expect(r).toEqual({ boardId: s.boardId, mode: "replaced" });
  const { board, stages, meta } = await t.run(async (ctx) => ({
    board: await ctx.db.get(s.boardId),
    stages: await ctx.db.query("stages").withIndex("by_board_and_order", (q) => q.eq("boardId", s.boardId)).collect(),
    meta: (await ctx.db.get(s.organizationId))?.onboardingMeta,
  }));
  expect(board?.name).toBe("Funil Imobiliária");
  expect(board?.isDefault).toBe(true);
  expect(stages.map((x) => x.name)).toEqual(["Novo contato", "Visita", "Fechado", "Perdido"]);
  expect(stages[2].isClosedWon).toBe(true);
  expect(meta?.steps?.funnel?.status).toBe("done");
});

test("applyFunnelTemplate com leads cria funil novo", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await addLead(t, s);
  const r = await as(t, s.adminUserId).mutation(api.onboarding.applyFunnelTemplate, { organizationId: s.organizationId, ...FUNNEL });
  expect(r.mode).toBe("created");
  expect(r.boardId).not.toBe(s.boardId);
  const boards = await orgBoards(t, s.organizationId);
  expect(boards).toHaveLength(2);
  expect(boards.find((b) => b._id === r.boardId)?.isDefault).toBe(false);
  const old = await t.run(async (ctx) => ({
    board: await ctx.db.get(s.boardId),
    stages: await ctx.db.query("stages").withIndex("by_board", (q) => q.eq("boardId", s.boardId)).collect(),
  }));
  expect(old.board?.name).toBe("Pipeline de Vendas");
  expect(old.stages).toHaveLength(5);
});

test("applyFunnelTemplate é idempotente", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const call = () => as(t, s.adminUserId).mutation(api.onboarding.applyFunnelTemplate, { organizationId: s.organizationId, ...FUNNEL });
  const a = await call();
  const idsOf = () =>
    t.run(async (ctx) =>
      (await ctx.db.query("stages").withIndex("by_board", (q) => q.eq("boardId", s.boardId)).collect()).map((x) => x._id).sort(),
    );
  const before = await idsOf();
  const b = await call();
  expect(b).toEqual(a);
  expect(await idsOf()).toEqual(before);
  expect(await orgBoards(t, s.organizationId)).toHaveLength(1);

  // Com leads: a segunda chamada devolve o board criado antes, sem duplicar.
  const t2 = convexTest(schema, modules);
  const s2 = await seed(t2);
  await addLead(t2, s2);
  const call2 = () => as(t2, s2.adminUserId).mutation(api.onboarding.applyFunnelTemplate, { organizationId: s2.organizationId, ...FUNNEL });
  const c = await call2();
  const d = await call2();
  expect(d).toEqual(c);
  expect(await orgBoards(t2, s2.organizationId)).toHaveLength(2);
});

test("applyFunnelTemplate não toca leadSources nem outros boards", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const other = await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("leadSources", { organizationId: s.organizationId, name: "Site", type: "website", isActive: true, createdAt: now });
    const boardId = await ctx.db.insert("boards", {
      organizationId: s.organizationId, name: "Outro", color: "#000000", isDefault: false, order: 1, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("stages", {
      organizationId: s.organizationId, boardId, name: "X", color: "#000000", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    return boardId;
  });
  await as(t, s.adminUserId).mutation(api.onboarding.applyFunnelTemplate, { organizationId: s.organizationId, ...FUNNEL });
  const after = await t.run(async (ctx) => ({
    sources: await ctx.db.query("leadSources").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect(),
    otherBoard: await ctx.db.get(other),
    otherStages: await ctx.db.query("stages").withIndex("by_board", (q) => q.eq("boardId", other)).collect(),
  }));
  expect(after.sources.map((x) => x.name)).toEqual(["Site"]);
  expect(after.otherBoard?.name).toBe("Outro");
  expect(after.otherStages).toHaveLength(1);
});

test("applyFunnelTemplate re-aponta estágio inicial do atendente", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await as(t, s.adminUserId).mutation(api.onboarding.applyFunnelTemplate, { organizationId: s.organizationId, ...FUNNEL });
  const { ai, stages } = await t.run(async (ctx) => ({
    ai: await ctx.db.get(s.aiId),
    stages: await ctx.db.query("stages").withIndex("by_board_and_order", (q) => q.eq("boardId", s.boardId)).collect(),
  }));
  expect(ai?.agentProfile?.pipelineConfig?.initialStageId).toBe(stages[0]._id);
  expect(ai?.agentProfile?.pipelineConfig?.qualifiedStageId).toBeUndefined();
  expect(ai?.agentProfile?.pipelineConfig?.boardId).toBe(s.boardId);
  const audit = await t.run((ctx) =>
    ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect(),
  );
  expect(audit.some((a) => a.entityId === s.aiId)).toBe(true);
});

test("applyFunnelTemplate faz upsert de campos por key", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const fields = [
    { key: "tipo_imovel", name: "Tipo de imóvel", type: "select" as const, options: ["Casa", "Apartamento"] },
    { key: "orcamento", name: "Orçamento", type: "text" as const },
  ];
  const run = (extra: typeof fields) =>
    as(t, s.adminUserId).mutation(api.onboarding.applyFunnelTemplate, { organizationId: s.organizationId, ...FUNNEL, fields: extra });
  await run(fields);
  await run([{ ...fields[0], name: "Tipo" }, fields[1]]);
  const defs = await t.run((ctx) =>
    ctx.db.query("fieldDefinitions").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect(),
  );
  expect(defs).toHaveLength(2);
  expect(defs.find((d) => d.key === "tipo_imovel")?.name).toBe("Tipo");
});

test("applyFunnelTemplate valida o payload", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const bad = (over: Record<string, unknown>) =>
    as(t, s.adminUserId).mutation(api.onboarding.applyFunnelTemplate, { organizationId: s.organizationId, ...FUNNEL, ...over });
  await expect(bad({ stages: [FUNNEL.stages[0]] })).rejects.toThrow(/2 a 12/);
  await expect(bad({ boardName: "  " })).rejects.toThrow(/nome do funil/);
  await expect(
    bad({ stages: [...FUNNEL.stages, { name: "Outro ganho", color: "#000", isClosedWon: true }] }),
  ).rejects.toThrow(/no máximo uma/);
  await expect(as(t, s.agentUserId).mutation(api.onboarding.applyFunnelTemplate, { organizationId: s.organizationId, ...FUNNEL })).rejects.toThrow(/Permissão insuficiente/);
});

test("applyFunnelTemplate em org legada cria funil novo", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t, { onboardingMeta: { wizardCompletedAt: 1 } });
  const r = await as(t, s.adminUserId).mutation(api.onboarding.applyFunnelTemplate, { organizationId: s.organizationId, ...FUNNEL });
  expect(r.mode).toBe("created");
  expect(await orgBoards(t, s.organizationId)).toHaveLength(2);
});

test("deferWizard esconde o wizard", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const prog = () => as(t, s.adminUserId).query(api.onboarding.getOnboardingProgress, { organizationId: s.organizationId });
  expect((await prog()).shouldShowWizard).toBe(true);
  await as(t, s.adminUserId).mutation(api.onboarding.deferWizard, { organizationId: s.organizationId });
  expect((await prog()).shouldShowWizard).toBe(false);
  const st = await as(t, s.adminUserId).query(api.onboarding.getOnboardingStatus, { organizationId: s.organizationId });
  expect(st.wizardDeferred).toBe(true);
  await as(t, s.adminUserId).mutation(api.onboarding.reopenWizard, { organizationId: s.organizationId });
  expect((await prog()).shouldShowWizard).toBe(true);
});

test("org legada com wizardCompletedAt não vê wizard", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t, { onboardingMeta: { industry: "financeiro", wizardCompletedAt: 1 } });
  const p = await as(t, s.adminUserId).query(api.onboarding.getOnboardingProgress, { organizationId: s.organizationId });
  expect(p.shouldShowWizard).toBe(false);
  const st = await as(t, s.adminUserId).query(api.onboarding.getOnboardingStatus, { organizationId: s.organizationId });
  expect(st.shouldShowWizard).toBe(false);
  expect(st.legacy).toBe(true);
  expect(st.steps?.funnel).toBe("done");
  expect(st.steps?.business).toBe("done");
  expect(st.steps?.test).toBe("done");
});

test("completeWizard v2 grava wizardVersion e preserva o perfil", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const admin = as(t, s.adminUserId);
  await admin.mutation(api.onboarding.saveBusinessProfile, { organizationId: s.organizationId, segment: "saas", offer: "App" });
  await admin.mutation(api.onboarding.initOnboardingProgress, { organizationId: s.organizationId });
  await admin.mutation(api.onboarding.completeWizard, { organizationId: s.organizationId, version: 2 });
  const meta = (await t.run((ctx) => ctx.db.get(s.organizationId)))?.onboardingMeta;
  expect(meta?.wizardVersion).toBe(2);
  expect(meta?.industry).toBe("saas");
  expect(meta?.business?.offer).toBe("App");
  expect(meta?.wizardCompletedAt).toBeTypeOf("number");
});

test("checklist: WhatsApp conectado marca o item", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const item = async (id: string) =>
    (await as(t, s.adminUserId).query(api.onboarding.getOnboardingChecklist, { organizationId: s.organizationId }))
      .items.find((i: { id: string }) => i.id === id);
  expect((await item("whatsapp"))?.completed).toBe(false);
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("channelConfigs", {
      organizationId: s.organizationId, channel: "whatsapp", provider: "bridge", displayName: "Zap",
      bridgeSessionState: "connected", status: "active", createdAt: now, updatedAt: now,
    });
  });
  expect((await item("whatsapp"))?.completed).toBe(true);
  const c = await as(t, s.adminUserId).query(api.onboarding.getOnboardingChecklist, { organizationId: s.organizationId });
  expect(c.totalCount).toBe(c.items.length);
  // Campos antigos que o front v1 lê continuam.
  expect(Object.keys(c)).toEqual(expect.arrayContaining(["items", "completedCount", "totalCount", "dismissed", "celebratedMilestones"]));
  expect(c.items.some((i: { id: string }) => i.id === "webhookOrApiKey" || i.id === "customFieldsExplored")).toBe(false);
});

test("checklist: item de aceite bridge só aparece com canal bridge", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const ids = async () =>
    (await as(t, s.adminUserId).query(api.onboarding.getOnboardingChecklist, { organizationId: s.organizationId }))
      .items.map((i: { id: string }) => i.id);
  expect(await ids()).not.toContain("bridgeAiAck");
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("channelConfigs", {
      organizationId: s.organizationId, channel: "whatsapp", provider: "bridge", displayName: "Zap",
      bridgeSessionState: "qr", status: "active", createdAt: now, updatedAt: now,
    });
  });
  // O seed já tem atendente ativo (aiId): com canal bridge e sem aceite, aparece.
  expect(await ids()).toContain("bridgeAiAck");
  await t.run(async (ctx) => {
    const org = await ctx.db.get(s.organizationId);
    await ctx.db.patch(s.organizationId, {
      settings: { ...org!.settings, aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, bridgeAiAck: { acceptedAt: 1, acceptedBy: s.adminId } } },
    });
  });
  expect(await ids()).not.toContain("bridgeAiAck");
});

test("getOnboardingStatus de membro agent não expõe business", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await as(t, s.adminUserId).mutation(api.onboarding.saveBusinessProfile, { organizationId: s.organizationId, segment: "saas", offer: "Segredo comercial" });
  const asAgent = await as(t, s.agentUserId).query(api.onboarding.getOnboardingStatus, { organizationId: s.organizationId });
  expect(asAgent).toEqual({ shouldShowWizard: false });
  const asAdmin = await as(t, s.adminUserId).query(api.onboarding.getOnboardingStatus, { organizationId: s.organizationId });
  expect(asAdmin.business?.offer).toBe("Segredo comercial");
  expect(asAdmin.accountHasEmail).toBe(true);
  expect(asAdmin.capabilities).toBeDefined();
  expect(asAdmin.steps?.business).toBe("done");
});

test("markWizardStep aceita funil pulado, mas recusa funil feito", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const admin = as(t, s.adminUserId);
  await admin.mutation(api.onboarding.markWizardStep, { organizationId: s.organizationId, step: "funnel", status: "skipped" });
  await expect(
    admin.mutation(api.onboarding.markWizardStep, { organizationId: s.organizationId, step: "funnel", status: "done" }),
  ).rejects.toThrow(/calculado/);
  const st = await admin.query(api.onboarding.getOnboardingStatus, { organizationId: s.organizationId });
  expect(st.steps?.funnel).toBe("skipped");
});

test("markWizardStep só aceita passos não deriváveis", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  const admin = as(t, s.adminUserId);
  await admin.mutation(api.onboarding.markWizardStep, { organizationId: s.organizationId, step: "test", status: "done" });
  await admin.mutation(api.onboarding.markWizardStep, { organizationId: s.organizationId, step: "whatsapp", status: "skipped" });
  await expect(
    admin.mutation(api.onboarding.markWizardStep, { organizationId: s.organizationId, step: "whatsapp", status: "done" }),
  ).rejects.toThrow(/calculado/);
  const st = await admin.query(api.onboarding.getOnboardingStatus, { organizationId: s.organizationId });
  expect(st.steps?.test).toBe("done");
  expect(st.steps?.whatsapp).toBe("skipped");
  const ctxData = await t.query(internal.onboarding.internalGetSetupContext, { organizationId: s.organizationId });
  expect(ctxData!.organizationName).toBe("Org Onboarding");
});

test("org criada antes do PR (sem campos novos) lê sem erro em todas as queries", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t, { onboardingMeta: { industry: "outro", companySize: "1-10", mainGoal: "vender", wizardCompletedAt: 5 } });
  const a = as(t, s.adminUserId);
  const organizationId = s.organizationId;
  await a.query(api.onboarding.getOnboardingProgress, { organizationId });
  await a.query(api.onboarding.getOnboardingChecklist, { organizationId });
  await a.query(api.onboarding.getOnboardingStatus, { organizationId });
  await a.query(api.onboarding.getPlatformCapabilities, { organizationId });
  await t.query(internal.onboarding.internalGetSetupContext, { organizationId });
  await as(t, s.agentUserId).query(api.onboarding.getOnboardingChecklist, { organizationId });
});

test("applyFunnelTemplate não substitui funil referenciado por formulário/campanha", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("forms", {
      organizationId: s.organizationId, name: "Contato", slug: "contato", status: "published",
      fields: [], theme: { primaryColor: "#000000", backgroundColor: "#ffffff", textColor: "#000000", borderRadius: "md", showBranding: false },
      settings: {
        submitButtonText: "Enviar", successMessage: "Ok", notifyOnSubmission: false, assignmentMode: "none", defaultPriority: "low", defaultTemperature: "cold", tags: [], honeypotEnabled: false,
        leadTitle: "Lead", boardId: s.boardId, stageId: s.stageIds[1],
      },
      createdAt: now, updatedAt: now,
      createdBy: s.adminId, submissionCount: 0,
    } as never);
  });
  const r = await as(t, s.adminUserId).mutation(api.onboarding.applyFunnelTemplate, { organizationId: s.organizationId, ...FUNNEL });
  expect(r.mode).toBe("created");
  const stages = await t.run((ctx) => ctx.db.query("stages").withIndex("by_board", (q) => q.eq("boardId", s.boardId)).collect());
  expect(stages).toHaveLength(5);
});

test("applyFunnelTemplate exige primeira etapa aberta", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await expect(
    as(t, s.adminUserId).mutation(api.onboarding.applyFunnelTemplate, {
      organizationId: s.organizationId, ...FUNNEL, stages: [FUNNEL.stages[2], FUNNEL.stages[0]],
    }),
  ).rejects.toThrow(/primeira etapa/);
});

test("initOnboardingProgress: org antiga com dados nasce concluída; org vazia segue mostrando", async () => {
  const t = convexTest(schema, modules);
  const old = await seed(t);
  await addLead(t, old);
  await as(t, old.adminUserId).mutation(api.onboarding.initOnboardingProgress, { organizationId: old.organizationId });
  const p1 = await as(t, old.adminUserId).query(api.onboarding.getOnboardingProgress, { organizationId: old.organizationId });
  expect(p1.shouldShowWizard).toBe(false);

  const fresh = await seed(t);
  await as(t, fresh.adminUserId).mutation(api.onboarding.initOnboardingProgress, { organizationId: fresh.organizationId });
  const p2 = await as(t, fresh.adminUserId).query(api.onboarding.getOnboardingProgress, { organizationId: fresh.organizationId });
  expect(p2.shouldShowWizard).toBe(true);
});
