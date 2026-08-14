/// <reference types="vite/client" />
/**
 * P2 — loop de coaching (humano instrui → IA propõe → humano aprova/reinstrui).
 * Prova que:
 *  - requestAiDraft atravessa SÓ os 3 holds humanos (pausa, lead de humano,
 *    handoff pendente) — opt-out LGPD continua bloqueando;
 *  - a instrução do humano entra no system prompt (fora do envelope);
 *  - regenerar supersede o rascunho antigo → "revised" + ponteiros encadeados;
 *  - "revised" fica FORA de `reviewed` (não sabota o gate do autopilot);
 *  - coach em org autopilot commita como SUGESTÃO (nunca envia direto);
 *  - TOCTOU: commit aborta se o rascunho de origem foi resolvido na geração;
 *  - acceptAiDraft de rascunho "revised" falha;
 *  - returnToAi: despausa + reatribui ao atendente + cancela repasse + enfileira
 *    turno com instrução;
 *  - notificação ai_draft_pending com dedupe por não-lida da conversa;
 *  - RBAC: requestAiDraft/returnToAi exigem inbox >= reply.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  return convexTest(schema, modules);
}

async function seedCoachOrg(
  t: TestConvex<typeof schema>,
  opts?: { mode?: "suggest" | "autopilot" }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", {});
    const sellerUserId = await ctx.db.insert("users", {});
    const viewerUserId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Coach",
      slug: "org-coach",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const sellerId = await ctx.db.insert("teamMembers", {
      organizationId, userId: sellerUserId, name: "Vendedor", role: "agent",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const viewerId = await ctx.db.insert("teamMembers", {
      organizationId, userId: viewerUserId, name: "Só Leitura", role: "agent",
      type: "human", status: "active",
      permissions: {
        leads: "view_own", contacts: "view", inbox: "view_own", tasks: "view_own",
        reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none",
      },
      createdAt: now, updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...org.settings.aiConfig!,
          lgpdAck: { acceptedAt: now, acceptedBy: adminId },
        },
      },
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: opts?.mode ?? "suggest" },
      createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta",
      displayName: "Número principal", phoneNumberId: "555000111",
      status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Cliente", phone: "5511988887777", tags: [],
      createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Cliente WhatsApp", contactId, boardId, stageId,
      assignedTo: agentId, value: 0, currency: "BRL", priority: "medium",
      temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId,
      status: "active", lastInboundAt: now, messageCount: 1,
      createdAt: now, updatedAt: now,
    });
    const inboundId = await ctx.db.insert("messages", {
      organizationId, conversationId, leadId,
      direction: "inbound", senderType: "contact",
      content: "Quanto custa o plano anual?", contentType: "text",
      isInternal: false, createdAt: now,
    });
    return {
      organizationId, adminUserId, sellerUserId, viewerUserId,
      adminId, sellerId, viewerId, agentId, configId, boardId, stageId,
      contactId, leadId, conversationId, inboundId,
    };
  });
}

type Seed = Awaited<ReturnType<typeof seedCoachOrg>>;

const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|s1` });

// Mock de LLM: sempre responde texto puro (sem tools) e captura o request body.
function stubLlm(reply: string) {
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: reply }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function systemPromptOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  const init = fetchMock.mock.calls[call]?.[1] as { body?: string } | undefined;
  const body = JSON.parse(init?.body ?? "{}");
  return body.messages?.[0]?.content ?? "";
}

// Aplica os TRÊS holds humanos de uma vez: pausa + lead de humano + handoff.
async function applyHumanHolds(t: TestConvex<typeof schema>, seed: Seed) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(seed.conversationId, { aiPausedUntil: Number.MAX_SAFE_INTEGER });
    await ctx.db.patch(seed.leadId, {
      assignedTo: seed.sellerId,
      handoffState: {
        status: "requested", fromMemberId: seed.agentId,
        reason: "Cliente pediu humano", requestedAt: now,
      },
    });
  });
}

// Libera o slot de pacing por-org para uma SEGUNDA run no mesmo teste (o cursor
// real impõe ≥1s entre inferências e o claim deferiria).
async function resetPacing(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  await t.run(async (ctx) => {
    const pacing = await ctx.db
      .query("aiPacing")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .first();
    if (pacing) await ctx.db.patch(pacing._id, { nextInferenceAt: 0 });
  });
}

async function coachItemOf(t: TestConvex<typeof schema>, seed: Seed) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("aiReplyQueue").collect()).find((i) => i.origin === "coach")
  );
}

async function draftsOf(t: TestConvex<typeof schema>, seed: Seed) {
  return await t.run(async (ctx) =>
    (
      await ctx.db
        .query("messages")
        .withIndex("by_conversation_and_created", (q) =>
          q.eq("conversationId", seed.conversationId)
        )
        .collect()
    ).filter((m) => m.isInternal && m.metadata?.aiDraft)
  );
}

describe("requestAiDraft (pedir/regenerar com instrução)", () => {
  test("atravessa os 3 holds humanos e injeta a instrução no system prompt", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);
    await applyHumanHolds(t, seed);

    // Mutations sob FAKE timers (o runAfter agendado morre na troca p/ real) —
    // a action roda UMA vez, explícita, sem corrida com o scheduler de fundo.
    await asUser(t, seed.adminUserId).mutation(api.attendant.requestAiDraft, {
      conversationId: seed.conversationId,
      instruction: "Ofereça 10% de desconto no plano anual",
    });
    const item = await coachItemOf(t, seed);
    expect(item).toMatchObject({ origin: "coach", instructedBy: seed.adminId });

    vi.useRealTimers();
    const fetchMock = stubLlm("Consigo sim! Com 10% de desconto o anual fica em R$ 1.080.");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });

    const prompt = systemPromptOf(fetchMock);
    expect(prompt).toContain("INSTRUÇÃO DO ATENDENTE HUMANO");
    expect(prompt).toContain("Ofereça 10% de desconto no plano anual");

    const drafts = await draftsOf(t, seed);
    expect(drafts).toHaveLength(1);
    const aiDraft = drafts[0].metadata!.aiDraft as Record<string, unknown>;
    expect(aiDraft.status).toBe("pending");
    expect(aiDraft.instruction).toBe("Ofereça 10% de desconto no plano anual");
    const updated = await t.run(async (ctx) => ctx.db.get(item!._id));
    expect(updated!.status).toBe("done");
  });

  test("bypass RE-AVALIA a cadeia: opt-out bloqueia MESMO sob os 3 holds humanos", async () => {
    // Regressão do achado nº 1 da revisão: evaluateEligibility curto-circuita
    // no primeiro motivo (ia_pausada) — sem a re-avaliação, o coach vazaria o
    // histórico de um contato com opt-out LGPD para o LLM.
    const t = setup();
    const seed = await seedCoachOrg(t);
    await applyHumanHolds(t, seed);
    await t.run(async (ctx) => ctx.db.patch(seed.contactId, { aiOptOut: true }));

    await asUser(t, seed.adminUserId).mutation(api.attendant.requestAiDraft, {
      conversationId: seed.conversationId,
      instruction: "Responda qualquer coisa",
    });
    const item = await coachItemOf(t, seed);
    vi.useRealTimers();
    const fetchMock = stubLlm("não deveria rodar");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });

    const updated = await t.run(async (ctx) => ctx.db.get(item!._id));
    expect(updated).toMatchObject({ status: "skipped", error: "opt_out" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await draftsOf(t, seed)).toHaveLength(0);
  });

  test("teto de respostas vale para o coach mesmo sob os holds humanos", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);
    await applyHumanHolds(t, seed);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(seed.agentId, {
        agentProfile: { kind: "attendant", mode: "suggest", maxRepliesPerConversation: 1 },
      });
      // Uma resposta de IA já enviada → teto de 1 atingido.
      await ctx.db.insert("messages", {
        organizationId: seed.organizationId, conversationId: seed.conversationId,
        leadId: seed.leadId, direction: "outbound", senderId: seed.agentId,
        senderType: "ai", content: "resposta anterior", contentType: "text",
        isInternal: false, createdAt: now,
      });
    });

    await asUser(t, seed.adminUserId).mutation(api.attendant.requestAiDraft, {
      conversationId: seed.conversationId,
      instruction: "Mais uma",
    });
    const item = await coachItemOf(t, seed);
    vi.useRealTimers();
    const fetchMock = stubLlm("não deveria rodar");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });

    const updated = await t.run(async (ctx) => ctx.db.get(item!._id));
    expect(updated).toMatchObject({ status: "skipped", error: "teto_conversa" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("opt-out LGPD NÃO é atravessado pelo coach", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);
    await t.run(async (ctx) => ctx.db.patch(seed.contactId, { aiOptOut: true }));

    await asUser(t, seed.adminUserId).mutation(api.attendant.requestAiDraft, {
      conversationId: seed.conversationId,
      instruction: "Responda qualquer coisa",
    });
    const item = await coachItemOf(t, seed);
    vi.useRealTimers();
    stubLlm("não deveria rodar");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });

    const updated = await t.run(async (ctx) => ctx.db.get(item!._id));
    expect(updated).toMatchObject({ status: "skipped", error: "opt_out" });
    expect(await draftsOf(t, seed)).toHaveLength(0);
  });

  test("regenerar supersede o rascunho antigo (revised + ponteiros) e o prompt cita o anterior", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);

    // 1º rascunho: fluxo normal do inbound (mutations sob fake timers).
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId: seed.inboundId });
    const normalItem = await t.run(async (ctx) =>
      (await ctx.db.query("aiReplyQueue").collect())[0]
    );
    await t.run(async (ctx) =>
      ctx.db.patch(normalItem._id, { nextAttemptAt: Date.now() - 1_000 })
    );
    vi.useRealTimers();
    const first = stubLlm("Primeira versão longa do rascunho sobre o plano anual.");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: normalItem._id });
    const [firstDraft] = await draftsOf(t, seed);
    expect(firstDraft).toBeDefined();
    expect(first.mock.calls.length).toBeGreaterThan(0);

    // Regeneração com instrução (mutation de volta sob fake timers).
    vi.useFakeTimers();
    await asUser(t, seed.adminUserId).mutation(api.attendant.requestAiDraft, {
      conversationId: seed.conversationId,
      instruction: "Mais curto",
      sourceDraftId: firstDraft._id,
    });
    const coachItem = await coachItemOf(t, seed);
    await resetPacing(t, seed.organizationId);
    vi.useRealTimers();
    const fetchMock2 = stubLlm("Versão nova, mais curta: plano anual por R$ 1.200.");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: coachItem!._id });

    expect(systemPromptOf(fetchMock2)).toContain("Seu rascunho anterior foi");

    const drafts = await draftsOf(t, seed);
    expect(drafts).toHaveLength(2);
    const oldDraft = drafts.find((d) => d._id === firstDraft._id)!;
    const newDraft = drafts.find((d) => d._id !== firstDraft._id)!;
    const oldMeta = oldDraft.metadata!.aiDraft as Record<string, unknown>;
    const newMeta = newDraft.metadata!.aiDraft as Record<string, unknown>;
    expect(oldMeta.status).toBe("revised");
    expect(oldMeta.nextDraftId).toBe(newDraft._id);
    expect(newMeta.status).toBe("pending");
    expect(newMeta.previousDraftId).toBe(oldDraft._id);
  });

  test("coach em org AUTOPILOT commita como sugestão, nunca envia", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t, { mode: "autopilot" });

    await asUser(t, seed.adminUserId).mutation(api.attendant.requestAiDraft, {
      conversationId: seed.conversationId,
      instruction: "Confirme o desconto",
    });
    const item = await coachItemOf(t, seed);
    vi.useRealTimers();
    stubLlm("Resposta instruída que NÃO deve sair sozinha.");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });

    const messages = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation_and_created", (q) =>
          q.eq("conversationId", seed.conversationId)
        )
        .collect()
    );
    const outbound = messages.filter((m) => m.direction === "outbound");
    expect(outbound).toHaveLength(0);
    expect(await draftsOf(t, seed)).toHaveLength(1);
  });

  test("guard anti duplo-clique: segundo pedido com item em voo falha", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);
    const asAdmin = asUser(t, seed.adminUserId);

    await asAdmin.mutation(api.attendant.requestAiDraft, {
      conversationId: seed.conversationId,
    });
    await expect(
      asAdmin.mutation(api.attendant.requestAiDraft, {
        conversationId: seed.conversationId,
      })
    ).rejects.toThrow(/preparando/);
  });

  test("RBAC: membro sem inbox>=reply não pede rascunho nem devolve à IA", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);
    const asViewer = asUser(t, seed.viewerUserId);

    await expect(
      asViewer.mutation(api.attendant.requestAiDraft, {
        conversationId: seed.conversationId,
      })
    ).rejects.toThrow();
    await expect(
      asViewer.mutation(api.attendant.returnToAi, {
        conversationId: seed.conversationId,
      })
    ).rejects.toThrow();
  });
});

describe("TOCTOU e guards do rascunho", () => {
  test("commit aborta se o rascunho de origem foi resolvido durante a geração", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);
    const { itemId, runId, agentRunId, sourceId } = await t.run(async (ctx) => {
      const now = Date.now();
      // Rascunho de origem JÁ enviado (humano resolveu enquanto a IA gerava).
      const sourceId = await ctx.db.insert("messages", {
        organizationId: seed.organizationId, conversationId: seed.conversationId,
        leadId: seed.leadId, direction: "internal", senderId: seed.agentId,
        senderType: "ai", content: "rascunho velho", contentType: "text",
        isInternal: true,
        metadata: { aiDraft: { status: "sent" } },
        createdAt: now,
      });
      await ctx.db.patch(seed.conversationId, {
        aiTurnLock: { runId: "run-1", leaseUntil: now + 60_000 },
      });
      const agentRunId = await ctx.db.insert("agentRuns", {
        organizationId: seed.organizationId, memberId: seed.agentId,
        kind: "attendant", status: "running", conversationId: seed.conversationId,
        requestCount: 0, startedAt: now,
      });
      const itemId = await ctx.db.insert("aiReplyQueue", {
        organizationId: seed.organizationId, conversationId: seed.conversationId,
        triggerMessageId: seed.inboundId, agentMemberId: seed.agentId,
        status: "processing", attempts: 0, nextAttemptAt: now,
        origin: "coach", sourceDraftId: sourceId, instructedBy: seed.adminId,
        createdAt: now, updatedAt: now,
      });
      return { itemId, runId: "run-1", agentRunId, sourceId };
    });

    const result = await t.mutation(internal.attendant.internalCommitAiSuggestion, {
      queueItemId: itemId,
      conversationId: seed.conversationId,
      agentMemberId: seed.agentId,
      runId,
      agentRunId,
      text: "nova versão que perdeu o objeto",
      proposedActions: [],
      needsDisclosure: false,
      disclosure: "",
      humanInstructed: true,
      supersedesDraftId: sourceId,
    });
    expect(result).toMatchObject({ committed: false, reason: "rascunho_ja_revisado" });
    const item = await t.run(async (ctx) => ctx.db.get(itemId));
    expect(item!.status).toBe("skipped");
    // O rascunho "sent" ficou intacto.
    const source = await t.run(async (ctx) => ctx.db.get(sourceId));
    expect((source!.metadata!.aiDraft as { status: string }).status).toBe("sent");
  });

  test("acceptAiDraft de rascunho 'revised' falha com erro claro", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);
    const draftId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: seed.organizationId, conversationId: seed.conversationId,
        leadId: seed.leadId, direction: "internal", senderId: seed.agentId,
        senderType: "ai", content: "versão antiga", contentType: "text",
        isInternal: true,
        metadata: { aiDraft: { status: "revised" } },
        createdAt: Date.now(),
      })
    );

    await expect(
      asUser(t, seed.adminUserId).mutation(api.attendant.acceptAiDraft, {
        draftMessageId: draftId,
      })
    ).rejects.toThrow(/já revisado/);
  });

  test("requestAiDraft recusa sourceDraftId que não está mais pendente", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);
    const draftId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: seed.organizationId, conversationId: seed.conversationId,
        leadId: seed.leadId, direction: "internal", senderId: seed.agentId,
        senderType: "ai", content: "já enviado", contentType: "text",
        isInternal: true,
        metadata: { aiDraft: { status: "sent" } },
        createdAt: Date.now(),
      })
    );

    await expect(
      asUser(t, seed.adminUserId).mutation(api.attendant.requestAiDraft, {
        conversationId: seed.conversationId,
        sourceDraftId: draftId,
      })
    ).rejects.toThrow(/já revisado/);
  });
});

describe("métricas de aceitação (gate do autopilot)", () => {
  test("'revised' fica fora de reviewed e não altera a acceptanceRate", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      const insertRunWithDraft = async (status: string) => {
        const messageId = await ctx.db.insert("messages", {
          organizationId: seed.organizationId, conversationId: seed.conversationId,
          leadId: seed.leadId, direction: "internal", senderId: seed.agentId,
          senderType: "ai", content: `draft ${status}`, contentType: "text",
          isInternal: true, metadata: { aiDraft: { status } }, createdAt: now,
        });
        await ctx.db.insert("agentRuns", {
          organizationId: seed.organizationId, memberId: seed.agentId,
          kind: "attendant", status: "done", conversationId: seed.conversationId,
          requestCount: 1, resultMessageId: messageId, startedAt: now, finishedAt: now,
        });
      };
      await insertRunWithDraft("sent");
      await insertRunWithDraft("discarded");
      await insertRunWithDraft("revised");
      await insertRunWithDraft("revised");
    });

    const metrics = await asUser(t, seed.adminUserId).query(api.aiSettings.getAttendantMetrics, {
      organizationId: seed.organizationId,
    });
    expect(metrics.revised).toBe(2);
    expect(metrics.reviewed).toBe(2); // sent + discarded — revised FORA
    expect(metrics.acceptanceRate).toBeCloseTo(0.5);
  });

  test("runs de coaching (humanInitiated) ficam FORA do gate — contadas como coached", async () => {
    // Regressão do achado nº 4: rascunho ditado pelo humano e enviado não pode
    // contar como acerto autônomo da IA (destravaria o autopilot de graça).
    const t = setup();
    const seed = await seedCoachOrg(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      const insertRun = async (status: string, humanInitiated: boolean) => {
        const messageId = await ctx.db.insert("messages", {
          organizationId: seed.organizationId, conversationId: seed.conversationId,
          leadId: seed.leadId, direction: "internal", senderId: seed.agentId,
          senderType: "ai", content: `draft ${status}`, contentType: "text",
          isInternal: true, metadata: { aiDraft: { status } }, createdAt: now,
        });
        await ctx.db.insert("agentRuns", {
          organizationId: seed.organizationId, memberId: seed.agentId,
          kind: "attendant", status: "done", conversationId: seed.conversationId,
          ...(humanInitiated ? { humanInitiated: true } : {}),
          requestCount: 1, resultMessageId: messageId, startedAt: now, finishedAt: now,
        });
      };
      await insertRun("sent", false); // autônomo, conta
      await insertRun("sent", true); // coaching, NÃO conta
      await insertRun("sent_edited", true); // coaching, NÃO conta
    });

    const metrics = await asUser(t, seed.adminUserId).query(api.aiSettings.getAttendantMetrics, {
      organizationId: seed.organizationId,
    });
    expect(metrics.coached).toBe(2);
    expect(metrics.reviewed).toBe(1); // só o autônomo
    expect(metrics.sent).toBe(1);
  });
});

describe("returnToAi (devolver a conversa à IA)", () => {
  test("sem atendente disponível no canal: falha e PRESERVA o dono do lead", async () => {
    // Regressão do achado nº 2: com o atendente inativo, o patch antigo
    // apagava assignedTo em silêncio e a conversa ficava órfã.
    const t = setup();
    const seed = await seedCoachOrg(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.agentId, { status: "inactive" });
      await ctx.db.patch(seed.conversationId, { aiPausedUntil: Number.MAX_SAFE_INTEGER });
      await ctx.db.patch(seed.leadId, { assignedTo: seed.sellerId });
    });

    await expect(
      asUser(t, seed.sellerUserId).mutation(api.attendant.returnToAi, {
        conversationId: seed.conversationId,
      })
    ).rejects.toThrow(/atendente/i);

    const { lead, conversation } = await t.run(async (ctx) => ({
      lead: await ctx.db.get(seed.leadId),
      conversation: await ctx.db.get(seed.conversationId),
    }));
    expect(lead!.assignedTo).toBe(seed.sellerId); // dono preservado
    expect(conversation!.aiPausedUntil).toBe(Number.MAX_SAFE_INTEGER); // pausa intacta
  });

  test("despausa, reatribui ao atendente, cancela repasse e enfileira turno instruído", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);
    // Estado típico pós-assumir: pausada + lead do humano + repasse pendente.
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.conversationId, { aiPausedUntil: Number.MAX_SAFE_INTEGER });
      await ctx.db.patch(seed.leadId, { assignedTo: seed.sellerId });
    });
    const handoffId = await t.mutation(internal.handoffs.internalRequestHandoff, {
      leadId: seed.leadId,
      conversationId: seed.conversationId,
      reason: "Cliente pediu humano",
      suggestedActions: [],
      teamMemberId: seed.agentId,
      origin: "ai_tool",
    });

    await asUser(t, seed.sellerUserId).mutation(api.attendant.returnToAi, {
      conversationId: seed.conversationId,
      instruction: "Faça follow-up oferecendo o plano anual com 10% off",
    });

    const { conversation, lead, handoff, items } = await t.run(async (ctx) => ({
      conversation: await ctx.db.get(seed.conversationId),
      lead: await ctx.db.get(seed.leadId),
      handoff: await ctx.db.get(handoffId),
      items: await ctx.db.query("aiReplyQueue").collect(),
    }));
    expect(conversation!.aiPausedUntil).toBeUndefined();
    expect(lead!.assignedTo).toBe(seed.agentId);
    expect(lead!.handoffState).toBeUndefined();
    expect(handoff!.status).toBe("canceled");
    const returnItem = items.find((i) => i.origin === "return_to_ai");
    expect(returnItem).toMatchObject({
      status: "pending",
      instruction: "Faça follow-up oferecendo o plano anual com 10% off",
      instructedBy: seed.sellerId,
    });
  });

  test("turno de devolução respeita o modo suggest: gera rascunho, não envia", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.conversationId, { aiPausedUntil: Number.MAX_SAFE_INTEGER });
      await ctx.db.patch(seed.leadId, { assignedTo: seed.sellerId });
    });

    await asUser(t, seed.sellerUserId).mutation(api.attendant.returnToAi, {
      conversationId: seed.conversationId,
      instruction: "Reforce a proposta do plano anual",
    });
    const item = await t.run(async (ctx) =>
      (await ctx.db.query("aiReplyQueue").collect()).find((i) => i.origin === "return_to_ai")
    );
    vi.useRealTimers();
    const fetchMock = stubLlm("Olá! Passando para reforçar a proposta do plano anual.");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });

    expect(systemPromptOf(fetchMock)).toContain("Reforce a proposta do plano anual");
    const drafts = await draftsOf(t, seed);
    expect(drafts).toHaveLength(1);
    const outbound = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("messages")
          .withIndex("by_conversation_and_created", (q) =>
            q.eq("conversationId", seed.conversationId)
          )
          .collect()
      ).filter((m) => m.direction === "outbound")
    );
    expect(outbound).toHaveLength(0);
  });
});

describe("notificação ai_draft_pending", () => {
  test("dono do lead é a IA (instrução via peek): notifica quem instruiu", async () => {
    // Regressão do achado nº 9: no fluxo "instruir em vez de assumir", o lead
    // segue com o atendente IA — sem este caminho, ninguém era avisado do
    // rascunho prometido.
    const t = setup();
    const seed = await seedCoachOrg(t); // lead.assignedTo = agentId (IA)
    await asUser(t, seed.adminUserId).mutation(api.attendant.requestAiDraft, {
      conversationId: seed.conversationId,
      instruction: "Proponha um horário de conversa",
    });
    const item = await coachItemOf(t, seed);
    vi.useRealTimers();
    stubLlm("Que tal amanhã às 10h?");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });

    const notifs = await t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).filter(
        (n) => n.type === "ai_draft_pending"
      )
    );
    expect(notifs).toHaveLength(1);
    expect(notifs[0].memberId).toBe(seed.adminId);
  });

  test("avisa o dono humano do lead, com dedupe por não-lida da conversa", async () => {
    const t = setup();
    const seed = await seedCoachOrg(t);
    // Dono do lead = vendedor humano; quem instrui = admin (ator ≠ dono).
    await t.run(async (ctx) => ctx.db.patch(seed.leadId, { assignedTo: seed.sellerId }));

    const asAdmin = asUser(t, seed.adminUserId);
    await asAdmin.mutation(api.attendant.requestAiDraft, {
      conversationId: seed.conversationId,
      instruction: "Responda a dúvida do plano",
    });
    let item = await coachItemOf(t, seed);
    vi.useRealTimers();
    stubLlm("Rascunho 1");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });

    let pendingNotifs = await t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).filter(
        (n) => n.type === "ai_draft_pending"
      )
    );
    expect(pendingNotifs).toHaveLength(1);
    expect(pendingNotifs[0].memberId).toBe(seed.sellerId);
    expect(pendingNotifs[0].conversationId).toBe(seed.conversationId);

    // Segundo rascunho com a notificação anterior ainda NÃO LIDA → dedupe.
    vi.useFakeTimers();
    const [firstDraft] = await draftsOf(t, seed);
    await asAdmin.mutation(api.attendant.requestAiDraft, {
      conversationId: seed.conversationId,
      instruction: "Mais curto",
      sourceDraftId: firstDraft._id,
    });
    item = await t.run(async (ctx) =>
      (await ctx.db.query("aiReplyQueue").collect()).find(
        (i) => i.origin === "coach" && i.status === "pending"
      )
    );
    await resetPacing(t, seed.organizationId);
    vi.useRealTimers();
    stubLlm("Rascunho 2");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });

    // A 2ª run ACONTECEU (rascunho novo existe, o antigo virou revised)...
    const drafts = await draftsOf(t, seed);
    expect(drafts).toHaveLength(2);
    expect(
      drafts.map((d) => (d.metadata!.aiDraft as { status: string }).status).sort()
    ).toEqual(["pending", "revised"]);

    // ...mas a notificação não empilhou (a anterior segue não-lida).
    pendingNotifs = await t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).filter(
        (n) => n.type === "ai_draft_pending"
      )
    );
    expect(pendingNotifs).toHaveLength(1); // dedupado
  });
});
