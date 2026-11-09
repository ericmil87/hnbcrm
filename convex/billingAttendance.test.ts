/// <reference types="vite/client" />
/**
 * Billing B2: o atendimento IA é o CONTATO distinto no mês, gravado no commit
 * (resposta ou rascunho) pelo livro `aiAttendances`.
 *
 *  - contato em 2 conversas/canais conta 1;
 *  - claim sozinho e run com erro não contam; rascunho conta; simulador não conta;
 *  - org legacy com `monthlyConversationBudget` dispara no mesmo ponto ou DEPOIS;
 *  - backfill não dobra o contador; salvaguarda do mês da virada.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { clearRuntimeField } from "./lib/conversationRuntime";
import { recordAttendance } from "./lib/attendanceLedger";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;
const MONTH = "2026-10";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T15:00:00Z"));
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Conv = { leadId: Id<"leads">; conversationId: Id<"conversations"> };

async function seed(budget?: number, billing?: Doc<"organizations">["billing"]) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Medicao",
      slug: "org-medicao",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 0.8,
          ...(budget !== undefined ? { monthlyConversationBudget: budget } : {}),
        },
      },
      ...(billing ? { billing } : {}),
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
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Assistente (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" },
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
    const makeContact = async (name: string, phone: string) =>
      await ctx.db.insert("contacts", {
        organizationId,
        firstName: name,
        phone,
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
    const makeLead = async (title: string, contactId: Id<"contacts">): Promise<Conv> => {
      const leadId = await ctx.db.insert("leads", {
        organizationId,
        title,
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
    const contactA = await makeContact("Cliente A", "5585999990001");
    const contactB = await makeContact("Cliente B", "5585999990002");
    // Mesmo contato em dois leads/conversas (ex.: WhatsApp e Instagram).
    const a1 = await makeLead("A canal 1", contactA);
    const a2 = await makeLead("A canal 2", contactA);
    const b = await makeLead("B", contactB);
    return { organizationId, agentId, adminId, a1, a2, b };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function inboundAndSettle(s: Seed, c: Conv) {
  const messageId = await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(c.conversationId, { lastInboundAt: now });
    return await ctx.db.insert("messages", {
      organizationId: s.organizationId,
      conversationId: c.conversationId,
      leadId: c.leadId,
      direction: "inbound",
      senderType: "contact",
      content: "Oi",
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
        .withIndex("by_conversation_and_status", (q) => q.eq("conversationId", c.conversationId).eq("status", "pending"))
        .collect()
    )[0]
  );
}

async function claim(s: Seed, c: Conv, runId: string) {
  const item = await inboundAndSettle(s, c);
  const res = await t.mutation(internal.attendant.internalClaimForProcessing, { queueItemId: item._id, runId });
  return { item, res };
}

/** Commit de RASCUNHO (modo sugestão): persiste a nota interna e conta o atendimento. */
async function commitSuggestion(s: Seed, c: Conv, item: Doc<"aiReplyQueue">, runId: string, agentRunId: Id<"agentRuns">) {
  return await t.mutation(internal.attendant.internalCommitAiSuggestion, {
    queueItemId: item._id,
    conversationId: c.conversationId,
    agentMemberId: s.agentId,
    runId,
    agentRunId,
    text: "Rascunho de resposta",
    proposedActions: [],
    needsDisclosure: false,
    disclosure: "",
  });
}

const ledger = (organizationId: Id<"organizations">, month = MONTH) =>
  t.run((ctx) =>
    ctx.db
      .query("aiAttendances")
      .withIndex("by_organization_and_month_and_billing", (q) => q.eq("organizationId", organizationId).eq("month", month))
      .collect()
  );
const usage = (organizationId: Id<"organizations">, month = MONTH) =>
  t.run((ctx) =>
    ctx.db
      .query("aiUsageMonthly")
      .withIndex("by_organization_and_month", (q) => q.eq("organizationId", organizationId).eq("month", month))
      .unique()
  );
const meterOf = (organizationId: Id<"organizations">, month = MONTH) =>
  t.run((ctx) =>
    ctx.db
      .query("orgUsageMonthly")
      .withIndex("by_organization_and_month", (q) => q.eq("organizationId", organizationId).eq("month", month))
      .unique()
  );
/** Atendimentos do mês como o teto e o painel enxergam: congelado + livro. */
const attended = async (organizationId: Id<"organizations">, month = MONTH) =>
  ((await usage(organizationId, month))?.conversations ?? 0) + ((await meterOf(organizationId, month))?.aiAttendances ?? 0);
const release = (c: Conv, itemId: Id<"aiReplyQueue">) =>
  t.run(async (ctx) => {
    await clearRuntimeField(ctx, c.conversationId, "aiTurnLock");
    await ctx.db.patch(itemId, { status: "done" });
  });

describe("atendimento = contato distinto, gravado no commit", () => {
  test("claim sozinho e run com erro não contam", async () => {
    const s = await seed();
    const { res } = await claim(s, s.a1, "r1");
    expect(res.kind).toBe("run");
    const runId = (res as { context: { agentRunId: Id<"agentRuns"> } }).context.agentRunId;
    await t.mutation(internal.agentRuns.internalFinishRun, { runId, status: "error", error: "boom" });
    expect(await ledger(s.organizationId)).toHaveLength(0);
    expect(await attended(s.organizationId)).toBe(0);
    // O claim gravou a classe na run (org sem billing = legacy).
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run?.billingClass).toBe("legacy");
  });

  test("rascunho conta; o mesmo contato em outra conversa/canal não conta de novo", async () => {
    const s = await seed();
    const first = await claim(s, s.a1, "r1");
    const ctx1 = (first.res as { context: { agentRunId: Id<"agentRuns"> } }).context;
    expect((await commitSuggestion(s, s.a1, first.item, "r1", ctx1.agentRunId)).committed).toBe(true);
    let rows = await ledger(s.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ billing: "legacy", conversationId: s.a1.conversationId });
    expect(await attended(s.organizationId)).toBe(1);

    await release(s.a1, first.item._id);
    const second = await claim(s, s.a2, "r2");
    const ctx2 = (second.res as { context: { agentRunId: Id<"agentRuns"> } }).context;
    await commitSuggestion(s, s.a2, second.item, "r2", ctx2.agentRunId);
    rows = await ledger(s.organizationId);
    expect(rows).toHaveLength(1);
    expect(await attended(s.organizationId)).toBe(1);

    // Contato diferente conta.
    await release(s.a2, second.item._id);
    const third = await claim(s, s.b, "r3");
    const ctx3 = (third.res as { context: { agentRunId: Id<"agentRuns"> } }).context;
    await commitSuggestion(s, s.b, third.item, "r3", ctx3.agentRunId);
    expect(await ledger(s.organizationId)).toHaveLength(2);
    expect(await attended(s.organizationId)).toBe(2);
  });

  test("org com plano: o commit usa a classe gravada no claim (included)", async () => {
    const s = await seed(undefined, { plan: "profissional", status: "active", updatedAt: 1 });
    const c = await claim(s, s.a1, "r1");
    const ctx1 = (c.res as { context: { agentRunId: Id<"agentRuns"> } }).context;
    expect((await t.run((ctx) => ctx.db.get(ctx1.agentRunId)))?.billingClass).toBe("included");
    await commitSuggestion(s, s.a1, c.item, "r1", ctx1.agentRunId);
    const rows = await ledger(s.organizationId);
    expect(rows[0].billing).toBe("included");
    expect(await meterOf(s.organizationId)).toMatchObject({ aiAttendances: 1, attendancesIncluded: 1 });
    // Os commits não tocam `aiUsageMonthly` (doc do custo, disputado por finishRun).
    expect(await usage(s.organizationId)).toBeNull();
  });

  test("simulador não conta", async () => {
    const s = await seed();
    const runId = await t.mutation(internal.agentRuns.internalStartRun, {
      organizationId: s.organizationId,
      memberId: s.agentId,
      kind: "simulator",
      conversationId: s.a1.conversationId,
    });
    await t.mutation(internal.agentRuns.internalFinishRun, { runId, status: "done", promptTokens: 10, completionTokens: 5 });
    expect(await ledger(s.organizationId)).toHaveLength(0);
    expect(await attended(s.organizationId)).toBe(0);
  });
});

describe("org legacy com monthlyConversationBudget: nunca dispara mais cedo", () => {
  test("claim sem commit não ocupa o teto (antes ocupava): dispara MAIS TARDE", async () => {
    const s = await seed(1);
    const a = await claim(s, s.a1, "r1");
    expect(a.res.kind).toBe("run");
    await release(s.a1, a.item._id); // run sem commit (erro/abandono)
    const bEarly = await claim(s, s.b, "r2");
    expect(bEarly.res.kind).toBe("run"); // pré-B2 estourava aqui (budget_mensal)
  });

  test("com A comprometido, o contato B estoura no mesmo ponto de sempre", async () => {
    const s = await seed(1);
    const a = await claim(s, s.a1, "r1");
    const ctxA = (a.res as { context: { agentRunId: Id<"agentRuns"> } }).context;
    await commitSuggestion(s, s.a1, a.item, "r1", ctxA.agentRunId);
    await release(s.a1, a.item._id);
    const b = await claim(s, s.b, "r2");
    expect(b.res).toEqual({ kind: "skip", reason: "budget_mensal" });
    // O mesmo contato de A (outro canal) segue atendido: já está no livro.
    const a2 = await claim(s, s.a2, "r3");
    expect(a2.res.kind).toBe("run");
  });
});

describe("recordAttendance: modos live e backfill (A1)", () => {
  test("backfill só insere a linha; depois o live do mesmo contato é no-op e não dobra", async () => {
    const s = await seed();
    const base = { organizationId: s.organizationId, month: MONTH, contactKey: "c-1", conversationId: s.a1.conversationId, firstAt: Date.now() };
    await t.run((ctx) => recordAttendance(ctx, { ...base, billing: "legacy", mode: "backfill" }));
    expect(await ledger(s.organizationId)).toHaveLength(1);
    expect(await attended(s.organizationId)).toBe(0);
    const again = await t.run((ctx) => recordAttendance(ctx, { ...base, billing: "legacy", mode: "live" }));
    expect(again.inserted).toBe(false);
    expect(await attended(s.organizationId)).toBe(0);
    // Contato novo em live incrementa o total e o bucket.
    await t.run((ctx) => recordAttendance(ctx, { ...base, contactKey: "c-2", billing: "overage", unitPriceBrlCents: 49, mode: "live" }));
    expect(await meterOf(s.organizationId)).toMatchObject({ aiAttendances: 1, attendancesOverage: 1, overageBrlCents: 49 });
  });

  test("deploy no meio do mês (qualquer mês): conversa já atendida e contada pelo código antigo vira linha backfill e não conta de novo", async () => {
    // Estado pré-B2: run antiga do atendente nesta conversa + contador já incrementado pelo claim antigo.
    const s = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("agentRuns", {
        organizationId: s.organizationId,
        memberId: s.agentId,
        kind: "attendant",
        status: "done",
        conversationId: s.a1.conversationId,
        requestCount: 1,
        startedAt: Date.now(),
      });
      await ctx.db.insert("aiUsageMonthly", {
        organizationId: s.organizationId,
        month: MONTH,
        costUsdMicros: 0,
        runs: 1,
        conversations: 1,
        byKind: {},
        updatedAt: Date.now(),
      });
    });
    const c = await claim(s, s.a1, "r1");
    const ctxA = (c.res as { context: { agentRunId: Id<"agentRuns"> } }).context;
    // A salvaguarda (sempre ativa para contato sem linha) gravou a linha em backfill no claim.
    expect(await ledger(s.organizationId)).toHaveLength(1);
    await commitSuggestion(s, s.a1, c.item, "r1", ctxA.agentRunId);
    expect(await ledger(s.organizationId)).toHaveLength(1);
    expect(await attended(s.organizationId)).toBe(1);
  });

  test("deploy no meio do mês com contador antigo já incrementado: budget dispara no mesmo ponto ou depois", async () => {
    const s = await seed(1);
    await t.run(async (ctx) => {
      await ctx.db.insert("agentRuns", {
        organizationId: s.organizationId,
        memberId: s.agentId,
        kind: "attendant",
        status: "done",
        conversationId: s.a1.conversationId,
        requestCount: 1,
        startedAt: Date.now(),
      });
      await ctx.db.insert("aiUsageMonthly", {
        organizationId: s.organizationId,
        month: MONTH,
        costUsdMicros: 0,
        runs: 1,
        conversations: 1, // teto 1 já ocupado pelo A, contado pelo código antigo
        byKind: {},
        updatedAt: Date.now(),
      });
    });
    // O contato já atendido segue atendido (não dobra o contador)...
    const a = await claim(s, s.a1, "r1");
    expect(a.res.kind).toBe("run");
    expect(await attended(s.organizationId)).toBe(1);
    await release(s.a1, a.item._id);
    // ...e o outro contato estoura no MESMO ponto do código antigo (nunca antes).
    const b = await claim(s, s.b, "r2");
    expect(b.res).toEqual({ kind: "skip", reason: "budget_mensal" });
  });
});

async function seedRuns(s: Seed, overrides: Array<Partial<Doc<"agentRuns">> & { lead: Conv }>) {
  await t.run(async (ctx) => {
    for (const o of overrides) {
      const { lead, ...rest } = o;
      await ctx.db.insert("agentRuns", {
        organizationId: s.organizationId,
        memberId: s.agentId,
        kind: "attendant",
        status: "done",
        conversationId: lead.conversationId,
        leadId: lead.leadId,
        requestCount: 1,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ...rest,
      } as never);
    }
  });
}

describe("internalBackfillMonthlyUsage (A1): não toca conversations a partir do mês da virada", () => {
  test("mês do livro: não infla (nem dobra); mês anterior: comportamento antigo", async () => {
    const s = await seed();
    await seedRuns(s, [{ lead: s.a1 }, { lead: s.b }]);
    // Livro começou em 2026-10: este mês NÃO escreve conversations (doc novo → 0).
    await t.mutation(internal.aiSpend.internalBackfillMonthlyUsage, {
      organizationId: s.organizationId,
      month: MONTH,
      ledgerStartMonth: MONTH,
      dryRun: false,
    });
    expect((await usage(s.organizationId))?.conversations).toBe(0);
    expect((await usage(s.organizationId))?.runs).toBe(2);
    // Com a virada depois do mês, o recálculo antigo (por conversa) segue valendo.
    await t.run(async (ctx) => {
      const doc = await ctx.db
        .query("aiUsageMonthly")
        .withIndex("by_organization_and_month", (q) => q.eq("organizationId", s.organizationId).eq("month", MONTH))
        .unique();
      await ctx.db.delete(doc!._id);
    });
    await t.mutation(internal.aiSpend.internalBackfillMonthlyUsage, {
      organizationId: s.organizationId,
      month: MONTH,
      ledgerStartMonth: "2026-11",
      dryRun: false,
    });
    expect((await usage(s.organizationId))?.conversations).toBe(2);
  });

  test("mês que já tem linha no livro: não toca conversations mesmo antes da constante", async () => {
    const s = await seed();
    await seedRuns(s, [{ lead: s.a1 }, { lead: s.b }]);
    // Só uma linha backfill (sem contador): o mês já é "do livro", o recálculo por conversa não vale.
    await t.run((ctx) => recordAttendance(ctx, { organizationId: s.organizationId, month: MONTH, contactKey: "c-y", conversationId: s.a1.conversationId, firstAt: Date.now(), billing: "legacy", mode: "backfill" }));
    await t.mutation(internal.aiSpend.internalBackfillMonthlyUsage, {
      organizationId: s.organizationId,
      month: MONTH,
      ledgerStartMonth: "2099-01",
      dryRun: false,
    });
    expect((await usage(s.organizationId))?.conversations).toBe(0);
  });

  test("contador já alimentado pelo livro fica intacto", async () => {
    const s = await seed();
    await seedRuns(s, [{ lead: s.a1 }]);
    await t.run((ctx) => recordAttendance(ctx, { organizationId: s.organizationId, month: MONTH, contactKey: "c-x", conversationId: s.a1.conversationId, firstAt: Date.now(), billing: "legacy", mode: "live" }));
    await t.mutation(internal.aiSpend.internalBackfillMonthlyUsage, {
      organizationId: s.organizationId,
      month: MONTH,
      ledgerStartMonth: MONTH,
      dryRun: false,
    });
    expect(await attended(s.organizationId)).toBe(1);
  });
});

describe("internalBackfillAttendances", () => {
  test("dryRun (default) conta e não escreve; real cria linhas backfill sem mexer no contador; ignora run com erro", async () => {
    const s = await seed();
    await seedRuns(s, [
      { lead: s.a1 },
      { lead: s.a2 }, // mesmo contato que a1: 1 linha só
      { lead: s.b, status: "error" }, // run com erro não vira atendimento
    ]);
    const dry = await t.mutation(internal.opsBilling.internalBackfillAttendances, { month: MONTH, organizationId: s.organizationId });
    expect(dry).toMatchObject({ dryRun: true, newContacts: 1, inserted: 0 });
    expect(await ledger(s.organizationId)).toHaveLength(0);

    const real = await t.mutation(internal.opsBilling.internalBackfillAttendances, { month: MONTH, organizationId: s.organizationId, dryRun: false });
    expect(real).toMatchObject({ newContacts: 1, inserted: 1, isDone: true });
    const rows = await ledger(s.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].billing).toBe("legacy");
    expect(await attended(s.organizationId)).toBe(0);

    // Idempotente.
    const again = await t.mutation(internal.opsBilling.internalBackfillAttendances, { month: MONTH, organizationId: s.organizationId, dryRun: false });
    expect(again).toMatchObject({ newContacts: 0, inserted: 0 });
    expect(await ledger(s.organizationId)).toHaveLength(1);
  });

  test("sem organizationId o dry run só lista; mês inválido é recusado", async () => {
    await seed();
    const res = await t.mutation(internal.opsBilling.internalBackfillAttendances, { month: MONTH });
    expect(res).toMatchObject({ dryRun: true, scheduled: 0, organizationId: null });
    await expect(t.mutation(internal.opsBilling.internalBackfillAttendances, { month: "2026-13" })).rejects.toThrow();
  });
});

describe("internalCostAudit", () => {
  test("agrupa runs com custo 0 por tipo e provedor, sem PII", async () => {
    const s = await seed();
    await seedRuns(s, [
      { lead: s.a1, kind: "copilot", provider: "openrouter", costUsdEstimate: 0 },
      { lead: s.a1, kind: "copilot", provider: "openrouter", costUsdEstimate: 0.01, promptTokens: 100 },
      { lead: s.a1, kind: "attendant", provider: "openrouter", costUsdEstimate: 0.02, promptTokens: 10 },
    ]);
    const res = await t.query(internal.opsBilling.internalCostAudit, { now: Date.now() + 1000 });
    const copilot = res.rows.find((r) => r.kind === "copilot" && r.provider === "openrouter")!;
    expect(copilot).toMatchObject({ finishedRuns: 2, zeroCostRuns: 1, noTokensRuns: 1 });
    await expect(t.query(internal.opsBilling.internalCostAudit, { now: Date.now(), sinceDays: 31 })).rejects.toThrow();
  });
});

describe("origem do atendimento (D14) e OCC", () => {
  test("coach/devolver à IA gravam human_request; resposta ao cliente grava ai", async () => {
    const s = await seed();
    // Turno normal (cliente escreveu).
    const normal = await claim(s, s.a1, "r1");
    const ctxN = (normal.res as { context: { agentRunId: Id<"agentRuns"> } }).context;
    await commitSuggestion(s, s.a1, normal.item, "r1", ctxN.agentRunId);
    await release(s.a1, normal.item._id);
    // Turno pedido por humano (coach) em OUTRO contato.
    const item = await inboundAndSettle(s, s.b);
    await t.run((ctx) => ctx.db.patch(item._id, { origin: "coach" }));
    const res = await t.mutation(internal.attendant.internalClaimForProcessing, { queueItemId: item._id, runId: "r2" });
    const ctxC = (res as { context: { agentRunId: Id<"agentRuns"> } }).context;
    await commitSuggestion(s, s.b, item, "r2", ctxC.agentRunId);
    const rows = await ledger(s.organizationId);
    expect(rows.find((r) => r.conversationId === s.a1.conversationId)?.origin).toBe("ai");
    expect(rows.find((r) => r.conversationId === s.b.conversationId)?.origin).toBe("human_request");
  });

  test("o commit não toca aiUsageMonthly (nenhum conflito com finishRun no doc do custo)", async () => {
    const s = await seed();
    await t.run((ctx) =>
      ctx.db.insert("aiUsageMonthly", { organizationId: s.organizationId, month: MONTH, costUsdMicros: 5, runs: 1, conversations: 4, byKind: {}, updatedAt: 111 })
    );
    const c = await claim(s, s.a1, "r1");
    const ctxA = (c.res as { context: { agentRunId: Id<"agentRuns"> } }).context;
    await commitSuggestion(s, s.a1, c.item, "r1", ctxA.agentRunId);
    const doc = await usage(s.organizationId);
    expect(doc).toMatchObject({ conversations: 4, updatedAt: 111 });
    expect((await meterOf(s.organizationId))?.aiAttendances).toBe(1);
    // O teto enxerga a soma (congelado 4 + livro 1).
    expect(await attended(s.organizationId)).toBe(5);
    // E o finishRun continua escrevendo no doc do custo sem perder o contador.
    await t.mutation(internal.agentRuns.internalFinishRun, { runId: ctxA.agentRunId, status: "done", promptTokens: 10, completionTokens: 5, costUsdEstimate: 0.01 });
    expect((await usage(s.organizationId))?.conversations).toBe(4);
  });
});

describe("salvaguarda: só runs PRÉ-B2 (billingClass ausente), de qualquer status", () => {
  const preDeployCounter = (s: Seed) =>
    t.run((ctx) =>
      ctx.db.insert("aiUsageMonthly", { organizationId: s.organizationId, month: MONTH, costUsdMicros: 0, runs: 1, conversations: 1, byKind: {}, updatedAt: Date.now() })
    );

  test("(a) pré-deploy com run em erro (o claim antigo contou) + contato volta = 1 no total", async () => {
    const s = await seed();
    await seedRuns(s, [{ lead: s.a1, status: "error" }]); // sem billingClass = claim antigo
    await preDeployCounter(s);
    const c = await claim(s, s.a1, "r1");
    const ctxA = (c.res as { context: { agentRunId: Id<"agentRuns"> } }).context;
    expect(await ledger(s.organizationId)).toHaveLength(1); // linha backfill no claim
    await commitSuggestion(s, s.a1, c.item, "r1", ctxA.agentRunId);
    expect(await attended(s.organizationId)).toBe(1); // congelado 1 + livro 0
    expect((await meterOf(s.organizationId))?.aiAttendances ?? 0).toBe(0);
  });

  test("(b) pós-deploy: run sem commit (bot/silêncio/recusa) não serve de salvaguarda; a resposta depois conta 1", async () => {
    const s = await seed();
    const first = await claim(s, s.a1, "r1");
    expect(first.res.kind).toBe("run");
    await release(s.a1, first.item._id); // a run nova terminou sem commit
    const second = await claim(s, s.a1, "r2");
    expect(await ledger(s.organizationId)).toHaveLength(0); // a run nova NÃO virou "já atendida"
    const ctxB = (second.res as { context: { agentRunId: Id<"agentRuns"> } }).context;
    await commitSuggestion(s, s.a1, second.item, "r2", ctxB.agentRunId);
    expect(await attended(s.organizationId)).toBe(1);
    expect((await meterOf(s.organizationId))?.aiAttendances).toBe(1);
  });

  test("(c) run em voo no deploy (claim antigo, commit novo): grava a linha sem incrementar", async () => {
    const s = await seed();
    await preDeployCounter(s); // o claim antigo já contou esta conversa
    const c = await claim(s, s.a1, "r1");
    const ctxA = (c.res as { context: { agentRunId: Id<"agentRuns"> } }).context;
    await t.run((ctx) => ctx.db.patch(ctxA.agentRunId, { billingClass: undefined }));
    // Sem a run nova como salvaguarda e sem linha, o commit decide: run sem classe = backfill.
    await commitSuggestion(s, s.a1, c.item, "r1", ctxA.agentRunId);
    expect(await ledger(s.organizationId)).toHaveLength(1);
    expect(await attended(s.organizationId)).toBe(1); // sem +1
  });
});

describe("internalBackfillAttendances sem org", () => {
  test("pagina as orgs por cursor e o dry run devolve newContacts por org", async () => {
    const s1 = await seed();
    const s2 = await seed();
    await seedRuns(s1, [{ lead: s1.a1 }, { lead: s1.b }]);
    const dry = await t.mutation(internal.opsBilling.internalBackfillAttendances, { month: MONTH, pageSize: 1 });
    expect(dry.dryRun).toBe(true);
    expect(dry.perOrg).toHaveLength(1);
    expect(dry.isDone).toBe(false);
    expect(dry.continueCursor).not.toBeNull();
    const dryAll = await t.mutation(internal.opsBilling.internalBackfillAttendances, { month: MONTH, pageSize: 50 });
    expect(dryAll.perOrg).toEqual(
      expect.arrayContaining([
        { organizationId: s1.organizationId, newContacts: 2, truncated: false },
        { organizationId: s2.organizationId, newContacts: 0, truncated: false },
      ])
    );
    expect(await ledger(s1.organizationId)).toHaveLength(0);
  });
});
