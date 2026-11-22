/// <reference types="vite/client" />
/**
 * Sentinela de plataforma: vereditos puros, condição com estado (alerta,
 * lembrete, "resolvido"), gancho das falhas reais de IA (marcador na cadeia
 * LLM → agentRuns → alerta), sondas e varredura.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { decidePlatformCondition, platformCondition } from "./lib/platformAlert";
import {
  bridgeProbeRoundFailing,
  envNumber,
  evaluateOpenRouterCredits,
  evaluateOpenRouterKey,
  isStuckOutbound,
  isStuckTranscription,
  parsePlatformLlmFailure,
  platformLlmFailureTag,
  stripPlatformLlmFailureTag,
  summarizeNames,
} from "./lib/platformSentinel";
import { chatWithFallback, resolveByoRoute, resolvePlatformChain } from "./lib/llm";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** O Resend não está registrado nos testes: cada tentativa de envio loga com o `kind`. */
function sends(spy: { mock: { calls: unknown[][] } }, kind: string): number {
  return spy.mock.calls.filter((c) => String(c[0]).includes(`platform_alert:${kind}`) && !String(c[0]).includes(`platform_alert:${kind}:resolved`) && !String(c[0]).includes(`platform_alert:${kind}_`)).length;
}
function resolvedSends(spy: { mock: { calls: unknown[][] } }, kind: string): number {
  return spy.mock.calls.filter((c) => String(c[0]).includes(`platform_alert:${kind}:resolved`)).length;
}
function enableAlerts() {
  vi.stubEnv("PLATFORM_ALERT_EMAIL", "alertas@acme.com.br");
  vi.stubEnv("RESEND_TEST_MODE", "false");
  vi.stubEnv("CRONS_DISABLED", "");
}
async function alertRow(t: TestConvex<typeof schema>, kind: string) {
  return await t.run((ctx) => ctx.db.query("platformAlerts").withIndex("by_kind", (q) => q.eq("kind", kind)).unique());
}

describe("vereditos puros", () => {
  test("OpenRouter /key: 401 = inválida; 200 = menor saldo entre limite da chave e orçamento; resto = desconhecido", () => {
    expect(evaluateOpenRouterKey(401, null)).toEqual({ kind: "invalid", status: 401 });
    expect(evaluateOpenRouterKey(200, { data: { limit_remaining: null } })).toEqual({ kind: "ok", remainingUsd: null });
    expect(
      evaluateOpenRouterKey(200, { data: { limit_remaining: 12.5, effective_budget: { remaining_usd: 3 } } })
    ).toEqual({ kind: "ok", remainingUsd: 3 });
    expect(evaluateOpenRouterKey(429, null)).toEqual({ kind: "unknown" });
    expect(evaluateOpenRouterKey(0, null)).toEqual({ kind: "unknown" });
  });

  test("OpenRouter /credits: saldo = comprado − usado; 403 (chave comum) = inválida", () => {
    expect(evaluateOpenRouterCredits(200, { data: { total_credits: 100.5, total_usage: 25.75 } })).toEqual({
      kind: "ok",
      balanceUsd: 74.75,
    });
    expect(evaluateOpenRouterCredits(403, {})).toEqual({ kind: "invalid", status: 403 });
    expect(evaluateOpenRouterCredits(200, { data: {} })).toEqual({ kind: "unknown" });
  });

  test("marcador de falha real: só 401/402/403, sobrevive a texto depois", () => {
    expect(parsePlatformLlmFailure(`${platformLlmFailureTag(402)}LLM request failed (HTTP 402): x`)).toBe(402);
    expect(parsePlatformLlmFailure("LLM request failed (HTTP 402): x")).toBeNull();
    expect(parsePlatformLlmFailure(undefined)).toBeNull();
    expect(parsePlatformLlmFailure("[openrouter-plataforma HTTP 500] x")).toBeNull();
    // 403 da OpenRouter = moderação/modelo restrito (texto do cliente): nunca alerta de chave.
    expect(parsePlatformLlmFailure("[openrouter-plataforma HTTP 403] x")).toBeNull();
    expect(stripPlatformLlmFailureTag(`${platformLlmFailureTag(402)}LLM falhou`)).toBe("LLM falhou");
  });

  test("saída presa: outbound sem envio entre 15 min e 6 h, fora de retry/self-heal/tradução", () => {
    const now = 10 * 3_600_000;
    const base = { direction: "outbound", isInternal: false, createdAt: now - 20 * MIN };
    expect(isStuckOutbound(base, now)).toBe(true);
    expect(isStuckOutbound({ ...base, createdAt: now - 5 * MIN }, now)).toBe(false);
    expect(isStuckOutbound({ ...base, createdAt: now - 7 * 3_600_000 }, now)).toBe(false);
    expect(isStuckOutbound({ ...base, externalId: "x" }, now)).toBe(false);
    expect(isStuckOutbound({ ...base, deliveryStatus: "failed" }, now)).toBe(false);
    expect(isStuckOutbound({ ...base, isInternal: true }, now)).toBe(false);
    expect(isStuckOutbound({ ...base, direction: "inbound" }, now)).toBe(false);
    expect(isStuckOutbound({ ...base, metadata: { bridgeRetry: { nextAt: now + MIN } } }, now)).toBe(false);
    expect(isStuckOutbound({ ...base, metadata: { bridgeRetry: { nextAt: now - 31 * MIN } } }, now)).toBe(true);
    expect(isStuckOutbound({ ...base, metadata: { selfHealAt: now - MIN } }, now)).toBe(false);
    expect(isStuckOutbound({ ...base, metadata: { translation: { status: "pending" } } }, now)).toBe(false);
  });

  test("transcrição presa: pending há mais de 20 min", () => {
    const now = 10 * 3_600_000;
    const m = (at: number, status = "pending") => ({ createdAt: at, metadata: { transcription: { status, at } } });
    expect(isStuckTranscription(m(now - 21 * MIN), now)).toBe(true);
    expect(isStuckTranscription(m(now - 10 * MIN), now)).toBe(false);
    expect(isStuckTranscription(m(now - 21 * MIN, "failed"), now)).toBe(false);
    expect(isStuckTranscription({ createdAt: now - 30 * MIN }, now)).toBe(false);
  });

  test("gateway do bridge, envs e nomes", () => {
    expect(bridgeProbeRoundFailing(0, 3)).toBe(true);
    expect(bridgeProbeRoundFailing(1, 4)).toBe(true);
    expect(bridgeProbeRoundFailing(0, 1)).toBe(false);
    expect(bridgeProbeRoundFailing(5, 2)).toBe(false);
    expect(envNumber(undefined, 5)).toBe(5);
    expect(envNumber("abc", 5)).toBe(5);
    expect(envNumber("-1", 5)).toBe(5);
    expect(envNumber("20", 5)).toBe(20);
    expect(envNumber("999", 5, { max: 100 })).toBe(100);
    expect(summarizeNames(["A", "B", "A", "C"], 2)).toBe("A, B e mais 1");
  });

  test("decisão da condição (com histerese no resolvido)", () => {
    const d = (failing: boolean, previousStreak: number, activeSince?: number, previousOkStreak = 0) =>
      decidePlatformCondition({ failing, previousStreak, previousOkStreak, activeSince, minStreak: 2 });
    expect(d(false, 0)).toEqual({ streak: 0, okStreak: 0, action: "none" });
    expect(d(true, 0)).toEqual({ streak: 1, okStreak: 0, action: "pending" });
    expect(d(true, 1)).toEqual({ streak: 2, okStreak: 0, action: "alert" });
    // Sem alerta ativo, uma boa zera na hora (sem e-mail).
    expect(d(false, 1)).toEqual({ streak: 0, okStreak: 0, action: "recover" });
    // Alerta ativo: a 1ª boa só conta; a 2ª seguida resolve.
    expect(d(false, 3, 100)).toEqual({ streak: 3, okStreak: 1, action: "recovering" });
    expect(d(false, 3, 100, 1)).toEqual({ streak: 0, okStreak: 0, action: "recover" });
    // Uma ruim no meio zera as boas.
    expect(d(true, 3, 100, 1)).toEqual({ streak: 4, okStreak: 0, action: "alert" });
  });
});

describe("marcador na cadeia LLM (falha real com a chave da plataforma)", () => {
  function stubFetchStatus(byHost: Record<string, number>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const host = Object.keys(byHost).find((h) => String(url).includes(h))!;
        return new Response(JSON.stringify({ error: { message: "no" } }), { status: byHost[host] });
      })
    );
  }

  test("OpenRouter da plataforma com 402 marca o erro final, mesmo com outra rota depois", async () => {
    vi.useRealTimers();
    stubFetchStatus({ "openrouter.ai": 402, "opencode.ai": 400 });
    const chain = resolvePlatformChain("deepseek-v4-flash", { opencodeGoKey: "k1", openrouterKey: "k2" });
    // openrouter primeiro, opencode depois (ordem "openrouter-first").
    const routes = [...chain.filter((r) => r.providerId === "openrouter"), ...chain.filter((r) => r.providerId !== "openrouter")];
    const err = await chatWithFallback(routes, { messages: [{ role: "user", content: "oi" }] }).catch((e) => e);
    expect(parsePlatformLlmFailure(err.message)).toBe(402);
  });

  test("401 da plataforma propaga marcado; BYO e OpenCode Go nunca marcam", async () => {
    vi.useRealTimers();
    stubFetchStatus({ "openrouter.ai": 401, "opencode.ai": 402 });
    const platform = resolvePlatformChain("deepseek-v4-flash", { openrouterKey: "k2" });
    const e1 = await chatWithFallback(platform, { messages: [{ role: "user", content: "oi" }] }).catch((e) => e);
    expect(parsePlatformLlmFailure(e1.message)).toBe(401);

    const byo = [resolveByoRoute({ provider: "openrouter", apiKey: "org-key" }, "deepseek-v4-flash")];
    const e2 = await chatWithFallback(byo, { messages: [{ role: "user", content: "oi" }] }).catch((e) => e);
    expect(parsePlatformLlmFailure(e2.message)).toBeNull();

    const opencode = resolvePlatformChain("deepseek-v4-flash", { opencodeGoKey: "k1" });
    const e3 = await chatWithFallback(opencode, { messages: [{ role: "user", content: "oi" }] }).catch((e) => e);
    expect(parsePlatformLlmFailure(e3.message)).toBeNull();
  });
});

describe("platformCondition", () => {
  test("anti-oscilação, lembrete pelo dedupe, e-mail de resolvido e rearme", async () => {
    enableAlerts();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const input = { kind: "teste_cond", severity: "critical" as const, title: "X caiu", detail: "X não responde.", minStreak: 2 };

    // Observação boa sem estado: nada gravado.
    expect(await t.run((ctx) => platformCondition(ctx, { ...input, failing: false }))).toEqual({ state: "ok" });
    expect(await alertRow(t, "teste_cond")).toBeNull();

    expect(await t.run((ctx) => platformCondition(ctx, { ...input, failing: true }))).toEqual({ state: "pending", streak: 1 });
    expect(sends(spy, "teste_cond")).toBe(0);
    const r2 = await t.run((ctx) => platformCondition(ctx, { ...input, failing: true }));
    expect(r2.state).toBe("alerting");
    expect(sends(spy, "teste_cond")).toBe(1);
    // Continua falhando: o dedupe de 6 h segura.
    await t.run((ctx) => platformCondition(ctx, { ...input, failing: true }));
    expect(sends(spy, "teste_cond")).toBe(1);

    vi.setSystemTime(Date.now() + 30 * MIN);
    expect(await t.run((ctx) => platformCondition(ctx, { ...input, failing: false }))).toEqual({ state: "recovering", okStreak: 1 });
    expect(resolvedSends(spy, "teste_cond")).toBe(0);
    expect(await t.run((ctx) => platformCondition(ctx, { ...input, failing: false }))).toEqual({ state: "recovered", notified: false });
    expect(resolvedSends(spy, "teste_cond")).toBe(1);
    const row = await alertRow(t, "teste_cond");
    expect(row).toMatchObject({ failStreak: 0 });
    expect(row?.activeSince).toBeUndefined();
    expect(row?.lastSentAt).toBeUndefined();

    // Volta a falhar: alerta de novo assim que cruza o limiar (sem esperar 6 h).
    await t.run((ctx) => platformCondition(ctx, { ...input, failing: true }));
    await t.run((ctx) => platformCondition(ctx, { ...input, failing: true }));
    expect(sends(spy, "teste_cond")).toBe(2);
  });

  test("oscilação em volta do limite não vira par alerta + resolvido a cada rodada", async () => {
    enableAlerts();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const input = { kind: "teste_flap", severity: "warning" as const, title: "Y", detail: "Y", throttleMs: 12 * 60 * MIN };
    for (const failing of [true, false, true, false, true, false, true]) {
      await t.run((ctx) => platformCondition(ctx, { ...input, failing }));
      vi.setSystemTime(Date.now() + 30 * MIN);
    }
    expect(sends(spy, "teste_flap")).toBe(1);
    expect(resolvedSends(spy, "teste_flap")).toBe(0);
    await t.run((ctx) => platformCondition(ctx, { ...input, failing: false }));
    await t.run((ctx) => platformCondition(ctx, { ...input, failing: false }));
    expect(resolvedSends(spy, "teste_flap")).toBe(1);
  });

  test("sem PLATFORM_ALERT_EMAIL: não envia nem alerta de resolvido", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const input = { kind: "teste_sem_env", severity: "critical" as const, title: "X", detail: "X" };
    await t.run((ctx) => platformCondition(ctx, { ...input, failing: true }));
    await t.run((ctx) => platformCondition(ctx, { ...input, failing: false }));
    expect(sends(spy, "teste_sem_env") + resolvedSends(spy, "teste_sem_env")).toBe(0);
  });
});

async function seedOrg(t: TestConvex<typeof schema>, name = "Org Alfa", demo = false) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", ...(demo ? { demoMode: true } : {}) },
      createdAt: now,
      updatedAt: now,
    } as any);
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      channel: "whatsapp",
      status: "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    } as any);
    return { organizationId, conversationId };
  });
}

describe("gancho em agentRuns.internalFinishRun", () => {
  test("erro marcado agenda o alerta de crédito; erro comum não", async () => {
    enableAlerts();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const { organizationId } = await seedOrg(t);
    const runId = await t.mutation(internal.agentRuns.internalStartRun, { organizationId, kind: "translation" });
    await t.mutation(internal.agentRuns.internalFinishRun, { runId, status: "error", error: "LLM request failed (HTTP 500): x" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await alertRow(t, "openrouter_no_credit")).toBeNull();

    const run2 = await t.mutation(internal.agentRuns.internalStartRun, { organizationId, kind: "translation" });
    await t.mutation(internal.agentRuns.internalFinishRun, {
      runId: run2,
      status: "error",
      error: `${platformLlmFailureTag(402)}LLM request failed (HTTP 402): Insufficient credits`,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await alertRow(t, "openrouter_no_credit")).not.toBeNull();
    expect(sends(spy, "openrouter_no_credit")).toBe(1);
  });
});

describe("sondas", () => {
  test("Whisper: 2 falhas seguidas alertam; volta = resolvido", async () => {
    enableAlerts();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    await t.mutation(internal.platformSentinel.internalApplyProbes, { whisperOk: false });
    expect(sends(spy, "whisper_down")).toBe(0);
    await t.mutation(internal.platformSentinel.internalApplyProbes, { whisperOk: false });
    expect(sends(spy, "whisper_down")).toBe(1);
    await t.mutation(internal.platformSentinel.internalApplyProbes, { whisperOk: true });
    await t.mutation(internal.platformSentinel.internalApplyProbes, { whisperOk: true });
    expect(resolvedSends(spy, "whisper_down")).toBe(1);
  });

  test("OpenRouter: chave inválida é crítica na 1ª; saldo baixo e zerado em kinds separados", async () => {
    enableAlerts();
    vi.stubEnv("OPENROUTER_LOW_BALANCE_USD", "10");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    await t.mutation(internal.platformSentinel.internalApplyProbes, { openrouterKey: "invalid", openrouterKeyStatus: 401 });
    expect(sends(spy, "openrouter_key_invalid")).toBe(1);
    await t.mutation(internal.platformSentinel.internalApplyProbes, { openrouterKey: "ok", openrouterKeyRemainingUsd: 4, credits: "ok", creditsBalanceUsd: 50 });
    await t.mutation(internal.platformSentinel.internalApplyProbes, { openrouterKey: "ok", openrouterKeyRemainingUsd: 4, credits: "ok", creditsBalanceUsd: 50 });
    expect(resolvedSends(spy, "openrouter_key_invalid")).toBe(1);
    expect(sends(spy, "openrouter_low_balance")).toBe(1);
    expect(sends(spy, "openrouter_no_balance")).toBe(0);
    await t.mutation(internal.platformSentinel.internalApplyProbes, { openrouterKey: "ok", openrouterKeyRemainingUsd: null, credits: "ok", creditsBalanceUsd: 0 });
    expect(sends(spy, "openrouter_no_balance")).toBe(1);
    // O gancho das chamadas reais não manda um 2º crítico do mesmo incidente.
    await t.mutation(internal.platformSentinel.internalNoteLlmFailure, { status: 402 });
    expect(sends(spy, "openrouter_no_credit")).toBe(0);
    // Desconhecido (429/rede) não muda estado.
    await t.mutation(internal.platformSentinel.internalApplyProbes, { openrouterKey: "unknown" });
    expect(resolvedSends(spy, "openrouter_no_balance")).toBe(0);
  });

  test("tick de sondas: sem a env ou com CRONS_DISABLED não faz nada", async () => {
    const t = convexTest(schema, modules);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await t.action(internal.platformSentinel.internalProbeTick, {})).toEqual({ skipped: true });
    enableAlerts();
    vi.stubEnv("CRONS_DISABLED", "1");
    expect(await t.action(internal.platformSentinel.internalProbeTick, {})).toEqual({ skipped: true });
    vi.stubEnv("CRONS_DISABLED", "");
    vi.stubEnv("RESEND_TEST_MODE", "true");
    expect(await t.action(internal.platformSentinel.internalProbeTick, {})).toEqual({ skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("tick de sondas: chave e Whisper sondados, sem vazar a chave no corpo do alerta", async () => {
    enableAlerts();
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test-segredo");
    vi.stubEnv("WHISPER_SERVICE_URL", "https://whisper.exemplo.com/");
    vi.useRealTimers();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes("openrouter.ai")) return new Response("{}", { status: 401 });
        return new Response("{}", { status: 200 });
      })
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    expect(await t.action(internal.platformSentinel.internalProbeTick, {})).toEqual({ skipped: false });
    expect(calls).toContain("https://openrouter.ai/api/v1/key");
    expect(calls).toContain("https://whisper.exemplo.com/health");
    expect(sends(spy, "openrouter_key_invalid")).toBe(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("segredo");
  });

  test("placar do bridge: 2 rodadas ruins seguidas", async () => {
    enableAlerts();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    await t.mutation(internal.platformSentinel.internalRecordBridgeProbeRound, { checked: 0, probeErrors: 4 });
    await t.mutation(internal.platformSentinel.internalRecordBridgeProbeRound, { checked: 0, probeErrors: 4 });
    expect(sends(spy, "bridge_gateway_unreachable")).toBe(1);
    await t.mutation(internal.platformSentinel.internalRecordBridgeProbeRound, { checked: 4, probeErrors: 0 });
    await t.mutation(internal.platformSentinel.internalRecordBridgeProbeRound, { checked: 4, probeErrors: 0 });
    expect(resolvedSends(spy, "bridge_gateway_unreachable")).toBe(1);
  });
});

describe("varredura", () => {
  test("saída presa (org real) alerta com nome da org; org demo e mensagem recente não contam", async () => {
    enableAlerts();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const real = await seedOrg(t, "Org Alfa");
    const demo = await seedOrg(t, "Org Demo", true);
    const insertOut = (n: number, seed: typeof real) => t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("messages", {
          organizationId: seed.organizationId,
          conversationId: seed.conversationId,
          direction: "outbound",
          senderType: "human",
          content: "segredo do cliente",
          contentType: "text",
          isInternal: false,
          createdAt: Date.now(),
        } as any);
      }
    });
    await insertOut(3, real);
    await insertOut(5, demo);
    vi.setSystemTime(Date.now() + 30 * MIN);
    await insertOut(1, real); // recente: ainda no pacing
    await t.run(async (ctx) => {
      const now = Date.now();
      const out = (seed: typeof real, createdAt: number) =>
        ctx.db.insert("messages", {
          organizationId: seed.organizationId,
          conversationId: seed.conversationId,
          direction: "outbound",
          senderType: "human",
          content: "segredo do cliente",
          contentType: "text",
          isInternal: false,
          createdAt,
        } as any);
      void out;
      void now;
    });
    const r = await t.mutation(internal.platformSentinel.internalScanTick, {});
    expect(r).toMatchObject({ skipped: false, stuckOutbound: 3 });
    expect(sends(spy, "outbound_stuck")).toBe(1);
    const log = JSON.stringify(spy.mock.calls);
    expect(log).not.toContain("segredo do cliente");
  });

  test("rajada de erros de IA ignora orgs BYO; canal caído há mais de 7 dias sai do resumo; Asaas falhado alerta", async () => {
    enableAlerts();
    vi.stubEnv("PLATFORM_ALERT_LLM_ERROR_BURST", "3");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const byo = await seedOrg(t, "Org BYO");
    const plat = await seedOrg(t, "Org Plataforma");
    await t.run(async (ctx) => {
      const now = Date.now();
      const org = await ctx.db.get(byo.organizationId);
      await ctx.db.patch(byo.organizationId, {
        settings: { ...(org!.settings as any), aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, providerConfig: { mode: "byo", zdr: true, models: { copilot: "x", attendant: "x", classify: "x" } } } },
      } as any);
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("agentRuns", { organizationId: byo.organizationId, kind: "attendant", status: "error", requestCount: 1, startedAt: now - MIN });
      }
      await ctx.db.insert("agentRuns", { organizationId: plat.organizationId, kind: "translation", status: "error", requestCount: 1, startedAt: now - MIN });
      // Canal largado há 8 dias: fora do resumo.
      await ctx.db.insert("channelConfigs", {
        organizationId: plat.organizationId,
        channel: "whatsapp",
        provider: "bridge",
        displayName: "Velho",
        status: "active",
        bridgeSessionState: "disconnected",
        bridgeSessionAlertedAt: now - 8 * 24 * 60 * MIN,
        createdAt: now,
        updatedAt: now,
      } as any);
      await ctx.db.insert("billingWebhookEvents", { provider: "asaas", eventId: "evt_1", event: "PAYMENT_CONFIRMED", receivedAt: now - 60 * MIN, status: "failed", attempts: 5 } as any);
    });
    const r = await t.mutation(internal.platformSentinel.internalScanTick, {});
    expect(r).toMatchObject({ llmErrors: 1, bridgeChannelsLost: 0, asaasProblems: 1 });
    expect(sends(spy, "llm_error_burst")).toBe(0);
    expect(sends(spy, "bridge_channels_lost")).toBe(0);
    expect(sends(spy, "asaas_webhook_failing")).toBe(1);
  });

  test("falha do juiz de afirmação (timeout, JSON inválido) NÃO conta na rajada de erros de IA", async () => {
    enableAlerts();
    vi.stubEnv("PLATFORM_ALERT_LLM_ERROR_BURST", "3");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const plat = await seedOrg(t, "Org Plataforma");
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 6; i++) await ctx.db.insert("agentRuns", { organizationId: plat.organizationId, kind: "sched_claim_judge", status: "error", requestCount: 1, startedAt: now - MIN });
    });
    const r = await t.mutation(internal.platformSentinel.internalScanTick, {});
    expect(r).toMatchObject({ llmErrors: 0 });
    expect(sends(spy, "llm_error_burst")).toBe(0);
    // o mesmo volume de outro tipo de run conta e alerta
    await t.run(async (ctx) => {
      for (let i = 0; i < 4; i++) await ctx.db.insert("agentRuns", { organizationId: plat.organizationId, kind: "attendant", status: "error", requestCount: 1, startedAt: Date.now() - MIN });
    });
    await t.mutation(internal.platformSentinel.internalScanTick, {});
    expect(sends(spy, "llm_error_burst")).toBe(1);
  });

  test("falha do classificador da confirmação (`sched_interpret`) NÃO conta na rajada de erros de IA", async () => {
    enableAlerts();
    vi.stubEnv("PLATFORM_ALERT_LLM_ERROR_BURST", "3");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const plat = await seedOrg(t, "Org Plataforma");
    await t.run(async (ctx) => {
      for (let i = 0; i < 6; i++) await ctx.db.insert("agentRuns", { organizationId: plat.organizationId, kind: "sched_interpret", status: "error", requestCount: 1, startedAt: Date.now() - MIN });
    });
    const r = await t.mutation(internal.platformSentinel.internalScanTick, {});
    expect(r).toMatchObject({ llmErrors: 0 });
    expect(sends(spy, "llm_error_burst")).toBe(0);
    await t.run(async (ctx) => {
      for (let i = 0; i < 4; i++) await ctx.db.insert("agentRuns", { organizationId: plat.organizationId, kind: "attendant", status: "error", requestCount: 1, startedAt: Date.now() - MIN });
    });
    await t.mutation(internal.platformSentinel.internalScanTick, {});
    expect(sends(spy, "llm_error_burst")).toBe(1);
  });

  test("sem a env a varredura não lê nada", async () => {
    const t = convexTest(schema, modules);
    const r = await t.mutation(internal.platformSentinel.internalScanTick, {});
    expect(r.skipped).toBe(true);
  });
});
