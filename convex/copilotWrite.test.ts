/// <reference types="vite/client" />
/**
 * Gate do F2: escrita do copiloto com attribution "via copiloto" e confirmação
 * two-phase server-side para destrutivo — deleteLead NUNCA apaga direto, só
 * grava pendingAction; a exclusão real exige a mutation de confirmação (disparo
 * humano). RBAC do usuário enforçado no executor.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
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

async function seedCopilotOrg(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Copiloto",
      slug: "org-copiloto",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const agentRoleId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Vendedor",
      role: "agent", // leads: edit_own — SEM "full" (não pode excluir)
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Vendas",
      color: "#6366f1",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "Novo",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId,
      title: "Lead a excluir",
      boardId,
      stageId,
      value: 1000,
      currency: "BRL",
      priority: "medium",
      temperature: "warm",
      tags: [],
      customFields: {},
      conversationStatus: "new",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminId, agentRoleId, boardId, stageId, leadId };
  });
}

describe("copiloto: escrita com attribution + two-phase destrutivo", () => {
  test("createLead executa e audita como humano via copiloto", async () => {
    const t = setup();
    const seed = await seedCopilotOrg(t);

    const result = await t.mutation(internal.copilot.internalRunCopilotWriteTool, {
      name: "createLead",
      argsJson: JSON.stringify({ title: "Novo negócio", value: 500 }),
      organizationId: seed.organizationId,
      memberId: seed.adminId,
    });
    expect(result.status).toBe("criado");

    const audits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityType === "lead")
    );
    const created = audits.find((a) => a.action === "create");
    expect(created).toBeDefined();
    // Accountability: ator HUMANO, instrumento copiloto.
    expect(created!.actorType).toBe("human");
    expect(created!.actorId).toEqual(seed.adminId);
    expect(created!.metadata?.via).toBe("copilot");
  });

  test("deleteLead NÃO exclui: gera pendingAction com preview", async () => {
    const t = setup();
    const seed = await seedCopilotOrg(t);

    const result = await t.mutation(internal.copilot.internalRunCopilotWriteTool, {
      name: "deleteLead",
      argsJson: JSON.stringify({ leadId: seed.leadId }),
      organizationId: seed.organizationId,
      memberId: seed.adminId,
    });
    expect(result.status).toBe("confirmacao_necessaria");
    expect(result.preview).toContain("Lead a excluir");

    const { lead, pending } = await t.run(async (ctx) => ({
      lead: await ctx.db.get(seed.leadId),
      pending: await ctx.db.query("pendingActions").collect(),
    }));
    expect(lead).not.toBeNull(); // o lead CONTINUA existindo
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      tool: "deleteLead",
      status: "pending",
      requestedBy: seed.adminId,
    });
  });

  test("RBAC: membro sem leads:full não consegue nem propor exclusão", async () => {
    const t = setup();
    const seed = await seedCopilotOrg(t);

    await expect(
      t.mutation(internal.copilot.internalRunCopilotWriteTool, {
        name: "deleteLead",
        argsJson: JSON.stringify({ leadId: seed.leadId }),
        organizationId: seed.organizationId,
        memberId: seed.agentRoleId, // role agent: leads edit_own, sem full
      })
    ).rejects.toThrow(/Permissão insuficiente/);
  });

  test("tool de escrita desconhecida ou de leitura no executor errado é recusada", async () => {
    const t = setup();
    const seed = await seedCopilotOrg(t);

    const unknown = await t.mutation(internal.copilot.internalRunCopilotWriteTool, {
      name: "internalGetBridgeCredentials", // denylist — jamais é tool
      argsJson: "{}",
      organizationId: seed.organizationId,
      memberId: seed.adminId,
    });
    expect(unknown.error).toMatch(/desconhecida/);

    const readInWrite = await t.mutation(internal.copilot.internalRunCopilotWriteTool, {
      name: "listLeads",
      argsJson: "{}",
      organizationId: seed.organizationId,
      memberId: seed.adminId,
    });
    expect(readInWrite.error).toMatch(/desconhecida/);
  });

  test("createBoard cria board + estágios (onboarding conversacional)", async () => {
    const t = setup();
    const seed = await seedCopilotOrg(t);

    const result = await t.mutation(internal.copilot.internalRunCopilotWriteTool, {
      name: "createBoard",
      argsJson: JSON.stringify({
        name: "Locação",
        stages: [
          { name: "Interessado" },
          { name: "Visita" },
          { name: "Fechado", isClosedWon: true },
          { name: "Perdido", isClosedLost: true },
        ],
      }),
      organizationId: seed.organizationId,
      memberId: seed.adminId,
    });
    expect(result.status).toBe("criado");
    expect(result.stageCount).toBe(4);

    const stages = await t.run(async (ctx) =>
      (
        await ctx.db.query("stages").collect()
      ).filter((s) => s.boardId === result.boardId)
    );
    expect(stages.map((s) => s.name)).toEqual(["Interessado", "Visita", "Fechado", "Perdido"]);
  });
});
