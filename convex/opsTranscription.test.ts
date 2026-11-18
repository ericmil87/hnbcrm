/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("opsTranscription", () => {
  test("probe sem GROQ_API_KEY: não configurado, nenhuma chamada", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    expect(await t.action(internal.opsTranscription.internalGroqProbe, {})).toEqual({ configured: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("ping lista os modelos e nunca devolve a chave", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk-test-fake-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "whisper-large-v3-turbo" }, { id: "llama" }] }),
      }))
    );
    const t = convexTest(schema, modules);
    const r = await t.action(internal.opsTranscription.internalGroqProbe, {});
    expect(r).toMatchObject({
      configured: true,
      ok: true,
      models: [
        { model: "whisper-large-v3-turbo", available: true },
        { model: "whisper-large-v3", available: false },
      ],
    });
    expect(JSON.stringify(r)).not.toContain("gsk-test");
  });

  test("probe com arquivo em dryRun não chama a Groq", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk-test-fake-key");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x".repeat(2500)], { type: "audio/ogg" })));
    const r = await t.action(internal.opsTranscription.internalGroqProbe, { storageId });
    expect(r).toMatchObject({ dryRun: true, size: 2500, estimatedSeconds: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("teste do alerta: dryRun só informa se a env existe", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.opsTranscription.internalPlatformAlertTest, {})).toEqual({
      recipientConfigured: false,
      sent: false,
      reason: "dry_run",
    });
    vi.stubEnv("PLATFORM_ALERT_EMAIL", "alertas@acme.com.br");
    expect((await t.mutation(internal.opsTranscription.internalPlatformAlertTest, {})).recipientConfigured).toBe(true);
  });
});
