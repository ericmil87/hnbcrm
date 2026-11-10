/// <reference types="vite/client" />
/**
 * Billing B6: limite, credito e excedente. Contato NOVO de org com plano e classificado no
 * claim (`classifyNewAttendance`); o commit consome credito/soma o excedente atomicamente.
 * Org legacy/sem plano: inalterada.
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
    const contactC = await makeContact("Cliente C", "5585999990003");
    const c = await makeLead("C", contactC);
    return { organizationId, agentId, adminId, a1, a2, b, c };
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

type Plan = NonNullable<Doc<"organizations">["billing"]>;
const paid = (extra: Partial<Plan> = {}): Plan => ({ plan: "profissional", status: "active", updatedAt: 1, ...extra });
const overageOn = (capBrl: number): Plan["overage"] => ({ enabled: true, capBrl, updatedAt: 1 });

const grantCredit = (organizationId: Id<"organizations">, granted: number) =>
  t.run((ctx) =>
    ctx.db.insert("usageCredits", {
      organizationId,
      kind: "ai_attendances",
      granted,
      consumed: 0,
      expiresAt: Date.now() + 90 * 86_400_000,
      source: "pack",
      createdAt: Date.now(),
    })
  );

type ClaimCtx = { agentRunId: Id<"agentRuns">; forceSuggest: boolean };

/** Claim + commit de rascunho do contato; devolve a run e se o turno foi forcado a rascunho. */
async function attend(s: Seed, c: Conv, runId: string, itemPatch?: Partial<Doc<"aiReplyQueue">>) {
  const item = await inboundAndSettle(s, c);
  if (itemPatch) await t.run((ctx) => ctx.db.patch(item._id, itemPatch));
  const res = await t.mutation(internal.attendant.internalClaimForProcessing, { queueItemId: item._id, runId });
  expect(res.kind).toBe("run");
  const context = (res as unknown as { context: ClaimCtx }).context;
  const run = await t.run((ctx) => ctx.db.get(context.agentRunId));
  await commitSuggestion(s, c, item, runId, context.agentRunId);
  await release(c, item._id);
  return { run: run!, forceSuggest: context.forceSuggest };
}
const handoffsOf = (leadId: Id<"leads">) =>
  t.run((ctx) => ctx.db.query("handoffs").withIndex("by_lead", (q) => q.eq("leadId", leadId)).collect());
const rowOf = async (s: Seed, leadDoc: Conv) => {
  const lead = await t.run((ctx) => ctx.db.get(leadDoc.leadId));
  return (await ledger(s.organizationId)).find((r) => r.contactKey === String(lead!.contactId));
};

describe("B6: franquia, credito e excedente", () => {
  test("301o contato vira rascunho forcado com 1 repasse ai_budget; o 1o fica included", async () => {
    const s = await seed(undefined, paid({ overrides: { aiAttendances: 1 } }));
    const first = await attend(s, s.a1, "r1");
    expect(first.run.billingClass).toBe("included");
    expect(first.forceSuggest).toBe(false);
    const second = await attend(s, s.b, "r2");
    expect(second.run.billingClass).toBe("suggest_only");
    expect(second.forceSuggest).toBe(true);
    expect((await rowOf(s, s.b))?.billing).toBe("suggest_only");
    const hs = await handoffsOf(s.b.leadId);
    expect(hs.filter((h) => h.origin === "ai_budget")).toHaveLength(1);
    expect(await meterOf(s.organizationId)).toMatchObject({ attendancesIncluded: 1, attendancesSuggestOnly: 1 });
  });

  test("contato ja atendido no mes segue normal mesmo acima da franquia", async () => {
    const s = await seed(undefined, paid({ overrides: { aiAttendances: 1 } }));
    await attend(s, s.a1, "r1");
    const again = await attend(s, s.a2, "r2"); // mesmo contato, outro canal
    expect(again.forceSuggest).toBe(false);
    expect(again.run.billingClass).toBe("included");
  });

  test("credito antes do excedente; depois do credito, excedente soma centavos", async () => {
    const s = await seed(undefined, paid({ overrides: { aiAttendances: 0 }, overage: overageOn(100) }));
    const creditId = await grantCredit(s.organizationId, 1);
    const a = await attend(s, s.a1, "r1");
    expect(a.run.billingClass).toBe("credit");
    expect(a.forceSuggest).toBe(false);
    expect(await rowOf(s, s.a1)).toMatchObject({ billing: "credit", creditId });
    expect((await t.run((ctx) => ctx.db.get(creditId)))?.consumed).toBe(1);
    const b = await attend(s, s.b, "r2");
    expect(b.run).toMatchObject({ billingClass: "overage", unitPriceBrlCents: 49 });
    expect(await meterOf(s.organizationId)).toMatchObject({
      attendancesCredit: 1,
      attendancesOverage: 1,
      overageBrlCents: 49,
    });
    expect(await rowOf(s, s.b)).toMatchObject({ billing: "overage", unitPriceBrlCents: 49 });
  });

  test("teto do excedente: o que nao cabe vira sugerir", async () => {
    const s = await seed(undefined, paid({ overrides: { aiAttendances: 0 }, overage: overageOn(1) })); // 100c, unit 49
    expect((await attend(s, s.a1, "r1")).run.billingClass).toBe("overage");
    expect((await attend(s, s.b, "r2")).run.billingClass).toBe("overage");
    const third = await attend(s, s.c, "r3"); // 98 + 49 > 100
    expect(third.run.billingClass).toBe("suggest_only");
    expect(third.forceSuggest).toBe(true);
    expect((await meterOf(s.organizationId))?.overageBrlCents).toBe(98);
  });

  test("corrida no teto: o commit regrava suggest_only mesmo com a mensagem ja enviada", async () => {
    const s = await seed(undefined, paid({ overrides: { aiAttendances: 0 }, overage: overageOn(1) }));
    const item = await inboundAndSettle(s, s.b);
    const res = await t.mutation(internal.attendant.internalClaimForProcessing, { queueItemId: item._id, runId: "r1" });
    const context = (res as unknown as { context: ClaimCtx }).context;
    expect((await t.run((ctx) => ctx.db.get(context.agentRunId)))?.billingClass).toBe("overage");
    // Outro commit consumiu o teto entre o claim e o commit.
    await t.run(async (ctx) => {
      await ctx.db.insert("orgUsageMonthly", {
        organizationId: s.organizationId,
        month: MONTH,
        campaignSends: 0,
        aiAttendances: 1,
        attendancesOverage: 1,
        overageBrlCents: 60,
        updatedAt: Date.now(),
      });
    });
    await commitSuggestion(s, s.b, item, "r1", context.agentRunId);
    expect((await rowOf(s, s.b))?.billing).toBe("suggest_only");
    expect(await meterOf(s.organizationId)).toMatchObject({
      overageBrlCents: 60,
      attendancesOverage: 1,
      attendancesSuggestOnly: 1,
    });
  });

  test("forceSuggest (spendCap em block) nunca vira overage nem credito", async () => {
    const s = await seed(undefined, paid({ overrides: { aiAttendances: 0 }, overage: overageOn(100) }));
    const creditId = await grantCredit(s.organizationId, 5);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, {
        settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, spendCap: { mode: "block", monthlyBrl: 1 } } },
      });
      await ctx.db.insert("aiUsageMonthly", {
        organizationId: s.organizationId,
        month: MONTH,
        costUsdMicros: 900_000_000,
        runs: 1,
        estimatedRuns: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: 0,
        byKind: {},
        updatedAt: Date.now(),
      });
    });
    const r = await attend(s, s.a1, "r1");
    expect(r.forceSuggest).toBe(true);
    expect(r.run.billingClass).toBe("suggest_only");
    expect((await meterOf(s.organizationId))?.overageBrlCents ?? 0).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(creditId)))?.consumed).toBe(0);
  });

  test("pedido humano (coach) nunca consome credito nem vira excedente", async () => {
    const s = await seed(undefined, paid({ overrides: { aiAttendances: 0 }, overage: overageOn(100) }));
    const creditId = await grantCredit(s.organizationId, 5);
    const r = await attend(s, s.a1, "r1", { origin: "coach" });
    expect(r.run.billingClass).toBe("suggest_only");
    expect((await t.run((ctx) => ctx.db.get(creditId)))?.consumed).toBe(0);
    expect((await rowOf(s, s.a1))?.origin).toBe("human_request");
    // Sem repasse: o humano ja esta ali.
    expect((await handoffsOf(s.a1.leadId)).filter((h) => h.origin === "ai_budget")).toHaveLength(0);
  });

  test("teste nunca tem credito nem excedente", async () => {
    const now = Date.now();
    const s = await seed(undefined, {
      plan: "profissional",
      status: "trial",
      trialEndsAt: now + 20 * 86_400_000,
      periodStart: now - 86_400_000,
      overrides: { aiAttendances: 0 },
      overage: overageOn(100),
      updatedAt: 1,
    });
    const creditId = await grantCredit(s.organizationId, 5);
    const r = await attend(s, s.a1, "r1");
    expect(r.run.billingClass).toBe("suggest_only");
    expect(r.forceSuggest).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(creditId)))?.consumed).toBe(0);
  });

  test("org legacy e org sem plano: nada muda (legacy, sem forcar rascunho, credito intacto)", async () => {
    for (const billing of [{ status: "legacy" as const, updatedAt: 1 }, undefined]) {
      t = convexTest(schema, modules);
      const s = await seed(undefined, billing);
      const creditId = await grantCredit(s.organizationId, 5);
      const r = await attend(s, s.a1, "r1");
      expect(r.run.billingClass).toBe("legacy");
      expect(r.forceSuggest).toBe(false);
      expect((await rowOf(s, s.a1))?.billing).toBe("legacy");
      expect((await t.run((ctx) => ctx.db.get(creditId)))?.consumed).toBe(0);
      expect((await handoffsOf(s.a1.leadId)).filter((h) => h.origin === "ai_budget")).toHaveLength(0);
    }
  });
});

describe("classifyNewAttendance (pura)", () => {
  test("ordem: franquia, credito, excedente, sugerir; past_due = active", async () => {
    const { classifyNewAttendance, resolveEntitlements } = await import("./lib/entitlements");
    const e = resolveEntitlements(
      {
        settings: {} as never,
        billing: { plan: "profissional", status: "past_due", overage: { enabled: true, capBrl: 1, updatedAt: 1 }, updatedAt: 1 },
      },
      0
    );
    const base = { e, used: 1000, overageBrlCents: 0, hasCredit: false, origin: "ai" as const, forceSuggest: false };
    expect(classifyNewAttendance({ ...base, used: 999 }).billingClass).toBe("included");
    expect(classifyNewAttendance({ ...base, hasCredit: true }).billingClass).toBe("credit");
    expect(classifyNewAttendance(base)).toEqual({ billingClass: "overage", unitPriceBrlCents: 49 });
    expect(classifyNewAttendance({ ...base, overageBrlCents: 60 }).billingClass).toBe("suggest_only");
    expect(classifyNewAttendance({ ...base, forceSuggest: true, hasCredit: true }).billingClass).toBe("suggest_only");
    expect(classifyNewAttendance({ ...base, origin: "human_request" }).billingClass).toBe("suggest_only");
    expect(classifyNewAttendance({ ...base, used: 5, forceSuggest: true }).billingClass).toBe("included");
  });
});
