/// <reference types="vite/client" />
/**
 * Fase 4b (perf Convex I/O): presença, lock do turno de IA e cursor de pacing
 * por conversa saíram do doc `conversations` para `conversationRuntime`.
 * Prova que:
 *  - presença (1:1 e grupo) grava no runtime e NÃO toca o doc da conversa;
 *  - `getConversationPresence` devolve a presença só para membro da org;
 *  - o claim respeita o lease gravado no runtime (2º claim defere) e o
 *    release só solta o lock do próprio runId;
 *  - `scheduleWhatsappDispatch` avança o cursor no runtime sem patchar a conversa;
 *  - `internalClearLegacyRuntimeFields` limpa os campos legados (dryRun e real);
 *  - a cascata de exclusão da conversa apaga a linha de runtime.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { getRuntime, upsertRuntime } from "./lib/conversationRuntime";
import { scheduleWhatsappDispatch, PAIR_RATE_INTERVAL_MS } from "./lib/whatsappDispatch";
import { deleteConversationCascade, newBudget } from "./lib/leadCascade";

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

const PHONE = "5511988887777";

async function seedOrg(t: TestConvex<typeof schema>, slug = "org-runtime") {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Runtime",
      slug,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: false, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {});
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
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Número principal",
      phoneNumberId: `pn-${slug}`,
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
    const contactId = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "Cliente",
      phone: PHONE,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId,
      title: "Cliente WhatsApp",
      contactId,
      boardId,
      stageId,
      value: 0,
      currency: "BRL",
      priority: "medium",
      temperature: "warm",
      tags: [],
      customFields: {},
      conversationStatus: "active",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      leadId,
      channel: "whatsapp",
      channelConfigId: configId,
      status: "active",
      lastInboundAt: now,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, userId, humanId, configId, contactId, leadId, conversationId };
  });
}

type Seed = Awaited<ReturnType<typeof seedOrg>>;

async function conversationDoc(t: TestConvex<typeof schema>, id: Id<"conversations">) {
  return await t.run(async (ctx) => ctx.db.get(id));
}

async function runtimeOf(t: TestConvex<typeof schema>, id: Id<"conversations">) {
  return await t.run(async (ctx) => getRuntime(ctx, id));
}

function expectNoLegacyFields(doc: Record<string, unknown> | null) {
  expect(doc).not.toBeNull();
  expect("contactPresence" in doc!).toBe(false);
  expect("aiTurnLock" in doc!).toBe(false);
  expect("nextDispatchAt" in doc!).toBe(false);
}

describe("presença do contato", () => {
  test("1:1: grava no runtime e não toca o doc da conversa", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const before = await conversationDoc(t, seed.conversationId);

    await t.mutation(internal.conversations.internalSetContactPresence, {
      organizationId: seed.organizationId,
      phone: PHONE,
      state: "composing",
    });

    expect(await conversationDoc(t, seed.conversationId)).toEqual(before);
    const runtime = await runtimeOf(t, seed.conversationId);
    expect(runtime).toMatchObject({
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      contactPresence: { state: "composing", at: Date.now() },
    });

    // Evento seguinte atualiza a MESMA linha (não cria outra).
    vi.setSystemTime(Date.now() + 3_000);
    await t.mutation(internal.conversations.internalSetContactPresence, {
      organizationId: seed.organizationId,
      phone: PHONE,
      state: "paused",
    });
    const rows = await t.run(async (ctx) => ctx.db.query("conversationRuntime").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].contactPresence).toEqual({ state: "paused", at: Date.now() });
    expect(await conversationDoc(t, seed.conversationId)).toEqual(before);
  });

  test("telefone desconhecido é no-op (nenhuma linha criada)", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await t.mutation(internal.conversations.internalSetContactPresence, {
      organizationId: seed.organizationId,
      phone: "5511900000000",
      state: "composing",
    });
    const rows = await t.run(async (ctx) => ctx.db.query("conversationRuntime").collect());
    expect(rows).toHaveLength(0);
  });

  test("grupo monitorado: grava no runtime da conversa da sala", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const { groupConversationId } = await t.run(async (ctx) => {
      const now = Date.now();
      const groupConversationId = await ctx.db.insert("conversations", {
        organizationId: seed.organizationId,
        kind: "group",
        externalChatId: "120363000000000000@g.us",
        channel: "whatsapp",
        channelConfigId: seed.configId,
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("groupChats", {
        organizationId: seed.organizationId,
        channelConfigId: seed.configId,
        conversationId: groupConversationId,
        jid: "120363000000000000@g.us",
        subject: "Sala",
        monitored: true,
        createdAt: now,
        updatedAt: now,
      });
      return { groupConversationId };
    });
    const before = await conversationDoc(t, groupConversationId);

    await t.mutation(internal.conversations.internalSetGroupPresence, {
      channelConfigId: seed.configId,
      jid: "120363000000000000@g.us",
      state: "composing",
    });

    expect(await conversationDoc(t, groupConversationId)).toEqual(before);
    expect((await runtimeOf(t, groupConversationId))?.contactPresence).toEqual({
      state: "composing",
      at: Date.now(),
    });
  });

  test("getConversationPresence: membro lê, não-membro recebe null, sem linha = null", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const other = await seedOrg(t, "outra-org");
    const asMember = t.withIdentity({ subject: `${seed.userId}|s1` });
    const asOutsider = t.withIdentity({ subject: `${other.userId}|s2` });

    expect(
      await asMember.query(api.conversations.getConversationPresence, {
        conversationId: seed.conversationId,
      })
    ).toBeNull();

    await t.mutation(internal.conversations.internalSetContactPresence, {
      organizationId: seed.organizationId,
      phone: PHONE,
      state: "composing",
    });
    const at = Date.now();

    expect(
      await asMember.query(api.conversations.getConversationPresence, {
        conversationId: seed.conversationId,
      })
    ).toEqual({ state: "composing", at });
    expect(
      await asOutsider.query(api.conversations.getConversationPresence, {
        conversationId: seed.conversationId,
      })
    ).toBeNull();
    expect(
      await t.query(api.conversations.getConversationPresence, {
        conversationId: seed.conversationId,
      })
    ).toBeNull();

    // A expiração é do cliente (TTL 12 s sobre `at`): a query devolve o `at`
    // original, e o "paused" seguinte substitui o estado.
    vi.setSystemTime(at + 20_000);
    expect(
      await asMember.query(api.conversations.getConversationPresence, {
        conversationId: seed.conversationId,
      })
    ).toEqual({ state: "composing", at });
    expect(Date.now() - at).toBeGreaterThan(12_000);
    await t.mutation(internal.conversations.internalSetContactPresence, {
      organizationId: seed.organizationId,
      phone: PHONE,
      state: "paused",
    });
    expect(
      await asMember.query(api.conversations.getConversationPresence, {
        conversationId: seed.conversationId,
      })
    ).toEqual({ state: "paused", at: at + 20_000 });
  });
});

describe("lock do turno de IA no runtime", () => {
  async function seedAttendant(t: TestConvex<typeof schema>) {
    const seed = await seedOrg(t);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const org = (await ctx.db.get(seed.organizationId))!;
      await ctx.db.patch(seed.organizationId, {
        settings: {
          ...org.settings,
          aiConfig: {
            enabled: true,
            autoAssign: false,
            handoffThreshold: 0.8,
            lgpdAck: { acceptedAt: now, acceptedBy: seed.humanId },
          },
        },
      });
      const agentId = await ctx.db.insert("teamMembers", {
        organizationId: seed.organizationId,
        name: "Ana (IA)",
        role: "ai",
        type: "ai",
        status: "active",
        agentProfile: { kind: "attendant", mode: "suggest" },
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(seed.leadId, { assignedTo: agentId });
      const messageId = await ctx.db.insert("messages", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        leadId: seed.leadId,
        direction: "inbound",
        senderType: "contact",
        content: "Oi, quero um orçamento",
        contentType: "text",
        isInternal: false,
        createdAt: now,
      });
      await ctx.db.patch(seed.conversationId, { lastInboundAt: now });
      return { agentId, messageId };
    });
    return { ...seed, ...ids };
  }

  async function enqueue(t: TestConvex<typeof schema>, seed: Seed & { agentId: Id<"teamMembers">; messageId: Id<"messages"> }) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("aiReplyQueue", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        triggerMessageId: seed.messageId,
        agentMemberId: seed.agentId,
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  test("2º claim na mesma lease defere; lease vencida deixa o claim rodar", async () => {
    const t = setup();
    const seed = await seedAttendant(t);
    // Outra run segura o lock no runtime.
    await t.run(async (ctx) =>
      upsertRuntime(
        ctx,
        { organizationId: seed.organizationId, conversationId: seed.conversationId },
        { aiTurnLock: { runId: "run-outra", leaseUntil: Date.now() + 60_000 } }
      )
    );

    const itemId = await enqueue(t, seed);
    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: itemId,
      runId: "run-nova",
    });
    expect(claim.kind).toBe("defer");
    expect((await runtimeOf(t, seed.conversationId))?.aiTurnLock?.runId).toBe("run-outra");

    // Lease vencida: o claim assume e grava o próprio lock.
    vi.setSystemTime(Date.now() + 61_000);
    await t.run(async (ctx) => ctx.db.patch(itemId, { nextAttemptAt: Date.now() }));
    const claim2 = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: itemId,
      runId: "run-nova",
    });
    expect(claim2.kind).toBe("run");
    expect((await runtimeOf(t, seed.conversationId))?.aiTurnLock?.runId).toBe("run-nova");
    // O claim não grava lock na conversa.
    expectNoLegacyFields(await conversationDoc(t, seed.conversationId));
  });

  test("release só solta o lock do próprio runId", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await t.run(async (ctx) =>
      upsertRuntime(
        ctx,
        { organizationId: seed.organizationId, conversationId: seed.conversationId },
        { aiTurnLock: { runId: "run-dono", leaseUntil: Date.now() + 60_000 } }
      )
    );

    await t.mutation(internal.attendant.internalReleaseLock, {
      conversationId: seed.conversationId,
      runId: "run-intrusa",
    });
    expect((await runtimeOf(t, seed.conversationId))?.aiTurnLock?.runId).toBe("run-dono");

    await t.mutation(internal.attendant.internalReleaseLock, {
      conversationId: seed.conversationId,
      runId: "run-dono",
    });
    expect((await runtimeOf(t, seed.conversationId))?.aiTurnLock ?? null).toBeNull();
  });

  test("release sem linha de runtime é no-op (não cria linha)", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await t.mutation(internal.attendant.internalReleaseLock, {
      conversationId: seed.conversationId,
      runId: "run-x",
    });
    expect(await runtimeOf(t, seed.conversationId)).toBeNull();
  });
});

describe("pacing por conversa no runtime", () => {
  test("envios consecutivos avançam o cursor no runtime sem patchar a conversa", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const insertOutbound = async () =>
      await t.run(async (ctx) =>
        ctx.db.insert("messages", {
          organizationId: seed.organizationId,
          conversationId: seed.conversationId,
          leadId: seed.leadId,
          direction: "outbound",
          senderType: "human",
          senderId: seed.humanId,
          content: "Olá!",
          contentType: "text",
          isInternal: false,
          createdAt: Date.now(),
        })
      );

    const before = await conversationDoc(t, seed.conversationId);
    const m1 = await insertOutbound();
    await t.run(async (ctx) => {
      const conversation = (await ctx.db.get(seed.conversationId))!;
      await scheduleWhatsappDispatch(ctx, conversation, m1);
    });
    const first = (await runtimeOf(t, seed.conversationId))!.nextDispatchAt!;
    expect(first).toBeGreaterThanOrEqual(Date.now() + PAIR_RATE_INTERVAL_MS);

    const m2 = await insertOutbound();
    await t.run(async (ctx) => {
      const conversation = (await ctx.db.get(seed.conversationId))!;
      await scheduleWhatsappDispatch(ctx, conversation, m2);
    });
    const second = (await runtimeOf(t, seed.conversationId))!.nextDispatchAt!;
    // O 2º envio respeita o cursor do 1º (slot ≥ first) e o empurra adiante.
    expect(second).toBeGreaterThanOrEqual(first + PAIR_RATE_INTERVAL_MS);

    const after = await conversationDoc(t, seed.conversationId);
    expect(after).toEqual(before);
    expectNoLegacyFields(after);
  });
});

describe("internalClearLegacyRuntimeFields", () => {
  test("dryRun conta sem escrever; real limpa os 3 campos", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const legacyId = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(seed.conversationId, {
        contactPresence: { state: "composing", at: now },
        aiTurnLock: { runId: "velho", leaseUntil: now + 60_000 },
      });
      return await ctx.db.insert("conversations", {
        organizationId: seed.organizationId,
        leadId: seed.leadId,
        channel: "whatsapp",
        status: "active",
        nextDispatchAt: now + 6_500,
        messageCount: 3,
        createdAt: now,
        updatedAt: now,
      });
    });
    // Uma conversa limpa, para provar que ela não conta.
    await t.run(async (ctx) =>
      ctx.db.insert("conversations", {
        organizationId: seed.organizationId,
        channel: "webchat",
        status: "active",
        messageCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const dry = await t.mutation(internal.conversations.internalClearLegacyRuntimeFields, {});
    expect(dry).toMatchObject({
      dryRun: true,
      scanned: 3,
      cleared: 2,
      withContactPresence: 1,
      withAiTurnLock: 1,
      withNextDispatchAt: 1,
      isDone: true,
      scheduledNext: false,
    });
    expect((await conversationDoc(t, seed.conversationId))!.aiTurnLock).toBeDefined();

    const updatedAtBefore = (await conversationDoc(t, legacyId))!.updatedAt;
    const real = await t.mutation(internal.conversations.internalClearLegacyRuntimeFields, {
      dryRun: false,
    });
    expect(real).toMatchObject({ dryRun: false, cleared: 2, isDone: true, scheduledNext: false });
    expectNoLegacyFields(await conversationDoc(t, seed.conversationId));
    const legacy = await conversationDoc(t, legacyId);
    expectNoLegacyFields(legacy);
    expect(legacy!.updatedAt).toBe(updatedAtBefore);

    // Idempotente.
    const again = await t.mutation(internal.conversations.internalClearLegacyRuntimeFields, {
      dryRun: false,
    });
    expect(again.cleared).toBe(0);
  });
});

describe("cascata", () => {
  test("excluir a conversa apaga a linha de runtime", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await t.run(async (ctx) =>
      upsertRuntime(
        ctx,
        { organizationId: seed.organizationId, conversationId: seed.conversationId },
        {
          contactPresence: { state: "composing", at: Date.now() },
          nextDispatchAt: Date.now() + 6_500,
        }
      )
    );
    expect(await runtimeOf(t, seed.conversationId)).not.toBeNull();

    const done = await t.run(async (ctx) =>
      deleteConversationCascade(ctx, seed.conversationId, newBudget())
    );
    expect(done).toBe(true);
    expect(await conversationDoc(t, seed.conversationId)).toBeNull();
    expect(await runtimeOf(t, seed.conversationId)).toBeNull();
  });
});
