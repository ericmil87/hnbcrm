/// <reference types="vite/client" />
/**
 * Ops de laboratório `opsPromptReplay:internalReplayBody`: reenvia um corpo já
 * montado ao caminho de LLM do atendente. Prova: dryRun (default) não chama o
 * LLM, o teto de amostras vale, IA desligada recusa e NADA é gravado.
 */
import { expect, test, describe, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubLlm() {
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Disponha!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function seed(t: TestConvex<typeof schema>, aiEnabled: boolean) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Replay",
      slug: "org-replay",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: aiEnabled, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Admin", role: "admin", type: "human", status: "active",
      createdAt: now, updatedAt: now,
    });
    if (aiEnabled) {
      const org = (await ctx.db.get(organizationId))!;
      await ctx.db.patch(organizationId, {
        settings: {
          ...org.settings,
          aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: adminId } },
        },
      });
    }
    const agentMemberId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" },
      createdAt: now, updatedAt: now,
    });
    return { organizationId, agentMemberId };
  });
}

const messages = [
  { role: "system", content: "Você é a Ana." },
  { role: "user", content: "Oi" },
];

describe("opsPromptReplay.internalReplayBody", () => {
  test("dryRun é o padrão: devolve a cadeia de rotas e NÃO chama o LLM", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, true);
    const fetchMock = stubLlm();
    const res = await t.action(internal.opsPromptReplay.internalReplayBody, { ...s, messages });
    expect(res.dryRun).toBe(true);
    expect(res.routes!.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("dryRun:false reenvia N vezes e devolve só texto/tools/modelo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, true);
    const fetchMock = stubLlm();
    const res = await t.action(internal.opsPromptReplay.internalReplayBody, {
      ...s, messages, n: 3, dryRun: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.samples!).toHaveLength(3);
    expect(res.samples![0]).toMatchObject({ text: "Disponha!", finishReason: "stop", toolCalls: [] });
  });

  test("n tem teto (20) e piso (1)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, true);
    stubLlm();
    const alto = await t.action(internal.opsPromptReplay.internalReplayBody, {
      ...s, messages, n: 999, dryRun: false,
    });
    expect(alto.samples!).toHaveLength(20);
    const baixo = await t.action(internal.opsPromptReplay.internalReplayBody, {
      ...s, messages, n: -5, dryRun: false,
    });
    expect(baixo.samples!).toHaveLength(1);
  });

  test("IA da organização desligada recusa sem chamar o LLM", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, false);
    const fetchMock = stubLlm();
    const res = await t.action(internal.opsPromptReplay.internalReplayBody, {
      ...s, messages, dryRun: false,
    });
    expect(res.error).toMatch(/desligada/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("não grava nada no banco", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, true);
    stubLlm();
    const before = await t.run(async (ctx) => ({
      messages: (await ctx.db.query("messages").collect()).length,
      runs: (await ctx.db.query("agentRuns").collect()).length,
      audit: (await ctx.db.query("auditLogs").collect()).length,
    }));
    await t.action(internal.opsPromptReplay.internalReplayBody, { ...s, messages, n: 2, dryRun: false });
    const after = await t.run(async (ctx) => ({
      messages: (await ctx.db.query("messages").collect()).length,
      runs: (await ctx.db.query("agentRuns").collect()).length,
      audit: (await ctx.db.query("auditLogs").collect()).length,
    }));
    expect(after).toEqual(before);
  });
});
