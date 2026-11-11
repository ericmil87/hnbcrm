/// <reference types="vite/client" />
/**
 * Resposta em áudio do chat do onboarding (P4.2b), caminhos de falha que o
 * `fetch` simulado não alcança:
 *  - a action de síntese LANÇA depois de gravar o WAV (erro de plataforma) →
 *    só texto, o WAV é achado pelo `requestId` e descartado, a reserva é solta;
 *  - o REGISTRO de custo lança → o áudio ainda é vinculado e a reserva é solta
 *    pela `internalReleaseOnboardingReservation`.
 *
 * A síntese é trocada por uma action falsa (vi.mock) que grava um WAV de
 * verdade pela mesma mutation da porta (`internalInsertWebAudioFile`).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

type Mode = "ok" | "throw_after_write";
const state = vi.hoisted(() => ({ mode: "ok" as Mode, failTtsRecord: false }));

vi.mock("./voiceReplyNode", async () => {
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  const { internal: internalApi } = await import("./_generated/api");
  return {
    internalSynthesizeWebAudio: internalAction({
      args: {
        organizationId: v.id("organizations"),
        memberId: v.id("teamMembers"),
        text: v.string(),
        strictZdr: v.boolean(),
        routingAllowed: v.boolean(),
        requestId: v.optional(v.string()),
      },
      returns: v.any(),
      handler: async (ctx, args) => {
        const storageId = await ctx.storage.store(new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: "audio/wav" }));
        const fileId = await ctx.runMutation(internalApi.voiceReply.internalInsertWebAudioFile, {
          organizationId: args.organizationId,
          memberId: args.memberId,
          storageId,
          size: 4,
          ...(args.requestId ? { requestId: args.requestId } : {}),
        });
        if (state.mode === "throw_after_write") throw new Error("plataforma caiu depois de gravar");
        return {
          ok: true,
          fileId,
          storageId,
          durationSec: 2,
          mimeType: "audio/wav",
          model: "google/gemini-3.8-flash-tts",
          cost: { costUsd: 0.001, promptTokens: 20, completionTokens: 50, estimated: false },
        };
      },
    }),
  };
});

// Registro de custo que lança só no papel `tts`, sob demanda.
vi.mock("./onboardingBudget", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./onboardingBudget")>();
  const { internalMutation } = await import("./_generated/server");
  const original = orig.internalRecordOnboardingSpend as unknown as {
    _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
  };
  return {
    ...orig,
    internalRecordOnboardingSpend: internalMutation({
      handler: async (ctx, args: Record<string, unknown>) => {
        if (state.failTtsRecord && args.role === "tts") throw new Error("medidor fora do ar");
        return await original._handler(ctx, args);
      },
    }),
  };
});

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  state.mode = "ok";
  state.failTtsRecord = false;
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-FAKE-test-key");
  vi.stubEnv("LLM_PLATFORM_ORDER", "openrouter-only");
  vi.stubEnv("WHISPER_SERVICE_URL", "https://whisper.example");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/transcribe")) {
        return new Response(JSON.stringify({ text: "Oi, tenho uma clínica de estética no centro." }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  reply: "Que bom ouvir você! Montei um funil inicial para a sua clínica. Está certo assim?",
                  chips: ["Está certo", "Quero ajustar"],
                  blocks: [],
                  nextStage: "interview",
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 600, completion_tokens: 80 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Clínica Sol",
      slug: "clinica-sol",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: false, autoAssign: false, handoffThreshold: 0.8 },
      },
      onboardingMeta: { industry: "saude" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "dona@example.com", emailVerificationTime: now });
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "dona",
      email: "dona@example.com",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, userId };
  });
}

async function audioTurn(t: TestConvex<typeof schema>, s: { organizationId: Id<"organizations">; userId: Id<"users"> }) {
  const client = t.withIdentity({ subject: `${s.userId}|s1` });
  const session = await client.mutation(api.onboardingSessions.getOrCreateSession, { organizationId: s.organizationId });
  await client.mutation(api.onboardingChat.ackMaterialsNotice, { organizationId: s.organizationId, sessionId: session._id });
  const storageId = await t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }));
    await ctx.db.insert("files", { organizationId: s.organizationId, storageId: id, name: "voz.webm", mimeType: "audio/webm", size: 4, fileType: "other", createdAt: Date.now() });
    return id;
  });
  return await client.action(internal.onboardingChat.internalSendTurn, {
    organizationId: s.organizationId,
    attachment: { kind: "audio", storageId },
  });
}

async function snapshot(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const session = await ctx.db.query("onboardingSessions").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).first();
    const messages = await ctx.db.query("onboardingMessages").withIndex("by_session", (q) => q.eq("sessionId", session!._id)).collect();
    const files = await ctx.db.query("files").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect();
    const voiceFiles = files.filter((f) => f.metadata?.kind === "onboarding_voice_reply");
    const storage = await ctx.db.system.query("_storage").collect();
    const runs = await ctx.db.query("agentRuns").collect();
    return { session: session!, messages, voiceFiles, storageCount: storage.length, runs };
  });
}

describe("resposta em áudio do onboarding: falhas de plataforma", () => {
  test("action lança DEPOIS de gravar: só texto, WAV órfão descartado pelo requestId, reserva solta", async () => {
    state.mode = "throw_after_write";
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await audioTurn(t, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.audio).toBeUndefined();
    expect(r.audioSkipReason).toBe("falha_tts");
    const snap = await snapshot(t, s.organizationId);
    expect(snap.voiceFiles).toEqual([]);
    // Só o áudio do usuário continua no storage (o WAV foi apagado).
    expect(snap.storageCount).toBe(1);
    expect(snap.session.reservedUsdMicros ?? 0).toBe(0);
    // Registro da falha com custo 0 (não dá para saber se o provedor cobrou).
    const ttsRun = snap.runs.find((x) => x.kind === "onboarding" && x.status === "error" && x.model === undefined && x.requestCount === 1);
    expect(ttsRun?.costUsdEstimate ?? 0).toBe(0);
    expect(snap.messages.find((m) => m.role === "assistant")!.audioSkipReason).toBe("falha_tts");
  });

  test("registro do custo lança: o áudio ainda é vinculado e a reserva não fica presa", async () => {
    state.failTtsRecord = true;
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await audioTurn(t, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.audio).toMatchObject({ mimeType: "audio/wav", durationSec: 2 });
    const snap = await snapshot(t, s.organizationId);
    expect(snap.voiceFiles).toHaveLength(1);
    expect(snap.messages.find((m) => m.role === "assistant")!.audio?.fileId).toBe(snap.voiceFiles[0]._id);
    expect(snap.session.reservedUsdMicros ?? 0).toBe(0);
    // Nenhuma run de TTS (a medição falhou); as demais continuam medidas.
    expect(snap.runs.some((x) => x.model === "google/gemini-3.8-flash-tts")).toBe(false);
    expect(snap.runs.filter((x) => x.kind === "onboarding").length).toBeGreaterThan(0);
  });
});
