/// <reference types="vite/client" />
/**
 * Regressão do SSE do Copiloto (`POST /api/copilot/stream`).
 *
 * Golden gravado ANTES da extração do loop para `lib/copilotTurn.ts` (F3 do
 * Copiloto no Telegram): a sequência de eventos, o que fica persistido na
 * thread e o run em `agentRuns` têm de ser idênticos depois do refactor.
 * O LLM é um `fetch` stubado que devolve SSE no formato OpenAI.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-FAKE-test-key");
  vi.stubEnv("LLM_PLATFORM_ORDER", "openrouter-only");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Seed = {
  organizationId: Id<"organizations">;
  memberId: Id<"teamMembers">;
  userId: Id<"users">;
};

async function seed(t: TestConvex<typeof schema>): Promise<Seed> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", { email: "eric@example.com" });
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org SSE",
      slug: "org-sse",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: false, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Eric",
      email: "eric@example.com",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    // lgpdAck precisa apontar para um membro real.
    const org = await ctx.db.get(organizationId);
    await ctx.db.patch(organizationId, {
      settings: {
        ...org!.settings,
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 0.8,
          lgpdAck: { acceptedAt: now, acceptedBy: memberId },
        },
      },
    });
    return { organizationId, memberId, userId };
  });
}

function sseBody(frames: Array<Record<string, unknown> | "[DONE]">): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) {
        const payload = f === "[DONE]" ? "[DONE]" : JSON.stringify(f);
        controller.enqueue(enc.encode(`data: ${payload}\n\n`));
      }
      controller.close();
    },
  });
}

const textFrames = (text: string) => [
  { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
  { choices: [{ delta: { content: text.slice(0, 4) }, finish_reason: null }] },
  { choices: [{ delta: { content: text.slice(4) }, finish_reason: null }] },
  {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  },
  "[DONE]" as const,
];

const toolFrames = (name: string, args: string) => [
  {
    choices: [
      {
        delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "" } }] },
        finish_reason: null,
      },
    ],
  },
  {
    choices: [
      { delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null },
    ],
  },
  {
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
  },
  "[DONE]" as const,
];

/** Stub do LLM: cada chamada consome a próxima resposta da fila. */
function stubLlm(responses: Array<Array<Record<string, unknown> | "[DONE]">>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const next = responses.shift();
      if (!next) return new Response("no more fixtures", { status: 500 });
      return new Response(sseBody(next), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    })
  );
  return calls;
}

async function readEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice("data: ".length)));
}

describe("copilot SSE golden", () => {
  test("texto puro: thread → deltas → done; persiste user+assistant e fecha o run", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubLlm([textFrames("Olá, Eric!")]);
    const asUser = t.withIdentity({ subject: `${s.userId}|s1` });

    const res = await asUser.fetch("/api/copilot/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: s.organizationId, message: "oi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const events = await readEvents(res);

    expect(events.map((e) => e.type)).toEqual(["thread", "delta", "delta", "done"]);
    const threadId = events[0].threadId as Id<"copilotThreads">;
    expect(typeof threadId).toBe("string");
    expect(events.filter((e) => e.type === "delta").map((e) => e.text).join("")).toBe(
      "Olá, Eric!"
    );
    expect(calls).toHaveLength(1);
    const sent = calls[0].body as { messages: Array<{ role: string; content: string }>; stream: boolean };
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[0].content).toContain("Copiloto do HNBCRM");
    expect(sent.messages[sent.messages.length - 1]).toMatchObject({ role: "user", content: "oi" });

    const persisted = await t.run(async (ctx) => {
      const thread = await ctx.db.get(threadId);
      const messages = await ctx.db
        .query("copilotMessages")
        .withIndex("by_thread_and_created", (q) => q.eq("threadId", threadId))
        .collect();
      const runs = await ctx.db.query("agentRuns").collect();
      return { thread, messages, runs };
    });
    expect(persisted.thread?.title).toBe("oi");
    expect(persisted.messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "oi", undefined],
      ["assistant", "Olá, Eric!", "done"],
    ]);
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0]).toMatchObject({ kind: "copilot", status: "done", requestCount: 1 });
    expect(persisted.runs[0].toolCallNames).toEqual([]);
  });

  test("rodada com tool de leitura: evento tool, resultado volta como dado e o turno termina", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubLlm([
      toolFrames("getDashboardStats", "{}"),
      textFrames("Resumo pronto."),
    ]);
    const asUser = t.withIdentity({ subject: `${s.userId}|s1` });

    const res = await asUser.fetch("/api/copilot/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: s.organizationId, message: "como está o funil?" }),
    });
    const events = await readEvents(res);
    expect(events.map((e) => e.type)).toEqual(["thread", "tool", "delta", "delta", "done"]);
    expect(events[1]).toEqual({ type: "tool", name: "getDashboardStats" });
    expect(calls).toHaveLength(2);
    // A 2ª chamada leva o assistant(tool_calls) + a resposta role:"tool" envelopada.
    const second = calls[1].body as { messages: Array<Record<string, unknown>> };
    const roles = second.messages.map((m) => m.role);
    expect(roles.slice(-3)).toEqual(["user", "assistant", "tool"]);
    expect(String(second.messages[second.messages.length - 1].content)).toContain("getDashboardStats");

    const threadId = events[0].threadId as Id<"copilotThreads">;
    const persisted = await t.run(async (ctx) => {
      const messages = await ctx.db
        .query("copilotMessages")
        .withIndex("by_thread_and_created", (q) => q.eq("threadId", threadId))
        .collect();
      const runs = await ctx.db.query("agentRuns").collect();
      return { messages, runs };
    });
    expect(persisted.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(persisted.messages[1].toolCalls?.[0]).toMatchObject({ id: "call_1", name: "getDashboardStats" });
    expect(persisted.runs[0]).toMatchObject({ status: "done", requestCount: 2 });
    expect(persisted.runs[0].toolCallNames).toEqual(["getDashboardStats"]);
  });

  test("tool de escrita: createTask grava a tarefa como humano via copiloto e o turno fecha", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubLlm([
      toolFrames("createTask", JSON.stringify({ title: "Ligar para a Rejane" })),
      textFrames("Tarefa criada."),
    ]);
    const asUser = t.withIdentity({ subject: `${s.userId}|s1` });
    const res = await asUser.fetch("/api/copilot/stream", {
      method: "POST",
      body: JSON.stringify({ organizationId: s.organizationId, message: "cria uma tarefa" }),
    });
    const events = await readEvents(res);
    expect(events.map((e) => e.type)).toEqual(["thread", "tool", "delta", "delta", "done"]);
    expect(calls).toHaveLength(2);
    const persisted = await t.run(async (ctx) => ({
      tasks: await ctx.db.query("tasks").collect(),
      threadMessages: await ctx.db.query("copilotMessages").collect(),
    }));
    expect(persisted.tasks).toHaveLength(1);
    expect(persisted.tasks[0].title).toBe("Ligar para a Rejane");
    // O copiloto age COMO o usuário: criador e responsável são o membro humano.
    expect(persisted.tasks[0].createdBy).toEqual(s.memberId);
    expect(persisted.tasks[0].assignedTo).toEqual(s.memberId);
    // O resultado da tool voltou ao modelo como dado delimitado.
    const toolMsg = persisted.threadMessages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("resultado de createTask");
  });

  test("fallback de rota antes do 1º delta: 400 não-retriável na 1ª rota → 2ª rota responde", async () => {
    vi.stubEnv("OPENCODE_GO_API", "sk-opencode-FAKE-test");
    vi.stubEnv("LLM_PLATFORM_ORDER", "auto");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (!/openrouter/i.test(url)) {
          return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
        }
        return new Response(sseBody(textFrames("Via rota 2.")), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      })
    );
    const asUser = t.withIdentity({ subject: `${s.userId}|s1` });
    const res = await asUser.fetch("/api/copilot/stream", {
      method: "POST",
      body: JSON.stringify({ organizationId: s.organizationId, message: "oi" }),
    });
    const events = await readEvents(res);
    expect(events.map((e) => e.type)).toEqual(["thread", "delta", "delta", "done"]);
    // 1ª rota (OpenCode Go) falhou com 400 não-retriável → sem retry, direto pra 2ª.
    expect(urls.filter((u) => !/openrouter/i.test(u))).toHaveLength(1);
    expect(urls.filter((u) => /openrouter/i.test(u))).toHaveLength(1);
    const runs = await t.run(async (ctx) => await ctx.db.query("agentRuns").collect());
    expect(runs[0].status).toBe("done");
    expect(runs[0].requestCount).toBe(2);
    expect(String(runs[0].provider)).toMatch(/openrouter/i);
  });

  test("content_filter → evento error e run error", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubLlm([
      [
        { choices: [{ delta: { content: "Olá" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "content_filter" }] },
        "[DONE]",
      ],
    ]);
    const asUser = t.withIdentity({ subject: `${s.userId}|s1` });
    const res = await asUser.fetch("/api/copilot/stream", {
      method: "POST",
      body: JSON.stringify({ organizationId: s.organizationId, message: "oi" }),
    });
    const events = await readEvents(res);
    expect(events.map((e) => e.type)).toEqual(["thread", "delta", "error"]);
    expect(String(events[2].message)).toMatch(/filtro de conteúdo/);
    const runs = await t.run(async (ctx) => await ctx.db.query("agentRuns").collect());
    expect(runs[0].status).toBe("error");
  });

  test("histórico cortado em 60 mensagens, em fronteira de mensagem do usuário", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const threadId = await t.run(async (ctx) => {
      const now = Date.now();
      const threadId = await ctx.db.insert("copilotThreads", {
        organizationId: s.organizationId,
        memberId: s.memberId,
        title: "antiga",
        createdAt: now,
        updatedAt: now,
      });
      for (let i = 0; i < 71; i++) {
        await ctx.db.insert("copilotMessages", {
          threadId,
          organizationId: s.organizationId,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `m${i}`,
          status: i % 2 === 0 ? undefined : "done",
          createdAt: now - 10_000 + i,
        });
      }
      return threadId;
    });
    const calls = stubLlm([textFrames("ok.")]);
    const asUser = t.withIdentity({ subject: `${s.userId}|s1` });
    const res = await asUser.fetch("/api/copilot/stream", {
      method: "POST",
      body: JSON.stringify({ organizationId: s.organizationId, threadId, message: "nova" }),
    });
    const events = await readEvents(res);
    expect(events[0]).toMatchObject({ type: "thread", threadId });
    const sent = calls[0].body as { messages: Array<{ role: string; content: string }> };
    const history = sent.messages.slice(1);
    expect(history.length).toBeLessThanOrEqual(60);
    expect(history[0].role).toBe("user");
    expect(history[history.length - 1]).toMatchObject({ role: "user", content: "nova" });
  });

  test("sem sessão → 401; copiloto desligado → 403; sem rota → 503", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const anon = await t.fetch("/api/copilot/stream", {
      method: "POST",
      body: JSON.stringify({ organizationId: s.organizationId, message: "oi" }),
    });
    expect(anon.status).toBe(401);

    await t.run(async (ctx) => {
      const org = await ctx.db.get(s.organizationId);
      await ctx.db.patch(s.organizationId, {
        settings: {
          ...org!.settings,
          aiConfig: { ...(org!.settings.aiConfig as object), copilotEnabled: false } as never,
        },
      });
    });
    const asUser = t.withIdentity({ subject: `${s.userId}|s1` });
    const off = await asUser.fetch("/api/copilot/stream", {
      method: "POST",
      body: JSON.stringify({ organizationId: s.organizationId, message: "oi" }),
    });
    expect(off.status).toBe(403); // gate da org (antes da F3 respondia 401 por regex incompleta)
    expect((await off.json()).error).toMatch(/desativado/);

    await t.run(async (ctx) => {
      const org = await ctx.db.get(s.organizationId);
      await ctx.db.patch(s.organizationId, {
        settings: {
          ...org!.settings,
          aiConfig: { ...(org!.settings.aiConfig as object), copilotEnabled: true } as never,
        },
      });
    });
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENCODE_GO_API", "");
    const noRoute = await asUser.fetch("/api/copilot/stream", {
      method: "POST",
      body: JSON.stringify({ organizationId: s.organizationId, message: "oi" }),
    });
    expect(noRoute.status).toBe(503);
  });

  test("erro do provider antes do 1º delta em todas as rotas → evento error e run error", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 }))
    );
    const asUser = t.withIdentity({ subject: `${s.userId}|s1` });
    const res = await asUser.fetch("/api/copilot/stream", {
      method: "POST",
      body: JSON.stringify({ organizationId: s.organizationId, message: "oi" }),
    });
    const events = await readEvents(res);
    expect(events.map((e) => e.type)).toEqual(["thread", "error"]);
    const runs = await t.run(async (ctx) => await ctx.db.query("agentRuns").collect());
    expect(runs[0].status).toBe("error");
  });

  test("thread de outro membro: 409 thread_not_owned, sem mensagens nem run", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubLlm([textFrames("não deve rodar")]);
    const { otherUserId, threadId } = await t.run(async (ctx) => {
      const now = Date.now();
      const otherUserId = await ctx.db.insert("users", { email: "outro@example.com" });
      const otherMemberId = await ctx.db.insert("teamMembers", {
        organizationId: s.organizationId,
        userId: otherUserId,
        name: "Outro",
        email: "outro@example.com",
        role: "admin",
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const threadId = await ctx.db.insert("copilotThreads", {
        organizationId: s.organizationId,
        memberId: otherMemberId,
        createdAt: now,
        updatedAt: now,
      });
      return { otherUserId, threadId };
    });
    expect(otherUserId).not.toBe(s.userId);
    const res = await t.withIdentity({ subject: `${s.userId}|s1` }).fetch("/api/copilot/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: s.organizationId, threadId, message: "oi" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("thread_not_owned");
    expect(typeof body.error).toBe("string");
    expect(calls).toHaveLength(0);
    const after = await t.run(async (ctx) => ({
      messages: await ctx.db.query("copilotMessages").collect(),
      runs: await ctx.db.query("agentRuns").collect(),
    }));
    expect(after.messages).toHaveLength(0);
    expect(after.runs).toHaveLength(0);
  });
});
