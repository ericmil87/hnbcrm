/// <reference types="vite/client" />
/**
 * Jev, fase 0 (fundação sem caller) — integração com convex-test.
 *
 * Prova: módulo OFF = nada acontece (nem run, nem rede); gates de IA/teto/escopo; decisão gravada
 * sem PII e custo no contador pela porta única; fail-open (nunca lança); fim idempotente;
 * retenção de `jevDecisions`; ops do módulo e `internalPingJev`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import { modulesOf } from "./lib/orgModules";
import { JEV_KINDS, JEV_PRICE_ID, JEV_URL } from "./lib/jev/types";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const MONTH = "2026-10";
const FAKE_KEY = "sk-or-v1-fake-test-key-0000";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T15:00:00Z"));
  vi.stubEnv("OPENROUTER_API_KEY", FAKE_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const setup = () => convexTest(schema, modules);

const QUESTIONS = {
  pede_humano: { type: "noul", instructions: "`mensagem` pede uma pessoa?" },
  intencao: { type: "choice", instructions: "Qual o pedido?", criteria: { preco: "valor", outro: "resto" } },
};
const MENSAGEM = "me liga no 81 99999-8888 que eu quero o preço";

function jevResponse(usage: Record<string, unknown> = { input_tokens: 400, output_tokens: 40, cost: 0.00002, is_byok: false }) {
  return new Response(
    JSON.stringify({
      id: "gen-dec-1",
      model: "typesafe/jev-1.13-20260917",
      provider: "TypeSafe",
      answers: {
        pede_humano: { type: "noul", noul: 0.04 },
        intencao: { type: "choice", choice: "preco", confidence: 0.9, probabilities: { preco: 0.95, outro: 0.05 } },
      },
      usage,
    }),
    { status: 200 }
  );
}
const stubFetch = (fn: () => Response) => {
  const mock = vi.fn(async (_url: string, _init?: RequestInit) => fn());
  vi.stubGlobal("fetch", mock);
  return mock;
};
const sentBody = (mock: ReturnType<typeof stubFetch>) => JSON.parse(mock.mock.calls[0]![1]!.body as string);

type SpendCap = NonNullable<NonNullable<Doc<"organizations">["settings"]["aiConfig"]>["spendCap"]>;
type SeedOpts = { jev?: boolean; ai?: boolean; spendCap?: SpendCap };

async function seedOrg(t: TestConvex<typeof schema>, slug: string, opts: SeedOpts = {}) {
  const { jev = true, ai = true, spendCap } = opts;
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: `Org ${slug}`,
      slug,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, ...(spendCap ? { spendCap } : {}) },
        ...(jev ? { modules: { jev: true } } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: `${slug}@empresa-teste.com.br` });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", email: `${slug}@empresa-teste.com.br`, role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    if (ai) {
      const org = (await ctx.db.get(organizationId))!;
      await ctx.db.patch(organizationId, {
        settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: adminId } } },
      });
    }
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "Cliente", phone: "5585999990001", tags: [], createdAt: now, updatedAt: now });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Cliente", contactId, boardId, stageId, value: 0, currency: "BRL", priority: "medium", temperature: "warm",
      tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", status: "active", lastInboundAt: now, messageCount: 0, createdAt: now, updatedAt: now,
    });
    const messageId = await ctx.db.insert("messages", {
      organizationId, conversationId, leadId, direction: "inbound", senderType: "contact", content: MENSAGEM, contentType: "text", isInternal: false, createdAt: now,
    });
    return { organizationId, adminId, leadId, conversationId, messageId };
  });
}
type Seed = Awaited<ReturnType<typeof seedOrg>>;

const decideArgs = (seed: Seed, extra: Record<string, unknown> = {}) => ({
  organizationId: seed.organizationId,
  kind: "triage" as const,
  conversationId: seed.conversationId,
  leadId: seed.leadId,
  triggerMessageId: seed.messageId,
  state: { mensagem: MENSAGEM, historico: [{ de: "empresa", texto: "Olá! Como posso ajudar?" }] },
  questions: QUESTIONS,
  questionsVersion: "triage@1",
  policiesVersion: "p@1",
  ...extra,
});

const all = async <T extends "agentRuns" | "jevDecisions" | "aiUsageMonthly" | "auditLogs">(t: TestConvex<typeof schema>, table: T): Promise<Doc<T>[]> =>
  (await t.run(async (ctx) => ctx.db.query(table).collect())) as Doc<T>[];

describe("módulo e gates", () => {
  test("flag OFF por padrão: nada roda — nem run, nem decisão, nem rede", async () => {
    expect(modulesOf({ settings: {} } as never).jev).toBe(false);
    expect(modulesOf(null).jev).toBe(false);
    const t = setup();
    const seed = await seedOrg(t, "off", { jev: false });
    const fetchMock = stubFetch(() => jevResponse());
    const r = await t.action(internal.jev.internalDecide, decideArgs(seed));
    expect(r).toEqual({ ok: false, reason: "module_off" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await all(t, "agentRuns")).toHaveLength(0);
    expect(await all(t, "jevDecisions")).toHaveLength(0);
    expect(await all(t, "aiUsageMonthly")).toHaveLength(0);
  });

  test("IA da org inativa (sem aceite LGPD) → ai_inactive, sem rede", async () => {
    const t = setup();
    const seed = await seedOrg(t, "semack", { ai: false });
    const fetchMock = stubFetch(() => jevResponse());
    expect(await t.action(internal.jev.internalDecide, decideArgs(seed))).toEqual({ ok: false, reason: "ai_inactive" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await all(t, "agentRuns")).toHaveLength(0);
  });

  test("teto de gastos em `block` estourado → spend_blocked, sem rede e sem run", async () => {
    const t = setup();
    const seed = await seedOrg(t, "teto", { spendCap: { mode: "block", monthlyBrl: 55, usdBrlRate: 5.5 } }); // US$ 10
    await t.run(async (ctx) => {
      await ctx.db.insert("aiUsageMonthly", { organizationId: seed.organizationId, month: MONTH, costUsdMicros: 10_000_000, runs: 1, byKind: {}, updatedAt: Date.now() });
    });
    const fetchMock = stubFetch(() => jevResponse());
    expect(await t.action(internal.jev.internalDecide, decideArgs(seed))).toEqual({ ok: false, reason: "spend_blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await all(t, "agentRuns")).toHaveLength(0);
  });

  test("teto em `warn` NÃO bloqueia o Jev (só `block` suspende)", async () => {
    const t = setup();
    const seed = await seedOrg(t, "warn", { spendCap: { mode: "warn", monthlyBrl: 55, usdBrlRate: 5.5 } });
    await t.run(async (ctx) => {
      await ctx.db.insert("aiUsageMonthly", { organizationId: seed.organizationId, month: MONTH, costUsdMicros: 20_000_000, runs: 1, byKind: {}, updatedAt: Date.now() });
    });
    stubFetch(() => jevResponse());
    expect((await t.action(internal.jev.internalDecide, decideArgs(seed))).ok).toBe(true);
  });

  test("ponteiro de OUTRA org → scope_mismatch (multi-tenant), sem rede e sem run", async () => {
    const t = setup();
    const a = await seedOrg(t, "org-a");
    const b = await seedOrg(t, "org-b");
    const fetchMock = stubFetch(() => jevResponse());
    for (const extra of [{ conversationId: b.conversationId }, { leadId: b.leadId }, { triggerMessageId: b.messageId }]) {
      expect(await t.action(internal.jev.internalDecide, decideArgs(a, extra))).toEqual({ ok: false, reason: "scope_mismatch" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await all(t, "agentRuns")).toHaveLength(0);
  });

  test("todo kind de JEV_KINDS é aceito; kind desconhecido é recusado pelo validator", async () => {
    const t = setup();
    const seed = await seedOrg(t, "kinds");
    for (const kind of JEV_KINDS) {
      const r = await t.mutation(internal.jev.internalBeginDecision, { organizationId: seed.organizationId, kind });
      expect(r.ok, kind).toBe(true);
    }
    await expect(t.mutation(internal.jev.internalBeginDecision, { organizationId: seed.organizationId, kind: "inventado" as never })).rejects.toThrow();
  });
});

describe("decisão gravada", () => {
  test("caminho feliz: decisão sem PII, run `jev` fechada, custo no contador pela porta única", async () => {
    const t = setup();
    const seed = await seedOrg(t, "feliz");
    const fetchMock = stubFetch(() => jevResponse());
    const r = await t.action(internal.jev.internalDecide, decideArgs(seed));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model).toBe("typesafe/jev-1.13-20260917");
    expect(r.costUsdMicros).toBe(20);
    expect(r.costEstimated).toBe(false);
    expect(r.answers.find((a) => a.id === "pede_humano")).toMatchObject({ type: "noul", noul: 0.04 });

    // o que SAIU para a rede: URL única, chave só no header, telefone mascarado, trava de privacidade
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(JEV_URL);
    const body = sentBody(fetchMock);
    expect(JSON.stringify(body)).not.toContain("99999");
    expect(JSON.stringify(body)).toContain("[telefone]");
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
    expect(body.provider.data_collection).toBe("deny");

    // o que FICOU no banco
    const [decision] = await all(t, "jevDecisions");
    expect(decision).toMatchObject({
      organizationId: seed.organizationId,
      kind: "triage",
      conversationId: seed.conversationId,
      leadId: seed.leadId,
      triggerMessageId: seed.messageId,
      model: "typesafe/jev-1.13-20260917",
      requestId: "gen-dec-1",
      questionsVersion: "triage@1",
      policiesVersion: "p@1",
      promptTokens: 400,
      costUsdMicros: 20,
    });
    expect(decision!.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(decision).not.toHaveProperty("costEstimated");
    const dump = JSON.stringify(await all(t, "jevDecisions")) + JSON.stringify(await all(t, "agentRuns"));
    expect(dump).not.toContain("preço"); // nenhum texto de conversa em lugar nenhum
    expect(dump).not.toContain("Olá");
    expect(dump).not.toContain("99999");

    const [run] = await all(t, "agentRuns");
    expect(run).toMatchObject({ kind: "jev", status: "done", provider: "openrouter", model: JEV_PRICE_ID, requestCount: 1, promptTokens: 400, completionTokens: 40 });
    expect(run!.costUsdEstimate).toBeCloseTo(0.00002, 9);
    expect(run).not.toHaveProperty("memberId");

    const [usage] = await all(t, "aiUsageMonthly");
    expect(usage).toMatchObject({ organizationId: seed.organizationId, month: MONTH, costUsdMicros: 20, runs: 1 });
    expect((usage as Doc<"aiUsageMonthly">).byKind).toHaveProperty("jev");
  });

  test("usage.cost ausente: custo vem da tabela do Jev (0,042/1M), com costEstimated — nunca 0 nem o preço conservador", async () => {
    const t = setup();
    const seed = await seedOrg(t, "semcusto");
    stubFetch(() => jevResponse({ input_tokens: 1000, output_tokens: 70 }));
    const r = await t.action(internal.jev.internalDecide, decideArgs(seed));
    expect(r.ok && r.costUsdMicros).toBe(42); // 1000 × 0,042 / 1M = US$ 0,000042
    expect(r.ok && r.costEstimated).toBe(true);
    const [decision] = await all(t, "jevDecisions");
    expect(decision).toMatchObject({ costUsdMicros: 42, costEstimated: true });
    const [run] = await all(t, "agentRuns");
    expect(run).toMatchObject({ costEstimated: true });
  });

  test("o fim é idempotente: repetir não duplica decisão nem soma custo de novo", async () => {
    const t = setup();
    const seed = await seedOrg(t, "idem");
    stubFetch(() => jevResponse());
    const r = await t.action(internal.jev.internalDecide, decideArgs(seed));
    if (!r.ok) throw new Error("esperava ok");
    const again = await t.mutation(internal.jev.internalRecordDecision, {
      runId: r.runId, organizationId: seed.organizationId, kind: "triage", model: "x", stateHash: "0".repeat(64),
      questionsVersion: "triage@1", policiesVersion: "p@1", answers: [], promptTokens: 999, completionTokens: 9,
      costUsdEstimate: 5, costEstimated: false, latencyMs: 1,
    });
    expect(again).toBeNull();
    await t.mutation(internal.jev.internalFailDecision, { runId: r.runId, organizationId: seed.organizationId, error: "tarde demais" });
    expect(await all(t, "jevDecisions")).toHaveLength(1);
    const [run] = await all(t, "agentRuns");
    expect(run).toMatchObject({ status: "done", promptTokens: 400 });
    const [usage] = await all(t, "aiUsageMonthly");
    expect(usage).toMatchObject({ costUsdMicros: 20, runs: 1 });
  });

  test("run de outra org ou de outro kind não é fechada por `internalRecordDecision`", async () => {
    const t = setup();
    const a = await seedOrg(t, "dono");
    const b = await seedOrg(t, "intruso");
    const begin = await t.mutation(internal.jev.internalBeginDecision, { organizationId: a.organizationId, kind: "triage" });
    if (!begin.ok) throw new Error("esperava ok");
    const attempt = await t.mutation(internal.jev.internalRecordDecision, {
      runId: begin.runId, organizationId: b.organizationId, kind: "triage", model: "x", stateHash: "0".repeat(64),
      questionsVersion: "q", policiesVersion: "p", answers: [], promptTokens: 1, completionTokens: 1, costUsdEstimate: 1, costEstimated: false, latencyMs: 1,
    });
    expect(attempt).toBeNull();
    expect(await all(t, "jevDecisions")).toHaveLength(0);
  });
});

describe("fail-open: nunca lança, nunca vira decisão", () => {
  test.each([
    ["400 da API", () => new Response(JSON.stringify({ error: { message: "bad", code: 400 } }), { status: 400 }), "bad_request"],
    ["401 chave inválida", () => new Response(JSON.stringify({ error: { message: "User not found.", code: 401 } }), { status: 401 }), "auth"],
    ["402 sem crédito", () => new Response(JSON.stringify({ error: { message: "credits", code: 402 } }), { status: 402 }), "credit"],
    ["404 política de dados", () => new Response(JSON.stringify({ error: { message: "no providers", code: 404 } }), { status: 404 }), "provider_unavailable"],
    ["200 fora do contrato (alpha mudou)", () => new Response(JSON.stringify({ model: "m", answers: {}, usage: { input_tokens: 1 } }), { status: 200 }), "invalid_response"],
  ])("%s → ok:false/error, run fechada com erro, sem decisão e sem custo", async (_name, make, code) => {
    const t = setup();
    const seed = await seedOrg(t, `fo-${code}`);
    stubFetch(make);
    const r = await t.action(internal.jev.internalDecide, decideArgs(seed));
    expect(r).toMatchObject({ ok: false, reason: "error", code });
    expect(await all(t, "jevDecisions")).toHaveLength(0);
    const [run] = await all(t, "agentRuns");
    expect(run).toMatchObject({ kind: "jev", status: "error" });
    expect(run!.error).toBeTruthy();
    expect(run!.error).not.toContain(FAKE_KEY);
    const usage = await all(t, "aiUsageMonthly");
    expect(usage.every((u) => u.costUsdMicros === 0)).toBe(true);
  });

  test("sem OPENROUTER_API_KEY → no_key, run fechada com erro, sem rede", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const t = setup();
    const seed = await seedOrg(t, "semchave");
    const fetchMock = stubFetch(() => jevResponse());
    expect(await t.action(internal.jev.internalDecide, decideArgs(seed))).toEqual({ ok: false, reason: "no_key" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await all(t, "agentRuns"))[0]).toMatchObject({ kind: "jev", status: "error" });
  });

  test("estado com campo proibido ou pergunta inválida → invalid_input ANTES de qualquer escrita ou rede", async () => {
    const t = setup();
    const seed = await seedOrg(t, "invalido");
    const fetchMock = stubFetch(() => jevResponse());
    const r1 = await t.action(internal.jev.internalDecide, decideArgs(seed, { state: { mensagem: "oi", telefone: "81999998888" } }));
    expect(r1).toMatchObject({ ok: false, reason: "invalid_input", code: "invalid_state" });
    expect(JSON.stringify(r1)).not.toContain("81999998888");
    const r2 = await t.action(internal.jev.internalDecide, decideArgs(seed, { questions: { x: { type: "choice", instructions: "?", criteria: { a: "so uma" } } } }));
    expect(r2).toMatchObject({ ok: false, reason: "invalid_input", code: "invalid_questions" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await all(t, "agentRuns")).toHaveLength(0);
  });
});

describe("retenção (retention.ts) e ops", () => {
  test("jevDecisions entra na retenção de 30 dias, pelo índice de sistema", async () => {
    const t = setup();
    const seed = await seedOrg(t, "ret");
    stubFetch(() => jevResponse());
    await t.action(internal.jev.internalDecide, decideArgs(seed));
    const count = async (now: number) =>
      (await t.query(internal.retention.internalRetentionPreview, { now })).find((p) => p.table === "jevDecisions")!.count;
    const day = 24 * 60 * 60 * 1000;
    expect(await count(Date.now() + 29 * day)).toBe(0);
    expect(await count(Date.now() + 31 * day)).toBe(1);
  });

  test("internalSetModule: dryRun é o padrão; liga com audit `high`; exige IA ativa para ligar; desligar sempre pode", async () => {
    const t = setup();
    const seed = await seedOrg(t, "ops", { jev: false });
    expect(await t.mutation(internal.jev.internalSetModule, { organizationId: seed.organizationId, enabled: true })).toEqual({ dryRun: true, before: false, after: true });
    expect(modulesOf((await t.run(async (ctx) => ctx.db.get(seed.organizationId)))!).jev).toBe(false);
    expect(await t.mutation(internal.jev.internalSetModule, { organizationId: seed.organizationId, enabled: true, dryRun: false })).toEqual({ dryRun: false, before: false, after: true });
    const org = (await t.run(async (ctx) => ctx.db.get(seed.organizationId)))!;
    expect(modulesOf(org).jev).toBe(true);
    expect(org.settings.aiConfig?.lgpdAck).toBeDefined(); // o resto das settings ficou intacto
    const audits = (await all(t, "auditLogs")).filter((a) => a.description?.includes("Jev"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ severity: "high", actorType: "system", changes: { before: { jev: false }, after: { jev: true } } });
    await t.mutation(internal.jev.internalSetModule, { organizationId: seed.organizationId, enabled: false, dryRun: false });
    expect(modulesOf((await t.run(async (ctx) => ctx.db.get(seed.organizationId)))!).jev).toBe(false);

    const semIa = await seedOrg(t, "ops-sem-ia", { jev: false, ai: false });
    await expect(t.mutation(internal.jev.internalSetModule, { organizationId: semIa.organizationId, enabled: true, dryRun: false })).rejects.toThrow(/IA da organização/);
    await t.mutation(internal.jev.internalSetModule, { organizationId: semIa.organizationId, enabled: false, dryRun: false });
  });

  test("fase 0: o módulo NÃO é ligável pela API pública (`setOrgModules` recusa a chave `jev`); a leitura devolve false", async () => {
    const t = setup();
    const seed = await seedOrg(t, "publico", { jev: false });
    const userId = (await t.run(async (ctx) => (await ctx.db.get(seed.adminId))!.userId))!;
    const asAdmin = t.withIdentity({ subject: `${userId}|s1` });
    await expect(
      asAdmin.mutation(api.orgModules.setOrgModules, { organizationId: seed.organizationId, modules: { jev: true } as never })
    ).rejects.toThrow();
    expect((await asAdmin.query(api.orgModules.getOrgModules, { organizationId: seed.organizationId })).jev).toBe(false);
  });
});

describe("internalPingJev (diagnóstico)", () => {
  test("ok: estado sintético fixo, sem run nem decisão, sem depender do módulo", async () => {
    const t = setup();
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) =>
      new Response(
        JSON.stringify({ id: "gen-dec-p", model: "typesafe/jev-1.13-20260917", provider: "TypeSafe", answers: { pede_preco: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 350, output_tokens: 20, cost: 0.0000147 } }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await t.action(internal.aiDiagnostics.internalPingJev, {});
    expect(r).toMatchObject({ ok: true, model: "typesafe/jev-1.13-20260917", attempts: 1, costUsd: 0.0000147, costEstimated: false });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).state).toEqual({ mensagem: "quero saber o preço do plano anual" });
    expect(await all(t, "agentRuns")).toHaveLength(0);
    expect(await all(t, "jevDecisions")).toHaveLength(0);
  });
  test("sem chave → no_key; chave recusada → auth (sem vazar a chave)", async () => {
    const t = setup();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(await t.action(internal.aiDiagnostics.internalPingJev, {})).toMatchObject({ ok: false, code: "no_key" });
    vi.stubEnv("OPENROUTER_API_KEY", FAKE_KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: `User not found. ${FAKE_KEY}`, code: 401 } }), { status: 401 })));
    const r = await t.action(internal.aiDiagnostics.internalPingJev, {});
    expect(r).toMatchObject({ ok: false, code: "auth" });
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });
});
