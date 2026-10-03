/// <reference types="vite/client" />
/**
 * Medidor de custo de IA + teto em R$ (v0.69, T04) — integração com convex-test.
 *
 * Prova que: o contador mensal é incrementado em `internalFinishRun` por kind
 * (e é idempotente por run); `getAiUsage` lê o contador (não varre
 * `agentRuns`); o aviso de 80% e o de teto saem 1×/mês; o teto em `block`
 * deixa o atendente em RASCUNHO e abre o repasse `ai_budget` uma vez; o
 * `monthlyConversationBudget` estourado abre repasse em vez de ficar mudo; os
 * demais produtos recebem o gate; o validator público recusa `ai_budget`; o
 * backfill em dryRun não escreve.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const MONTH = "2026-10";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T15:00:00Z"));
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

type AiConfigExtra = Partial<NonNullable<Doc<"organizations">["settings"]["aiConfig"]>>;

async function seedOrg(t: TestConvex<typeof schema>, aiExtra: AiConfigExtra = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Teto",
      slug: "org-teto",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", { email: "admin@empresa-teste.com.br" });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      email: "admin@empresa-teste.com.br",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const agentUserId = await ctx.db.insert("users", { email: "agente@empresa-teste.com.br" });
    const humanAgentId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: agentUserId,
      name: "Atendente humano",
      role: "agent",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Assistente (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: { kind: "attendant", mode: "autopilot" },
      createdAt: now,
      updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...org.settings.aiConfig!,
          lgpdAck: { acceptedAt: now, acceptedBy: adminId },
          ...aiExtra,
        },
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
    const makeLead = async (name: string, phone: string) => {
      const contactId = await ctx.db.insert("contacts", {
        organizationId,
        firstName: name,
        phone,
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
      const leadId = await ctx.db.insert("leads", {
        organizationId,
        title: name,
        contactId,
        boardId,
        stageId,
        assignedTo: agentId,
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
      return { leadId, conversationId };
    };
    const a = await makeLead("Cliente A", "5585999990001");
    const b = await makeLead("Cliente B", "5585999990002");
    return { organizationId, adminUserId, adminId, humanAgentId, agentId, a, b };
  });
}

type Seed = Awaited<ReturnType<typeof seedOrg>>;
type LeadRef = Seed["a"];

const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|s1` });

/** Inbound do cliente → enfileira → passa o debounce; devolve o item pendente. */
async function inboundAndSettle(t: TestConvex<typeof schema>, seed: Seed, lead: LeadRef, content = "Oi") {
  const messageId = await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(lead.conversationId, { lastInboundAt: now });
    return await ctx.db.insert("messages", {
      organizationId: seed.organizationId,
      conversationId: lead.conversationId,
      leadId: lead.leadId,
      direction: "inbound",
      senderType: "contact",
      content,
      contentType: "text",
      isInternal: false,
      createdAt: now,
    });
  });
  await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
  vi.setSystemTime(Date.now() + 10_000);
  return await t.run(async (ctx) =>
    (
      await ctx.db
        .query("aiReplyQueue")
        .withIndex("by_conversation_and_status", (q) =>
          q.eq("conversationId", lead.conversationId).eq("status", "pending")
        )
        .collect()
    )[0]
  );
}

async function usageDoc(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("aiUsageMonthly")
      .withIndex("by_organization_and_month", (q) =>
        q.eq("organizationId", organizationId).eq("month", MONTH)
      )
      .unique()
  );
}

async function setCounter(
  t: TestConvex<typeof schema>,
  organizationId: Id<"organizations">,
  fields: Partial<Doc<"aiUsageMonthly">>
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("aiUsageMonthly", {
      organizationId,
      month: MONTH,
      costUsdMicros: 0,
      runs: 0,
      byKind: {},
      updatedAt: Date.now(),
      ...fields,
    });
  });
}

async function finishRun(
  t: TestConvex<typeof schema>,
  seed: Seed,
  kind: "attendant" | "copilot" | "vision" | "group_post",
  costUsd: number
) {
  const runId = await t.mutation(internal.agentRuns.internalStartRun, {
    organizationId: seed.organizationId,
    memberId: kind === "copilot" ? seed.adminId : seed.agentId,
    kind,
  });
  await t.mutation(internal.agentRuns.internalFinishRun, {
    runId,
    status: "done",
    promptTokens: 1000,
    completionTokens: 100,
    costUsdEstimate: costUsd,
  });
  return runId;
}

async function handoffsOf(t: TestConvex<typeof schema>, leadId: Id<"leads">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("handoffs")
      .withIndex("by_lead", (q) => q.eq("leadId", leadId))
      .collect()
  );
}

// ═══════════════════════════════════════════════════════════════════════════
describe("contador mensal (internalFinishRun)", () => {
  test("incrementa por kind para atendente, copiloto, visão e publicação", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await finishRun(t, seed, "attendant", 0.01);
    await finishRun(t, seed, "attendant", 0.02);
    await finishRun(t, seed, "copilot", 0.005);
    await finishRun(t, seed, "vision", 0.0004);
    await finishRun(t, seed, "group_post", 0.001);

    const doc = (await usageDoc(t, seed.organizationId))!;
    expect(doc.runs).toBe(5);
    expect(doc.costUsdMicros).toBe(30_000 + 5_000 + 400 + 1_000);
    expect(doc.byKind).toEqual({
      attendant: { runs: 2, costUsdMicros: 30_000 },
      copilot: { runs: 1, costUsdMicros: 5_000 },
      vision: { runs: 1, costUsdMicros: 400 },
      group_post: { runs: 1, costUsdMicros: 1_000 },
    });
    expect(doc.promptTokens).toBe(5000);
    expect(doc.completionTokens).toBe(500);
  });

  test("idempotente por run: 2º finish só soma a diferença e não recontabiliza a run", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const runId = await finishRun(t, seed, "attendant", 0.01);
    await t.mutation(internal.agentRuns.internalFinishRun, {
      runId,
      status: "error",
      promptTokens: 1000,
      completionTokens: 100,
      costUsdEstimate: 0.015,
      error: "falhou depois",
    });
    // Sem custo novo: não muda nada.
    await t.mutation(internal.agentRuns.internalFinishRun, { runId, status: "error" });
    const doc = (await usageDoc(t, seed.organizationId))!;
    expect(doc.runs).toBe(1);
    expect(doc.costUsdMicros).toBe(15_000);
    expect(doc.byKind.attendant).toEqual({ runs: 1, costUsdMicros: 15_000 });
  });

  test("costEstimated é gravado na run e contado no mês", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const runId = await t.mutation(internal.agentRuns.internalStartRun, {
      organizationId: seed.organizationId,
      memberId: seed.agentId,
      kind: "attendant",
    });
    await t.mutation(internal.agentRuns.internalFinishRun, {
      runId,
      status: "done",
      costUsdEstimate: 0.5,
      costEstimated: true,
    });
    const run = await t.run(async (ctx) => ctx.db.get(runId));
    expect(run!.costEstimated).toBe(true);
    expect((await usageDoc(t, seed.organizationId))!.estimatedRuns).toBe(1);
  });
});

describe("getAiUsage lê 1 documento", () => {
  test("ignora agentRuns soltas e reflete o contador + teto em R$", async () => {
    const t = setup();
    const seed = await seedOrg(t, {
      spendCap: { mode: "warn", monthlyBrl: 55, usdBrlRate: 5.5 },
      providerConfig: {
        mode: "byo",
        zdr: true,
        models: { copilot: "kimi-k2.7-code", attendant: "deepseek-v4-flash", classify: "deepseek-v4-flash" },
      },
    });
    // Run gravada DIRETO (sem passar pelo contador): se a query varresse
    // agentRuns, ela apareceria no total.
    await t.run(async (ctx) => {
      await ctx.db.insert("agentRuns", {
        organizationId: seed.organizationId,
        memberId: seed.agentId,
        kind: "attendant",
        status: "done",
        requestCount: 1,
        costUsdEstimate: 99,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      });
    });
    const user = asUser(t, seed.adminUserId);
    let usage = await user.query(api.aiSettings.getAiUsage, {
      organizationId: seed.organizationId,
      month: MONTH,
    });
    expect(usage.costUsdEstimate).toBe(0);
    expect(usage.runsThisMonth).toBe(0);
    expect(usage.byo).toBe(true);

    await setCounter(t, seed.organizationId, {
      costUsdMicros: 8_000_000,
      runs: 7,
      conversations: 3,
      byKind: { copilot: { runs: 7, costUsdMicros: 8_000_000 } },
    });
    usage = await user.query(api.aiSettings.getAiUsage, {
      organizationId: seed.organizationId,
      month: MONTH,
    });
    expect(usage).toMatchObject({
      month: MONTH,
      runsThisMonth: 7,
      conversationsThisMonth: 3,
      costUsdEstimate: 8,
      level: "warn",
      blocked: false,
    });
    expect(usage.costBrl).toBeCloseTo(44, 6);
    expect(usage.pct).toBeCloseTo(80, 6);

    // Argumento legado (monthStart) continua aceito.
    const legacy = await user.query(api.aiSettings.getAiUsage, {
      organizationId: seed.organizationId,
      monthStart: Date.UTC(2026, 9, 1),
    });
    expect(legacy.runsThisMonth).toBe(7);
  });
});

describe("avisos 1×/mês", () => {
  test("80% notifica os admins UMA vez; teto atingido notifica UMA vez", async () => {
    const t = setup();
    const seed = await seedOrg(t, { spendCap: { mode: "warn", monthlyBrl: 55, usdBrlRate: 5.5 } }); // US$ 10

    await finishRun(t, seed, "attendant", 7); // 70%
    await finishRun(t, seed, "copilot", 1.5); // 85% → aviso
    await finishRun(t, seed, "attendant", 0.5); // 90% → nada novo
    await finishRun(t, seed, "vision", 2); // 110% → teto
    await finishRun(t, seed, "attendant", 3); // 140% → nada novo

    const state = await t.run(async (ctx) => {
      const notifications = await ctx.db
        .query("notifications")
        .withIndex("by_organization", (q) => q.eq("organizationId", seed.organizationId))
        .collect();
      const jobs = await ctx.db.system.query("_scheduled_functions").collect();
      const emails = jobs
        .filter((j) => j.name.includes("dispatchNotification"))
        .map((j) => j.args[0] as { eventType: string; recipientMemberId: string; templateData: Record<string, unknown> });
      return { notifications, emails };
    });
    const warn = state.notifications.filter((n) => n.type === "ai_spend_warning");
    const reached = state.notifications.filter((n) => n.type === "ai_spend_reached");
    // Só o ADMIN (settings:manage) — o atendente humano não recebe.
    expect(warn.map((n) => n.memberId)).toEqual([seed.adminId]);
    expect(reached.map((n) => n.memberId)).toEqual([seed.adminId]);
    const spendEmails = state.emails.filter((e) => e.eventType === "aiSpendAlert");
    expect(spendEmails).toHaveLength(2);
    expect(spendEmails.map((e) => e.templateData.level)).toEqual(["warn", "reached"]);
    expect(spendEmails.every((e) => e.recipientMemberId === seed.adminId)).toBe(true);

    const doc = (await usageDoc(t, seed.organizationId))!;
    expect(doc.warnedAt).toBeDefined();
    expect(doc.reachedAt).toBeDefined();
  });

  test("sem teto definido (spendCap ausente) nada é avisado", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await finishRun(t, seed, "attendant", 500);
    const notifications = await t.run(async (ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_organization", (q) => q.eq("organizationId", seed.organizationId))
        .collect()
    );
    expect(notifications).toHaveLength(0);
  });

  test("o template de e-mail existe e não é vazio (fail-closed)", async () => {
    const { buildTemplate } = await import("./emailTemplates");
    const tpl = buildTemplate("aiSpendAlert", {
      level: "reached",
      orgName: "<b>Org</b>",
      month: MONTH,
      costBrl: "R$ 60,00",
      capBrl: "R$ 55,00",
      pct: 109,
      mode: "block",
    });
    expect(tpl.subject).toMatch(/Teto de gastos de IA atingido/);
    expect(tpl.html).toContain("&lt;b&gt;Org&lt;/b&gt;");
    expect(tpl.html).toContain("RASCUNHO");
  });
});

describe("atendente 1 a 1 com teto em R$ em `block`", () => {
  test("vira RASCUNHO e abre repasse ai_budget UMA vez no mês", async () => {
    const t = setup();
    const seed = await seedOrg(t, { spendCap: { mode: "block", monthlyBrl: 55, usdBrlRate: 5.5 } });
    await setCounter(t, seed.organizationId, { costUsdMicros: 10_000_000 });

    const item = await inboundAndSettle(t, seed, seed.a);
    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-teto-1",
    });
    expect(claim.kind).toBe("run");
    expect((claim as { context: { forceSuggest: boolean; mode: string } }).context.forceSuggest).toBe(true);
    expect((claim as { context: { mode: string } }).context.mode).toBe("autopilot");

    let handoffs = await handoffsOf(t, seed.a.leadId);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      origin: "ai_budget",
      status: "pending",
      conversationId: seed.a.conversationId,
      fromMemberId: seed.agentId,
    });
    expect(handoffs[0].reason).toMatch(/Teto de gastos/);

    // O rascunho é GRAVADO mesmo com o repasse `ai_budget` pendente: o commit
    // de sugestão não re-checa `handoff_pendente`.
    const ctx1 = (claim as { context: { agentRunId: Id<"agentRuns"> } }).context;
    const commit = await t.mutation(internal.attendant.internalCommitAiSuggestion, {
      queueItemId: item._id,
      conversationId: seed.a.conversationId,
      agentMemberId: seed.agentId,
      runId: "run-teto-1",
      agentRunId: ctx1.agentRunId,
      text: "Oi! Já te respondo.",
      proposedActions: [],
      needsDisclosure: false,
      disclosure: "",
    });
    expect(commit.committed).toBe(true);
    const draft = await t.run(async (ctx) =>
      commit.committed ? ctx.db.get(commit.messageId) : null
    );
    expect(draft).toMatchObject({ isInternal: true, content: "Oi! Já te respondo." });
    expect((draft!.metadata?.aiDraft as { status?: string } | undefined)?.status).toBe("pending");
    expect((await handoffsOf(t, seed.a.leadId))[0].status).toBe("pending");

    // Humano devolve à IA (repasse resolvido) e o cliente escreve de novo:
    // continua em rascunho, SEM um 2º repasse no mês.
    await t.run(async (ctx) => {
      await ctx.db.patch(handoffs[0]._id, { status: "rejected" });
      await ctx.db.patch(seed.a.leadId, { handoffState: undefined });
      await ctx.db.patch(seed.a.conversationId, { aiTurnLock: undefined });
      await ctx.db.patch(item._id, { status: "done" });
    });
    const item2 = await inboundAndSettle(t, seed, seed.a, "Ainda está aí?");
    const claim2 = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item2._id,
      runId: "run-teto-2",
    });
    expect(claim2.kind).toBe("run");
    expect((claim2 as { context: { forceSuggest: boolean } }).context.forceSuggest).toBe(true);
    handoffs = await handoffsOf(t, seed.a.leadId);
    expect(handoffs).toHaveLength(1);
  });

  test("modo warn com teto estourado: segue em autopilot, sem repasse", async () => {
    const t = setup();
    const seed = await seedOrg(t, { spendCap: { mode: "warn", monthlyBrl: 55, usdBrlRate: 5.5 } });
    await setCounter(t, seed.organizationId, { costUsdMicros: 20_000_000 });
    const item = await inboundAndSettle(t, seed, seed.a);
    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-warn",
    });
    expect((claim as { context: { forceSuggest: boolean } }).context.forceSuggest).toBe(false);
    expect(await handoffsOf(t, seed.a.leadId)).toHaveLength(0);
  });

  test("demais produtos: internalSpendGate bloqueia só em block + teto estourado", async () => {
    const t = setup();
    const seed = await seedOrg(t, { spendCap: { mode: "block", monthlyBrl: 55, usdBrlRate: 5.5 } });
    let gate = await t.query(internal.aiSpend.internalSpendGate, {
      organizationId: seed.organizationId,
      month: MONTH,
    });
    expect(gate).toEqual({ blocked: false, reason: null });
    await setCounter(t, seed.organizationId, { costUsdMicros: 10_000_000 });
    gate = await t.query(internal.aiSpend.internalSpendGate, {
      organizationId: seed.organizationId,
      month: MONTH,
    });
    expect(gate).toEqual({ blocked: true, reason: "teto_de_gastos" });
    // Outro mês: zera.
    gate = await t.query(internal.aiSpend.internalSpendGate, {
      organizationId: seed.organizationId,
      month: "2026-11",
    });
    expect(gate.blocked).toBe(false);
  });
});

describe("monthlyConversationBudget (teto por conversas)", () => {
  test("conversa NOVA além do teto: item budget_mensal + repasse ai_budget (não mais mudo)", async () => {
    const t = setup();
    const seed = await seedOrg(t, { monthlyConversationBudget: 1 });
    await setCounter(t, seed.organizationId, { conversations: 1 });

    const item = await inboundAndSettle(t, seed, seed.b);
    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-budget",
    });
    expect(claim).toEqual({ kind: "skip", reason: "budget_mensal" });
    const after = await t.run(async (ctx) => ctx.db.get(item._id));
    expect(after).toMatchObject({ status: "skipped", error: "budget_mensal" });

    const handoffs = await handoffsOf(t, seed.b.leadId);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ origin: "ai_budget", status: "pending" });
    expect(handoffs[0].reason).toMatch(/Limite mensal de conversas/);
  });

  test("conversa já atendida no mês continua sendo atendida; conversa nova conta 1 vez", async () => {
    const t = setup();
    const seed = await seedOrg(t, { monthlyConversationBudget: 1 });

    // 1ª conversa: cabe no teto e passa a contar.
    const first = await inboundAndSettle(t, seed, seed.a);
    expect(
      (await t.mutation(internal.attendant.internalClaimForProcessing, { queueItemId: first._id, runId: "r1" })).kind
    ).toBe("run");
    expect((await usageDoc(t, seed.organizationId))!.conversations).toBe(1);

    // Mesma conversa de novo: já atendida no mês → passa e não conta outra vez.
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.a.conversationId, { aiTurnLock: undefined });
      await ctx.db.patch(first._id, { status: "done" });
    });
    const again = await inboundAndSettle(t, seed, seed.a, "Mais uma dúvida");
    expect(
      (await t.mutation(internal.attendant.internalClaimForProcessing, { queueItemId: again._id, runId: "r2" })).kind
    ).toBe("run");
    expect((await usageDoc(t, seed.organizationId))!.conversations).toBe(1);

    // Conversa B: estoura.
    const other = await inboundAndSettle(t, seed, seed.b);
    expect(
      await t.mutation(internal.attendant.internalClaimForProcessing, { queueItemId: other._id, runId: "r3" })
    ).toEqual({ kind: "skip", reason: "budget_mensal" });
  });
});

describe("origem ai_budget é só do core", () => {
  test("validator de internalRequestHandoff (REST/MCP/runtime) recusa ai_budget", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await expect(
      t.mutation(internal.handoffs.internalRequestHandoff, {
        leadId: seed.a.leadId,
        reason: "forjado",
        suggestedActions: [],
        teamMemberId: seed.agentId,
        origin: "ai_budget",
      } as never)
    ).rejects.toThrow();
    expect(await handoffsOf(t, seed.a.leadId)).toHaveLength(0);
  });
});

describe("setSpendCap (validação no servidor)", () => {
  test("grava, recusa faixas inválidas e audita", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const user = asUser(t, seed.adminUserId);
    await user.mutation(api.aiSettings.setSpendCap, {
      organizationId: seed.organizationId,
      mode: "block",
      monthlyBrl: 200,
      usdBrlRate: 5.4,
      warnPct: 75,
    });
    const org = await t.run(async (ctx) => ctx.db.get(seed.organizationId));
    expect(org!.settings.aiConfig!.spendCap).toEqual({
      mode: "block",
      monthlyBrl: 200,
      usdBrlRate: 5.4,
      warnPct: 75,
    });
    // MERGE: só o modo não zera teto/cotação/aviso.
    await user.mutation(api.aiSettings.setSpendCap, {
      organizationId: seed.organizationId,
      mode: "warn",
    });
    const merged = await t.run(async (ctx) => ctx.db.get(seed.organizationId));
    expect(merged!.settings.aiConfig!.spendCap).toEqual({
      mode: "warn",
      monthlyBrl: 200,
      usdBrlRate: 5.4,
      warnPct: 75,
    });
    // null limpa só o campo pedido.
    await user.mutation(api.aiSettings.setSpendCap, {
      organizationId: seed.organizationId,
      mode: "block",
      warnPct: null,
    });
    const cleared = await t.run(async (ctx) => ctx.db.get(seed.organizationId));
    expect(cleared!.settings.aiConfig!.spendCap).toEqual({
      mode: "block",
      monthlyBrl: 200,
      usdBrlRate: 5.4,
    });
    await expect(
      user.mutation(api.aiSettings.setSpendCap, {
        organizationId: seed.organizationId,
        mode: "warn",
        usdBrlRate: 25,
      })
    ).rejects.toThrow(/cotação/);
    await expect(
      user.mutation(api.aiSettings.setSpendCap, {
        organizationId: seed.organizationId,
        mode: "warn",
        warnPct: 99,
      })
    ).rejects.toThrow(/aviso/);
    await expect(
      user.mutation(api.aiSettings.setSpendCap, {
        organizationId: seed.organizationId,
        mode: "warn",
        monthlyBrl: -5,
      })
    ).rejects.toThrow(/negativo/);
    // Atendente humano (sem settings:manage) não altera.
    const agentUserId = await t.run(async (ctx) => (await ctx.db.get(seed.humanAgentId))!.userId!);
    await expect(
      asUser(t, agentUserId).mutation(api.aiSettings.setSpendCap, {
        organizationId: seed.organizationId,
        mode: "off",
      })
    ).rejects.toThrow();
    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_organization", (q) => q.eq("organizationId", seed.organizationId))
        .collect()
    );
    expect(audits.some((a) => a.severity === "high" && /teto de gastos/.test(a.description ?? ""))).toBe(true);

    // Mudar o teto no meio do mês rearma os avisos (régua nova).
    await setCounter(t, seed.organizationId, { warnedAt: 1, reachedAt: 2 });
    await user.mutation(api.aiSettings.setSpendCap, {
      organizationId: seed.organizationId,
      mode: "block",
      monthlyBrl: 400,
    });
    const doc = (await usageDoc(t, seed.organizationId))!;
    expect(doc.warnedAt).toBeUndefined();
    expect(doc.reachedAt).toBeUndefined();
  });
});

describe("backfill do contador", () => {
  async function seedRuns(t: TestConvex<typeof schema>, seed: Seed) {
    await t.run(async (ctx) => {
      const now = Date.now();
      const base = {
        organizationId: seed.organizationId,
        status: "done" as const,
        requestCount: 1,
        startedAt: now,
        finishedAt: now,
      };
      await ctx.db.insert("agentRuns", {
        ...base,
        memberId: seed.agentId,
        kind: "attendant",
        conversationId: seed.a.conversationId,
        model: "deepseek-v4-flash",
        promptTokens: 1_000_000,
        completionTokens: 0,
        costUsdEstimate: 0.14, // preço fixo antigo (maior que a tabela nova)
      });
      // Copiloto antigo: sem custo gravado → re-estimado pelos tokens.
      await ctx.db.insert("agentRuns", {
        ...base,
        memberId: seed.adminId,
        kind: "copilot",
        model: "kimi-k2.7-code",
        promptTokens: 1_000_000,
        completionTokens: 0,
      });
      // Mês anterior: fora.
      await ctx.db.insert("agentRuns", {
        ...base,
        memberId: seed.agentId,
        kind: "attendant",
        startedAt: Date.UTC(2026, 8, 20),
        costUsdEstimate: 5,
      });
    });
  }

  test("dryRun (default) não escreve; real grava o recalculado", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await seedRuns(t, seed);

    const dry = await t.mutation(internal.aiSpend.internalBackfillMonthlyUsage, {
      organizationId: seed.organizationId,
      month: MONTH,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.written).toBe(false);
    expect(dry.computed).toMatchObject({ runs: 2, conversations: 1 });
    // flash: max(gravado 0,14; tabela 0,132) + copiloto kimi-k2.7-code 0,95 (tabela)
    expect(dry.computed?.costUsdMicros).toBe(140_000 + 950_000);
    expect(await usageDoc(t, seed.organizationId)).toBeNull();

    await t.mutation(internal.aiSpend.internalBackfillMonthlyUsage, {
      organizationId: seed.organizationId,
      month: MONTH,
      dryRun: false,
    });
    const doc = (await usageDoc(t, seed.organizationId))!;
    expect(doc.costUsdMicros).toBe(1_090_000);
    expect(doc.runs).toBe(2);
    expect(doc.conversations).toBe(1);
    expect(doc.byKind.copilot).toEqual({ runs: 1, costUsdMicros: 950_000 });
  });

  test("mês inválido é recusado", async () => {
    const t = setup();
    await expect(
      t.mutation(internal.aiSpend.internalBackfillMonthlyUsage, { month: "10/2026" })
    ).rejects.toThrow(/Mês inválido/);
  });
});
