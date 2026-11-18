/// <reference types="vite/client" />
/**
 * Teste da resposta em áudio nas Configurações: "Ouvir amostra"
 * (`voiceReply.previewVoiceSample`) e o simulador com voz
 * (`attendant.simulateAttendant` com `voice:true`). Mesma porta de TTS do
 * atendente (OpenRouter `/audio/speech`, simulado por URL), WAV de vida curta,
 * nada no CRM (sem mensagem, conversa, lead), limite por usuário e cache.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { VOICE_PREVIEW_TTL_MS, VOICE_SAMPLE_GREETING, type SimulatedVoice } from "./lib/voicePreview";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 18, 15, 0));
  vi.stubEnv("OPENROUTER_API_KEY", "sk-test-openrouter-fake-000");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function fakePcm(seconds: number): Uint8Array {
  const samples = Math.round(seconds * 24_000);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, ((i % 200) - 100) * 150, true);
  return out;
}

function stubNetwork(opts: { llmText?: string; tts?: () => Response } = {}) {
  const fetchMock = vi.fn(async (input: unknown, _init?: unknown) => {
    const url = String(input);
    if (url.includes("/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: opts.llmText ?? "Oi! Posso te ajudar com o horário." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 500, completion_tokens: 40 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/audio/speech")) {
      return opts.tts
        ? opts.tts()
        : new Response(fakePcm(2), { status: 200, headers: { "Content-Type": "audio/pcm;rate=24000;channels=1" } });
    }
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, fragment: string) {
  return (fetchMock.mock.calls as Array<[unknown, RequestInit | undefined]>).filter(([u]) => String(u).includes(fragment));
}
const ttsBodies = (fetchMock: ReturnType<typeof vi.fn>) =>
  callsTo(fetchMock, "/audio/speech").map(([, init]) => JSON.parse(String(init!.body)));

type SeedOpts = {
  aiActive?: boolean;
  strictZdr?: boolean;
  byo?: boolean;
  voiceOn?: boolean;
  notice?: string;
  role?: "admin" | "agent";
};

async function seed(t: T, opts: SeedOpts = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", { email: "admin@voz.example" });
    const organizationId = await ctx.db.insert("organizations", {
      name: "Clínica Voz",
      slug: "clinica-voz",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: {
          enabled: opts.aiActive !== false,
          autoAssign: false,
          handoffThreshold: 0.8,
          ...(opts.voiceOn ? { voiceReplyEnabled: true } : {}),
          voiceReplyVoice: "Puck",
          ...(opts.notice ? { voiceReplyNotice: opts.notice } : {}),
          ...(opts.strictZdr || opts.byo
            ? {
                providerConfig: {
                  mode: opts.byo ? ("byo" as const) : ("platform" as const),
                  zdr: true,
                  strictZdr: opts.strictZdr === true,
                  models: { copilot: "kimi-k2.7-code", attendant: "deepseek-v4-flash", classify: "deepseek-v4-flash" },
                },
              }
            : {}),
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Admin",
      role: opts.role ?? "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: memberId } } },
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Marina (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: { kind: "attendant", mode: "autopilot", disclosureMode: "on_demand" },
      createdAt: now,
      updatedAt: now,
    });
    return { userId, organizationId, memberId, agentId };
  });
}

const asUser = (t: T, s: { userId: unknown }) => t.withIdentity({ subject: `${String(s.userId)}|s1` });

async function crmCounts(t: T) {
  return await t.run(async (ctx) => ({
    messages: (await ctx.db.query("messages").collect()).length,
    conversations: (await ctx.db.query("conversations").collect()).length,
    leads: (await ctx.db.query("leads").collect()).length,
  }));
}

describe("Ouvir amostra (previewVoiceSample)", () => {
  test("fala aviso + saudação com a voz escolhida, pela porta do atendente, e registra o custo", async () => {
    const fetchMock = stubNetwork();
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const result = await asUser(t, s).action(api.voiceReply.previewVoiceSample, {
      organizationId: s.organizationId,
      voice: "Charon",
      notice: "  Sou a assistente   do Kenji ",
    });
    expect(result).toMatchObject({ ok: true, cached: false });
    if (!result.ok) throw new Error("esperava ok");
    expect(result.url).toMatch(/^https?:/);
    expect(result.durationSec).toBeCloseTo(2, 0);

    const [body] = ttsBodies(fetchMock);
    expect(body.voice).toBe("Charon");
    expect(body.response_format).toBe("pcm");
    expect(body.input).toBe(`Sou a assistente do Kenji. ${VOICE_SAMPLE_GREETING}`);
    expect(body.provider).toMatchObject({ data_collection: "deny" });
    // Teste não passa pelo conversor da VPS nem toca o CRM.
    expect(callsTo(fetchMock, "/convert")).toHaveLength(0);
    expect(await crmCounts(t)).toEqual({ messages: 0, conversations: 0, leads: 0 });

    await t.run(async (ctx) => {
      const files = await ctx.db.query("files").collect();
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ fileType: "other", mimeType: "audio/wav", uploadedBy: s.memberId });
      expect(files[0].metadata?.kind).toBe("voice_preview");
      expect(files[0].messageId).toBeUndefined();
      const runs = await ctx.db.query("agentRuns").collect();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ kind: "tts", status: "done", memberId: s.memberId });
      expect(runs[0].conversationId).toBeUndefined();
      expect(runs[0].costUsdEstimate).toBeGreaterThan(0);
    });
  });

  test("sem aviso: só a saudação; o mesmo texto + voz de novo sai do cache (sem pagar)", async () => {
    const fetchMock = stubNetwork();
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const args = { organizationId: s.organizationId, voice: "Kore" };
    const first = await asUser(t, s).action(api.voiceReply.previewVoiceSample, args);
    const second = await asUser(t, s).action(api.voiceReply.previewVoiceSample, { ...args, notice: "" });
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(ttsBodies(fetchMock).map((b) => b.input)).toEqual([VOICE_SAMPLE_GREETING]);
    // Outra voz = outro áudio.
    await asUser(t, s).action(api.voiceReply.previewVoiceSample, { ...args, voice: "Puck" });
    expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(2);
  });

  test("aviso com número/link/valor: recusa com a mesma mensagem do salvar, sem chamar o TTS", async () => {
    const fetchMock = stubNetwork();
    const t = convexTest(schema, modules);
    const s = await seed(t);
    for (const notice of ["Ligue 11 99999-0000", "Veja hnbcrm.com", "Consulta por R$ 50"]) {
      const result = await asUser(t, s).action(api.voiceReply.previewVoiceSample, {
        organizationId: s.organizationId,
        voice: "Kore",
        notice,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.message).toMatch(/não pode ter números, links/);
    }
    const tooLong = await asUser(t, s).action(api.voiceReply.previewVoiceSample, {
      organizationId: s.organizationId,
      voice: "Kore",
      notice: "a".repeat(201),
    });
    expect(tooLong).toMatchObject({ ok: false, message: expect.stringMatching(/até 200 caracteres/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("limite por usuário: 6 por minuto; recusa não paga e a janela vira", async () => {
    const fetchMock = stubNetwork();
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const voices = ["Kore", "Puck", "Charon", "Fenrir", "Leda", "Orus", "Aoede"];
    const results = [];
    for (const voice of voices) {
      results.push(await asUser(t, s).action(api.voiceReply.previewVoiceSample, { organizationId: s.organizationId, voice }));
    }
    expect(results.slice(0, 6).every((r) => r.ok)).toBe(true);
    expect(results[6]).toMatchObject({ ok: false, message: expect.stringMatching(/Muitos testes de voz/) });
    expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(6);
    // O cache continua valendo mesmo com a janela cheia.
    expect(await asUser(t, s).action(api.voiceReply.previewVoiceSample, { organizationId: s.organizationId, voice: "Kore" })).toMatchObject({
      ok: true,
      cached: true,
    });
    vi.setSystemTime(Date.now() + 61_000);
    expect(
      await asUser(t, s).action(api.voiceReply.previewVoiceSample, { organizationId: s.organizationId, voice: "Aoede" }),
    ).toMatchObject({ ok: true });
  });

  test("recusas: IA inativa, privacidade rígida, chave própria e voz fora do catálogo", async () => {
    const cases: Array<[SeedOpts, string, RegExp]> = [
      [{ aiActive: false }, "Kore", /Ative a IA/],
      [{ strictZdr: true }, "Kore", /privacidade rígida/],
      [{ byo: true }, "Kore", /chave de IA própria/],
      [{}, "VozInventada", /Voz desconhecida/],
    ];
    for (const [opts, voice, re] of cases) {
      const fetchMock = stubNetwork();
      const t = convexTest(schema, modules);
      const s = await seed(t, opts);
      const result = await asUser(t, s).action(api.voiceReply.previewVoiceSample, { organizationId: s.organizationId, voice });
      expect(result).toMatchObject({ ok: false, message: expect.stringMatching(re) });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  test("RBAC: sem login ou sem acesso às configurações não sintetiza", async () => {
    const fetchMock = stubNetwork();
    const t = convexTest(schema, modules);
    const s = await seed(t, { role: "agent" });
    await expect(
      t.action(api.voiceReply.previewVoiceSample, { organizationId: s.organizationId, voice: "Kore" }),
    ).rejects.toThrow();
    await expect(
      asUser(t, s).action(api.voiceReply.previewVoiceSample, { organizationId: s.organizationId, voice: "Kore" }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("falha do provedor: mensagem em PT-BR, sem arquivo, run de erro sem custo", async () => {
    stubNetwork({ tts: () => new Response("boom", { status: 502 }) });
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const result = await asUser(t, s).action(api.voiceReply.previewVoiceSample, { organizationId: s.organizationId, voice: "Kore" });
    expect(result).toMatchObject({ ok: false, reason: "falha_tts", message: expect.stringMatching(/Não foi possível gerar/) });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("files").collect()).toHaveLength(0);
      const [run] = await ctx.db.query("agentRuns").collect();
      expect(run).toMatchObject({ kind: "tts", status: "error" });
      expect(run.costUsdEstimate ?? 0).toBe(0);
    });
  });

  test("o WAV de teste se apaga sozinho depois do prazo", async () => {
    stubNetwork();
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await asUser(t, s).action(api.voiceReply.previewVoiceSample, { organizationId: s.organizationId, voice: "Kore" });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("files").collect()).toHaveLength(1);
    });
    await t.run(async (ctx) => {
      const [job] = await ctx.db.system.query("_scheduled_functions").collect();
      expect(job.name).toContain("internalDiscardVoicePreview");
      expect(job.scheduledTime - Date.now()).toBe(VOICE_PREVIEW_TTL_MS);
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("files").collect()).toHaveLength(0);
    });
  });
});

describe("Simulador com voz (simulateAttendant voice:true)", () => {
  const simulate = async (
    t: T,
    s: Awaited<ReturnType<typeof seed>>,
    customer: { content: string; audio?: boolean },
    extra: Record<string, unknown> = {},
  ) =>
    (await asUser(t, s).action(api.attendant.simulateAttendant, {
      organizationId: s.organizationId,
      agentMemberId: s.agentId,
      transcript: [{ role: "customer" as const, ...customer }],
      transport: "bridge",
      voice: true,
      ...extra,
    })) as { error: string | null; reply: string | null; voice?: SimulatedVoice };

  test("cliente mandou áudio: resposta em áudio com a voz e o aviso da org, sem tocar o CRM", async () => {
    const fetchMock = stubNetwork({ llmText: "Oi! Tenho horário amanhã às 15h, quer marcar?" });
    const t = convexTest(schema, modules);
    const s = await seed(t, { voiceOn: true, notice: "Sou a assistente da clínica" });
    const result = await simulate(t, s, { content: "Oi, tem horário amanhã?", audio: true });
    expect(result.error).toBeNull();
    expect(result.voice).toMatchObject({ mode: "audio", voice: "Puck", noticeIncluded: true, enabledInOrg: true, textAfter: null });
    if (result.voice?.mode !== "audio") throw new Error("esperava áudio");
    expect(result.voice.spokenText).toMatch(/^Sou a assistente da clínica\n\nOi! Tenho horário amanhã às 15h/);
    const [body] = ttsBodies(fetchMock);
    expect(body.voice).toBe("Puck");
    expect(body.input).toMatch(/^Sou a assistente da clínica\. Oi! Tenho horário amanhã às 15h/);
    expect(await crmCounts(t)).toEqual({ messages: 0, conversations: 0, leads: 0 });
  });

  test("valor/Pix vai por escrito depois do áudio; a parte falada não leva o dado", async () => {
    const fetchMock = stubNetwork({ llmText: "Claro, posso te ajudar com isso.\nA consulta custa R$ 250,00." });
    const t = convexTest(schema, modules);
    const s = await seed(t, { voiceOn: true });
    const result = await simulate(t, s, { content: "Quanto custa?", audio: true });
    expect(result.voice).toMatchObject({ mode: "audio", textAfter: "A consulta custa R$ 250,00." });
    expect(ttsBodies(fetchMock)[0].input).not.toMatch(/250/);
  });

  test("a regra manda texto: cliente escreveu, grupo, resposta longa ou só dado — sem TTS", async () => {
    const cases: Array<[string, { content: string; audio?: boolean }, Record<string, unknown>, string]> = [
      ["Oi! Posso te ajudar.", { content: "Oi" }, {}, "cliente_mandou_texto"],
      ["Oi! Posso te ajudar.", { content: "Oi", audio: true }, { group: { subject: "Clientes" } }, "grupo"],
      [`${"Esta é uma explicação bem detalhada sobre o atendimento. ".repeat(14)}`, { content: "Explica", audio: true }, {}, "longo"],
      ["Pix: chave 12345678900\nhttps://pagar.example.com/x", { content: "Pix?", audio: true }, {}, "dado_sensivel"],
      ["Oi! Posso te ajudar.", { content: "Oi", audio: true }, { transport: "instagram" }, "canal"],
    ];
    for (const [llmText, customer, extra, reason] of cases) {
      const fetchMock = stubNetwork({ llmText });
      const t = convexTest(schema, modules);
      const s = await seed(t, { voiceOn: true });
      const result = await simulate(t, s, customer, extra);
      expect(result.voice).toMatchObject({ mode: "text", rule: true, reason });
      if (result.voice?.mode === "text") expect(result.voice.message.length).toBeGreaterThan(10);
      expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(0);
    }
  });

  test("voz desligada na org: o teste ainda fala, mas avisa que em produção iria texto", async () => {
    stubNetwork();
    const t = convexTest(schema, modules);
    const s = await seed(t, { voiceOn: false });
    const result = await simulate(t, s, { content: "Oi", audio: true });
    expect(result.voice).toMatchObject({ mode: "audio", enabledInOrg: false });
  });

  test("sem `voice`: o simulador segue só texto (nenhum TTS, campo ausente)", async () => {
    const fetchMock = stubNetwork();
    const t = convexTest(schema, modules);
    const s = await seed(t, { voiceOn: true });
    const result = await simulate(t, s, { content: "Oi", audio: true }, { voice: undefined });
    expect(result.voice).toBeUndefined();
    expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(0);
  });
});
