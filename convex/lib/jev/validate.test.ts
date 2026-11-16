import { describe, expect, it } from "vitest";
import {
  JEV_PROVIDER_ALLOWED_KEYS,
  JEV_REQUEST_ALLOWED_KEYS,
  assertRequestBodyShape,
  validateQuestions,
  validateResponse,
} from "./validate";
import { JEV_MODEL, JevValidationError, type JevQuestions } from "./types";
import { OPENROUTER_ZDR_PROVIDER_BODY } from "../llm/registry";

const Q: JevQuestions = {
  intencao: { type: "choice", instructions: "Qual o pedido em `mensagem`?", criteria: { preco: "valor", agendar: "marcar", outro: "resto" } },
  pede_humano: { type: "noul", instructions: "`mensagem` pede uma pessoa?" },
  urgencia: { type: "score", instructions: "Urgência?", criteria: ["baixa", "media", "alta"] },
};

const goodResponse = () => ({
  id: "gen-dec-1",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    intencao: { type: "choice", choice: "preco", confidence: 0.7, probabilities: { preco: 0.8, agendar: 0.2, outro: 0 } },
    pede_humano: { type: "noul", noul: 0.03 },
    urgencia: { type: "score", score: 0.61, confidence: 0.4, probabilities: { "0": 0.39, "1": 0.61, "2": 0 } },
  },
  usage: { input_tokens: 499, output_tokens: 88, cost: 0.000021, is_byok: false },
});

const throwsQ = (input: unknown) => {
  try {
    validateQuestions(input);
  } catch (e) {
    expect(e).toBeInstanceOf(JevValidationError);
    expect((e as JevValidationError).code).toBe("invalid_questions");
    return;
  }
  throw new Error("deveria ter lançado");
};

describe("validateQuestions (o alpha NÃO valida: 1 opção e 1 nível voltam 200)", () => {
  it("aceita perguntas válidas", () => {
    expect(validateQuestions(Q)).toEqual(Q);
  });
  it("recusa choice com 1 opção e score com 1 nível", () => {
    throwsQ({ x: { type: "choice", instructions: "?", criteria: { a: "só uma" } } });
    throwsQ({ x: { type: "score", instructions: "?", criteria: ["único"] } });
  });
  it("recusa o teto: 11 níveis de score, 256 opções de choice", () => {
    throwsQ({ x: { type: "score", instructions: "?", criteria: Array.from({ length: 11 }, (_, i) => `n${i}`) } });
    throwsQ({ x: { type: "choice", instructions: "?", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, "d"])) } });
  });
  it("aceita as fronteiras: 2 opções, 255 opções, 2 e 10 níveis", () => {
    validateQuestions({ x: { type: "choice", instructions: "?", criteria: { a: "a", b: "b" } } });
    validateQuestions({ x: { type: "choice", instructions: "?", criteria: Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o${i}`, "d"])) } });
    validateQuestions({ x: { type: "score", instructions: "?", criteria: ["a", "b"] } });
    validateQuestions({ x: { type: "score", instructions: "?", criteria: Array.from({ length: 10 }, (_, i) => `n${i}`) } });
  });
  it("recusa tipo desconhecido (box só existe em versão nova), id ruim, instructions vazio, vazio e excesso", () => {
    throwsQ({ x: { type: "box", instructions: "?" } });
    throwsQ({ "Id Ruim": { type: "noul", instructions: "?" } });
    throwsQ({ x: { type: "noul", instructions: "  " } });
    throwsQ({});
    throwsQ(null);
    throwsQ(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`q${i}`, { type: "noul", instructions: "?" }])));
  });
  it("aceita opção de choice com acento e espaço (nome de etapa), mas recusa opção vazia", () => {
    validateQuestions({ x: { type: "choice", instructions: "?", criteria: { "Inscrição em andamento": "d", "Retorno / recorrente": "d" } } });
    throwsQ({ x: { type: "choice", instructions: "?", criteria: { "": "d", b: "d" } } });
  });
  it("descarta campos extras da pergunta (só o contrato sai)", () => {
    const out = validateQuestions({ x: { type: "noul", instructions: "?", extra: 1 } });
    expect(out.x).toEqual({ type: "noul", instructions: "?" });
  });
});

describe("assertRequestBodyShape (alpha pode mudar: campo novo sem atualizar o validate falha)", () => {
  const ok = () => ({ model: JEV_MODEL, state: { mensagem: "oi" }, questions: Q, provider: { ...OPENROUTER_ZDR_PROVIDER_BODY.provider } });
  it("aceita o corpo canônico", () => {
    expect(() => assertRequestBodyShape(ok())).not.toThrow();
  });
  it("recusa campo novo no topo e dentro de provider", () => {
    expect(() => assertRequestBodyShape({ ...ok(), temperature: 0 })).toThrow(/não permitido no corpo/);
    expect(() => assertRequestBodyShape({ ...ok(), provider: { ...ok().provider, zdr: true } })).toThrow(/não permitido em provider/);
  });
  it("a trava de privacidade nunca some: sem provider ou sem data_collection:deny → lança", () => {
    const { provider: _p, ...semProvider } = ok();
    expect(() => assertRequestBodyShape(semProvider)).toThrow(/privacidade/);
    expect(() => assertRequestBodyShape({ ...ok(), provider: { require_parameters: true } })).toThrow(/deny/);
    expect(() => assertRequestBodyShape({ ...ok(), provider: { data_collection: "allow" } })).toThrow(/deny/);
  });
  it("só o modelo pinado passa", () => {
    expect(() => assertRequestBodyShape({ ...ok(), model: "~typesafe/jev-latest" })).toThrow(/pinado/);
  });
  it("as listas de campos permitidos espelham o contrato conhecido (mexeu? atualize de propósito)", () => {
    expect([...JEV_REQUEST_ALLOWED_KEYS]).toEqual(["model", "state", "questions", "provider"]);
    expect([...JEV_PROVIDER_ALLOWED_KEYS]).toEqual(["data_collection", "require_parameters", "allow_fallbacks"]);
    // O provider do repo cabe inteiro na lista: mudar o corpo ZDR do registry sem olhar aqui quebra.
    for (const k of Object.keys(OPENROUTER_ZDR_PROVIDER_BODY.provider)) expect(JEV_PROVIDER_ALLOWED_KEYS as readonly string[]).toContain(k);
  });
});

describe("validateResponse", () => {
  it("lê uma resposta real (confidence ausente em noul)", () => {
    const r = validateResponse(Q, goodResponse());
    expect(r.model).toBe("typesafe/jev-1.13-20260917");
    expect(r.requestId).toBe("gen-dec-1");
    expect(r.answers.pede_humano).toEqual({ type: "noul", noul: 0.03 });
    expect(r.usage).toEqual({ promptTokens: 499, completionTokens: 88, costUsd: 0.000021, isByok: false });
  });
  it("pergunta sem resposta LANÇA (nunca vira 'sim')", () => {
    const raw = goodResponse();
    delete (raw.answers as Record<string, unknown>).pede_humano;
    expect(() => validateResponse(Q, raw)).toThrow(/sem resposta/);
  });
  it("tipo trocado, choice fora das opções, probabilidade fora de [0,1], soma errada, score fora dos níveis", () => {
    const m = (f: (r: ReturnType<typeof goodResponse>) => void) => {
      const r = goodResponse();
      f(r);
      return () => validateResponse(Q, r);
    };
    expect(m((r) => ((r.answers.pede_humano as { type: string }).type = "choice"))).toThrow(/tipo/);
    expect(m((r) => ((r.answers.intencao as { choice: string }).choice = "inventada"))).toThrow(/fora das opções/);
    expect(m((r) => ((r.answers.intencao as { probabilities: Record<string, number> }).probabilities.preco = 1.4))).toThrow(/fora de \[0,1\]/);
    expect(m((r) => ((r.answers.intencao as { probabilities: Record<string, number> }).probabilities = { preco: 0.2, agendar: 0.2, outro: 0.2 }))).toThrow(/somam/);
    expect(m((r) => ((r.answers.urgencia as { score: number }).score = 2.5))).toThrow(/fora dos níveis/);
    expect(m((r) => ((r.answers.pede_humano as { noul: number }).noul = -0.2))).toThrow(/noul/);
    expect(m((r) => ((r.answers.intencao as { probabilities: Record<string, number> }).probabilities = { fantasma: 1 }))).toThrow(/desconhecida/);
  });
  it("confidence ausente não quebra; confidence fora de [0,1] quebra", () => {
    const r = goodResponse();
    delete (r.answers.intencao as { confidence?: number }).confidence;
    expect(validateResponse(Q, r).answers.intencao).not.toHaveProperty("confidence");
    (r.answers.urgencia as { confidence: number }).confidence = 1.5;
    expect(() => validateResponse(Q, r)).toThrow(/confidence/);
  });
  it("custo: ausente, zero com tokens, negativo e BYOK NÃO são custo utilizável; zero sem tokens é", () => {
    const withUsage = (usage: Record<string, unknown>) => {
      const r = goodResponse();
      r.usage = usage as typeof r.usage;
      return validateResponse(Q, r).usage.costUsd;
    };
    expect(withUsage({ input_tokens: 100, output_tokens: 5 })).toBeUndefined();
    expect(withUsage({ input_tokens: 100, output_tokens: 5, cost: 0 })).toBeUndefined();
    expect(withUsage({ input_tokens: 100, output_tokens: 5, cost: -1 })).toBeUndefined();
    expect(withUsage({ input_tokens: 100, output_tokens: 5, cost: 0.00001, is_byok: true })).toBeUndefined();
    expect(withUsage({ input_tokens: 0, output_tokens: 0, cost: 0 })).toBe(0);
    expect(withUsage({ input_tokens: 100, cost: 0.00001 })).toBe(0.00001);
  });
  it("sem input_tokens, sem model ou sem answers lança", () => {
    const r = goodResponse();
    expect(() => validateResponse(Q, { ...r, usage: {} })).toThrow(/input_tokens/);
    expect(() => validateResponse(Q, { ...r, model: undefined })).toThrow(/model/);
    expect(() => validateResponse(Q, { ...r, answers: undefined })).toThrow(/answers/);
    expect(() => validateResponse(Q, "x")).toThrow(/objeto/);
  });
  it("respostas extras que não perguntamos são ignoradas", () => {
    const r = goodResponse();
    (r.answers as Record<string, unknown>).bonus = { type: "noul", noul: 1 };
    expect(Object.keys(validateResponse(Q, r).answers)).toEqual(["intencao", "pede_humano", "urgencia"]);
  });
});
