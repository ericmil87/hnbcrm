/**
 * Produto `telegramCopilot` (D16): ordem padrão openrouter-first, modelo
 * `deepseek-flash-latest` via OpenRouter, fallback para o modelo do Copiloto
 * quando o deployment não tem OpenRouter, BYO usa o modelo do Copiloto.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { effectivePlatformOrder, productModel, resolveProductRoutes } from "./agentRoutes";
import { DEFAULT_MODELS } from "./llm/registry";

const noCtx = { runQuery: async () => null } as any;
const ORG = "org1" as any;

afterEach(() => vi.unstubAllEnvs());

describe("telegramCopilot", () => {
  test("ordem: produto > org > padrão openrouter-first (o env não vale para este produto)", () => {
    vi.stubEnv("LLM_PLATFORM_ORDER", "opencode-only");
    expect(effectivePlatformOrder(null, "telegramCopilot")).toBe("openrouter-first");
    expect(effectivePlatformOrder({ platformOrder: "auto" }, "telegramCopilot")).toBe("auto");
    expect(effectivePlatformOrder({ products: { telegramCopilot: { order: "opencode-only" } } }, "telegramCopilot")).toBe(
      "opencode-only",
    );
    // Os outros produtos seguem como antes.
    expect(effectivePlatformOrder(null, "copilot")).toBe("opencode-only");
  });

  test("ausente → deepseek-flash-latest pelo OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test-or");
    vi.stubEnv("OPENCODE_GO_API", "sk-test-go");
    const { routes, canonicalModel } = await resolveProductRoutes(noCtx, ORG, null, "telegramCopilot");
    expect(canonicalModel).toBe("deepseek-flash-latest");
    expect(DEFAULT_MODELS.telegramCopilot).toBe("deepseek-flash-latest");
    expect(routes[0].providerId).toBe("openrouter");
    expect(routes[0].model).toBe("~deepseek/deepseek-flash-latest");
  });

  test("sem OpenRouter no deployment → cai no modelo do Copiloto (DEFAULT_MODELS funciona sem OpenRouter)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENCODE_GO_API", "sk-test-go");
    const { routes, canonicalModel } = await resolveProductRoutes(noCtx, ORG, null, "telegramCopilot");
    expect(canonicalModel).toBe(DEFAULT_MODELS.copilot);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].providerId).toBe("opencode-go");
  });

  test("modelo fixado no produto; BYO usa o modelo do Copiloto da org", () => {
    expect(productModel({ products: { telegramCopilot: { model: "kimi-k3" } } }, "telegramCopilot").model).toBe("kimi-k3");
    expect(productModel({ mode: "byo", models: { copilot: "glm-5.2" } }, "telegramCopilot").model).toBe("glm-5.2");
  });
});
