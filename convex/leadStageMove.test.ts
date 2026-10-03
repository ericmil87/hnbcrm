/// <reference types="vite/client" />
/**
 * T03 — porta ÚNICA de mudança de etapa (`lib/leadStageMove.moveLeadToStageCore`).
 *
 * Prova, porta por porta (Kanban/painel, lote, REST/MCP, tool `moveThisLead`,
 * avanço pós-BANT, copiloto, desfecho da Central), que o fechamento é
 * carimbado (`closedAt`/`closedType`), que `lead.won`/`lead.lost` sai UMA vez
 * por fechamento, que o `actorType` é o real (humano/IA/API), que reabrir
 * limpa os campos e que `stageEnteredAt` é gravado na criação e na mudança.
 * Também cobre o backfill `leads:internalBackfillClosedAt`.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  planStageMove,
  leadCreationStagePatch,
  sanitizeCloseReason,
  backfillPatchForLead,
  moveThisLeadProposalError,
} from "./lib/leadStageMove";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const NOW = new Date("2026-10-03T15:00:00Z").getTime();
const API_KEY = "hnb_test_stage_move_key_1";

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
});

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function seed(opts: { qualifiedStage?: "won" | "open"; modules?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Funil",
      slug: `org-funil-${Math.random().toString(36).slice(2)}`,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
        ...(opts.modules ? { modules: { central: true } } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {});
    const humanId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Humana", role: "admin", type: "human", status: "active",
      createdAt: now, updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: humanId } },
      },
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const mkStage = (bId: Id<"boards">, name: string, order: number, won = false, lost = false) =>
      ctx.db.insert("stages", {
        organizationId, boardId: bId, name, color: "#6366f1", order,
        isClosedWon: won, isClosedLost: lost, createdAt: now, updatedAt: now,
      });
    const openStageId = await mkStage(boardId, "Novo", 0);
    const proposalStageId = await mkStage(boardId, "Proposta", 1);
    const wonStageId = await mkStage(boardId, "Ganho", 2, true);
    const won2StageId = await mkStage(boardId, "Ganho pago", 3, true);
    const lostStageId = await mkStage(boardId, "Perdido", 4, false, true);

    const otherBoardId = await ctx.db.insert("boards", {
      organizationId, name: "Pós-venda", color: "#22c55e", isDefault: false, order: 1, createdAt: now, updatedAt: now,
    });
    const otherStageId = await mkStage(otherBoardId, "Onboarding", 0);

    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: {
        kind: "attendant",
        mode: "autopilot",
        ...(opts.qualifiedStage
          ? {
              pipelineConfig: {
                qualifiedStageId: opts.qualifiedStage === "won" ? wonStageId : proposalStageId,
                qualifyThreshold: 3,
              },
            }
          : {}),
      },
      createdAt: now, updatedAt: now,
    });

    await ctx.db.insert("apiKeys", {
      organizationId, teamMemberId: humanId, name: "integra", keyHash: await sha256Hex(API_KEY),
      isActive: true, createdAt: now,
    });

    const mkLead = async (title: string, stageId = openStageId) => {
      const contactId = await ctx.db.insert("contacts", {
        organizationId, firstName: title, phone: "5511977776666", tags: [], createdAt: now, updatedAt: now,
      });
      const leadId = await ctx.db.insert("leads", {
        organizationId, title, contactId, boardId, stageId, value: 1500, currency: "BRL",
        priority: "medium", temperature: "warm", tags: [], customFields: {},
        conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId, leadId, channel: "whatsapp", status: "active", messageCount: 0,
        lastMessageAt: now, createdAt: now, updatedAt: now,
      });
      return { leadId, conversationId };
    };
    const a = await mkLead("Lead A");
    const b = await mkLead("Lead B");
    const c = await mkLead("Lead C");

    return {
      organizationId, userId, humanId, agentId, boardId, otherBoardId, otherStageId,
      openStageId, proposalStageId, wonStageId, won2StageId, lostStageId, a, b, c,
    };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;
const asHuman = (s: Seed) => t.withIdentity({ subject: `${s.userId}|s1` });

async function webhookEvents() {
  return await t.run(async (ctx) => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    return scheduled
      .filter((j) => j.name.includes("triggerWebhooks"))
      .map((j) => j.args[0] as { event: string; payload: Record<string, any> });
  });
}
const eventsOf = async (name: string, leadId?: Id<"leads">) =>
  (await webhookEvents()).filter((e) => e.event === name && (!leadId || e.payload.leadId === leadId));

async function moveTrail(leadId: Id<"leads">) {
  return await t.run(async (ctx) => ({
    lead: (await ctx.db.get(leadId))!,
    audits: (await ctx.db.query("auditLogs").collect()).filter(
      (l) => l.entityId === leadId && l.action === "move"
    ),
    activities: (
      await ctx.db.query("activities").withIndex("by_lead", (q) => q.eq("leadId", leadId)).collect()
    ).filter((x) => x.type === "stage_change"),
  }));
}

function attendantTool(s: Seed, ids: { leadId: Id<"leads">; conversationId: Id<"conversations"> }, name: string, args: unknown) {
  return t.mutation(internal.attendant.internalExecuteAttendantTool, {
    name,
    argsJson: JSON.stringify(args),
    organizationId: s.organizationId,
    agentMemberId: s.agentId,
    conversationId: ids.conversationId,
    leadId: ids.leadId,
  });
}

describe("núcleo puro", () => {
  test("planStageMove: fechamento novo, mesmo tipo e reabertura", () => {
    const won = { isClosedWon: true, isClosedLost: false };
    const open = { isClosedWon: false, isClosedLost: false };
    const fresh = planStageMove({ closedAt: undefined, closedType: undefined }, won, 100, { closedReason: "ok" });
    expect(fresh.closureEvent).toBe("won");
    expect(fresh.closePatch).toMatchObject({ closedAt: 100, closedType: "won", closedReason: "ok" });

    const again = planStageMove({ closedAt: 50, closedType: "won" }, won, 100);
    expect(again.closureEvent).toBeNull();
    expect(again.closePatch.closedAt).toBe(50);

    const flip = planStageMove({ closedAt: 50, closedType: "won" }, { isClosedLost: true }, 100);
    expect(flip.closureEvent).toBe("lost");
    expect(flip.closePatch.closedAt).toBe(100);

    const reopen = planStageMove({ closedAt: 50, closedType: "lost" }, open, 100);
    expect(reopen.reopened).toBe(true);
    expect(reopen.closePatch).toEqual({
      closedAt: undefined, closedReason: undefined, closedType: undefined,
      lossReasonKey: undefined, lostFromStageId: undefined,
    });
  });

  test("leadCreationStagePatch e sanitizeCloseReason", () => {
    expect(leadCreationStagePatch({ isClosedWon: false }, 7)).toEqual({ stageEnteredAt: 7 });
    expect(leadCreationStagePatch({ isClosedLost: true }, 7)).toEqual({
      stageEnteredAt: 7, closedAt: 7, closedType: "lost",
    });
    expect(sanitizeCloseReason("achou caro, liga 11 98888-7777 ou https://x.com")).not.toMatch(/9888|x\.com/);
    expect(sanitizeCloseReason(42)).toBe("");
    expect(sanitizeCloseReason("a".repeat(500)).length).toBe(200);
  });

  test("moveThisLeadProposalError: só perda sem motivo é recusada", () => {
    const stages = [{ name: "Novo" }, { name: "Perdido", isClosedLost: true }];
    expect(moveThisLeadProposalError(JSON.stringify({ stageName: "perdido " }), stages)).toMatch(/reason/);
    expect(moveThisLeadProposalError(JSON.stringify({ stageName: "Perdido", reason: "  " }), stages)).toMatch(/reason/);
    expect(moveThisLeadProposalError(JSON.stringify({ stageName: "Perdido", reason: "caro" }), stages)).toBeNull();
    expect(moveThisLeadProposalError(JSON.stringify({ stageName: "Novo" }), stages)).toBeNull();
    expect(moveThisLeadProposalError("{lixo", stages)).toBeNull();
  });

  test("backfillPatchForLead", () => {
    const base = { closedAt: undefined, closedType: undefined, stageEnteredAt: undefined, updatedAt: 99, _creationTime: 1 };
    expect(backfillPatchForLead(base, { isClosedWon: true }).patch).toEqual({
      closedAt: 99, closedType: "won", stageEnteredAt: 99,
    });
    expect(backfillPatchForLead({ ...base, stageEnteredAt: 5 }, { isClosedWon: false }).patch).toEqual({});
    expect(backfillPatchForLead({ ...base, closedType: "lost", closedAt: 3 }, null).openWithCloseFields).toBe(true);
  });
});

describe("Kanban / painel (leads.moveLeadToStage)", () => {
  test("ganho carimba, emite lead.won UMA vez e stage_changed com closedType; reabrir limpa", async () => {
    const s = await seed();
    await asHuman(s).mutation(api.leads.moveLeadToStage, {
      leadId: s.a.leadId, stageId: s.wonStageId, closedReason: "fechou", finalValue: 2000,
    });
    let { lead, audits, activities } = await moveTrail(s.a.leadId);
    expect(lead).toMatchObject({ closedAt: NOW, closedType: "won", closedReason: "fechou", value: 2000, stageEnteredAt: NOW });
    expect(audits[0].actorType).toBe("human");
    expect(activities[0].actorType).toBe("human");

    const won = await eventsOf("lead.won", s.a.leadId);
    expect(won).toHaveLength(1);
    expect(won[0].payload).toMatchObject({
      value: 2000, currency: "BRL", reason: "fechou", stageId: s.wonStageId, boardId: s.boardId,
      actorType: "human", closedAt: NOW,
    });
    const changed = await eventsOf("lead.stage_changed", s.a.leadId);
    expect(changed[0].payload).toMatchObject({ closedType: "won", reopened: false, actorType: "human" });

    // Ganho → outro ganho: não é fechamento novo.
    vi.setSystemTime(NOW + 1000);
    await asHuman(s).mutation(api.leads.moveLeadToStage, { leadId: s.a.leadId, stageId: s.won2StageId });
    ({ lead } = await moveTrail(s.a.leadId));
    expect(lead.closedAt).toBe(NOW);
    expect(lead.stageEnteredAt).toBe(NOW + 1000);
    expect(await eventsOf("lead.won", s.a.leadId)).toHaveLength(1);

    // Reabrir.
    await asHuman(s).mutation(api.leads.moveLeadToStage, { leadId: s.a.leadId, stageId: s.openStageId });
    ({ lead } = await moveTrail(s.a.leadId));
    expect(lead.closedAt).toBeUndefined();
    expect(lead.closedType).toBeUndefined();
    expect(lead.closedReason).toBeUndefined();
    const reopened = (await eventsOf("lead.stage_changed", s.a.leadId)).at(-1)!;
    expect(reopened.payload).toMatchObject({ closedType: null, reopened: true });
    expect(await eventsOf("lead.lost", s.a.leadId)).toHaveLength(0);
  });

  test("mesma etapa é no-op (sem evento) e etapa de outra org/funil é recusada", async () => {
    const s = await seed();
    await asHuman(s).mutation(api.leads.moveLeadToStage, { leadId: s.a.leadId, stageId: s.openStageId });
    expect(await eventsOf("lead.stage_changed", s.a.leadId)).toHaveLength(0);

    const other = await seed();
    await expect(
      asHuman(s).mutation(api.leads.moveLeadToStage, { leadId: s.a.leadId, stageId: other.wonStageId })
    ).rejects.toThrow(/Estágio não encontrado/);
  });

  test("painel: etapa de OUTRO funil leva o lead junto (boardId); funil arquivado recusa", async () => {
    const s = await seed();
    await asHuman(s).mutation(api.leads.moveLeadToStage, { leadId: s.a.leadId, stageId: s.otherStageId });
    const { lead } = await moveTrail(s.a.leadId);
    expect(lead.boardId).toBe(s.otherBoardId);
    expect(lead.stageId).toBe(s.otherStageId);

    await t.run((ctx) => ctx.db.patch(s.otherBoardId, { archivedAt: NOW }));
    await expect(
      asHuman(s).mutation(api.leads.moveLeadToStage, { leadId: s.b.leadId, stageId: s.otherStageId })
    ).rejects.toThrow(/arquivado/);
  });
});

describe("lote (bulkMoveLeads)", () => {
  test("um audit + um lead.lost por lead, sem duplicar", async () => {
    const s = await seed();
    const res = await asHuman(s).mutation(api.leads.bulkMoveLeads, {
      organizationId: s.organizationId,
      leadIds: [s.a.leadId, s.b.leadId, s.c.leadId],
      stageId: s.lostStageId,
    });
    expect(res.moved).toBe(3);
    for (const ids of [s.a, s.b, s.c]) {
      const { lead, audits, activities } = await moveTrail(ids.leadId);
      expect(lead).toMatchObject({ closedType: "lost", closedAt: NOW, stageEnteredAt: NOW });
      expect(audits).toHaveLength(1);
      expect(activities).toHaveLength(1);
      expect(await eventsOf("lead.lost", ids.leadId)).toHaveLength(1);
      expect(await eventsOf("lead.stage_changed", ids.leadId)).toHaveLength(1);
    }
  });
});

describe("REST/MCP (POST /api/v1/leads/move-stage)", () => {
  test("perda pela API carimba, actorType api, motivo saneado, lead.lost uma vez", async () => {
    const s = await seed();
    const res = await t.fetch("/api/v1/leads/move-stage", {
      method: "POST",
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: s.a.leadId, stageId: s.lostStageId, closedReason: "sem verba", finalValue: 0 }),
    });
    expect(res.status).toBe(200);
    const { lead, audits, activities } = await moveTrail(s.a.leadId);
    expect(lead).toMatchObject({ closedType: "lost", closedAt: NOW, closedReason: "sem verba", value: 0 });
    expect(audits[0].actorType).toBe("api");
    expect(activities[0].actorType).toBe("api");
    const lost = await eventsOf("lead.lost", s.a.leadId);
    expect(lost).toHaveLength(1);
    expect(lost[0].payload).toMatchObject({ actorType: "api", reason: "sem verba", value: 0 });
  });

  test("finalValue negativo ou não numérico → 400 (app: ConvexError)", async () => {
    const s = await seed();
    for (const finalValue of [-1, "10"]) {
      const res = await t.fetch("/api/v1/leads/move-stage", {
        method: "POST",
        headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: s.a.leadId, stageId: s.wonStageId, finalValue }),
      });
      expect(res.status).toBe(400);
    }
    await expect(
      asHuman(s).mutation(api.leads.moveLeadToStage, { leadId: s.a.leadId, stageId: s.wonStageId, finalValue: -5 })
    ).rejects.toThrow(/Valor final inválido/);
    expect((await moveTrail(s.a.leadId)).lead.stageId).toBe(s.openStageId);
  });

  test("etapa de outro funil é recusada sem alterar o lead", async () => {
    const s = await seed();
    const res = await t.fetch("/api/v1/leads/move-stage", {
      method: "POST",
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: s.a.leadId, stageId: s.otherStageId }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const { lead } = await moveTrail(s.a.leadId);
    expect(lead.stageId).toBe(s.openStageId);
  });
});

describe("atendente IA", () => {
  test("moveThisLead para perda SEM reason devolve erro instrutivo e não move", async () => {
    const s = await seed();
    const result = (await attendantTool(s, s.a, "moveThisLead", { stageName: "Perdido" })) as { error?: string };
    expect(result.error).toMatch(/reason/);
    const { lead } = await moveTrail(s.a.leadId);
    expect(lead.stageId).toBe(s.openStageId);
    expect(await eventsOf("lead.stage_changed")).toHaveLength(0);
  });

  test("moveThisLead para perda COM reason fecha como IA (lead.lost uma vez)", async () => {
    const s = await seed();
    const result = await attendantTool(s, s.a, "moveThisLead", { stageName: "perdido", reason: "comprou com outro" });
    expect(result).toMatchObject({ status: "movido" });
    const { lead, audits, activities } = await moveTrail(s.a.leadId);
    expect(lead).toMatchObject({ closedType: "lost", closedAt: NOW, closedReason: "comprou com outro" });
    expect(audits[0].actorType).toBe("ai");
    expect(audits[0].metadata?.via).toBe("attendant");
    expect(activities[0].actorType).toBe("ai");
    const lost = await eventsOf("lead.lost", s.a.leadId);
    expect(lost).toHaveLength(1);
    expect(lost[0].payload).toMatchObject({ actorType: "ai", reason: "comprou com outro" });
  });

  test("moveThisLead para ganho dispensa reason e emite lead.won", async () => {
    const s = await seed();
    await attendantTool(s, s.a, "moveThisLead", { stageName: "Ganho" });
    const { lead } = await moveTrail(s.a.leadId);
    expect(lead).toMatchObject({ closedType: "won", closedAt: NOW });
    expect(await eventsOf("lead.won", s.a.leadId)).toHaveLength(1);
  });

  test("avanço pós-BANT para etapa de ganho carimba e emite lead.won como IA", async () => {
    const s = await seed({ qualifiedStage: "won" });
    const result = await attendantTool(s, s.a, "qualifyThisLead", { budget: true, authority: true, need: true });
    expect(result).toMatchObject({ movedTo: "Ganho" });
    const { lead, audits } = await moveTrail(s.a.leadId);
    expect(lead).toMatchObject({ closedType: "won", closedAt: NOW, stageEnteredAt: NOW });
    expect(audits[0]).toMatchObject({ actorType: "ai" });
    expect(audits[0].metadata?.via).toBe("attendant_qualification_rule");
    const won = await eventsOf("lead.won", s.a.leadId);
    expect(won).toHaveLength(1);
    expect(won[0].payload.actorType).toBe("ai");
  });
});

describe("copiloto (moveLead)", () => {
  test("perda sem reason → erro; com reason → fecha como humano via copiloto", async () => {
    const s = await seed();
    const run = (args: unknown) =>
      t.mutation(internal.copilot.internalRunCopilotWriteTool, {
        name: "moveLead",
        argsJson: JSON.stringify(args),
        organizationId: s.organizationId,
        memberId: s.humanId,
      });
    expect(((await run({ leadId: s.a.leadId, stageName: "Perdido" })) as { error?: string }).error).toMatch(/reason/);
    expect((await moveTrail(s.a.leadId)).lead.stageId).toBe(s.openStageId);

    await run({ leadId: s.a.leadId, stageName: "Perdido", reason: "sumiu" });
    const { lead, audits } = await moveTrail(s.a.leadId);
    expect(lead).toMatchObject({ closedType: "lost", closedReason: "sumiu", closedAt: NOW });
    expect(audits[0].actorType).toBe("human");
    expect(audits[0].metadata?.via).toBe("copilot");
    expect(await eventsOf("lead.lost", s.a.leadId)).toHaveLength(1);
  });
});

describe("Central (markConversationOutcome)", () => {
  test("convertido emite lead.won uma vez; marcar de novo só corrige o valor", async () => {
    const s = await seed({ modules: true });
    await asHuman(s).mutation(api.conversationRouting.markConversationOutcome, {
      conversationId: s.a.conversationId, outcome: "converted", value: 900,
    });
    await asHuman(s).mutation(api.conversationRouting.markConversationOutcome, {
      conversationId: s.a.conversationId, outcome: "converted", value: 950,
    });
    const { lead } = await moveTrail(s.a.leadId);
    expect(lead).toMatchObject({ closedType: "won", value: 950, closedAt: NOW });
    expect(await eventsOf("lead.won", s.a.leadId)).toHaveLength(1);
  });
});

describe("criação de lead", () => {
  test("createLead grava stageEnteredAt; em etapa fechada já nasce fechado, sem won/lost", async () => {
    const s = await seed();
    const openId = await asHuman(s).mutation(api.leads.createLead, {
      organizationId: s.organizationId, title: "Novo", boardId: s.boardId,
    });
    const wonId = await asHuman(s).mutation(api.leads.createLead, {
      organizationId: s.organizationId, title: "Já fechado", boardId: s.boardId, stageId: s.wonStageId,
    });
    const [open, won] = await t.run(async (ctx) => [await ctx.db.get(openId), await ctx.db.get(wonId)]);
    expect(open).toMatchObject({ stageEnteredAt: NOW });
    expect(open!.closedAt).toBeUndefined();
    expect(won).toMatchObject({ stageEnteredAt: NOW, closedAt: NOW, closedType: "won" });
    expect(await eventsOf("lead.won")).toHaveLength(0);
    expect(await eventsOf("lead.stage_changed")).toHaveLength(0);
  });

  test("createLead recusa etapa de outro funil", async () => {
    const s = await seed();
    await expect(
      asHuman(s).mutation(api.leads.createLead, {
        organizationId: s.organizationId, title: "X", boardId: s.boardId, stageId: s.otherStageId,
      })
    ).rejects.toThrow(/não pertence ao funil/);
  });

  test("copiloto createLead grava stageEnteredAt", async () => {
    const s = await seed();
    const res = (await t.mutation(internal.copilot.internalRunCopilotWriteTool, {
      name: "createLead",
      argsJson: JSON.stringify({ title: "Via copiloto" }),
      organizationId: s.organizationId,
      memberId: s.humanId,
    })) as { leadId: Id<"leads"> };
    const lead = await t.run((ctx) => ctx.db.get(res.leadId));
    expect(lead!.stageEnteredAt).toBe(NOW);
  });
});

describe("backfill leads:internalBackfillClosedAt", () => {
  test("dryRun não escreve; real carimba fechamento e stageEnteredAt", async () => {
    const s = await seed();
    // Legado: lead em etapa de ganho movido por porta antiga (sem carimbo).
    await t.run((ctx) => ctx.db.patch(s.a.leadId, { stageId: s.wonStageId, updatedAt: NOW - 5000 }));

    const dry = await t.mutation(internal.leads.internalBackfillClosedAt, { organizationId: s.organizationId });
    expect(dry).toMatchObject({ dryRun: true, scanned: 3, closedFixed: 1, stageEnteredFixed: 3, isDone: true });
    expect((await moveTrail(s.a.leadId)).lead.closedAt).toBeUndefined();

    const real = await t.mutation(internal.leads.internalBackfillClosedAt, {
      organizationId: s.organizationId, dryRun: false,
    });
    expect(real).toMatchObject({ dryRun: false, closedFixed: 1, scheduledNext: false });
    const { lead } = await moveTrail(s.a.leadId);
    expect(lead).toMatchObject({ closedAt: NOW - 5000, closedType: "won", stageEnteredAt: NOW - 5000 });

    const again = await t.mutation(internal.leads.internalBackfillClosedAt, { organizationId: s.organizationId });
    expect(again).toMatchObject({ closedFixed: 0, stageEnteredFixed: 0 });
    // Correção de dado: nenhum webhook retroativo.
    expect(await eventsOf("lead.won")).toHaveLength(0);
  });
});
