/// <reference types="vite/client" />
import { expect, test, describe, afterEach, vi } from "vitest";
import { chat, chatWithRetry, streamChat, accumulateToolCallDeltas, isUpstreamMislabeled400 } from "./openaiCompatible";
import { resolvePlatformChain, chatWithFallback } from "./index";
import { sanitizeLlmError } from "./sanitize";
import {
  resolveModelId,
  routeInfo,
  OPENROUTER_ZDR_PROVIDER_BODY,
  OPENCODE_GO_MODELS,
  DEFAULT_MODELS,
  DEFAULT_STORED_MODELS,
  supportsVision,
  visionChainFor,
} from "./registry";
import { ContentPart, LlmHttpError, StreamToolCallDelta, flattenContent } from "./types";

const ENDPOINT = { providerId: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "sk-test-secret-key" };
const REQ = { model: "deepseek-v4-flash", messages: [{ role: "user" as const, content: "oi" }] };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// Build a mock streaming Response whose body yields the given byte chunks.
function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat — response parsing", () => {
  test("parses content, usage (incl. cached), tool_calls and finish_reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "getLead", arguments: '{"id":"1"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 64 },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await chat(ENDPOINT, REQ);

    expect(res.finishReason).toBe("tool_calls");
    expect(res.message.content).toBeNull();
    expect(res.message.tool_calls).toHaveLength(1);
    expect(res.message.tool_calls![0].function.name).toBe("getLead");
    expect(res.usage).toEqual({ promptTokens: 100, completionTokens: 20, cachedPromptTokens: 64 });

    // Request shape sanity: correct URL + Bearer auth + stream:false.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect((init as any).headers.Authorization).toBe("Bearer sk-test-secret-key");
    expect(JSON.parse((init as any).body).stream).toBe(false);
  });

  test("maps OpenAI cached_tokens detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } },
        })
      )
    );
    const res = await chat(ENDPOINT, REQ);
    expect(res.usage?.cachedPromptTokens).toBe(40);
  });
});

describe("chatWithRetry", () => {
  test("retries on 429 respecting retry-after then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate limited" }, { "retry-after": "1" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = chatWithRetry(ENDPOINT, REQ, { maxAttempts: 3 });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.message.content).toBe("ok");
    vi.useRealTimers();
  });

  test("does not retry on 400", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: { message: "bad request" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatWithRetry(ENDPOINT, REQ, { maxAttempts: 3 })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("chatWithFallback", () => {
  const routes = resolvePlatformChain("deepseek-v4-flash", {
    opencodeGoKey: "sk-opencode",
    openrouterKey: "sk-openrouter",
  });

  test("advances to the 2nd route on 500 and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" })) // maxAttempts:2 on route 1
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { role: "assistant", content: "from openrouter" }, finish_reason: "stop" }],
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    const promise = chatWithFallback(routes, { messages: REQ.messages });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.message.content).toBe("from openrouter");
    expect(res.usedRoute.providerId).toBe("openrouter");
    // The OpenRouter hop must carry the ZDR double-lock in its body.
    const lastBody = JSON.parse((fetchMock.mock.calls.at(-1)![1] as any).body);
    expect(lastBody.provider).toEqual(OPENROUTER_ZDR_PROVIDER_BODY.provider);
    expect(lastBody.model).toBe("deepseek/deepseek-v4-flash");
    vi.useRealTimers();
  });

  test("does NOT advance on 400 — propagates immediately", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: { message: "nope" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatWithFallback(routes, { messages: REQ.messages })).rejects.toMatchObject({ status: 400 });
    // Only route 1 attempted (maxAttempts:2 but 400 isn't retriable) — exactly one call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("sanitizeLlmError", () => {
  test("redacts sk- keys and Bearer tokens", () => {
    const dirty = "auth failed with Authorization: Bearer sk-proj-abcdef123456 and key sk-or-v1-secretkey99";
    const clean = sanitizeLlmError(dirty);
    expect(clean).not.toContain("sk-proj-abcdef123456");
    expect(clean).not.toContain("sk-or-v1-secretkey99");
    expect(clean).not.toMatch(/Bearer\s+sk-/);
    expect(clean).toContain("[REDACTED]");
  });

  test("truncates at 500 chars and never throws", () => {
    const long = "x".repeat(2000);
    expect(sanitizeLlmError(long).length).toBeLessThanOrEqual(501);
    expect(sanitizeLlmError(undefined as unknown as string)).toBeTypeOf("string");
  });
});

describe("streaming", () => {
  test("parses content deltas and accumulates tool_calls across a split frame", async () => {
    // A tool-call streamed in fragments; the second `data:` frame is split
    // across two chunks (…"argu / ments":"..."}) to exercise the line buffer.
    const chunks = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"getLead","arg',
      'uments":"{\\"id\\""}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"1\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\n',
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(chunks)));

    let text = "";
    const toolDeltas: StreamToolCallDelta[] = [];
    let finish: string | undefined;
    let usageSeen = false;
    for await (const d of streamChat(ENDPOINT, REQ)) {
      if (d.contentDelta) text += d.contentDelta;
      if (d.toolCallDeltas) toolDeltas.push(...d.toolCallDeltas);
      if (d.finishReason) finish = d.finishReason;
      if (d.usage) usageSeen = true;
    }

    expect(text).toBe("Hello");
    expect(finish).toBe("tool_calls");
    expect(usageSeen).toBe(true);

    const calls = accumulateToolCallDeltas(toolDeltas);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("call_9");
    expect(calls[0].function.name).toBe("getLead");
    expect(calls[0].function.arguments).toBe('{"id":"1"}');
  });

  test("throws sanitized LlmHttpError on pre-stream HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { message: "invalid key sk-abcdef123456" } }))
    );
    const gen = streamChat(ENDPOINT, REQ);
    await expect(gen.next()).rejects.toMatchObject({ status: 401 });
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of streamChat(ENDPOINT, REQ)) {
        // no-op
      }
    } catch (e) {
      expect((e as Error).message).not.toContain("sk-abcdef123456");
      expect(e).toBeInstanceOf(LlmHttpError);
    }
  });
});

describe("registry", () => {
  test("resolveModelId maps per-provider and falls back to canonical", () => {
    expect(resolveModelId("deepseek-v4-flash", "openrouter")).toBe("deepseek/deepseek-v4-flash");
    expect(resolveModelId("deepseek-v4-flash", "opencode-go")).toBe("deepseek-v4-flash");
    expect(resolveModelId("unknown-model", "openrouter")).toBe("unknown-model");
  });

  test("routeInfo: opencode-go paid is ZDR; deepseek direct is not", () => {
    expect(routeInfo("opencode-go", "deepseek-v4-flash").zdrCapable).toBe(true);
    expect(routeInfo("deepseek", "deepseek-v4-flash").zdrCapable).toBe(false);
    expect(routeInfo("opencode-go", "deepseek-v4-flash-free").trainsOnData).toBe(true);
    expect(routeInfo("mystery", "x").dataResidency).toBe("desconhecida");
  });
});

describe("resolvePlatformChain", () => {
  test("1 route without openrouterKey, 2 with ZDR extraBody on the 2nd", () => {
    const solo = resolvePlatformChain("deepseek-v4-flash", { opencodeGoKey: "sk-a" });
    expect(solo).toHaveLength(1);
    expect(solo[0].providerId).toBe("opencode-go");

    const both = resolvePlatformChain("deepseek-v4-flash", { opencodeGoKey: "sk-a", openrouterKey: "sk-b" });
    expect(both).toHaveLength(2);
    expect(both[1].providerId).toBe("openrouter");
    expect(both[1].extraBody).toEqual({ ...OPENROUTER_ZDR_PROVIDER_BODY });
    expect(both[0].extraBody).toBeUndefined();
  });
});

describe("400 'Upstream request failed' mal-rotulado (achado do E2E)", () => {
  const upstream400 = () =>
    new Response(JSON.stringify({ error: { message: "Upstream request failed" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  const ok = () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  const endpoint = { providerId: "opencode-go", baseUrl: "https://x.test/v1", apiKey: "sk-test1234" };
  const req = { model: "deepseek-v4-flash", messages: [{ role: "user" as const, content: "oi" }] };

  test("chatWithRetry RE-TENTA o upstream-400 e recupera", async () => {
    vi.useRealTimers(); // sleeps reais (curtos o suficiente com mocks)
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => upstream400())
      .mockImplementationOnce(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const resp = await chatWithRetry(endpoint, req, { maxAttempts: 3 });
    expect(resp.message.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 20_000);

  test("chatWithRetry NÃO re-tenta um 400 genuíno", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "Invalid request: bad tool schema" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatWithRetry(endpoint, req, { maxAttempts: 3 })).rejects.toThrow(/bad tool schema/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("chatWithFallback cai para a 2ª rota no upstream-400 persistente", async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("primary")) return upstream400();
      return ok();
    });
    vi.stubGlobal("fetch", fetchMock);
    const routes = [
      {
        endpoint: { providerId: "opencode-go", baseUrl: "https://primary.test/v1", apiKey: "sk-a1234567" },
        providerId: "opencode-go",
        model: "deepseek-v4-flash",
        canonicalModel: "deepseek-v4-flash",
        zdr: routeInfo("opencode-go", "deepseek-v4-flash"),
      },
      {
        endpoint: { providerId: "openrouter", baseUrl: "https://secondary.test/v1", apiKey: "sk-b1234567" },
        providerId: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        canonicalModel: "deepseek-v4-flash",
        zdr: routeInfo("openrouter", "deepseek-v4-flash"),
      },
    ];
    const resp = await chatWithFallback(routes, { messages: req.messages });
    expect(resp.message.content).toBe("ok");
    expect(resp.usedRoute.providerId).toBe("openrouter");
  }, 30_000);

  test("isUpstreamMislabeled400 distingue upstream de 400 genuíno", () => {
    expect(
      isUpstreamMislabeled400(new LlmHttpError(400, "LLM request failed (HTTP 400): Upstream request failed"))
    ).toBe(true);
    expect(isUpstreamMislabeled400(new LlmHttpError(400, "Invalid request"))).toBe(false);
    expect(isUpstreamMislabeled400(new LlmHttpError(500, "Upstream request failed"))).toBe(false);
  });
});


// ── Visão: content parts + allowlist por rota (F1 do plano de visão) ─────────

describe("content parts (passe de visão)", () => {
  // Comprovante fake: o data URI tem de chegar ao provider byte a byte igual.
  const DATA_URI = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAo=";
  const PARTS: ContentPart[] = [
    { type: "text", text: "Descreva a imagem em JSON." },
    { type: "image_url", image_url: { url: DATA_URI } },
  ];

  test("chat serializa content parts SEM alterar (buildBody passa direto)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 495, completion_tokens: 30 },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await chat(ENDPOINT, {
      model: "deepseek-v4-flash-vision-exp",
      messages: [{ role: "user", content: PARTS }],
      maxTokens: 1500,
    });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.model).toBe("deepseek-v4-flash-vision-exp");
    expect(sent.messages[0].content).toEqual(PARTS);
    // O data URI não pode ser truncado nem re-encodado no caminho.
    expect(sent.messages[0].content[1].image_url.url).toBe(DATA_URI);
  });

  test("flattenContent achata parts em texto e ignora imagens", () => {
    expect(flattenContent(PARTS)).toBe("Descreva a imagem em JSON.");
    expect(
      flattenContent([
        { type: "text", text: "linha 1" },
        { type: "image_url", image_url: { url: DATA_URI } },
        { type: "text", text: "linha 2" },
      ])
    ).toBe("linha 1\nlinha 2");
    expect(flattenContent("já é texto")).toBe("já é texto");
    expect(flattenContent(null)).toBe("");
    expect(flattenContent(undefined)).toBe("");
    // Só imagens -> string vazia, nunca "[object Object]".
    expect(flattenContent([{ type: "image_url", image_url: { url: DATA_URI } }])).toBe("");
  });
});

describe("supportsVision — allowlist FAIL-CLOSED por rota", () => {
  test("modelos que ignoram a imagem em silêncio ficam de fora", () => {
    // hy3 e longcat-2.0 aceitam o request e devolvem tudo null (58-66 tokens de
    // input): não há erro para detectar, por isso a lista é explícita.
    expect(supportsVision("hy3", "opencode-go")).toBe(false);
    expect(supportsVision("longcat-2.0", "opencode-go")).toBe(false);
  });

  test("o ZDR do OpenRouter derruba o melhor modelo — allowlist é POR ROTA", () => {
    expect(supportsVision("deepseek-v4-flash-vision-exp", "opencode-go")).toBe(true);
    expect(supportsVision("deepseek-v4-flash-vision-exp", "openrouter")).toBe(false);
    expect(supportsVision("glm-5.3-flash", "openrouter")).toBe(true);
    expect(supportsVision("glm-5.3-flash", "opencode-go")).toBe(true);
    // kimi-k3 funciona pela OpenCode Go, mas está com 429 persistente no OpenRouter.
    expect(supportsVision("kimi-k3", "opencode-go")).toBe(true);
    expect(supportsVision("kimi-k3", "openrouter")).toBe(false);
  });

  test("provider ou modelo desconhecido -> false", () => {
    expect(supportsVision("glm-5.3-flash", "provider-que-nao-existe")).toBe(false);
    expect(supportsVision("glm-5.3-flash", "openai")).toBe(false);
    expect(supportsVision("modelo-inventado", "opencode-go")).toBe(false);
    expect(supportsVision("", "")).toBe(false);
  });

  test("visionChainFor devolve a cadeia medida, e [] p/ rota sem visão", () => {
    expect(visionChainFor("opencode-go")).toEqual([
      "deepseek-v4-flash-vision-exp",
      "glm-5.3-flash",
      "kimi-k3",
    ]);
    expect(visionChainFor("openrouter")).toEqual(["glm-5.3-flash", "kimi-k2.7-code", "mimo-v2.5"]);
    expect(visionChainFor("openai")).toEqual([]);
    expect(visionChainFor("nao-existe")).toEqual([]);
  });

  test("toda a cadeia da OpenCode Go existe no /v1/models e o default é o 1º", () => {
    for (const model of visionChainFor("opencode-go")) {
      expect(OPENCODE_GO_MODELS).toContain(model);
    }
    expect(DEFAULT_MODELS.vision).toBe(visionChainFor("opencode-go")[0]);
    // Resolução de id na rota OpenRouter (D17).
    expect(resolveModelId("glm-5.3-flash", "openrouter")).toBe("z-ai/glm-5.3-flash");
    expect(resolveModelId("mimo-v2.5", "openrouter")).toBe("xiaomi/mimo-v2.5");
    expect(resolveModelId("kimi-k2.7-code", "openrouter")).toBe("moonshotai/kimi-k2.7-code");
    // Pela rota OpenCode Go o id canônico vale como está.
    expect(resolveModelId("deepseek-v4-flash-vision-exp", "opencode-go")).toBe(
      "deepseek-v4-flash-vision-exp"
    );
  });

  test("o papel 'vision' NÃO entra no que a org persiste (aiModelsValidator)", () => {
    // Gravar { ...DEFAULT_MODELS } em providerConfig.models quebra o validator
    // do schema ("Unexpected field `vision`") — o modelo de visão vem da cadeia
    // por rota, não da config da org.
    expect(Object.keys(DEFAULT_STORED_MODELS).sort()).toEqual([
      "attendant",
      "classify",
      "complex",
      "copilot",
    ]);
    expect(DEFAULT_STORED_MODELS).not.toHaveProperty("vision");
  });
});
