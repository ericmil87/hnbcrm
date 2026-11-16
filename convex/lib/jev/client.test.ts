import { describe, expect, it, vi } from "vitest";
import {
  JEV_BACKOFF_MS,
  JEV_MAX_ATTEMPTS,
  JEV_RETRY_AFTER_CAP_MS,
  buildJevRequestBody,
  callJev,
  parseRetryAfterMs,
  type JevFetch,
} from "./client";
import { JEV_MODEL, JEV_URL, JevError, JevValidationError, type JevQuestions } from "./types";
import { JEV_REQUEST_ALLOWED_KEYS } from "./validate";
import { OPENROUTER_ZDR_PROVIDER_BODY } from "../llm/registry";

const KEY = "sk-or-v1-fake-test-key-0000";
const Q: JevQuestions = {
  pede_humano: { type: "noul", instructions: "`mensagem` pede uma pessoa?" },
  intencao: { type: "choice", instructions: "Qual o pedido?", criteria: { preco: "valor", outro: "resto" } },
};
const STATE = { mensagem: "quero o preço" };

const okBody = (usage: Record<string, unknown> = { input_tokens: 300, output_tokens: 40, cost: 0.0000126, is_byok: false }) => ({
  id: "gen-dec-9",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    pede_humano: { type: "noul", noul: 0.02 },
    intencao: { type: "choice", choice: "preco", confidence: 0.9, probabilities: { preco: 0.95, outro: 0.05 } },
  },
  usage,
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

/** Relógio fake: só avança quando o cliente "dorme". */
function harness(responses: Array<Response | Error | (() => Response | Promise<Response>)>) {
  let t = 0;
  const waits: number[] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...responses];
  const fetchImpl: JevFetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch sem resposta enfileirada");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  const sleepImpl = async (ms: number) => {
    waits.push(ms);
    t += ms;
  };
  return { fetchImpl, sleepImpl, waits, calls, nowMs: () => t, random: () => 0.5 };
}
const call = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) =>
  callJev({ apiKey: KEY, state: STATE, questions: Q, fetchImpl: h.fetchImpl, sleepImpl: h.sleepImpl, nowMs: h.nowMs, random: h.random, ...extra });
const failure = async (p: Promise<unknown>): Promise<JevError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(JevError);
    return e as JevError;
  }
  throw new Error("deveria ter lançado");
};

describe("corpo da requisição", () => {
  it("vai para JEV_URL com a chave só no header e SÓ os campos permitidos, com o provider do repo", async () => {
    const h = harness([json(200, okBody())]);
    await call(h);
    expect(h.calls).toHaveLength(1);
    const { url, init } = h.calls[0]!;
    expect(url).toBe(JEV_URL);
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual([...JEV_REQUEST_ALLOWED_KEYS].sort());
    expect(body.model).toBe(JEV_MODEL);
    expect(body.provider).toEqual(OPENROUTER_ZDR_PROVIDER_BODY.provider);
    expect(body.provider.data_collection).toBe("deny");
    expect(init.body as string).not.toContain(KEY);
  });
  it("buildJevRequestBody devolve cópia do provider (não aliasa a constante do registry)", () => {
    const b = buildJevRequestBody(STATE, Q);
    expect(b.provider).not.toBe(OPENROUTER_ZDR_PROVIDER_BODY.provider);
    expect(Object.keys(b)).toEqual(["model", "state", "questions", "provider"]);
  });
  it("pergunta inválida lança ANTES de qualquer chamada (erro nosso, não da API)", async () => {
    const h = harness([]);
    await expect(call(h, { questions: { x: { type: "choice", instructions: "?", criteria: { a: "so uma" } } } })).rejects.toBeInstanceOf(JevValidationError);
    expect(h.calls).toHaveLength(0);
  });
});

describe("sucesso e custo", () => {
  it("devolve respostas tipadas, snapshot, id e custo do provedor (costEstimated=false)", async () => {
    const r = await call(harness([json(200, okBody())]));
    expect(r.model).toBe("typesafe/jev-1.13-20260917");
    expect(r.requestId).toBe("gen-dec-9");
    expect(r.provider).toBe("TypeSafe");
    expect(r.answers.pede_humano).toEqual({ type: "noul", noul: 0.02 });
    expect(r.usage).toEqual({ promptTokens: 300, completionTokens: 40, costUsd: 0.0000126 });
    expect(r.costEstimated).toBe(false);
    expect(r.attempts).toBe(1);
  });
  it("usage.cost AUSENTE → costEstimated (a tabela de preços cobre; nunca 0)", async () => {
    const r = await call(harness([json(200, okBody({ input_tokens: 300, output_tokens: 40 }))]));
    expect(r.costEstimated).toBe(true);
    expect(r.usage.costUsd).toBeUndefined();
    expect(r.usage.promptTokens).toBe(300);
  });
  it("usage.cost = 0 com tokens consumidos é tratado como ausente (não é grátis por engano)", async () => {
    const r = await call(harness([json(200, okBody({ input_tokens: 300, output_tokens: 40, cost: 0 }))]));
    expect(r.costEstimated).toBe(true);
    expect(r.usage.costUsd).toBeUndefined();
  });
  it("200 sem resposta de uma pergunta → invalid_response, SEM retry (repetir não conserta)", async () => {
    const body = okBody();
    delete (body.answers as Record<string, unknown>).pede_humano;
    const h = harness([json(200, body), json(200, okBody())]);
    const e = await failure(call(h));
    expect(e.code).toBe("invalid_response");
    expect(e.retryable).toBe(false);
    expect(h.calls).toHaveLength(1);
  });
  it("200 que não é JSON → invalid_response sem retry", async () => {
    const h = harness([json(200, "<html>oops</html>")]);
    expect((await failure(call(h))).code).toBe("invalid_response");
    expect(h.calls).toHaveLength(1);
  });
});

describe("retry", () => {
  it("429 + Retry-After: espera o que o servidor pediu (≥ backoff) e depois funciona", async () => {
    const h = harness([json(429, { error: { message: "rate limited", code: 429 } }, { "retry-after": "3" }), json(200, okBody())]);
    const r = await call(h);
    expect(r.attempts).toBe(2);
    expect(h.waits).toEqual([3000]);
  });
  it("Retry-After absurdo é limitado ao teto", async () => {
    const h = harness([json(429, { error: { message: "x" } }, { "retry-after": "600" }), json(200, okBody())]);
    await call(h);
    expect(h.waits).toEqual([JEV_RETRY_AFTER_CAP_MS]);
  });
  it("sem Retry-After usa o backoff da tabela (jitter 0,5 → fator 1,0)", async () => {
    const h = harness([json(503, { error: { message: "x" } }), json(524, "timeout cdn"), json(200, okBody())]);
    const r = await call(h);
    expect(r.attempts).toBe(3);
    expect(h.waits).toEqual([JEV_BACKOFF_MS[0], JEV_BACKOFF_MS[1]]);
  });
  it("5xx persistente: desiste na última tentativa com o erro do servidor", async () => {
    const h = harness(Array.from({ length: JEV_MAX_ATTEMPTS }, () => json(500, { error: { message: "boom" } })));
    const e = await failure(call(h, { deadlineMs: 60_000 }));
    expect(e.code).toBe("server");
    expect(e.status).toBe(500);
    expect(h.calls).toHaveLength(JEV_MAX_ATTEMPTS);
    expect(h.waits).toEqual([...JEV_BACKOFF_MS]);
  });
  it("o prazo total corta o retry: fail-open vale mais que insistir", async () => {
    const h = harness([json(503, { error: { message: "x" } }), json(200, okBody())]);
    const e = await failure(call(h, { deadlineMs: 100 }));
    expect(e.code).toBe("server");
    expect(h.calls).toHaveLength(1);
    expect(h.waits).toEqual([]);
  });
  it("402 TRANSITÓRIO (orçamento em voo) é retentado; 402 de crédito é terminal", async () => {
    const inflight = json(402, { error: { message: "in flight", code: 402, metadata: { limit_source: "openrouter_in_flight_budget" } } }, { "retry-after": "1" });
    const h1 = harness([inflight, json(200, okBody())]);
    expect((await call(h1)).attempts).toBe(2);
    const h2 = harness([json(402, { error: { message: "Insufficient credits", code: 402 } }), json(200, okBody())]);
    const e = await failure(call(h2));
    expect(e.code).toBe("credit");
    expect(e.retryable).toBe(false);
    expect(h2.calls).toHaveLength(1);
  });
  it("erro de rede é retentado", async () => {
    const h = harness([new TypeError("fetch failed"), json(200, okBody())]);
    expect((await call(h)).attempts).toBe(2);
  });
  it("timeout real (AbortSignal) vira code 'timeout' e é retentado até o limite", async () => {
    // Um fetch que nunca responde, mas respeita o signal, como o real:
    const calls: number[] = [];
    const fetchImpl: JevFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        calls.push(1);
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const e = await failure(callJev({ apiKey: KEY, state: STATE, questions: Q, fetchImpl, sleepImpl: async () => {}, timeoutMs: 5, deadlineMs: 60_000 }));
    expect(e.code).toBe("timeout");
    expect(calls).toHaveLength(JEV_MAX_ATTEMPTS);
  });
});

describe("erros terminais (uma tentativa só)", () => {
  const cases: Array<[number, string, string]> = [
    [400, "bad_request", "Model typesafe/jev-0.0 does not exist"],
    [401, "auth", "User not found."],
    [403, "auth", "forbidden"],
    [404, "provider_unavailable", "No allowed providers are available for the selected model"],
    [418, "http_error", "teapot"],
  ];
  for (const [status, code, message] of cases) {
    it(`${status} → ${code}, sem retry`, async () => {
      const h = harness([json(status, { error: { message, code: status } }), json(200, okBody())]);
      const e = await failure(call(h));
      expect(e.code).toBe(code);
      expect(e.status).toBe(status);
      expect(e.retryable).toBe(false);
      expect(h.calls).toHaveLength(1);
    });
  }
  it("a chave nunca aparece na mensagem de erro, nem quando o servidor a ecoa", async () => {
    const h = harness([json(400, { error: { message: `bad header Authorization: Bearer ${KEY}` } })]);
    const e = await failure(call(h));
    expect(e.message).not.toContain(KEY);
    expect(e.message.length).toBeLessThan(500);
  });
  it("corpo de erro que não é JSON também é tratado e truncado", async () => {
    const h = harness([json(400, "x".repeat(5000))]);
    const e = await failure(call(h));
    expect(e.code).toBe("bad_request");
    expect(e.message.length).toBeLessThan(500);
  });
  it("400/4xx NÃO copiam o corpo (pode ecoar o estado com nome do lead); só o código", async () => {
    for (const status of [400, 422, 405]) {
      const h = harness([json(status, { error: { message: "Invalid value 'Maria Souza, Rua das Flores 10' at state.mensagem", code: status } })]);
      const e = await failure(call(h));
      expect(e.message, String(status)).not.toContain("Maria");
      expect(e.message, String(status)).not.toContain("Flores");
      expect(e.message).toContain(String(status));
    }
  });
  it("401/402/404/5xx mantêm a mensagem do servidor (não ecoam estado), já mascarada de dado pessoal", async () => {
    const h = harness([json(404, { error: { message: "No allowed providers are available for the selected model", code: 404 } })]);
    expect((await failure(call(h))).message).toContain("No allowed providers");
    const h2 = harness([json(401, { error: { message: "User not found. contato 81 99999-8888", code: 401 } })]);
    const e = await failure(call(h2));
    expect(e.message).toContain("User not found");
    expect(e.message).not.toContain("99999");
  });
  it("attempts na falha = quantas chamadas saíram (retry conta)", async () => {
    const h = harness([json(503, { error: { message: "x" } }), json(503, { error: { message: "x" } }), json(400, { error: { code: 400 } })]);
    const e = await failure(call(h));
    expect(e.code).toBe("bad_request");
    expect(e.attempts).toBe(3);
    const h2 = harness(Array.from({ length: JEV_MAX_ATTEMPTS }, () => json(500, { error: { message: "boom" } })));
    expect((await failure(call(h2, { deadlineMs: 60_000 }))).attempts).toBe(JEV_MAX_ATTEMPTS);
  });
  it("o prazo total limita também a tentativa em andamento (timeout da tentativa ≤ prazo restante)", async () => {
    const seen: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      seen.push(ms);
      return real(ms);
    });
    try {
      const h = harness([json(503, { error: { message: "x" } }), json(200, okBody())]);
      await call(h, { timeoutMs: 10_000, deadlineMs: 10_400 });
      expect(seen[0]).toBe(10_000); // 1ª: o prazo (10,4 s) ainda é maior que o timeout
      expect(seen[1]).toBe(9_900); // 2ª: só o que restou do prazo depois da pausa de 500 ms
    } finally {
      spy.mockRestore();
    }
  });
  it("sem `nowMs` injetado usa Date.now (existe no runtime do Convex), não performance.now", async () => {
    const h = harness([json(200, okBody())]);
    const r = await callJev({ apiKey: KEY, state: STATE, questions: Q, fetchImpl: h.fetchImpl, sleepImpl: h.sleepImpl });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("parseRetryAfterMs", () => {
  it("segundos, data HTTP, lixo, zero e negativo", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("1.5")).toBe(1500);
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:05 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(5000);
    expect(parseRetryAfterMs("abc")).toBeUndefined();
    expect(parseRetryAfterMs("0")).toBeUndefined();
    expect(parseRetryAfterMs("-3")).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("99999")).toBe(JEV_RETRY_AFTER_CAP_MS);
  });
});
