/// <reference types="vite/client" />
/**
 * Arquivamento e exclusão definitiva de pipelines (boards).
 * Prova que:
 *  - arquivar tira o board das listagens (e do fallback de board default),
 *    promovendo outro board a padrão, e restaurar desfaz;
 *  - o último pipeline ATIVO não pode ser arquivado nem excluído;
 *  - board com leads só é excluído com `deleteLeads: true` (texto do erro
 *    antigo preservado);
 *  - a exclusão marca o board na hora e a cascata batched apaga leads (com
 *    snapshot em auditoria), conversas, mensagens e etapas, respeitando
 *    `deleteContacts` (contato com lead em outro board sobrevive);
 *  - `getBoardDeletionImpact` conta leads e contatos exclusivos;
 *  - RBAC: agent não arquiva nem exclui.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.useRealTimers();
});

// Roda a cascata até o fim (os jobs se re-agendam), provando que ela termina.
async function drainScheduler(t: TestConvex<typeof schema>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Pipelines",
      slug: "org-pipelines",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });

    const mk = async (name: string, role: "admin" | "manager" | "agent") => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name,
        role,
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return { userId, memberId };
    };

    const admin = await mk("Admin", "admin");
    const agent = await mk("Vendedor", "agent");

    const mkBoard = async (name: string, order: number, isDefault: boolean) => {
      const boardId = await ctx.db.insert("boards", {
        organizationId,
        name,
        color: "#3b82f6",
        isDefault,
        order,
        createdAt: now,
        updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        organizationId,
        boardId,
        name: `Novo (${name})`,
        color: "#6366f1",
        order: 0,
        isClosedWon: false,
        isClosedLost: false,
        createdAt: now,
        updatedAt: now,
      });
      return { boardId, stageId };
    };

    const principal = await mkBoard("Funil Principal", 0, true);
    const secundario = await mkBoard("Funil Secundário", 1, false);

    return { organizationId, admin, agent, principal, secundario };
  });
}

async function insertLead(
  t: TestConvex<typeof schema>,
  args: {
    organizationId: Id<"organizations">;
    boardId: Id<"boards">;
    stageId: Id<"stages">;
    title: string;
    contactId?: Id<"contacts">;
  }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("leads", {
      organizationId: args.organizationId,
      title: args.title,
      contactId: args.contactId,
      boardId: args.boardId,
      stageId: args.stageId,
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
  });
}

async function insertContact(
  t: TestConvex<typeof schema>,
  organizationId: Id<"organizations">,
  firstName: string
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("contacts", {
      organizationId,
      firstName,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("arquivar pipeline", () => {
  test("arquiva, some das listagens e promove outro board a padrão", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    await asAdmin.mutation(api.boards.archiveBoard, { boardId: s.principal.boardId });

    const ativos = await asAdmin.query(api.boards.getBoards, {
      organizationId: s.organizationId,
    });
    expect(ativos.map((b: any) => b._id)).toEqual([s.secundario.boardId]);
    expect(ativos[0].isDefault).toBe(true);

    const todos = await asAdmin.query(api.boards.getBoards, {
      organizationId: s.organizationId,
      includeArchived: true,
    });
    expect(todos).toHaveLength(2);
    const arquivado = todos.find((b: any) => b._id === s.principal.boardId)!;
    expect(arquivado.archivedAt).toBeTypeOf("number");
    expect(arquivado.isDefault).toBe(false);

    const log = await t.run(async (ctx) => {
      const logs = await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "board").eq("entityId", s.principal.boardId)
        )
        .collect();
      return logs[logs.length - 1];
    });
    expect(log.description).toBe("Arquivou o pipeline 'Funil Principal'");
    expect(log.metadata?.promotedDefaultBoardId).toBe(s.secundario.boardId);
  });

  test("board arquivado não é escolhido como fallback de board ativo", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    await asAdmin.mutation(api.boards.archiveBoard, { boardId: s.principal.boardId });

    const internos = await t.run(async (ctx) => ctx.db.get(s.principal.boardId));
    expect(internos?.archivedAt).toBeTypeOf("number");

    const viaInternal = await t.query(internal.boards.internalGetBoards, {
      organizationId: s.organizationId,
    });
    expect(viaInternal.map((b: any) => b._id)).toEqual([s.secundario.boardId]);
  });

  test("não arquiva o último pipeline ativo nem um já arquivado", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    await asAdmin.mutation(api.boards.archiveBoard, { boardId: s.principal.boardId });

    await expect(
      asAdmin.mutation(api.boards.archiveBoard, { boardId: s.principal.boardId })
    ).rejects.toThrow("já está arquivado");

    await expect(
      asAdmin.mutation(api.boards.archiveBoard, { boardId: s.secundario.boardId })
    ).rejects.toThrow("Não é possível arquivar o último pipeline ativo.");
  });

  test("restaurar devolve o board às listagens", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    await asAdmin.mutation(api.boards.archiveBoard, { boardId: s.principal.boardId });
    await asAdmin.mutation(api.boards.unarchiveBoard, { boardId: s.principal.boardId });

    const ativos = await asAdmin.query(api.boards.getBoards, {
      organizationId: s.organizationId,
    });
    expect(ativos).toHaveLength(2);
    await expect(
      asAdmin.mutation(api.boards.unarchiveBoard, { boardId: s.principal.boardId })
    ).rejects.toThrow("não está arquivado");
  });

  test("agent não arquiva nem exclui pipeline", async () => {
    const s = await seed(t);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });

    await expect(
      asAgent.mutation(api.boards.archiveBoard, { boardId: s.principal.boardId })
    ).rejects.toThrow("Not authorized");
    await expect(
      asAgent.mutation(api.boards.deleteBoard, { boardId: s.principal.boardId })
    ).rejects.toThrow("Not authorized");
  });
});

describe("excluir pipeline", () => {
  test("board com leads exige deleteLeads e o último ativo nunca sai", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    await insertLead(t, {
      organizationId: s.organizationId,
      boardId: s.principal.boardId,
      stageId: s.principal.stageId,
      title: "Lead A",
    });

    await expect(
      asAdmin.mutation(api.boards.deleteBoard, { boardId: s.principal.boardId })
    ).rejects.toThrow("Não é possível excluir pipeline com leads. Mova ou exclua os leads primeiro.");

    await asAdmin.mutation(api.boards.archiveBoard, { boardId: s.principal.boardId });
    await expect(
      asAdmin.mutation(api.boards.deleteBoard, { boardId: s.secundario.boardId })
    ).rejects.toThrow("Não é possível excluir o último pipeline ativo.");
  });

  test("exclui board vazio: some na hora e a cascata apaga etapas e o doc", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    await asAdmin.mutation(api.boards.deleteBoard, { boardId: s.principal.boardId });

    const durante = await asAdmin.query(api.boards.getBoards, {
      organizationId: s.organizationId,
    });
    expect(durante.map((b: any) => b._id)).toEqual([s.secundario.boardId]);
    expect(durante[0].isDefault).toBe(true);

    await drainScheduler(t);

    const depois = await t.run(async (ctx) => ({
      board: await ctx.db.get(s.principal.boardId),
      stage: await ctx.db.get(s.principal.stageId),
    }));
    expect(depois.board).toBeNull();
    expect(depois.stage).toBeNull();
  });

  test("exclui board com leads: cascata apaga filhos e guarda snapshot no audit", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const contactId = await insertContact(t, s.organizationId, "Cliente");
    const leadId = await insertLead(t, {
      organizationId: s.organizationId,
      boardId: s.principal.boardId,
      stageId: s.principal.stageId,
      title: "Lead com histórico",
      contactId,
    });

    const { taskId } = await t.run(async (ctx) => {
      const now = Date.now();
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: s.organizationId,
        leadId,
        channel: "whatsapp",
        status: "active",
        messageCount: 2,
        createdAt: now,
        updatedAt: now,
      });
      for (const content of ["oi", "tudo bem?"]) {
        await ctx.db.insert("messages", {
          organizationId: s.organizationId,
          conversationId,
          leadId,
          direction: "inbound",
          senderType: "contact",
          content,
          contentType: "text",
          isInternal: false,
          createdAt: now,
        });
      }
      await ctx.db.insert("activities", {
        organizationId: s.organizationId,
        leadId,
        type: "created",
        actorType: "system",
        createdAt: now,
      });
      await ctx.db.insert("handoffs", {
        organizationId: s.organizationId,
        leadId,
        fromMemberId: s.admin.memberId,
        reason: "cliente pediu humano",
        suggestedActions: [],
        status: "pending",
        createdAt: now,
      });
      const taskId = await ctx.db.insert("tasks", {
        organizationId: s.organizationId,
        title: "Ligar para o cliente",
        type: "task",
        status: "pending",
        priority: "medium",
        leadId,
        createdBy: s.admin.memberId,
        createdAt: now,
        updatedAt: now,
      });
      return { conversationId, taskId };
    });

    await asAdmin.mutation(api.boards.deleteBoard, {
      boardId: s.principal.boardId,
      deleteLeads: true,
    });
    await drainScheduler(t);

    const estado = await t.run(async (ctx) => ({
      lead: await ctx.db.get(leadId),
      board: await ctx.db.get(s.principal.boardId),
      conversas: (await ctx.db.query("conversations").collect()).length,
      mensagens: (await ctx.db.query("messages").collect()).length,
      atividades: (await ctx.db.query("activities").collect()).length,
      repasses: (await ctx.db.query("handoffs").collect()).length,
      task: await ctx.db.get(taskId),
      contato: await ctx.db.get(contactId),
    }));

    expect(estado.lead).toBeNull();
    expect(estado.board).toBeNull();
    expect(estado.conversas).toBe(0);
    expect(estado.mensagens).toBe(0);
    expect(estado.atividades).toBe(0);
    expect(estado.repasses).toBe(0);
    expect(estado.task).not.toBeNull();
    expect(estado.task?.leadId).toBeUndefined();
    // deleteContacts não foi pedido — o contato fica
    expect(estado.contato).not.toBeNull();

    const snapshot = await t.run(async (ctx) => {
      const logs = await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "lead").eq("entityId", leadId))
        .collect();
      return logs[0];
    });
    expect(snapshot.action).toBe("delete");
    expect(snapshot.severity).toBe("high");
    expect(snapshot.changes?.before?.title).toBe("Lead com histórico");
    expect(snapshot.changes?.before?.id).toBe(leadId);
    expect(snapshot.metadata?.viaBoardDeletion).toBe(true);
  });

  test("deleteContacts só apaga contato sem lead em outro board", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const exclusivo = await insertContact(t, s.organizationId, "Exclusivo");
    const compartilhado = await insertContact(t, s.organizationId, "Compartilhado");

    await insertLead(t, {
      organizationId: s.organizationId,
      boardId: s.principal.boardId,
      stageId: s.principal.stageId,
      title: "Lead exclusivo",
      contactId: exclusivo,
    });
    await insertLead(t, {
      organizationId: s.organizationId,
      boardId: s.principal.boardId,
      stageId: s.principal.stageId,
      title: "Lead compartilhado",
      contactId: compartilhado,
    });
    await insertLead(t, {
      organizationId: s.organizationId,
      boardId: s.secundario.boardId,
      stageId: s.secundario.stageId,
      title: "Lead no outro funil",
      contactId: compartilhado,
    });

    await asAdmin.mutation(api.boards.deleteBoard, {
      boardId: s.principal.boardId,
      deleteLeads: true,
      deleteContacts: true,
    });
    await drainScheduler(t);

    const estado = await t.run(async (ctx) => ({
      exclusivo: await ctx.db.get(exclusivo),
      compartilhado: await ctx.db.get(compartilhado),
      leadsRestantes: await ctx.db.query("leads").collect(),
    }));

    expect(estado.exclusivo).toBeNull();
    expect(estado.compartilhado).not.toBeNull();
    expect(estado.leadsRestantes).toHaveLength(1);
    expect(estado.leadsRestantes[0].title).toBe("Lead no outro funil");

    const logContato = await t.run(async (ctx) => {
      const logs = await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "contact").eq("entityId", exclusivo))
        .collect();
      return logs[0];
    });
    expect(logContato.changes?.before?.firstName).toBe("Exclusivo");
  });

  test("board em exclusão não pode ser restaurado nem re-excluído", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    await insertLead(t, {
      organizationId: s.organizationId,
      boardId: s.principal.boardId,
      stageId: s.principal.stageId,
      title: "Lead A",
    });

    await asAdmin.mutation(api.boards.deleteBoard, {
      boardId: s.principal.boardId,
      deleteLeads: true,
    });

    await expect(
      asAdmin.mutation(api.boards.unarchiveBoard, { boardId: s.principal.boardId })
    ).rejects.toThrow("está sendo excluído");
    await expect(
      asAdmin.mutation(api.boards.deleteBoard, { boardId: s.principal.boardId })
    ).rejects.toThrow("já está sendo excluído");

    await drainScheduler(t);
  });
});

describe("getBoardDeletionImpact", () => {
  test("conta leads e contatos exclusivos do board", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const exclusivo = await insertContact(t, s.organizationId, "Exclusivo");
    const compartilhado = await insertContact(t, s.organizationId, "Compartilhado");

    await insertLead(t, {
      organizationId: s.organizationId,
      boardId: s.principal.boardId,
      stageId: s.principal.stageId,
      title: "L1",
      contactId: exclusivo,
    });
    await insertLead(t, {
      organizationId: s.organizationId,
      boardId: s.principal.boardId,
      stageId: s.principal.stageId,
      title: "L2",
      contactId: compartilhado,
    });
    await insertLead(t, {
      organizationId: s.organizationId,
      boardId: s.secundario.boardId,
      stageId: s.secundario.stageId,
      title: "L3",
      contactId: compartilhado,
    });

    const impacto = await asAdmin.query(api.boards.getBoardDeletionImpact, {
      boardId: s.principal.boardId,
    });
    expect(impacto).toEqual({ leadCount: 2, exclusiveContactCount: 1, capped: false });
  });
});
