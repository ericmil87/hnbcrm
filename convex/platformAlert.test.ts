/// <reference types="vite/client" />
/**
 * Porta genérica de alerta de plataforma (`lib/platformAlert.ts`): destinatário
 * só da env, dedupe por kind com janela configurável, contagem de suprimidos,
 * envio só por `sendTransactionalEmail`.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { buildPlatformAlertEmail, platformAlert, platformAlertDue } from "./lib/platformAlert";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const INPUT = {
  kind: "openrouter_no_credit",
  severity: "critical" as const,
  title: "OpenRouter sem crédito",
  detail: "A OpenRouter recusou por falta de crédito <script>.",
  howToFix: "Recarregue o crédito.",
  fallback: "A IA cai na rota reserva.",
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function sendAttempts(spy: { mock: { calls: unknown[][] } }, kind: string) {
  return spy.mock.calls.filter((c: unknown[]) => String(c[0]).includes(`platform_alert:${kind}`)).length;
}

describe("platformAlert", () => {
  test("sem PLATFORM_ALERT_EMAIL: não envia nem carimba", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = convexTest(schema, modules);
      const r = await t.run((ctx) => platformAlert(ctx, INPUT));
      expect(r).toEqual({ sent: false, reason: "no_recipient" });
      expect(await t.run((ctx) => ctx.db.query("platformAlerts").collect())).toEqual([]);
      expect(sendAttempts(spy, INPUT.kind)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("1 envio por kind na janela; suprimidos contados; nova janela envia de novo", async () => {
    vi.stubEnv("PLATFORM_ALERT_EMAIL", "alertas@acme.com.br");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = convexTest(schema, modules);
      // O Resend não está registrado no teste: a porta tenta e loga a falha.
      const first = await t.run((ctx) => platformAlert(ctx, INPUT));
      expect(first).toEqual({ sent: false, reason: "send_failed" });
      expect(sendAttempts(spy, INPUT.kind)).toBe(1);

      const second = await t.run((ctx) => platformAlert(ctx, INPUT));
      expect(second).toEqual({ sent: false, reason: "throttled" });
      expect(sendAttempts(spy, INPUT.kind)).toBe(1);
      // Outro kind não é afetado pelo dedupe deste.
      await t.run((ctx) => platformAlert(ctx, { ...INPUT, kind: "outro_problema" }));
      expect(sendAttempts(spy, "outro_problema")).toBe(1);

      let row = await t.run((ctx) =>
        ctx.db.query("platformAlerts").withIndex("by_kind", (q) => q.eq("kind", INPUT.kind)).unique()
      );
      expect(row?.suppressedCount).toBe(1);

      vi.setSystemTime(Date.now() + 6 * 3_600_000);
      await t.run((ctx) => platformAlert(ctx, INPUT));
      expect(sendAttempts(spy, INPUT.kind)).toBe(2);
      row = await t.run((ctx) =>
        ctx.db.query("platformAlerts").withIndex("by_kind", (q) => q.eq("kind", INPUT.kind)).unique()
      );
      expect(row).toMatchObject({ lastSentAt: Date.now(), suppressedCount: 0, lastSeverity: "critical" });
    } finally {
      spy.mockRestore();
    }
  });

  test("janela configurável por chamada", async () => {
    vi.stubEnv("PLATFORM_ALERT_EMAIL", "alertas@acme.com.br");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = convexTest(schema, modules);
      await t.run((ctx) => platformAlert(ctx, { ...INPUT, throttleMs: 60_000 }));
      vi.setSystemTime(Date.now() + 61_000);
      await t.run((ctx) => platformAlert(ctx, { ...INPUT, throttleMs: 60_000 }));
      expect(sendAttempts(spy, INPUT.kind)).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("wrapper internalRaise (para actions) usa a mesma porta e o mesmo dedupe", async () => {
    vi.stubEnv("PLATFORM_ALERT_EMAIL", "alertas@acme.com.br");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = convexTest(schema, modules);
      const args = { kind: "openrouter_no_credit", severity: "critical" as const, title: "OpenRouter sem crédito", detail: "Sem crédito." };
      expect(await t.mutation(internal.platformAlerts.internalRaise, args)).toEqual({ sent: false, reason: "send_failed" });
      expect(await t.mutation(internal.platformAlerts.internalRaise, args)).toEqual({ sent: false, reason: "throttled" });
      expect(sendAttempts(spy, "openrouter_no_credit")).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("conteúdo: PT-BR, escapado, com suprimidos e o deployment", () => {
    const { subject, html } = buildPlatformAlertEmail(INPUT, {
      deployment: "careful-anaconda-127",
      suppressed: 3,
      throttleMs: 6 * 3_600_000,
    });
    expect(subject).toBe("[HNBCRM][CRÍTICO] OpenRouter sem crédito");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("mais 3 vez(es)");
    expect(html).toContain("careful-anaconda-127");
    expect(html).toContain("a cada 6 h");
    expect(platformAlertDue(undefined, 1, 10)).toBe(true);
    expect(platformAlertDue(0, 5, 10)).toBe(false);
  });
});
