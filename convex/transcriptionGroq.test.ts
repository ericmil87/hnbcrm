/// <reference types="vite/client" />
/**
 * Roteamento Groq × Whisper local (18/11/2026): áudio longo vai direto à Groq,
 * curto ao local; local ocupado ou com falha cai na Groq; Groq com falha cai no
 * local; orçamento a 85% dos limites oficiais; alerta por e-mail com dedupe.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { GROQ_MODELS } from "./lib/groqTranscription";
import { GROQ_MODEL_LITERALS } from "./transcriptionRouting";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const LONG = 1_500_000; // ~10 min de ogg/opus
const SHORT = 50_000; // ~20 s

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("WHISPER_SERVICE_URL", "https://whisper.test.local");
  vi.stubEnv("GROQ_API_KEY", "gsk-test-fake-key");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seed(t: TestConvex<typeof schema>, opts?: { aiActive?: boolean }) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Groq",
      slug: "org-groq",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "admin@groq.test" });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    if (opts?.aiActive !== false) {
      await ctx.db.patch(organizationId, {
        settings: {
          timezone: "America/Sao_Paulo",
          currency: "BRL",
          aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, lgpdAck: { acceptedAt: now, acceptedBy: adminId } },
        },
      });
    }
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Número",
      phoneNumberId: "555000999",
      status: "active",
      autoTranscribeAudio: true,
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      channel: "whatsapp",
      channelConfigId: configId,
      status: "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, conversationId };
  });
}

async function audio(t: TestConvex<typeof schema>, s: Awaited<ReturnType<typeof seed>>, size: number) {
  return await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["fake-opus"], { type: "audio/ogg; codecs=opus" }));
    const fileId = await ctx.db.insert("files", {
      organizationId: s.organizationId,
      storageId,
      name: "voz.ogg",
      mimeType: "audio/ogg; codecs=opus",
      size,
      fileType: "message_attachment",
      createdAt: Date.now(),
    });
    return await ctx.db.insert("messages", {
      organizationId: s.organizationId,
      conversationId: s.conversationId,
      direction: "inbound",
      senderType: "contact",
      content: "[mensagem de voz]",
      contentType: "audio",
      attachments: [fileId],
      isInternal: false,
      createdAt: Date.now(),
    });
  });
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
function mockFetch(groq: Reply[] | ((model: string) => Reply), whisper: Reply[]) {
  const calls: { target: "groq" | "whisper"; model?: string; fields?: string[] }[] = [];
  let g = 0;
  let w = 0;
  const respond = (r: Reply) => ({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: new Headers(r.headers ?? {}),
    json: async () => r.body ?? {},
    text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {})),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("api.groq.com")) {
        const form = init?.body as FormData;
        const model = String(form.get("model"));
        calls.push({ target: "groq", model, fields: Array.from((form as unknown as { keys(): Iterable<string> }).keys()).sort() });
        const r = typeof groq === "function" ? groq(model) : groq[Math.min(g++, groq.length - 1)]!;
        return respond(r);
      }
      calls.push({ target: "whisper" });
      return respond(whisper[Math.min(w++, whisper.length - 1)]!);
    })
  );
  return calls;
}

const GROQ_OK: Reply = { status: 200, body: { text: "oi, transcrito pela groq", language: "portuguese", duration: 600 } };
const WHISPER_OK: Reply = { status: 200, body: { text: "oi, transcrito local", language: "pt", duration_sec: 20 } };

async function stored(t: TestConvex<typeof schema>, id: Id<"messages">) {
  return await t.run(async (ctx) => ctx.db.get(id));
}
async function providerState(t: TestConvex<typeof schema>, key: string) {
  return await t.run(async (ctx) =>
    ctx.db.query("transcriptionProviderState").withIndex("by_key", (q) => q.eq("key", key)).unique()
  );
}

describe("roteamento Groq × local", () => {
  test("paridade do validator de modelos com GROQ_MODELS", () => {
    expect([...GROQ_MODEL_LITERALS]).toEqual([...GROQ_MODELS]);
  });

  test("áudio longo vai direto à Groq (turbo, language=pt, só os campos necessários)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await audio(t, s, LONG);
    const calls = mockFetch([GROQ_OK], [WHISPER_OK]);

    const r = await t.action(internal.transcription.autoTranscribe, { messageId: id });
    expect(r.status).toBe("done");
    expect(calls).toEqual([
      { target: "groq", model: "whisper-large-v3-turbo", fields: ["file", "language", "model", "response_format", "temperature"] },
    ]);
    const m = await stored(t, id);
    expect(m?.transcriptText).toBe("oi, transcrito pela groq");
    expect(m?.metadata?.transcription).toMatchObject({ status: "done", engine: "groq:whisper-large-v3-turbo", language: "pt" });
    // Orçamento ajustado ao cobrado de fato (600 s).
    expect((await providerState(t, "groq:whisper-large-v3-turbo"))?.dayAudioSec).toBe(600);
  });

  test("sem GROQ_API_KEY: tudo no Whisper local, como antes", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await audio(t, s, LONG);
    const calls = mockFetch([GROQ_OK], [WHISPER_OK]);
    await t.action(internal.transcription.autoTranscribe, { messageId: id });
    expect(calls.map((c) => c.target)).toEqual(["whisper"]);
  });

  test("org sem IA ativa/aceite LGPD (só o toggle do canal): nunca vai à Groq", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiActive: false });
    const id = await audio(t, s, LONG);
    const calls = mockFetch([GROQ_OK], [WHISPER_OK]);
    await t.action(internal.transcription.autoTranscribe, { messageId: id });
    expect(calls.map((c) => c.target)).toEqual(["whisper"]);
  });

  test("áudio curto vai ao local; falha local cai na Groq", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await audio(t, s, SHORT);
    const calls = mockFetch([GROQ_OK], [{ status: 500, body: { detail: "erro" } }]);
    const r = await t.action(internal.transcription.autoTranscribe, { messageId: id });
    expect(r.status).toBe("done");
    expect(calls.map((c) => c.target)).toEqual(["whisper", "groq"]);
    expect((await providerState(t, "local"))?.localInFlight).toEqual([]);
  });

  test("Whisper local ocupado (fila estimada alta): áudio curto vai à Groq", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const busy = await audio(t, s, LONG);
    await t.mutation(internal.transcriptionRouting.internalLocalStart, { messageId: busy, estMs: 400_000 });
    const id = await audio(t, s, SHORT);
    const calls = mockFetch([GROQ_OK], [WHISPER_OK]);
    await t.action(internal.transcription.autoTranscribe, { messageId: id });
    expect(calls.map((c) => c.target)).toEqual(["groq"]);
  });

  test("429 no turbo (respeita retry-after) → tenta o v3; cooldown gravado no turbo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await audio(t, s, LONG);
    const calls = mockFetch(
      (model) => (model === "whisper-large-v3-turbo" ? { status: 429, body: "rate limit", headers: { "retry-after": "120" } } : GROQ_OK),
      [WHISPER_OK]
    );
    const r = await t.action(internal.transcription.autoTranscribe, { messageId: id });
    expect(r.status).toBe("done");
    expect(calls.map((c) => c.model ?? c.target)).toEqual(["whisper-large-v3-turbo", "whisper-large-v3"]);
    const turbo = await providerState(t, "groq:whisper-large-v3-turbo");
    expect(turbo?.cooldownUntil).toBe(Date.now() + 120_000);
    expect(turbo?.dayAudioSec).toBe(0); // segundos devolvidos: não houve processamento
    expect((await stored(t, id))?.metadata?.transcription?.engine).toBe("groq:whisper-large-v3");
  });

  test("401 da Groq: cai no local, cooldown de 30 min e alerta por e-mail 1× a cada 6 h", async () => {
    vi.stubEnv("PLATFORM_ALERT_EMAIL", "alertas@acme.com.br");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      const id = await audio(t, s, LONG);
      const calls = mockFetch([{ status: 401, body: { error: { message: "Invalid API Key" } } }], [WHISPER_OK]);
      const r = await t.action(internal.transcription.autoTranscribe, { messageId: id });
      expect(r.status).toBe("done");
      // 401 vale para a conta toda: não tenta o v3, vai direto ao local.
      expect(calls.map((c) => c.model ?? c.target)).toEqual(["whisper-large-v3-turbo", "whisper"]);
      const global = await providerState(t, "groq");
      const alertRow = await t.run(async (ctx) => ctx.db.query("platformAlerts").withIndex("by_kind", (q) => q.eq("kind", "groq_auth")).unique());
      expect(alertRow?.lastSentAt).toBe(Date.now());
      expect(global?.consecutiveFailures).toBe(1);
      // A porta foi chamada (o Resend não existe no teste: o log de falha prova a tentativa).
      const attempts = () => errSpy.mock.calls.filter((c) => String(c[0]).includes("platform_alert:groq_auth")).length;
      expect(attempts()).toBe(1);

      // Outro 401 dentro de 6 h: sem novo e-mail.
      const res = await t.mutation(internal.transcriptionRouting.internalRecordGroqResult, {
        model: "whisper-large-v3-turbo",
        reservedSec: 10,
        ok: false,
        failure: { kind: "auth", status: 401, cooldownMs: 1_800_000, message: "HTTP 401" },
      });
      expect(res.alerted).toBeUndefined();
      expect(attempts()).toBe(1);
      // Passadas 6 h: novo e-mail.
      vi.setSystemTime(Date.now() + 6 * 3_600_000 + 1);
      const later = await t.mutation(internal.transcriptionRouting.internalRecordGroqResult, {
        model: "whisper-large-v3-turbo",
        reservedSec: 10,
        ok: false,
        failure: { kind: "auth", status: 401, cooldownMs: 1_800_000, message: "HTTP 401" },
      });
      expect(later.alerted).toBe("auth");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("sem PLATFORM_ALERT_EMAIL: nenhum e-mail é tentado", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = convexTest(schema, modules);
      const res = await t.mutation(internal.transcriptionRouting.internalRecordGroqResult, {
        model: "whisper-large-v3-turbo",
        reservedSec: 10,
        ok: false,
        failure: { kind: "quota", status: 402, cooldownMs: 3_600_000, message: "HTTP 402" },
      });
      expect(res.alerted).toBeUndefined();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("platform_alert:"))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("orçamento a 85% do limite de segundos/dia: para de mandar à Groq e usa o local", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    await t.run(async (ctx) => {
      for (const model of GROQ_MODELS) {
        await ctx.db.insert("transcriptionProviderState", {
          key: `groq:${model}`,
          dayStart: day,
          dayAudioSec: 28_800 * 0.85 - 100,
          dayRequests: 10,
          updatedAt: Date.now(),
        });
      }
    });
    const id = await audio(t, s, LONG);
    const calls = mockFetch([GROQ_OK], [WHISPER_OK]);
    await t.action(internal.transcription.autoTranscribe, { messageId: id });
    expect(calls.map((c) => c.target)).toEqual(["whisper"]);
  });

  test("Groq e local falham (rede): failed com re-tentativa agendada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await audio(t, s, LONG);
    mockFetch([{ status: 503, body: "unavailable" }], [{ status: 502, body: { detail: "Falha ao baixar áudio da URL" } }]);
    const r = await t.action(internal.transcription.autoTranscribe, { messageId: id });
    expect(r.status).toBe("failed");
    const m = await stored(t, id);
    expect(typeof m?.metadata?.transcription?.retryAt).toBe("number");
  });
});
