/// <reference types="vite/client" />
/**
 * Onboarding v2 (P4.2b): o Copiloto responde em áudio quando o usuário manda
 * áudio. Rede inteira stubada por URL: Whisper (`/transcribe`), TTS
 * (`/audio/speech`, PCM 24 kHz) e o entrevistador (chat completion).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { onboardingTtsEstimateUsdMicros } from "./lib/onboardingTurn";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-FAKE-test-key");
  vi.stubEnv("LLM_PLATFORM_ORDER", "openrouter-only");
  vi.stubEnv("WHISPER_SERVICE_URL", "https://whisper.example");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Seed = {
  organizationId: Id<"organizations">;
  otherOrgId: Id<"organizations">;
  adminUserId: Id<"users">;
  otherUserId: Id<"users">;
};

async function seed(t: TestConvex<typeof schema>): Promise<Seed> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const mkOrg = (name: string, slug: string) =>
      ctx.db.insert("organizations", {
        name,
        slug,
        settings: {
          timezone: "America/Sao_Paulo",
          currency: "BRL",
          aiConfig: { enabled: false, autoAssign: false, handoffThreshold: 0.8 },
        },
        onboardingMeta: { industry: "saude" },
        createdAt: now,
        updatedAt: now,
      });
    const organizationId = await mkOrg("Clínica Sol", "clinica-sol");
    const otherOrgId = await mkOrg("Outra Org", "outra-org");
    const mkMember = async (orgId: Id<"organizations">, email: string) => {
      const userId = await ctx.db.insert("users", { email, emailVerificationTime: now });
      await ctx.db.insert("teamMembers", {
        organizationId: orgId,
        userId,
        name: email.split("@")[0],
        email,
        role: "admin",
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return userId;
    };
    return {
      organizationId,
      otherOrgId,
      adminUserId: await mkMember(organizationId, "dona@example.com"),
      otherUserId: await mkMember(otherOrgId, "outra@example.com"),
    };
  });
}

const as = (t: TestConvex<typeof schema>, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

async function ackNotice(t: TestConvex<typeof schema>, organizationId: Id<"organizations">, userId: Id<"users">) {
  const session = await as(t, userId).mutation(api.onboardingSessions.getOrCreateSession, { organizationId });
  await as(t, userId).mutation(api.onboardingChat.ackMaterialsNotice, { organizationId, sessionId: session._id });
  return session._id;
}

async function uploadAudio(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }));
    await ctx.db.insert("files", { organizationId, storageId: id, name: "voz.webm", mimeType: "audio/webm", size: 4, fileType: "other", createdAt: Date.now() });
    return id;
  });
}

/** PCM s16le 24 kHz mono com um tom (segundos). */
function pcm(seconds: number): Uint8Array {
  const n = Math.floor(24_000 * seconds);
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) view.setInt16(i * 2, Math.round(Math.sin(i / 10) * 8000), true);
  return out;
}

const DEFAULT_REPLY = "Que bom ouvir você! Montei um funil inicial para a sua clínica. Está certo assim?";

type Net = {
  reply?: string;
  transcript?: string;
  tts?: "ok" | "http_500" | "long";
  interviewerUsage?: { prompt_tokens: number; completion_tokens: number };
};

function stubNet(net: Net = {}) {
  const speech: Array<{ input: string; voice: string; model: string; response_format: string; provider?: unknown }> = [];
  const chats: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith("/transcribe")) {
        return new Response(JSON.stringify({ text: net.transcript ?? "Oi, tenho uma clínica de estética no centro." }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/audio/speech")) {
        speech.push(body);
        if (net.tts === "http_500") return new Response("erro", { status: 500 });
        const bytes = pcm(net.tts === "long" ? 50 : 2);
        return new Response(bytes as BodyInit, { status: 200, headers: { "Content-Type": "audio/pcm;rate=24000;channels=1" } });
      }
      chats.push(body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  reply: net.reply ?? DEFAULT_REPLY,
                  chips: ["Está certo", "Quero ajustar"],
                  blocks: [{ kind: "funilPreview" }],
                  nextStage: "interview",
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: net.interviewerUsage ?? { prompt_tokens: 600, completion_tokens: 80 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  return { speech, chats };
}

async function state(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const session = await ctx.db.query("onboardingSessions").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).first();
    const messages = session
      ? await ctx.db.query("onboardingMessages").withIndex("by_session", (q) => q.eq("sessionId", session._id)).collect()
      : [];
    const runs = await ctx.db.query("agentRuns").collect();
    const files = await ctx.db.query("files").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect();
    return { session, messages, runs, files };
  });
}

async function audioTurn(t: TestConvex<typeof schema>, s: Seed) {
  await ackNotice(t, s.organizationId, s.adminUserId);
  const storageId = await uploadAudio(t, s.organizationId);
  return await as(t, s.adminUserId).action(internal.onboardingChat.internalSendTurn, {
    organizationId: s.organizationId,
    attachment: { kind: "audio", storageId },
  });
}

describe("resposta em áudio no chat do onboarding", () => {
  test("turno com áudio: WAV no storage da org, custo no orçamento da sessão, sem run tts paralela", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubNet();
    const r = await audioTurn(t, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.audio).toBeDefined();
    expect(r.audio!.mimeType).toBe("audio/wav");
    expect(r.audio!.durationSec).toBeCloseTo(2, 1);
    expect(typeof r.audio!.url).toBe("string");
    expect(r.audioSkipReason).toBeUndefined();

    // Uma síntese só, com o texto falável (sem marcação) e a trava de retenção.
    expect(net.speech).toHaveLength(1);
    expect(net.speech[0].input).toBe(DEFAULT_REPLY);
    expect(net.speech[0].response_format).toBe("pcm");
    expect(net.speech[0].provider).toMatchObject({ data_collection: "deny" });

    const st = await state(t, s.organizationId);
    const assistant = st.messages.find((m) => m.role === "assistant")!;
    expect(assistant.audio).toMatchObject({ mimeType: "audio/wav" });
    expect(assistant.audioExpiresAt).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
    const wavRow = st.files.find((f) => f.metadata?.kind === "onboarding_voice_reply");
    expect(wavRow).toMatchObject({ mimeType: "audio/wav", fileType: "other", name: "resposta-em-audio.wav" });
    expect(wavRow!._id).toBe(assistant.audio!.fileId);
    const head = await t.run(async (ctx) => {
      const blob = await ctx.storage.get(assistant.audio!.storageId);
      return String.fromCharCode(...new Uint8Array(await blob!.arrayBuffer()).slice(0, 4));
    });
    expect(head).toBe("RIFF");

    // Custo: run `onboarding` com o modelo de TTS, somada ao gasto da sessão; reserva solta.
    const ttsRun = st.runs.find((x) => x.kind === "onboarding" && x.model === "google/gemini-3.8-flash-tts");
    expect(ttsRun).toMatchObject({ status: "done" });
    expect(ttsRun!.costUsdEstimate).toBeGreaterThan(0);
    expect(st.runs.some((x) => x.kind === "tts")).toBe(false);
    expect(st.session!.spentUsdMicros).toBeGreaterThanOrEqual(Math.round(ttsRun!.costUsdEstimate! * 1_000_000));
    expect(st.session!.reservedUsdMicros ?? 0).toBe(0);
  });

  test("SSE: `done` antes da síntese e o evento `audio` depois", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubNet();
    await ackNotice(t, s.organizationId, s.adminUserId);
    const storageId = await uploadAudio(t, s.organizationId);
    const res = await as(t, s.adminUserId).fetch("/api/onboarding/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: s.organizationId, attachment: { kind: "audio", storageId } }),
    });
    expect(res.status).toBe(200);
    const events = (await res.text())
      .split("\n\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
    const types = events.map((e) => e.type);
    const audioAt = types.indexOf("audio");
    // `done` sai antes da síntese (o cliente destrava a entrada); `audio` chega depois.
    expect(audioAt).toBeGreaterThan(types.lastIndexOf("delta"));
    expect(audioAt).toBeGreaterThan(types.indexOf("done"));
    expect(types.slice(-2)).toEqual(["done", "audio"]);
    expect(types.filter((x) => x === "done")).toHaveLength(1);
    const audio = events[audioAt];
    expect(Object.keys(audio).sort()).toEqual(["durationSec", "mimeType", "type", "url"]);
    expect(audio.mimeType).toBe("audio/wav");
  });

  test("turno de texto: nenhuma síntese, nenhum áudio", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubNet();
    const r = await as(t, s.adminUserId).action(internal.onboardingChat.internalSendTurn, {
      organizationId: s.organizationId,
      text: "Tenho uma clínica de estética",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.audio).toBeUndefined();
    expect(r.audioSkipReason).toBeUndefined();
    expect(net.speech).toHaveLength(0);
    const st = await state(t, s.organizationId);
    expect(st.messages.every((m) => m.audio === undefined && m.audioSkipReason === undefined)).toBe(true);
    expect(st.files.some((f) => f.metadata?.kind === "onboarding_voice_reply")).toBe(false);
  });

  test("reply com Pix e valor: a fala leva só a parte sem dado; o texto inteiro fica na tela", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const reply = "Perfeito, anotei como você atende. Você aceita Pix e a consulta custa R$ 150. Quer ajustar o funil agora?";
    const net = stubNet({ reply });
    const r = await audioTurn(t, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reply).toBe(reply);
    expect(r.audio).toBeDefined();
    expect(net.speech).toHaveLength(1);
    const spoken = net.speech[0].input;
    expect(spoken).toContain("Perfeito, anotei como você atende.");
    expect(spoken).toContain("Quer ajustar o funil agora?");
    expect(spoken).not.toMatch(/pix|150|R\$|custa/i);
  });

  test("reply só de dado: nada é falado (dado_sensivel) e o turno segue em texto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubNet({ reply: "A consulta custa R$ 150." });
    const r = await audioTurn(t, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.audio).toBeUndefined();
    expect(r.audioSkipReason).toBe("dado_sensivel");
    expect(net.speech).toHaveLength(0);
  });

  test("reply em outro idioma: não fala (idioma)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubNet({ reply: "Great to hear from you! I have set up an initial pipeline for your clinic. Does it look right?" });
    const r = await audioTurn(t, s);
    expect(r.ok && r.audioSkipReason).toBe("idioma");
    expect(net.speech).toHaveLength(0);
  });

  test("strictZdr da org: sem áudio, motivo zdr_nao_validado, nenhuma chamada de TTS nem reserva", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, {
        settings: {
          ...org.settings,
          aiConfig: {
            ...org.settings.aiConfig!,
            providerConfig: {
              mode: "platform",
              zdr: true,
              strictZdr: true,
              models: { copilot: "kimi-k2.7-code", attendant: "deepseek-v4-flash", classify: "deepseek-v4-flash" },
            } as never,
          },
        },
      });
    });
    const net = stubNet();
    const r = await audioTurn(t, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.audio).toBeUndefined();
    expect(r.audioSkipReason).toBe("zdr_nao_validado");
    expect(net.speech).toHaveLength(0);
    const st = await state(t, s.organizationId);
    expect(st.runs.some((x) => x.model === "google/gemini-3.8-flash-tts")).toBe(false);
    expect(st.messages.find((m) => m.role === "assistant")!.audioSkipReason).toBe("zdr_nao_validado");
  });

  test("TTS falha (HTTP 500): só texto, turno ok, falha registrada sem custo e reserva solta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubNet({ tts: "http_500" });
    const r = await audioTurn(t, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reply).toBe(DEFAULT_REPLY);
    expect(r.audio).toBeUndefined();
    expect(r.audioSkipReason).toBe("falha_tts");
    expect(net.speech).toHaveLength(1);
    const st = await state(t, s.organizationId);
    const ttsRun = st.runs.find((x) => x.kind === "onboarding" && x.model === "google/gemini-3.8-flash-tts");
    expect(ttsRun).toMatchObject({ status: "error" });
    expect(ttsRun!.costUsdEstimate ?? 0).toBe(0);
    expect(st.session!.reservedUsdMicros ?? 0).toBe(0);
    expect(st.files.some((f) => f.metadata?.kind === "onboarding_voice_reply")).toBe(false);
  });

  test("áudio gerado longo demais: não vai à tela, mas o custo pago entra no orçamento", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubNet({ tts: "long" });
    const r = await audioTurn(t, s);
    expect(r.ok && r.audioSkipReason).toBe("audio_longo");
    const st = await state(t, s.organizationId);
    const ttsRun = st.runs.find((x) => x.kind === "onboarding" && x.model === "google/gemini-3.8-flash-tts");
    expect(ttsRun).toMatchObject({ status: "error" });
    expect(ttsRun!.costUsdEstimate).toBeGreaterThan(0);
    expect(st.files.some((f) => f.metadata?.kind === "onboarding_voice_reply")).toBe(false);
  });

  test("orçamento esgotado depois do entrevistador: sem TTS (orcamento_onboarding)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // Entrevistador caro: o gasto real passa do orçamento da sessão; a reserva do TTS é recusada.
    const net = stubNet({ interviewerUsage: { prompt_tokens: 3_000_000, completion_tokens: 500_000 } });
    const r = await audioTurn(t, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.audio).toBeUndefined();
    expect(r.audioSkipReason).toBe("orcamento_onboarding");
    expect(net.speech).toHaveLength(0);
    // Reserva = pior caso da porta (600 caracteres, 45 s) no modelo padrão.
    expect(onboardingTtsEstimateUsdMicros()).toBe(10_200);
  });
});

describe("histórico e isolamento entre orgs", () => {
  test("listMessages devolve `audio {url, durationSec, mimeType}` só na resposta falada; outra org não vê", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubNet();
    const r = await audioTurn(t, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const page = await as(t, s.adminUserId).query(api.onboardingChat.listMessages, {
      organizationId: s.organizationId,
      sessionId: r.sessionId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    const [assistant, user] = page.page;
    expect(assistant.role).toBe("assistant");
    expect(assistant.audio).toEqual({ url: expect.any(String), durationSec: r.audio!.durationSec, mimeType: "audio/wav" });
    expect(user.role).toBe("user");
    expect(user.audio).toBeUndefined();
    // storageId/fileId nunca saem na view.
    expect(JSON.stringify(page)).not.toMatch(/storageId|fileId|audioSkipReason/);

    // Membro de outra org: página vazia (nenhuma URL).
    const other = await as(t, s.otherUserId).query(api.onboardingChat.listMessages, {
      organizationId: s.organizationId,
      sessionId: r.sessionId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(other.page).toEqual([]);
  });

  test("vínculo e descarte recusam arquivo/mensagem de outra org", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubNet();
    const r = await audioTurn(t, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const st = await state(t, s.organizationId);
    const assistant = st.messages.find((m) => m.role === "assistant")!;
    const audio = assistant.audio!;

    // Arquivo de outra org não vincula à mensagem desta.
    const foreign = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob([new Uint8Array([1])], { type: "audio/wav" }));
      const fileId = await ctx.db.insert("files", {
        organizationId: s.otherOrgId,
        storageId,
        name: "x.wav",
        mimeType: "audio/wav",
        size: 1,
        fileType: "other",
        metadata: { kind: "onboarding_voice_reply" },
        createdAt: Date.now(),
      });
      return { storageId, fileId };
    });
    const res = await t.mutation(internal.onboardingChat.internalRecordReplyAudio, {
      organizationId: s.organizationId,
      sessionId: r.sessionId,
      messageId: assistant._id,
      audio: { fileId: foreign.fileId, storageId: foreign.storageId, durationSec: 1, mimeType: "audio/wav" },
    });
    expect(res.url).toBeNull();
    // Mensagem desta org com organizationId de outra: recusada.
    const res2 = await t.mutation(internal.onboardingChat.internalRecordReplyAudio, {
      organizationId: s.otherOrgId,
      sessionId: r.sessionId,
      messageId: assistant._id,
      audio: { fileId: foreign.fileId, storageId: foreign.storageId, durationSec: 1, mimeType: "audio/wav" },
    });
    expect(res2.url).toBeNull();
    const after = await t.run(async (ctx) => await ctx.db.get(assistant._id));
    expect(after!.audio).toEqual(audio);

    // Descarte com a org errada não apaga nada.
    expect(await t.mutation(internal.voiceReply.internalDiscardWebAudioFile, { organizationId: s.otherOrgId, fileId: audio.fileId })).toBe(false);
    expect(await t.run(async (ctx) => await ctx.db.get(audio.fileId))).not.toBeNull();
    // Descarte nunca apaga anexo que não é áudio do onboarding.
    const userAudio = st.files.find((f) => f.name === "voz.webm")!;
    expect(await t.mutation(internal.voiceReply.internalDiscardWebAudioFile, { organizationId: s.organizationId, fileId: userAudio._id })).toBe(false);
  });

  test("retenção: áudio vencido some (blob, linha de files, campo); o texto fica", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubNet();
    const r = await audioTurn(t, s);
    expect(r.ok).toBe(true);
    const st = await state(t, s.organizationId);
    const assistant = st.messages.find((m) => m.role === "assistant")!;
    const { fileId, storageId } = assistant.audio!;
    // Ainda dentro da janela: nada sai.
    expect(await t.mutation(internal.onboardingChat.internalExpireOnboardingAudio, {})).toBe(0);
    await t.run(async (ctx) => ctx.db.patch(assistant._id, { audioExpiresAt: Date.now() - 1 }));
    expect(await t.mutation(internal.onboardingChat.internalExpireOnboardingAudio, {})).toBe(1);
    const after = await t.run(async (ctx) => ({
      msg: await ctx.db.get(assistant._id),
      file: await ctx.db.get(fileId),
      blobGone: (await ctx.storage.get(storageId)) === null,
    }));
    expect(after.msg!.audio).toBeUndefined();
    expect(after.msg!.audioExpiresAt).toBeUndefined();
    expect(after.msg!.text.length).toBeGreaterThan(0);
    expect(after.file).toBeNull();
    expect(after.blobGone).toBe(true);
  });
});
