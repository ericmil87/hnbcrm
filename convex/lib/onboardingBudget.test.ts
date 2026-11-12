import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_GLOBAL_DAILY_USD_MICROS,
  DEFAULT_SESSION_BUDGET_USD_MICROS,
  DEFAULT_TRIAL_ORG_BUDGET_USD_MICROS,
  clampEstimate,
  evaluateFixedWindow,
  evaluateOnboardingBudget,
  getOnboardingBudgetConfig,
  normalizeIpKey,
  clientIpKey,
  parseBudgetMicros,
} from "./onboardingBudget";
import { ONBOARDING_V2_LAUNCH_MS, onboardingOrgBudgetApplies } from "./onboardingBudget";
import { getOnboardingModel, getOnboardingTts, resolveOnboardingModel } from "./onboardingModels";
import { DEFAULT_MODELS } from "./llm/registry";

describe("config de orçamento por env", () => {
  test("padrões quando a env está ausente, vazia ou inválida", () => {
    for (const raw of [undefined, "", "  ", "abc", "-5", "0", "1.5", "1e6", "99999999999999"]) {
      expect(parseBudgetMicros(raw, 123)).toBe(123);
    }
    expect(getOnboardingBudgetConfig({})).toEqual({
      sessionUsdMicros: DEFAULT_SESSION_BUDGET_USD_MICROS,
      trialOrgMonthlyUsdMicros: DEFAULT_TRIAL_ORG_BUDGET_USD_MICROS,
      globalDailyUsdMicros: DEFAULT_GLOBAL_DAILY_USD_MICROS,
    });
  });
  test("valor válido vale", () => {
    const cfg = getOnboardingBudgetConfig({
      ONBOARDING_SESSION_BUDGET_USD_MICROS: "100000",
      ONBOARDING_TRIAL_ORG_BUDGET_USD_MICROS: "300000",
      ONBOARDING_GLOBAL_DAILY_USD_MICROS: "5000000",
    });
    expect(cfg).toEqual({ sessionUsdMicros: 100000, trialOrgMonthlyUsdMicros: 300000, globalDailyUsdMicros: 5000000 });
  });
  test("clampEstimate", () => {
    expect(clampEstimate(undefined)).toBe(20_000);
    expect(clampEstimate(Number.NaN)).toBe(20_000);
    expect(clampEstimate(-1)).toBe(20_000);
    expect(clampEstimate(9_999_999)).toBe(500_000);
  });
});

describe("evaluateOnboardingBudget", () => {
  const config = { sessionUsdMicros: 1000, trialOrgMonthlyUsdMicros: 3000, globalDailyUsdMicros: 10_000 };
  const base = {
    estimateUsdMicros: 100,
    sessionSpentUsdMicros: 0,
    orgMonthSpentUsdMicros: 0,
    globalDaySpentUsdMicros: 0,
    orgBudgetApplies: true,
    config,
  };
  test("ordem: global, sessão, org", () => {
    expect(evaluateOnboardingBudget(base)).toEqual({ allowed: true });
    expect(evaluateOnboardingBudget({ ...base, sessionSpentUsdMicros: 950 })).toMatchObject({ allowed: false, code: "session_budget" });
    expect(evaluateOnboardingBudget({ ...base, orgMonthSpentUsdMicros: 2950 })).toMatchObject({ allowed: false, code: "org_budget" });
    expect(evaluateOnboardingBudget({ ...base, globalDaySpentUsdMicros: 9950, sessionSpentUsdMicros: 950 })).toMatchObject({
      code: "global_daily_cap",
    });
  });
  test("org paga não tem orçamento de org", () => {
    expect(evaluateOnboardingBudget({ ...base, orgMonthSpentUsdMicros: 99_999, orgBudgetApplies: false })).toEqual({ allowed: true });
  });
  test("mensagem em PT-BR", () => {
    const d = evaluateOnboardingBudget({ ...base, sessionSpentUsdMicros: 1000 });
    expect(d.allowed === false && d.message).toMatch(/limite/);
  });
});

describe("janela fixa", () => {
  const spec = { windowMs: 1000, limit: 2 };
  test("conta, recusa sem incrementar e reinicia", () => {
    const a = evaluateFixedWindow(null, 0, spec);
    const b = evaluateFixedWindow(a.next, 10, spec);
    expect(b.allowed).toBe(true);
    const c = evaluateFixedWindow(b.next, 20, spec);
    expect(c).toMatchObject({ allowed: false, retryAfterMs: 980 });
    expect(c.next.count).toBe(2);
    expect(evaluateFixedWindow(c.next, 1000, spec).allowed).toBe(true);
  });
  test("normalizeIpKey", () => {
    // entrada mais à direita (a que a borda acrescentou); a da esquerda pode ser forjada
    expect(normalizeIpKey("1.1.1.1, 203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeIpKey("203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeIpKey("999.1.1.1")).toBeNull();
    // IPv6 agrupa por /64
    expect(normalizeIpKey("2001:db8:aaaa:bbbb:1:2:3:4")).toBe("2001:db8:aaaa:bbbb::/64");
    expect(normalizeIpKey("2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff")).toBe("2001:db8:aaaa:bbbb::/64");
    expect(normalizeIpKey("2001:0db8::1")).toBe("2001:db8:0:0::/64");
    expect(normalizeIpKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeIpKey("::1")).toBe("0:0:0:0::/64");
    expect(normalizeIpKey("<script>")).toBeNull();
    expect(normalizeIpKey(undefined)).toBeNull();
  });
});

describe("onboardingModels", () => {
  test("env vazia = padrão do registry", () => {
    expect(getOnboardingModel("interviewer", {})).toBe(DEFAULT_MODELS.copilot);
    expect(getOnboardingModel("reader", { ONBOARDING_MODEL_READER: "  " })).toBe(DEFAULT_MODELS.attendant);
    expect(getOnboardingModel("vision", {})).toBe(DEFAULT_MODELS.vision);
  });
  test("env inválida (formato ou fora do registry) cai no padrão e sinaliza", () => {
    expect(resolveOnboardingModel("interviewer", { ONBOARDING_MODEL_INTERVIEWER: "bad id; rm" })).toEqual({
      model: DEFAULT_MODELS.copilot,
      source: "default",
      rejected: true,
    });
    expect(getOnboardingModel("reader", { ONBOARDING_MODEL_READER: "modelo-que-nao-existe" })).toBe(DEFAULT_MODELS.attendant);
    // modelo conhecido, mas fora da cadeia de visão: recusado para visão
    expect(getOnboardingModel("vision", { ONBOARDING_MODEL_VISION: "deepseek-v4-pro" })).toBe(DEFAULT_MODELS.vision);
  });
  test("env válida vale (canônico e id de provedor)", () => {
    expect(getOnboardingModel("interviewer", { ONBOARDING_MODEL_INTERVIEWER: "deepseek-v4-pro" })).toBe("deepseek-v4-pro");
    expect(getOnboardingModel("reader", { ONBOARDING_MODEL_READER: "deepseek/deepseek-v4-flash" })).toBe("deepseek/deepseek-v4-flash");
    expect(getOnboardingModel("vision", { ONBOARDING_MODEL_VISION: "glm-5.3-flash" })).toBe("glm-5.3-flash");
  });
  test("TTS: padrão da porta (gemini-3.8-flash-tts + Kore), env só dentro da lista", () => {
    // P4.1: padrão decidido pelo dono; env fora da lista da porta cai no padrão.
    expect(getOnboardingTts({})).toEqual({ model: "google/gemini-3.8-flash-tts", voice: "Kore" });
    expect(getOnboardingTts({ ONBOARDING_TTS_MODEL: "tts-x", ONBOARDING_TTS_VOICE: "<b>" })).toEqual({
      model: "google/gemini-3.8-flash-tts",
      voice: "Kore",
    });
    expect(
      getOnboardingTts({ ONBOARDING_TTS_MODEL: "google/gemini-3.8-flash-lite-tts", ONBOARDING_TTS_VOICE: "Puck" })
    ).toEqual({ model: "google/gemini-3.8-flash-lite-tts", voice: "Puck" });
  });
});

describe("onboardingOrgBudgetApplies", () => {
  const before = ONBOARDING_V2_LAUNCH_MS - 1;
  test("regra", () => {
    expect(onboardingOrgBudgetApplies({ createdAt: before })).toBe(true); // sem billing
    expect(onboardingOrgBudgetApplies({ createdAt: before, billing: { status: "trial", plan: "profissional" } })).toBe(true);
    expect(onboardingOrgBudgetApplies({ createdAt: before, billing: { status: "legacy" } })).toBe(false);
    expect(onboardingOrgBudgetApplies({ createdAt: ONBOARDING_V2_LAUNCH_MS, billing: { status: "legacy" } })).toBe(true);
    expect(onboardingOrgBudgetApplies({ createdAt: ONBOARDING_V2_LAUNCH_MS, billing: { status: "active", plan: "essencial" } })).toBe(false);
    expect(onboardingOrgBudgetApplies({ createdAt: ONBOARDING_V2_LAUNCH_MS, billing: { status: "past_due", plan: "essencial" } })).toBe(false);
  });
});

describe("clientIpKey", () => {
  const req = (h: Record<string, string>) => ({ headers: new Headers(h) });

  test("ordem: cf-connecting-ip, x-real-ip, x-forwarded-for (mais à direita)", () => {
    expect(clientIpKey(req({ "cf-connecting-ip": "203.0.113.1", "x-real-ip": "203.0.113.2", "x-forwarded-for": "9.9.9.9, 203.0.113.3" }))).toBe("203.0.113.1");
    expect(clientIpKey(req({ "x-real-ip": "203.0.113.2", "x-forwarded-for": "203.0.113.3" }))).toBe("203.0.113.2");
    expect(clientIpKey(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.3" }))).toBe("203.0.113.3");
  });

  test("cabeçalho inválido cai para o próximo; IPv6 vira /64", () => {
    expect(clientIpKey(req({ "cf-connecting-ip": "lixo", "x-real-ip": "2001:db8:1:2:3:4:5:6" }))).toBe("2001:db8:1:2::/64");
  });

  test("a chave normalizada é aceita de novo por normalizeIpKey", () => {
    const k = clientIpKey(req({ "x-real-ip": "2001:db8:1:2:3:4:5:6" }));
    expect(normalizeIpKey(k)).toBe(k);
    expect(normalizeIpKey("203.0.113.9")).toBe("203.0.113.9");
  });

  test("sem cabeçalho: null e um único aviso, sem dado pessoal", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(clientIpKey(req({ "x-forwarded-for": "nao-e-ip" }))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain("nao-e-ip");
    } finally {
      warn.mockRestore();
    }
  });
});
