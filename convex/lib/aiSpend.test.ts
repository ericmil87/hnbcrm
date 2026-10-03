/**
 * Custo de IA + teto em R$ (v0.69, T04) — núcleo puro.
 *
 * O teste de build mais importante é o primeiro: TODO modelo que o registry
 * pode mandar a um provider tem preço. Foi a falta dele que fez o Deskcomm
 * repetir 4 vezes o bug "modelo sem preço custa 0 e o teto nunca dispara".
 */
import { describe, expect, test } from "vitest";
import {
  CONSERVATIVE_MODEL_PRICE,
  MODEL_PRICES,
  MODEL_PRICES_COLLECTED_AT,
  modelPrice,
  registryModelIds,
} from "./llm/registry";
import {
  DEFAULT_SPEND_WARN_PCT,
  DEFAULT_USD_BRL_RATE,
  addUsage,
  estimateRunCost,
  evaluateSpend,
  finishRunCostFields,
  monthKeyUtc,
  monthStartUtcMs,
  newUsageTotals,
  nextMonthStartUtcMs,
  resolveSpendCap,
  spendCrossings,
  usdToMicros,
  mergeSpendCap,
  validateSpendCapInput,
} from "./aiSpend";

describe("tabela de preços (teste de build)", () => {
  test("todo modelo do registry tem preço — nunca 0", () => {
    const missing = registryModelIds().filter((id) => !MODEL_PRICES[id]);
    expect(missing, `Sem preço em MODEL_PRICES: ${missing.join(", ")}`).toEqual([]);
    for (const [id, price] of Object.entries(MODEL_PRICES)) {
      expect(price.inPerM, id).toBeGreaterThan(0);
      expect(price.outPerM, id).toBeGreaterThan(0);
    }
  });

  test("preço da ROTA (oficial/mediana dos endpoints), não o topo barato do /models", () => {
    // Topo do /models em 03/10: kimi-k3 0,40/13 e glm-5.2 0,06/3,5 (endpoints
    // Relace/InferenceNet). A rota ZDR com fallback paga o oficial/mediana.
    expect(MODEL_PRICES["kimi-k3"]).toMatchObject({ inPerM: 3, outPerM: 15 });
    expect(MODEL_PRICES["glm-5.2"]).toMatchObject({ inPerM: 1.4, outPerM: 4.4 });
  });

  test("a data da coleta está registrada", () => {
    expect(MODEL_PRICES_COLLECTED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("conservador = o MAIOR preço de entrada e de saída da tabela", () => {
    const published = Object.values(MODEL_PRICES).filter((p) => !p.estimated);
    expect(CONSERVATIVE_MODEL_PRICE.inPerM).toBe(Math.max(...published.map((p) => p.inPerM)));
    expect(CONSERVATIVE_MODEL_PRICE.outPerM).toBe(Math.max(...published.map((p) => p.outPerM)));
    expect(CONSERVATIVE_MODEL_PRICE.estimated).toBe(true);
  });

  test("casamento EXATO: id do provider resolve pelo canônico; prefixo parecido não casa", () => {
    expect(modelPrice("deepseek/deepseek-v4-flash")).toBe(MODEL_PRICES["deepseek-v4-flash"]);
    expect(modelPrice("deepseek-v4-flash-0731")).toBe(MODEL_PRICES["deepseek-v4-flash-0731"]);
    // `startsWith` cobraria isto como flash — o bug do Deskcomm.
    expect(modelPrice("deepseek-v4-flash-turbo-9000")).toBeNull();
    expect(modelPrice(undefined)).toBeNull();
  });
});

describe("estimateRunCost", () => {
  test("preço por modelo: o mesmo uso custa diferente em modelos diferentes", () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000 };
    const flash = estimateRunCost({ model: "deepseek-v4-flash", usage });
    const kimi = estimateRunCost({ model: "kimi-k2.7-code", usage });
    const pf = MODEL_PRICES["deepseek-v4-flash"];
    const pk = MODEL_PRICES["kimi-k2.7-code"];
    expect(flash.costUsd).toBeCloseTo(pf.inPerM + pf.outPerM, 10);
    expect(flash.costEstimated).toBe(false);
    expect(kimi.costUsd).toBeCloseTo(pk.inPerM + pk.outPerM, 8);
    expect(kimi.costUsd).not.toBeCloseTo(flash.costUsd, 3);
    expect(kimi.costEstimated).toBe(false);
  });

  test("cache de prefixo cobra o preço de cache", () => {
    const cost = estimateRunCost({
      model: "deepseek-v4-flash",
      usage: { promptTokens: 1_000_000, cachedPromptTokens: 1_000_000, completionTokens: 0 },
    });
    expect(cost.costUsd).toBeCloseTo(MODEL_PRICES["deepseek-v4-flash"].cachedInPerM!, 10);
  });

  test("modelo sem preço: conservador (MAIOR preço) + costEstimated, nunca 0", () => {
    const cost = estimateRunCost({
      model: "modelo-que-nao-existe",
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    });
    expect(cost.costEstimated).toBe(true);
    expect(cost.costUsd).toBe(CONSERVATIVE_MODEL_PRICE.inPerM + CONSERVATIVE_MODEL_PRICE.outPerM);
    expect(cost.costUsd).toBeGreaterThan(0);
  });

  test("modelo do registry sem preço publicado também é marcado estimado", () => {
    expect(estimateRunCost({ model: "qwen3.8-max", usage: { promptTokens: 10, completionTokens: 10 } }).costEstimated).toBe(true);
  });

  test("usage.cost do provedor vence a tabela", () => {
    const cost = estimateRunCost({
      model: "modelo-que-nao-existe",
      usage: { promptTokens: 5_000_000, completionTokens: 5_000_000, costUsd: 0.0123 },
    });
    expect(cost).toEqual({ costUsd: 0.0123, costEstimated: false });
  });
});

describe("addUsage (run com várias chamadas)", () => {
  test("precifica cada chamada pelo modelo da ROTA que atendeu e soma usage.cost", () => {
    const totals = newUsageTotals();
    addUsage(totals, { promptTokens: 1000, completionTokens: 100 }, { canonicalModel: "deepseek-v4-flash", providerId: "opencode-go" });
    addUsage(totals, { promptTokens: 1000, completionTokens: 100, costUsd: 0.5 }, { canonicalModel: "kimi-k2.7-code", providerId: "openrouter" });
    addUsage(totals, undefined, null);
    expect(totals.promptTokens).toBe(2000);
    expect(totals.completionTokens).toBe(200);
    expect(totals.providerCostRequests).toBe(1);
    const pf = MODEL_PRICES["deepseek-v4-flash"];
    const flashCost = (1000 * pf.inPerM + 100 * pf.outPerM) / 1_000_000;
    expect(totals.costUsd).toBeCloseTo(flashCost + 0.5, 12);
    expect(finishRunCostFields(totals)).toEqual({
      promptTokens: 2000,
      completionTokens: 200,
      cachedPromptTokens: 0,
      costUsdEstimate: totals.costUsd,
    });
  });

  test("rota ausente usa o modelo de fallback; desconhecido marca costEstimated", () => {
    const totals = addUsage(newUsageTotals(), { promptTokens: 10, completionTokens: 10 }, null, "x-desconhecido");
    expect(totals.costEstimated).toBe(true);
    expect(finishRunCostFields(totals).costEstimated).toBe(true);
  });
});

describe("mês e unidades", () => {
  test("mês UTC", () => {
    expect(monthKeyUtc(Date.UTC(2026, 9, 3, 12))).toBe("2026-10");
    // 21h do último dia em Brasília já é o mês seguinte em UTC (documentado).
    expect(monthKeyUtc(Date.UTC(2026, 9, 1, 0, 30))).toBe("2026-10");
    expect(monthStartUtcMs("2026-10")).toBe(Date.UTC(2026, 9, 1));
    expect(nextMonthStartUtcMs("2026-12")).toBe(Date.UTC(2027, 0, 1));
    expect(() => monthStartUtcMs("2026-13")).toThrow();
  });
  test("micros", () => {
    expect(usdToMicros(0.0123456)).toBe(12346);
    expect(usdToMicros(-1)).toBe(0);
  });
});

describe("config do teto", () => {
  test("ausente = warn sem valor (nada acontece)", () => {
    const cap = resolveSpendCap(undefined);
    expect(cap).toMatchObject({
      mode: "warn",
      monthlyBrl: null,
      usdBrlRate: DEFAULT_USD_BRL_RATE,
      warnPct: DEFAULT_SPEND_WARN_PCT,
      active: false,
      capUsd: null,
    });
    expect(evaluateSpend(999_000_000, cap)).toEqual({ level: "none", pct: null, blocked: false });
  });

  test("teto em R$ convertido pela cotação; off desliga", () => {
    const cap = resolveSpendCap({ mode: "block", monthlyBrl: 55, usdBrlRate: 5.5 });
    expect(cap.capUsd).toBeCloseTo(10, 10);
    expect(resolveSpendCap({ mode: "off", monthlyBrl: 55 }).active).toBe(false);
  });

  test("validação do servidor", () => {
    expect(validateSpendCapInput({ mode: "warn", monthlyBrl: 100, usdBrlRate: 5.5, warnPct: 80 })).toBeNull();
    expect(validateSpendCapInput({ mode: "warn", monthlyBrl: 0 })).toBeNull();
    expect(validateSpendCapInput({ mode: "warn", monthlyBrl: -1 })).toMatch(/negativo/);
    expect(validateSpendCapInput({ mode: "warn", usdBrlRate: 0.5 })).toMatch(/cotação/);
    expect(validateSpendCapInput({ mode: "warn", usdBrlRate: 21 })).toMatch(/cotação/);
    expect(validateSpendCapInput({ mode: "warn", warnPct: 49 })).toMatch(/aviso/);
    expect(validateSpendCapInput({ mode: "warn", warnPct: 96 })).toMatch(/aviso/);
    expect(validateSpendCapInput({ mode: "nope" as never })).toMatch(/Modo/);
  });
});

describe("mergeSpendCap", () => {
  const current = { mode: "warn" as const, monthlyBrl: 200, usdBrlRate: 5.4, warnPct: 75 };
  test("campo ausente mantém; null limpa; número grava; 0 limpa o teto", () => {
    expect(mergeSpendCap(current, { mode: "block" })).toEqual({ ...current, mode: "block" });
    expect(mergeSpendCap(current, { mode: "warn", monthlyBrl: null })).toEqual({
      mode: "warn",
      usdBrlRate: 5.4,
      warnPct: 75,
    });
    expect(mergeSpendCap(current, { mode: "warn", monthlyBrl: 0, warnPct: 90 })).toEqual({
      mode: "warn",
      usdBrlRate: 5.4,
      warnPct: 90,
    });
    expect(mergeSpendCap(undefined, { mode: "off" })).toEqual({ mode: "off" });
  });
});

describe("avaliação e cruzamento de limiares", () => {
  const cap = resolveSpendCap({ mode: "block", monthlyBrl: 55, usdBrlRate: 5.5, warnPct: 80 }); // US$ 10

  test("níveis", () => {
    expect(evaluateSpend(7_000_000, cap)).toMatchObject({ level: "ok", blocked: false });
    expect(evaluateSpend(8_000_000, cap)).toMatchObject({ level: "warn", blocked: false });
    expect(evaluateSpend(10_000_000, cap)).toMatchObject({ level: "reached", blocked: true });
    const warnOnly = resolveSpendCap({ mode: "warn", monthlyBrl: 55, usdBrlRate: 5.5 });
    expect(evaluateSpend(12_000_000, warnOnly)).toMatchObject({ level: "reached", blocked: false });
  });

  test("80% dispara 1 vez; 100% dispara 1 vez; salto direto a 100% só avisa o teto", () => {
    expect(spendCrossings({ costUsdMicros: 8_500_000, cap })).toEqual({ warn: true, reached: false });
    expect(spendCrossings({ costUsdMicros: 9_000_000, cap, warnedAt: 1 })).toEqual({ warn: false, reached: false });
    expect(spendCrossings({ costUsdMicros: 10_500_000, cap, warnedAt: 1 })).toEqual({ warn: false, reached: true });
    expect(spendCrossings({ costUsdMicros: 11_000_000, cap, warnedAt: 1, reachedAt: 2 })).toEqual({ warn: false, reached: false });
    expect(spendCrossings({ costUsdMicros: 20_000_000, cap })).toEqual({ warn: false, reached: true });
  });
});
