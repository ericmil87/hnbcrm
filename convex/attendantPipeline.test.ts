/// <reference types="vite/client" />
/**
 * v4.1 P4 — regras de pipeline do atendente. Prova que:
 *  - o roteamento inbound cria o lead no board/estágio do pipelineConfig do
 *    atendente do canal; config inválida → fallback ao default + aviso;
 *  - a qualificação BANT move o lead DETERMINISTICAMENTE ao atingir o limiar
 *    (código, não modelo), validando contra o board atual;
 *  - allowMoveStages:false é enforçado no EXECUTOR (tool_call forjada é
 *    recusada) e filtrado das tools da run.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  return convexTest(schema, modules);
}

type PipelineOpts = {
  boardConfig?: boolean; // cria 2º board + configura pipelineConfig p/ ele
  qualifiedStage?: boolean;
  qualifyThreshold?: number;
  allowMoveStages?: boolean;
  advanceRules?: string;
};

async function seedOrg(t: TestConvex<typeof schema>, opts: PipelineOpts = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Pipeline",
      slug: "org-pipeline",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const humanId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Humano", role: "admin", type: "human", status: "active",
      createdAt: now, updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...org.settings.aiConfig!,
          lgpdAck: { acceptedAt: now, acceptedBy: humanId },
        },
      },
    });

    // Board default (fluxo antigo) + board comercial (alvo do pipelineConfig).
    const defaultBoardId = await ctx.db.insert("boards", {
      organizationId, name: "Default", color: "#6366f1", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const defaultStageId = await ctx.db.insert("stages", {
      organizationId, boardId: defaultBoardId, name: "Novo", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const salesBoardId = await ctx.db.insert("boards", {
      organizationId, name: "Comercial", color: "#22c55e", isDefault: false, order: 1,
      createdAt: now, updatedAt: now,
    });
    const salesEntryStageId = await ctx.db.insert("stages", {
      organizationId, boardId: salesBoardId, name: "Triagem", color: "#22c55e", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const salesQualifiedStageId = await ctx.db.insert("stages", {
      organizationId, boardId: salesBoardId, name: "Qualificado", color: "#eab308", order: 1,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });

    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Meta",
      phoneNumberId: "555000111", status: "active", createdAt: now, updatedAt: now,
    });

    const pipelineConfig =
      opts.boardConfig === false
        ? undefined
        : {
            boardId: salesBoardId,
            initialStageId: salesEntryStageId,
            ...(opts.qualifiedStage !== false ? { qualifiedStageId: salesQualifiedStageId } : {}),
            ...(opts.qualifyThreshold !== undefined
              ? { qualifyThreshold: opts.qualifyThreshold }
              : {}),
            ...(opts.allowMoveStages !== undefined
              ? { allowMoveStages: opts.allowMoveStages }
              : {}),
            ...(opts.advanceRules ? { advanceRules: opts.advanceRules } : {}),
          };

    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: {
        kind: "attendant",
        mode: "autopilot",
        ...(pipelineConfig ? { pipelineConfig } : {}),
      },
      createdAt: now, updatedAt: now,
    });

    return {
      organizationId, humanId, agentId, configId,
      defaultBoardId, defaultStageId,
      salesBoardId, salesEntryStageId, salesQualifiedStageId,
    };
  });
}

async function seedLead(
  t: TestConvex<typeof schema>,
  seed: Awaited<ReturnType<typeof seedOrg>>,
  overrides: { boardId?: Id<"boards">; stageId?: Id<"stages"> } = {}
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const contactId = await ctx.db.insert("contacts", {
      organizationId: seed.organizationId, firstName: "Cliente", phone: "5511977776666",
      tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId: seed.organizationId, title: "Cliente", contactId,
      boardId: overrides.boardId ?? seed.salesBoardId,
      stageId: overrides.stageId ?? seed.salesEntryStageId,
      assignedTo: seed.agentId, value: 0, currency: "BRL", priority: "medium",
      temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId: seed.organizationId, leadId, channel: "whatsapp",
      channelConfigId: seed.configId, status: "active", lastInboundAt: now,
      messageCount: 0, createdAt: now, updatedAt: now,
    });
    return { contactId, leadId, conversationId };
  });
}

function qualifyArgs(
  seed: Awaited<ReturnType<typeof seedOrg>>,
  ids: { leadId: Id<"leads">; conversationId: Id<"conversations"> },
  argsJson: string,
  name = "qualifyThisLead"
) {
  return {
    name,
    argsJson,
    organizationId: seed.organizationId,
    agentMemberId: seed.agentId,
    conversationId: ids.conversationId,
    leadId: ids.leadId,
  };
}

describe("roteamento inbound com pipelineConfig", () => {
  test("lead novo nasce no board/estágio configurados no atendente do canal", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const { leadId } = await t.mutation(internal.whatsapp.internalRouteInbound, {
      configId: seed.configId,
      waId: "5511911112222",
      profileName: "Novo Cliente",
    });
    const lead = await t.run(async (ctx) => ctx.db.get(leadId));
    expect(lead!.boardId).toBe(seed.salesBoardId);
    expect(lead!.stageId).toBe(seed.salesEntryStageId);
  });

  test("sem pipelineConfig → comportamento atual (board default, 1º estágio)", async () => {
    const t = setup();
    const seed = await seedOrg(t, { boardConfig: false });
    const { leadId } = await t.mutation(internal.whatsapp.internalRouteInbound, {
      configId: seed.configId,
      waId: "5511911113333",
    });
    const lead = await t.run(async (ctx) => ctx.db.get(leadId));
    expect(lead!.boardId).toBe(seed.defaultBoardId);
    expect(lead!.stageId).toBe(seed.defaultStageId);
  });

  test("estágio configurado deletado → fallback ao default + activity de aviso", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await t.run(async (ctx) => {
      await ctx.db.delete(seed.salesEntryStageId);
    });
    const { leadId } = await t.mutation(internal.whatsapp.internalRouteInbound, {
      configId: seed.configId,
      waId: "5511911114444",
    });
    const { lead, activities } = await t.run(async (ctx) => ({
      lead: await ctx.db.get(leadId),
      activities: await ctx.db
        .query("activities")
        .withIndex("by_lead", (q) => q.eq("leadId", leadId))
        .collect(),
    }));
    // Board preferido vale; estágio caiu pro 1º do board + aviso.
    expect(lead!.boardId).toBe(seed.salesBoardId);
    expect(lead!.stageId).toBe(seed.salesQualifiedStageId); // único estágio restante
    expect(
      activities.some((a) => String(a.content).includes("Configuração de funil"))
    ).toBe(true);
  });

  test("atendente inativo → roteamento não se aplica", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.agentId, { status: "inactive" });
    });
    const { leadId } = await t.mutation(internal.whatsapp.internalRouteInbound, {
      configId: seed.configId,
      waId: "5511911115555",
    });
    const lead = await t.run(async (ctx) => ctx.db.get(leadId));
    expect(lead!.boardId).toBe(seed.defaultBoardId);
  });
});

describe("qualificação → avanço determinístico", () => {
  test("score ≥ limiar move o lead para qualifiedStageId com trilha de regra", async () => {
    const t = setup();
    const seed = await seedOrg(t); // threshold default 3
    const ids = await seedLead(t, seed);

    const result = await t.mutation(
      internal.attendant.internalExecuteAttendantTool,
      qualifyArgs(seed, ids, JSON.stringify({ budget: true, authority: true, need: true }))
    );
    expect(result).toMatchObject({ status: "qualificado", score: 3, movedTo: "Qualificado" });

    const { lead, activities } = await t.run(async (ctx) => ({
      lead: await ctx.db.get(ids.leadId),
      activities: await ctx.db
        .query("activities")
        .withIndex("by_lead", (q) => q.eq("leadId", ids.leadId))
        .collect(),
    }));
    expect(lead!.stageId).toBe(seed.salesQualifiedStageId);
    expect(
      activities.some((a) => String(a.content).includes("regra de qualificação"))
    ).toBe(true);
  });

  test("score abaixo do limiar não move", async () => {
    const t = setup();
    const seed = await seedOrg(t, { qualifyThreshold: 4 });
    const ids = await seedLead(t, seed);

    const result = await t.mutation(
      internal.attendant.internalExecuteAttendantTool,
      qualifyArgs(seed, ids, JSON.stringify({ budget: true, authority: true, need: true }))
    );
    expect(result).toMatchObject({ status: "qualificado", score: 3 });
    expect((result as { movedTo?: string }).movedTo).toBeUndefined();

    const lead = await t.run(async (ctx) => ctx.db.get(ids.leadId));
    expect(lead!.stageId).toBe(seed.salesEntryStageId);
  });

  test("qualifiedStageId de OUTRO board (lead movido de funil) → no-op seguro", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    // Lead vive no board default — o estágio de qualificação aponta pro Comercial.
    const ids = await seedLead(t, seed, {
      boardId: seed.defaultBoardId,
      stageId: seed.defaultStageId,
    });

    const result = await t.mutation(
      internal.attendant.internalExecuteAttendantTool,
      qualifyArgs(seed, ids, JSON.stringify({ budget: true, authority: true, need: true }))
    );
    expect(result).toMatchObject({ status: "qualificado", score: 3 });
    expect((result as { movedTo?: string }).movedTo).toBeUndefined();
    const lead = await t.run(async (ctx) => ctx.db.get(ids.leadId));
    expect(lead!.stageId).toBe(seed.defaultStageId);
  });

  test("movimento determinístico roda MESMO com allowMoveStages:false (é regra da org)", async () => {
    const t = setup();
    const seed = await seedOrg(t, { allowMoveStages: false });
    const ids = await seedLead(t, seed);

    const result = await t.mutation(
      internal.attendant.internalExecuteAttendantTool,
      qualifyArgs(
        seed,
        ids,
        JSON.stringify({ budget: true, authority: true, need: true, timeline: true })
      )
    );
    expect(result).toMatchObject({ movedTo: "Qualificado" });
  });
});

describe("allowMoveStages: enforcement e filtro", () => {
  test("tool_call forjada de moveThisLead é recusada no executor", async () => {
    const t = setup();
    const seed = await seedOrg(t, { allowMoveStages: false });
    const ids = await seedLead(t, seed);

    const result = await t.mutation(
      internal.attendant.internalExecuteAttendantTool,
      qualifyArgs(seed, ids, JSON.stringify({ stageName: "Qualificado" }), "moveThisLead")
    );
    expect(result).toMatchObject({ error: expect.stringContaining("desativada") });
    const lead = await t.run(async (ctx) => ctx.db.get(ids.leadId));
    expect(lead!.stageId).toBe(seed.salesEntryStageId);
  });

  test("claim propaga allowMoveStages e advanceRules para a run", async () => {
    const t = setup();
    const seed = await seedOrg(t, {
      allowMoveStages: false,
      advanceRules: "Mova para Qualificado quando pedir orçamento.",
    });
    const ids = await seedLead(t, seed);
    const messageId = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(ids.conversationId, { lastInboundAt: now });
      return await ctx.db.insert("messages", {
        organizationId: seed.organizationId,
        conversationId: ids.conversationId,
        leadId: ids.leadId,
        direction: "inbound",
        senderType: "contact",
        content: "Quero um orçamento",
        contentType: "text",
        isInternal: false,
        createdAt: now,
      });
    });
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    const [item] = await t.run(async (ctx) => await ctx.db.query("aiReplyQueue").collect());

    vi.setSystemTime(Date.now() + 10_000);
    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-p4",
    });
    expect(claim.kind).toBe("run");
    if (claim.kind !== "run") throw new Error("unreachable");
    expect(claim.context.allowMoveStages).toBe(false);
    expect(claim.context.advanceRules).toContain("orçamento");
  });
});
