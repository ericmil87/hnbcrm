/// <reference types="vite/client" />
/**
 * Guardrail anti-bot do atendente (v0.65). Casos reais que originaram:
 *  - suporte oficial do WhatsApp: "Este atendimento foi encerrado…" ↔ "thanks for
 *    contacting WhatsApp Support. Your ticket number is …" em ping-pong com o
 *    Guardião por dias;
 *  - canal/newsletter do Google Gemini virando conversa 1 a 1 (resolvido no
 *    parser — teste em bridgeParse.test.ts).
 *
 * Prova que: a heurística para o atendente na 3ª rodada (repasse `bot_suspect`
 * + etiqueta + rastro na fila + webhook); o guard é desligável; a elegibilidade
 * segura com suspeita ativa; "Devolver para IA" e rejeitar o repasse limpam (e
 * zeram os contadores); a tool `flagAutomatedSender` marca com
 * `source:"model"` e DESCARTA o reply do mesmo turno.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { evaluateEligibility } from "./attendant";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const SEC = 1_000;
const DAY = 24 * 60 * 60 * SEC;
const ENCERRADO =
  "Este atendimento foi encerrado. Caso você tenha outras dúvidas, fale conosco novamente.";
const TICKET = (n: string) =>
  `Hi 👋, thanks for contacting WhatsApp Support. Your ticket number is ${n}. We'll respond as soon as possible.`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T15:00:00Z"));
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup() {
  return convexTest(schema, modules);
}

type ProfileExtra = Partial<NonNullable<Doc<"teamMembers">["agentProfile"]>>;

async function seedOrg(
  t: TestConvex<typeof schema>,
  opts: { mode?: "suggest" | "autopilot"; profile?: ProfileExtra } = {}
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Aos Filhos (teste)",
      slug: "aos-filhos-teste",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Guardião (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: { kind: "attendant", mode: opts.mode ?? "autopilot", ...(opts.profile ?? {}) },
      createdAt: now,
      updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: adminId } },
      },
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Número principal",
      phoneNumberId: "555000111",
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
      firstName: "WhatsApp Support",
      phone: "15517868409",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId,
      title: "WhatsApp Support",
      contactId,
      boardId,
      stageId,
      assignedTo: agentId,
      value: 0,
      currency: "BRL",
      priority: "medium",
      temperature: "warm",
      tags: ["whatsapp"],
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
    return { organizationId, adminUserId, adminId, agentId, leadId, conversationId };
  });
}

type Seed = Awaited<ReturnType<typeof seedOrg>>;

const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|s1` });

/** Avança o relógio e grava um inbound do contato; devolve o id. */
async function inbound(t: TestConvex<typeof schema>, seed: Seed, content: string, advanceMs: number) {
  vi.setSystemTime(Date.now() + advanceMs);
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

/** Simula a resposta já enviada pela IA (outbound `ai`). */
async function aiReply(t: TestConvex<typeof schema>, seed: Seed, content: string, advanceMs: number) {
  vi.setSystemTime(Date.now() + advanceMs);
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      leadId: seed.leadId,
      direction: "outbound",
      senderType: "ai",
      senderId: seed.agentId,
      content,
      contentType: "text",
      isInternal: false,
      createdAt: Date.now(),
    });
  });
}

async function enqueue(t: TestConvex<typeof schema>, messageId: Id<"messages">) {
  await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
}

/** As 3 rodadas reais: encerrado → (IA) → ticket instantâneo → (IA) → encerrado dias depois. */
async function playWhatsAppSupportLoop(t: TestConvex<typeof schema>, seed: Seed) {
  await enqueue(t, await inbound(t, seed, ENCERRADO, 0));
  await aiReply(t, seed, "Olá! Posso ajudar em algo?", 10 * SEC);
  await enqueue(t, await inbound(t, seed, TICKET("3044939135877292"), 2 * SEC));
  await aiReply(t, seed, "Essa mensagem parece automática 🙂", 8 * SEC);
  await enqueue(t, await inbound(t, seed, ENCERRADO, 8 * DAY));
}

async function state(t: TestConvex<typeof schema>, seed: Seed) {
  return await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(seed.conversationId))!;
    const lead = (await ctx.db.get(seed.leadId))!;
    const handoffs = await ctx.db
      .query("handoffs")
      .withIndex("by_lead", (q) => q.eq("leadId", seed.leadId))
      .collect();
    const queue = await ctx.db
      .query("aiReplyQueue")
      .withIndex("by_conversation_and_status", (q) => q.eq("conversationId", seed.conversationId))
      .collect();
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    const webhooks = jobs
      .filter((j) => j.name.includes("triggerWebhooks"))
      .map((j) => j.args[0] as { event: string; payload: Record<string, unknown> });
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", seed.conversationId))
      .collect();
    return { conversation, lead, handoffs, queue, webhooks, messages };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
describe("heurística no enqueue", () => {
  test("caso real WhatsApp Support: na 3ª rodada para, abre repasse, etiqueta e deixa rastro", async () => {
    const t = setup();
    const seed = await seedOrg(t);

    // Rodadas 1 e 2: ainda dentro do "tudo bem umas mensagens".
    await enqueue(t, await inbound(t, seed, ENCERRADO, 0));
    await aiReply(t, seed, "Olá! Posso ajudar em algo?", 10 * SEC);
    await enqueue(t, await inbound(t, seed, TICKET("3044939135877292"), 2 * SEC));
    let s = await state(t, seed);
    expect(s.conversation.botSuspicion).toBeUndefined();
    expect(s.handoffs).toHaveLength(0);
    expect(s.queue.filter((i) => i.status === "pending")).toHaveLength(1);

    // Rodada 3: dispara.
    await aiReply(t, seed, "Essa mensagem parece automática 🙂", 8 * SEC);
    const third = await inbound(t, seed, ENCERRADO, 8 * DAY);
    await enqueue(t, third);
    s = await state(t, seed);

    expect(s.conversation.botSuspicion).toMatchObject({ source: "heuristic", score: 5 });
    expect(s.conversation.botSuspicion!.signals).toContain("texto_repetido");
    expect(s.conversation.botSuspicion!.reason).toMatch(/texto repetido/);
    expect(s.lead.tags).toEqual(["whatsapp", "bot-suspeito"]);

    expect(s.handoffs).toHaveLength(1);
    expect(s.handoffs[0]).toMatchObject({
      status: "pending",
      conversationId: seed.conversationId,
      fromMemberId: seed.agentId,
      reason: "Possível robô/mensagem automática do outro lado",
      origin: "bot_suspect",
    });
    expect(s.handoffs[0].suggestedActions).toHaveLength(3);
    expect(s.lead.handoffState?.status).toBe("requested");

    const skipped = s.queue.filter((i) => i.status === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ error: "suspeita_de_bot", triggerMessageId: third });

    const suspected = s.webhooks.filter((w) => w.event === "conversation.bot_suspected");
    expect(suspected).toHaveLength(1);
    expect(suspected[0].payload).toMatchObject({
      conversationId: seed.conversationId,
      leadId: seed.leadId,
      source: "heuristic",
      score: 5,
      tag: "bot-suspeito",
    });
    expect(s.webhooks.some((w) => w.event === "handoff.requested")).toBe(true);

    // Audit + activity.
    const trail = await t.run(async (ctx) => ({
      audits: await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "conversation").eq("entityId", seed.conversationId))
        .collect(),
      activities: await ctx.db
        .query("activities")
        .withIndex("by_lead", (q) => q.eq("leadId", seed.leadId))
        .collect(),
    }));
    expect(trail.audits.some((a) => a.severity === "medium" && a.action === "update")).toBe(true);
    expect(trail.activities.some((a) => a.metadata?.botSuspicion === true)).toBe(true);

    // Próximo inbound: segue segurado, sem 2º repasse.
    await enqueue(t, await inbound(t, seed, TICKET("1111"), 3 * SEC));
    s = await state(t, seed);
    expect(s.handoffs).toHaveLength(1);
    expect(s.queue.filter((i) => i.status === "skipped").length).toBeGreaterThanOrEqual(2);
  });

  test("guard desligado (botGuard.enabled:false): mesmas mensagens, enfileira normalmente", async () => {
    const t = setup();
    const seed = await seedOrg(t, { profile: { botGuard: { enabled: false } } });
    await playWhatsAppSupportLoop(t, seed);
    const s = await state(t, seed);
    expect(s.conversation.botSuspicion).toBeUndefined();
    expect(s.handoffs).toHaveLength(0);
    expect(s.lead.tags).toEqual(["whatsapp"]);
    expect(s.queue.filter((i) => i.status === "pending")).toHaveLength(1);
    expect(s.queue.filter((i) => i.status === "skipped")).toHaveLength(0);
  });

  test("etiqueta custom (botGuard.tag) é a usada", async () => {
    const t = setup();
    const seed = await seedOrg(t, { profile: { botGuard: { tag: "robo" } } });
    await playWhatsAppSupportLoop(t, seed);
    const s = await state(t, seed);
    expect(s.lead.tags).toEqual(["whatsapp", "robo"]);
    expect(s.webhooks.find((w) => w.event === "conversation.bot_suspected")!.payload.tag).toBe("robo");
  });
});

describe("elegibilidade", () => {
  test("suspeita ativa → suspeita_de_bot; com clearedAt → ok", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await t.run(async (ctx) => {
      const org = await ctx.db.get(seed.organizationId);
      const agent = await ctx.db.get(seed.agentId);
      const conversation = (await ctx.db.get(seed.conversationId))!;
      const lead = await ctx.db.get(seed.leadId);
      const base = {
        org,
        agent,
        lead,
        contact: null,
        channelProvider: "meta" as const,
        aiReplyCountConversation: 0,
        aiReplyCountLastHour: 0,
        now: Date.now(),
      };
      const suspicion = { at: Date.now(), source: "heuristic" as const, reason: "x" };
      expect(evaluateEligibility({ ...base, conversation })).toEqual({ ok: true });
      expect(
        evaluateEligibility({ ...base, conversation: { ...conversation, botSuspicion: suspicion } })
      ).toEqual({ ok: false, reason: "suspeita_de_bot" });
      expect(
        evaluateEligibility({
          ...base,
          conversation: { ...conversation, botSuspicion: { ...suspicion, clearedAt: Date.now() } },
        })
      ).toEqual({ ok: true });
    });
  });
});

describe("limpeza pelo humano", () => {
  test("returnToAi limpa (clearedAt/clearedBy), remove a etiqueta e a rodada idêntica não re-dispara", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await playWhatsAppSupportLoop(t, seed);
    expect((await state(t, seed)).conversation.botSuspicion?.clearedAt).toBeUndefined();

    vi.setSystemTime(Date.now() + 60 * SEC);
    await asUser(t, seed.adminUserId).mutation(api.attendant.returnToAi, {
      conversationId: seed.conversationId,
    });
    let s = await state(t, seed);
    expect(s.conversation.botSuspicion?.clearedAt).toBe(Date.now());
    expect(s.conversation.botSuspicion?.clearedBy).toBe(seed.adminId);
    expect(s.conversation.botSuspicion?.source).toBe("heuristic"); // a prova original fica
    expect(s.lead.tags).toEqual(["whatsapp"]);
    expect(s.handoffs[0].status).toBe("canceled");
    expect(s.webhooks.some((w) => w.event === "conversation.bot_cleared")).toBe(true);

    // Mesma frase de novo: os contadores recomeçaram no clearedAt (1 ponto só).
    await enqueue(t, await inbound(t, seed, ENCERRADO, 5 * 60 * SEC));
    s = await state(t, seed);
    expect(s.conversation.botSuspicion?.clearedAt).toBeDefined();
    expect(s.handoffs.filter((h) => h.status === "pending")).toHaveLength(0);
    expect(s.queue.some((i) => i.status === "pending")).toBe(true);
  });

  test("rejeitar o repasse bot_suspect limpa igual", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await playWhatsAppSupportLoop(t, seed);
    const { handoffs } = await state(t, seed);

    await asUser(t, seed.adminUserId).mutation(api.handoffs.rejectHandoff, {
      handoffId: handoffs[0]._id,
    });
    const s = await state(t, seed);
    expect(s.conversation.botSuspicion?.clearedAt).toBeDefined();
    expect(s.conversation.botSuspicion?.clearedBy).toBe(seed.adminId);
    expect(s.lead.tags).toEqual(["whatsapp"]);
    expect(s.handoffs[0].status).toBe("rejected");
  });

  test("aceitar o repasse NÃO limpa (humano assumiu; etiqueta fica)", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await playWhatsAppSupportLoop(t, seed);
    const { handoffs } = await state(t, seed);
    await asUser(t, seed.adminUserId).mutation(api.handoffs.acceptHandoff, {
      handoffId: handoffs[0]._id,
    });
    const s = await state(t, seed);
    expect(s.conversation.botSuspicion?.clearedAt).toBeUndefined();
    expect(s.lead.tags).toContain("bot-suspeito");
  });
});

describe("tool flagAutomatedSender", () => {
  test("internalFlagAutomatedSender marca com source:model, etiqueta e abre repasse", async () => {
    const t = setup();
    const seed = await seedOrg(t, { profile: { botGuard: { tag: "robo" } } });
    const res = await t.mutation(internal.attendant.internalFlagAutomatedSender, {
      conversationId: seed.conversationId,
      leadId: seed.leadId,
      agentMemberId: seed.agentId,
      reason: "auto-resposta com número de ticket",
    });
    expect(res).toEqual({ applied: true });
    const s = await state(t, seed);
    expect(s.conversation.botSuspicion).toMatchObject({
      source: "model",
      reason: "auto-resposta com número de ticket",
    });
    expect(s.lead.tags).toContain("robo");
    expect(s.handoffs).toHaveLength(1);
    // Sem mensagem-gatilho: o caminho da tool não insere linha nova na fila.
    expect(s.queue).toHaveLength(0);

    // Idempotente: segunda marcação não regrava nem abre outro repasse.
    const again = await t.mutation(internal.attendant.internalFlagAutomatedSender, {
      conversationId: seed.conversationId,
      leadId: seed.leadId,
      agentMemberId: seed.agentId,
      reason: "outra",
    });
    expect(again).toEqual({ applied: false });
    expect((await state(t, seed)).handoffs).toHaveLength(1);
  });

  test("escopo: lead de outra conversa é recusado", async () => {
    const t = setup();
    const a = await seedOrg(t);
    const otherLead = await t.run(async (ctx) => {
      const lead = (await ctx.db.get(a.leadId))!;
      const { _id, _creationTime, ...rest } = lead;
      return await ctx.db.insert("leads", { ...rest, title: "Outro" });
    });
    await expect(
      t.mutation(internal.attendant.internalFlagAutomatedSender, {
        conversationId: a.conversationId,
        leadId: otherLead,
        agentMemberId: a.agentId,
        reason: "x",
      })
    ).rejects.toThrow(/Escopo/);
  });
});

// ── Runtime (LLM mockado) ──

type ToolCall = { name: string; args: Record<string, unknown> };

function stubLlm(turns: ToolCall[][]) {
  let call = 0;
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (!url.includes("/chat/completions")) throw new Error(`fetch inesperado: ${url}`);
    const tools = turns[Math.min(call, turns.length - 1)];
    const index = call++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: tools.map((tc, i) => ({
                id: `call_${index}_${i}`,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              })),
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function llmBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));
}

async function pendingItem(t: TestConvex<typeof schema>, seed: Seed, content: string) {
  await enqueue(t, await inbound(t, seed, content, 0));
  const item = await t.run(async (ctx) =>
    (await ctx.db.query("aiReplyQueue").collect()).find((i) => i.status === "pending")
  );
  expect(item).toBeTruthy();
  await t.run(async (ctx) => {
    await ctx.db.patch(item!._id, { nextAttemptAt: Date.now() - 1_000 });
  });
  return item!._id;
}

describe("runtime do turno", () => {
  for (const mode of ["autopilot", "suggest"] as const) {
    test(`${mode}: flagAutomatedSender + replyToCustomer no mesmo turno → reply DESCARTADO`, async () => {
      const t = setup();
      const seed = await seedOrg(t, { mode });
      const itemId = await pendingItem(t, seed, TICKET("42"));
      const fetchMock = stubLlm([
        [
          { name: "replyToCustomer", args: { text: "Oi! Recebi seu ticket." } },
          { name: "flagAutomatedSender", args: { reason: "auto-resposta de ticket" } },
        ],
      ]);
      await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });

      const body = llmBodies(fetchMock)[0];
      const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
      expect(names).toContain("flagAutomatedSender");
      expect(body.messages[0].content).toContain("ROBÔ DO OUTRO LADO");

      const s = await state(t, seed);
      // Nem envio, nem rascunho.
      expect(s.messages.filter((m) => m.direction !== "inbound")).toHaveLength(0);
      expect(s.conversation.botSuspicion).toMatchObject({ source: "model" });
      expect(s.conversation.aiTurnLock).toBeUndefined();
      const item = s.queue.find((i) => i._id === itemId)!;
      expect(item).toMatchObject({ status: "skipped", error: "suspeita_de_bot" });
      expect(s.handoffs).toHaveLength(1);
    });
  }

  test("guard desligado: tool não é oferecida e a REGRA 11 some do prompt", async () => {
    const t = setup();
    const seed = await seedOrg(t, { profile: { botGuard: { enabled: false } } });
    const itemId = await pendingItem(t, seed, "Oi");
    const fetchMock = stubLlm([[{ name: "replyToCustomer", args: { text: "Olá!" } }]]);
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const body = llmBodies(fetchMock)[0];
    const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(names).not.toContain("flagAutomatedSender");
    expect(body.messages[0].content).not.toContain("ROBÔ DO OUTRO LADO");
  });
});

describe("configuração", () => {
  test("updateAgentProfile valida e persiste botGuard; null volta ao padrão", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const admin = asUser(t, seed.adminUserId);
    await expect(
      admin.mutation(api.aiSettings.updateAgentProfile, {
        agentMemberId: seed.agentId,
        patch: { botGuard: { tag: "a,b" } },
      })
    ).rejects.toThrow(/vírgula/);
    await expect(
      admin.mutation(api.aiSettings.updateAgentProfile, {
        agentMemberId: seed.agentId,
        patch: { botGuard: { tag: "x".repeat(41) } },
      })
    ).rejects.toThrow(/40/);

    await admin.mutation(api.aiSettings.updateAgentProfile, {
      agentMemberId: seed.agentId,
      patch: { botGuard: { enabled: false, tag: "  robo  " } },
    });
    let agent = await t.run(async (ctx) => ctx.db.get(seed.agentId));
    expect(agent!.agentProfile!.botGuard).toEqual({ enabled: false, tag: "robo" });

    await admin.mutation(api.aiSettings.updateAgentProfile, {
      agentMemberId: seed.agentId,
      patch: { botGuard: null },
    });
    agent = await t.run(async (ctx) => ctx.db.get(seed.agentId));
    expect(agent!.agentProfile!.botGuard).toBeUndefined();
  });

  test("internalSetBotGuard: dryRun por padrão; real aplica a todos os atendentes da org", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const dry = await t.mutation(internal.aiSettings.internalSetBotGuard, {
      organizationId: seed.organizationId,
      enabled: false,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.agents[0].effective).toEqual({ enabled: false, tag: "bot-suspeito" });
    let agent = await t.run(async (ctx) => ctx.db.get(seed.agentId));
    expect(agent!.agentProfile!.botGuard).toBeUndefined();

    await t.mutation(internal.aiSettings.internalSetBotGuard, {
      organizationId: seed.organizationId,
      enabled: false,
      dryRun: false,
    });
    agent = await t.run(async (ctx) => ctx.db.get(seed.agentId));
    expect(agent!.agentProfile!.botGuard).toEqual({ enabled: false });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Correções do review de 02/10/2026
describe("review: correções", () => {
  const LONGA =
    "Oi! Então, eu queria entender melhor como funciona a inscrição para o encontro de sábado, " +
    "se tem estacionamento perto, se posso levar minha filha de 12 anos e se o pagamento pode ser " +
    "dividido no cartão em duas vezes, porque este mês está apertado para mim e para o meu marido.";

  test("1. lead de HUMANO + respostas longas rápidas → heurística nem roda (só o skip de elegibilidade)", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await t.run(async (ctx) => ctx.db.patch(seed.leadId, { assignedTo: seed.adminId }));
    // Outbounds da IA (de antes de o humano assumir) — sem outbound HUMANO no
    // meio, a fronteira de episódio não zera nada: o que segura é a ORDEM
    // (elegibilidade antes da heurística). Com a ordem antiga, isto disparava.
    for (let i = 0; i < 4; i++) {
      await aiReply(t, seed, `Pergunta ${i}`, 0);
      await enqueue(t, await inbound(t, seed, `${LONGA} (${i})`, 3 * SEC));
      vi.setSystemTime(Date.now() + 60 * SEC);
    }
    const s = await state(t, seed);
    expect(s.conversation.botSuspicion).toBeUndefined();
    expect(s.handoffs).toHaveLength(0);
    expect(s.lead.tags).toEqual(["whatsapp"]);
    expect(s.queue.every((i) => i.status === "skipped" && i.error === "lead_de_humano")).toBe(true);
  });

  test("1b. a mesma sequência com a IA dona do lead DISPARA (prova que o teste acima mede a ordem)", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    for (let i = 0; i < 2; i++) {
      await aiReply(t, seed, `Pergunta ${i}`, 0);
      await enqueue(t, await inbound(t, seed, LONGA, 3 * SEC));
      vi.setSystemTime(Date.now() + 60 * SEC);
    }
    expect((await state(t, seed)).conversation.botSuspicion?.source).toBe("heuristic");
  });

  test("3. rejeitar repasse que NÃO é bot_suspect não limpa a suspeita", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const handoffId = await t.run(async (ctx) => {
      await ctx.db.patch(seed.conversationId, {
        botSuspicion: { at: Date.now(), source: "heuristic", reason: "x" },
      });
      return await ctx.db.insert("handoffs", {
        organizationId: seed.organizationId,
        leadId: seed.leadId,
        conversationId: seed.conversationId,
        fromMemberId: seed.adminId,
        reason: "Outro assunto",
        suggestedActions: [],
        origin: "human",
        status: "pending",
        createdAt: Date.now(),
      });
    });
    await asUser(t, seed.adminUserId).mutation(api.handoffs.rejectHandoff, { handoffId });
    const s = await state(t, seed);
    expect(s.conversation.botSuspicion?.clearedAt).toBeUndefined();
  });

  test("4. rodada com flagAutomatedSender descarta TODAS as outras tools (lead e follow-up intactos)", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const itemId = await pendingItem(t, seed, TICKET("77"));
    const fetchMock = stubLlm([
      [
        { name: "updateThisLeadInfo", args: { title: "Robô do suporte", temperature: "hot" } },
        { name: "scheduleFollowUp", args: { title: "Cobrar ticket", dueAtLocal: "2026-09-20T10:00" } },
        { name: "replyToCustomer", args: { text: "Oi!" } },
        { name: "flagAutomatedSender", args: { reason: "ticket automático" } },
      ],
    ]);
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    expect(llmBodies(fetchMock)).toHaveLength(1);
    const s = await state(t, seed);
    expect(s.lead.title).toBe("WhatsApp Support");
    expect(s.lead.temperature).toBe("warm");
    const extra = await t.run(async (ctx) => ({
      followUps: await ctx.db.query("aiFollowUps").collect(),
      tasks: await ctx.db.query("tasks").collect(),
      runs: await ctx.db.query("agentRuns").collect(),
    }));
    expect(extra.followUps).toHaveLength(0);
    expect(extra.tasks).toHaveLength(0);
    expect(extra.runs[0].toolCallNames).toEqual(["flagAutomatedSender"]);
    expect(s.conversation.botSuspicion?.source).toBe("model");
    expect(s.queue.find((i) => i._id === itemId)).toMatchObject({ error: "suspeita_de_bot" });
  });

  test("5. falha da marcação LANÇA → caminho de retry (não vira skipped/suspeita_de_bot)", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const itemId = await pendingItem(t, seed, TICKET("88"));
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // Durante a geração, a conversa troca de lead: o escopo da mutation falha.
        if (call++ === 0) {
          await t.run(async (ctx) => {
            const lead = (await ctx.db.get(seed.leadId))!;
            const { _id, _creationTime, ...rest } = lead;
            const other = await ctx.db.insert("leads", { ...rest, title: "Outro" });
            await ctx.db.patch(seed.conversationId, { leadId: other });
          });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: { name: "flagAutomatedSender", arguments: '{"reason":"x"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const s = await state(t, seed);
    expect(s.conversation.botSuspicion).toBeUndefined();
    const item = s.queue.find((i) => i._id === itemId)!;
    expect(item.error).not.toBe("suspeita_de_bot");
    expect(item.error).toMatch(/Escopo/);
    expect(item.attempts).toBeGreaterThanOrEqual(1);
    expect(["pending", "failed"]).toContain(item.status);
  });

  test("6. updateAgentProfile e internalSetBotGuard fazem MERGE; tag vazia volta à padrão", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const admin = asUser(t, seed.adminUserId);
    const guard = async () => (await t.run(async (ctx) => ctx.db.get(seed.agentId)))!.agentProfile!.botGuard;

    await admin.mutation(api.aiSettings.updateAgentProfile, {
      agentMemberId: seed.agentId,
      patch: { botGuard: { tag: "robo" } },
    });
    await admin.mutation(api.aiSettings.updateAgentProfile, {
      agentMemberId: seed.agentId,
      patch: { botGuard: { enabled: false } },
    });
    expect(await guard()).toEqual({ enabled: false, tag: "robo" });
    await admin.mutation(api.aiSettings.updateAgentProfile, {
      agentMemberId: seed.agentId,
      patch: { botGuard: { tag: "" } },
    });
    expect(await guard()).toEqual({ enabled: false });

    await t.mutation(internal.aiSettings.internalSetBotGuard, {
      organizationId: seed.organizationId,
      tag: "maquina",
      dryRun: false,
    });
    expect(await guard()).toEqual({ enabled: false, tag: "maquina" });
    await t.mutation(internal.aiSettings.internalSetBotGuard, {
      organizationId: seed.organizationId,
      tag: "",
      dryRun: false,
    });
    expect(await guard()).toEqual({ enabled: false });
  });

  test("7. returnToAi limpa mesmo com o doc da conversa alterado antes na transação", async () => {
    // returnToAi despausa ANTES de limpar: com a pausa ativa, o doc lido no
    // início já está velho quando clearBotSuspicion roda.
    const t = setup();
    const seed = await seedOrg(t);
    await playWhatsAppSupportLoop(t, seed);
    await t.run(async (ctx) => ctx.db.patch(seed.conversationId, { aiPausedUntil: Date.now() + DAY }));
    await asUser(t, seed.adminUserId).mutation(api.attendant.returnToAi, {
      conversationId: seed.conversationId,
    });
    const s = await state(t, seed);
    expect(s.conversation.aiPausedUntil).toBeUndefined();
    expect(s.conversation.botSuspicion?.clearedAt).toBeDefined();
  });

  test("8. internalRequestHandoff (REST/MCP/runtime) recusa origin bot_suspect", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await expect(
      t.mutation(internal.handoffs.internalRequestHandoff, {
        leadId: seed.leadId,
        reason: "x",
        suggestedActions: [],
        teamMemberId: seed.adminId,
        origin: "bot_suspect" as never,
      })
    ).rejects.toThrow();
    const ok = await t.mutation(internal.handoffs.internalRequestHandoff, {
      leadId: seed.leadId,
      reason: "x",
      suggestedActions: [],
      teamMemberId: seed.adminId,
    });
    const doc = await t.run(async (ctx) => ctx.db.get(ok));
    expect(doc!.origin).toBe("human");
  });
});
