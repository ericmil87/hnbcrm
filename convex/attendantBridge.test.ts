/// <reference types="vite/client" />
/**
 * v4.1 P1/P3 — atendente no canal bridge (aceite de risco) + toggles separados.
 * Prova que:
 *  - bridge SEM bridgeAiAck nunca enfileira; com ack, enfileira;
 *  - a janela de 24h só se aplica ao transporte Meta (bridge não tem janela;
 *    conversa sem provider resolvível é tratada como Meta — conservador);
 *  - revogar o ack entre o claim e o commit ABORTA o envio (condição de
 *    elegibilidade nº 10 re-checada no commit transacional — TOCTOU);
 *  - attendantEnabled:false desativa no enqueue E no claim;
 *  - copilotEnabled:false recusa a sessão do copiloto.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { evaluateEligibility } from "./attendant";

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

async function seedOrg(
  t: TestConvex<typeof schema>,
  opts: {
    provider: "meta" | "bridge";
    bridgeAiAck?: boolean;
    attendantEnabled?: boolean;
    copilotEnabled?: boolean;
    mode?: "suggest" | "autopilot";
  }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Bridge",
      slug: "org-bridge",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 0.8,
          ...(opts.attendantEnabled !== undefined
            ? { attendantEnabled: opts.attendantEnabled }
            : {}),
          ...(opts.copilotEnabled !== undefined ? { copilotEnabled: opts.copilotEnabled } : {}),
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    const humanId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Humano",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    // lgpdAck (+ bridgeAiAck opcional) apontando pro humano.
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...org.settings.aiConfig!,
          lgpdAck: { acceptedAt: now, acceptedBy: humanId },
          ...(opts.bridgeAiAck ? { bridgeAiAck: { acceptedAt: now, acceptedBy: humanId } } : {}),
        },
      },
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Ana (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: { kind: "attendant", mode: opts.mode ?? "suggest" },
      createdAt: now,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: opts.provider,
      displayName: opts.provider === "bridge" ? "Bridge" : "Meta",
      ...(opts.provider === "bridge"
        ? { bridgeBaseUrl: "https://wuzapi.example.com", bridgeInstanceId: "inst1" }
        : { phoneNumberId: "555000111" }),
      status: "active",
      createdAt: now,
      updatedAt: now,
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
      status: "active", lastInboundAt: now, messageCount: 0, createdAt: now, updatedAt: now,
    });
    return { organizationId, userId, humanId, agentId, configId, leadId, conversationId };
  });
}

async function insertInbound(
  t: TestConvex<typeof schema>,
  seed: { organizationId: Id<"organizations">; conversationId: Id<"conversations">; leadId: Id<"leads"> },
  content: string
): Promise<Id<"messages">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(seed.conversationId, { lastInboundAt: now });
    return await ctx.db.insert("messages", {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      leadId: seed.leadId,
      direction: "inbound",
      senderType: "contact",
      content,
      contentType: "text",
      isInternal: false,
      createdAt: now,
    });
  });
}

async function queueItems(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => await ctx.db.query("aiReplyQueue").collect());
}

async function revokeBridgeAck(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  await t.run(async (ctx) => {
    const org = (await ctx.db.get(organizationId))!;
    const { bridgeAiAck: _removed, ...rest } = org.settings.aiConfig!;
    await ctx.db.patch(organizationId, {
      settings: { ...org.settings, aiConfig: rest },
    });
  });
}

describe("P1: gate do bridge por aceite de risco", () => {
  test("bridge SEM ack: inbound não enfileira nada", async () => {
    const t = setup();
    const seed = await seedOrg(t, { provider: "bridge" });
    const messageId = await insertInbound(t, seed, "Oi!");
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    expect(await queueItems(t)).toHaveLength(0);
  });

  test("bridge COM ack: enfileira normalmente", async () => {
    const t = setup();
    const seed = await seedOrg(t, { provider: "bridge", bridgeAiAck: true });
    const messageId = await insertInbound(t, seed, "Oi!");
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    const items = await queueItems(t);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("pending");
  });

  test("Meta continua enfileirando sem nenhum ack de bridge", async () => {
    const t = setup();
    const seed = await seedOrg(t, { provider: "meta" });
    const messageId = await insertInbound(t, seed, "Oi!");
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    expect(await queueItems(t)).toHaveLength(1);
  });

  test("ack revogado entre claim e commit → commit aborta (bridge_sem_aceite)", async () => {
    const t = setup();
    const seed = await seedOrg(t, { provider: "bridge", bridgeAiAck: true, mode: "autopilot" });
    const messageId = await insertInbound(t, seed, "Quero comprar");
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    const [item] = await queueItems(t);

    vi.setSystemTime(Date.now() + 10_000);
    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-ack",
    });
    expect(claim.kind).toBe("run");
    if (claim.kind !== "run") throw new Error("unreachable");

    // Admin revoga o aceite ENQUANTO a inferência estaria rodando.
    await revokeBridgeAck(t, seed.organizationId);

    const commit = await t.mutation(internal.attendant.internalCommitAiReply, {
      queueItemId: item._id,
      conversationId: seed.conversationId,
      agentMemberId: seed.agentId,
      runId: "run-ack",
      agentRunId: claim.context.agentRunId,
      runStartedAt: claim.context.runStartedAt,
      text: "Olá! Posso ajudar?",
      needsDisclosure: false,
      disclosure: "",
      allowPendingHandoff: false,
    });
    expect(commit).toEqual({ committed: false, reason: "bridge_sem_aceite" });

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
    expect(outbound).toHaveLength(0); // nada saiu pro cliente
  });
});

describe("P1: janela de 24h por transporte (evaluateEligibility pura)", () => {
  const now = 1_700_000_000_000;
  const base = {
    org: {
      settings: {
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 0.8,
          lgpdAck: { acceptedAt: now, acceptedBy: "m1" },
          bridgeAiAck: { acceptedAt: now, acceptedBy: "m1" },
        },
      },
    },
    agent: {
      _id: "agent1",
      status: "active",
      type: "ai",
      agentProfile: { kind: "attendant", mode: "suggest" },
    },
    lead: null,
    contact: null,
    aiReplyCountConversation: 0,
    aiReplyCountLastHour: 0,
    now,
  } as unknown as Omit<
    Parameters<typeof evaluateEligibility>[0],
    "conversation" | "channelProvider"
  >;
  const staleConversation = {
    lastInboundAt: now - 25 * 60 * 60 * 1000, // 25h atrás — janela Meta FECHADA
  } as unknown as Doc<"conversations">;

  test("bridge ignora a janela de 24h", () => {
    expect(
      evaluateEligibility({ ...base, conversation: staleConversation, channelProvider: "bridge" })
    ).toEqual({ ok: true });
  });

  test("Meta continua exigindo a janela", () => {
    expect(
      evaluateEligibility({ ...base, conversation: staleConversation, channelProvider: "meta" })
    ).toEqual({ ok: false, reason: "janela_24h" });
  });

  test("provider não resolvível é tratado como Meta (conservador)", () => {
    expect(
      evaluateEligibility({ ...base, conversation: staleConversation, channelProvider: null })
    ).toEqual({ ok: false, reason: "janela_24h" });
  });

  test("bridge sem ack vigente cai na condição 10", () => {
    const orgSemAck = {
      settings: {
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 0.8,
          lgpdAck: { acceptedAt: now, acceptedBy: "m1" },
        },
      },
    } as unknown as Doc<"organizations">;
    expect(
      evaluateEligibility({
        ...base,
        org: orgSemAck,
        conversation: { lastInboundAt: now } as unknown as Doc<"conversations">,
        channelProvider: "bridge",
      })
    ).toEqual({ ok: false, reason: "bridge_sem_aceite" });
  });
});

describe("P3: toggles separados", () => {
  test("attendantEnabled:false → enqueue não cria item", async () => {
    const t = setup();
    const seed = await seedOrg(t, { provider: "meta", attendantEnabled: false });
    const messageId = await insertInbound(t, seed, "Oi!");
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    expect(await queueItems(t)).toHaveLength(0);
  });

  test("attendantEnabled desligado APÓS o enqueue → claim skipa (re-check)", async () => {
    const t = setup();
    const seed = await seedOrg(t, { provider: "meta" });
    const messageId = await insertInbound(t, seed, "Oi!");
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    const [item] = await queueItems(t);

    await t.run(async (ctx) => {
      const org = (await ctx.db.get(seed.organizationId))!;
      await ctx.db.patch(seed.organizationId, {
        settings: {
          ...org.settings,
          aiConfig: { ...org.settings.aiConfig!, attendantEnabled: false },
        },
      });
    });

    vi.setSystemTime(Date.now() + 10_000);
    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-toggle",
    });
    expect(claim).toEqual({ kind: "skip", reason: "atendente_desativado" });
  });

  test("copilotEnabled:false → sessão do copiloto recusada; ligado → resolve", async () => {
    const t = setup();
    const seed = await seedOrg(t, { provider: "meta", copilotEnabled: false });
    const asUser = t.withIdentity({ subject: `${seed.userId}|session1` });
    await expect(
      asUser.query(internal.copilot.internalResolveSession, {
        organizationId: seed.organizationId,
      })
    ).rejects.toThrow(/Copiloto está desativado/);

    const seedOn = await seedOrg(t, { provider: "meta" });
    const asUserOn = t.withIdentity({ subject: `${seedOn.userId}|session2` });
    const session = await asUserOn.query(internal.copilot.internalResolveSession, {
      organizationId: seedOn.organizationId,
    });
    expect(session.member.name).toBe("Humano");
  });
});
