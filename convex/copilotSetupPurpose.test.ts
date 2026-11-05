/// <reference types="vite/client" />
/** `purpose:"setup"` no `POST /api/copilot/stream` (fv2-20). Mesmos mocks de copilotStream.test.ts. */
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


async function post(
  t: ReturnType<typeof convexTest>,
  s: Seed,
  payload: Record<string, unknown>
) {
  const asUser = t.withIdentity({ subject: `${s.userId}|s1` });
  return await asUser.fetch("/api/copilot/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId: s.organizationId, ...payload }),
  });
}

type Sent = { messages: Array<{ role: string; content: string }> };

describe("copilot purpose setup", () => {
  test("purpose setup injeta contextBlock do servidor", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubLlm([textFrames("Vamos lá!")]);
    const res = await post(t, s, { message: "me ajude a configurar", purpose: "setup" });
    expect(res.status).toBe(200);
    await readEvents(res);
    const sent = calls[0].body as Sent;
    const systems = sent.messages.filter((m) => m.role === "system");
    expect(systems).toHaveLength(2);
    expect(systems[1].content).toContain("CONTEXTO DA CONFIGURAÇÃO INICIAL");
    expect(systems[1].content).toContain("Org SSE");
    expect(systems[1].content).toContain("WhatsApp: não conectado");
    expect(systems[1].content).not.toContain("eric@example.com");
    // O texto do usuário segue intacto (o cliente não manda contexto).
    expect(sent.messages[sent.messages.length - 1]).toMatchObject({
      role: "user",
      content: "me ajude a configurar",
    });
  });

  test("purpose desconhecido é ignorado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubLlm([textFrames("Olá!")]);
    const res = await post(t, s, { message: "oi", purpose: "hack" });
    const events = await readEvents(res);
    const sent = calls[0].body as Sent;
    expect(sent.messages.filter((m) => m.role === "system")).toHaveLength(1);
    const threadId = events[0].threadId as Id<"copilotThreads">;
    const thread = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(thread?.title).toBe("oi");
  });

  test("purpose setup cria thread com título Configuração guiada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubLlm([textFrames("Olá!")]);
    const res = await post(t, s, { message: "quero configurar", purpose: "setup" });
    const events = await readEvents(res);
    const threadId = events[0].threadId as Id<"copilotThreads">;
    const thread = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(thread?.title).toBe("Configuração guiada");
  });

  test("purpose setup sem IA ativa é recusado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const org = await ctx.db.get(s.organizationId);
      await ctx.db.patch(s.organizationId, {
        settings: {
          ...org!.settings,
          aiConfig: { enabled: false, autoAssign: false, handoffThreshold: 0.8 },
        },
      });
    });
    const calls = stubLlm([textFrames("x")]);
    const res = await post(t, s, { message: "oi", purpose: "setup" });
    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Quero que a IA me ajude");
    expect(calls).toHaveLength(0);
  });
});
