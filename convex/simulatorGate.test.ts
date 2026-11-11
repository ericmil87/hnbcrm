/// <reference types="vite/client" />
/**
 * Simulador do atendente (P2.4): só roda com IA ativa, respeita o teto de
 * gastos/modo leitura da org e agora é MEDIDO (agentRuns `simulator` +
 * aiUsageMonthly).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 10, 15, 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubLlm() {
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Olá, posso ajudar?" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 500, completion_tokens: 40 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function seed(t: T, opts: { ack?: boolean; enabled?: boolean; aiExtra?: Record<string, unknown>; billing?: Record<string, unknown> } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Sim",
      slug: "org-sim",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: opts.enabled ?? true, autoAssign: false, handoffThreshold: 0.8, ...opts.aiExtra },
      },
      ...(opts.billing ? { billing: opts.billing as never } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    if (opts.ack !== false) {
      const org = (await ctx.db.get(organizationId))!;
      await ctx.db.patch(organizationId, {
        settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: adminId } } },
      });
    }
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" }, createdAt: now, updatedAt: now,
    });
    return { userId, organizationId, agentId };
  });
}

const simulate = (t: T, s: Awaited<ReturnType<typeof seed>>) =>
  t.withIdentity({ subject: `${s.userId}|s1` }).action(api.attendant.simulateAttendant, {
    organizationId: s.organizationId,
    agentMemberId: s.agentId,
    transcript: [{ role: "customer" as const, content: "Oi" }],
  });

describe("simulateAttendant: gate e medição", () => {
  test("IA ativa: simula e registra a run + medidor mensal", async () => {
    const fetchMock = stubLlm();
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const result = await simulate(t, s);
    expect(result.error).toBeNull();
    expect(result.reply).toContain("Olá");
    expect(fetchMock).toHaveBeenCalled();
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("agentRuns").collect();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ kind: "simulator", status: "done", organizationId: s.organizationId });
      expect(runs[0].promptTokens).toBeGreaterThan(0);
      const usage = await ctx.db.query("aiUsageMonthly").collect();
      expect(usage).toHaveLength(1);
      expect(usage[0].byKind.simulator.runs).toBe(1);
      expect(usage[0].costUsdMicros).toBeGreaterThan(0);
    });
  });

  test("sem aceite de IA/LGPD ou IA desligada: recusa sem chamar o modelo nem gravar run", async () => {
    for (const opts of [{ ack: false }, { enabled: false }]) {
      const fetchMock = stubLlm();
      const t = convexTest(schema, modules);
      const s = await seed(t, opts);
      const result = await simulate(t, s);
      expect(result.reply).toBeNull();
      expect(result.error).toMatch(/Ative a IA/);
      expect(fetchMock).not.toHaveBeenCalled();
      await t.run(async (ctx) => {
        expect(await ctx.db.query("agentRuns").collect()).toHaveLength(0);
      });
    }
  });

  test("teto de gastos em modo block estourado: recusa", async () => {
    const fetchMock = stubLlm();
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiExtra: { spendCap: { monthlyBrl: 0.01, mode: "block" } } });
    await t.run(async (ctx) => {
      await ctx.db.insert("aiUsageMonthly", {
        organizationId: s.organizationId, month: "2026-11", costUsdMicros: 5_000_000, runs: 1, byKind: {}, updatedAt: Date.now(),
      });
    });
    const result = await simulate(t, s);
    expect(result.reply).toBeNull();
    expect(result.error).toMatch(/teto/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("modo leitura: recusa", async () => {
    const fetchMock = stubLlm();
    const t = convexTest(schema, modules);
    const s = await seed(t, { billing: { status: "read_only", plan: "profissional", updatedAt: Date.now() } });
    const result = await simulate(t, s);
    expect(result.error).toMatch(/modo leitura/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
