/// <reference types="vite/client" />
/**
 * Resposta em áudio do atendente (onboarding v2, P4.1), ponta a ponta no
 * runtime: claim → modelo (mock) → output guard → regras (`planVoiceReply`) →
 * TTS (mock do OpenRouter) → `/convert` (mock da VPS) → commit → mensagem com
 * texto + anexo ogg. Nada real é chamado: o `fetch` global responde por URL.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const WHISPER_URL = "https://whisper.example.com";
const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 1, 2, 3, 4]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENROUTER_API_KEY", "sk-test-openrouter-fake-000");
  vi.stubEnv("WHISPER_SERVICE_URL", WHISPER_URL);
  vi.stubEnv("WHISPER_SERVICE_TOKEN", "fake-whisper-token");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type VoiceOrgOpts = {
  voice?: boolean | "absent";
  voiceName?: string;
  notice?: string;
  mode?: "suggest" | "autopilot";
  strictZdr?: boolean;
  language?: string;
  disclosureFirstReply?: boolean;
};

async function seedOrg(t: TestConvex<typeof schema>, opts: VoiceOrgOpts = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Clínica Voz",
      slug: "clinica-voz",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 0.8,
          ...(opts.voice === "absent" ? {} : { voiceReplyEnabled: opts.voice ?? true }),
          ...(opts.voiceName ? { voiceReplyVoice: opts.voiceName } : {}),
          ...(opts.notice ? { voiceReplyNotice: opts.notice } : {}),
          ...(opts.strictZdr
            ? {
                providerConfig: {
                  mode: "platform" as const,
                  zdr: true,
                  strictZdr: true,
                  models: { copilot: "kimi-k2.7-code", attendant: "deepseek-v4-flash", classify: "deepseek-v4-flash" },
                },
              }
            : {}),
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "admin@voz.example" });
    const humanId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Marina (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: {
        kind: "attendant",
        mode: opts.mode ?? "autopilot",
        disclosureMode: opts.disclosureFirstReply ? "first_reply" : "on_demand",
        ...(opts.language ? { language: opts.language } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...org.settings.aiConfig!,
          lgpdAck: { acceptedAt: now, acceptedBy: humanId },
          // Voz só no bridge (até a validação viva na Meta): canal bridge com aceite.
          bridgeAiAck: { acceptedAt: now, acceptedBy: humanId },
        },
      },
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "Número principal",
      bridgeBaseUrl: "https://bridge.example.com",
      bridgeInstanceId: "org_fake_instance",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Vendas",
      color: "#6366f1",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "Novo",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "Cliente",
      phone: "5511900001111",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId,
      title: "Cliente WhatsApp",
      contactId,
      boardId,
      stageId,
      assignedTo: agentId,
      value: 0,
      currency: "BRL",
      priority: "medium",
      temperature: "warm",
      tags: [],
      customFields: {},
      conversationStatus: "active",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      leadId,
      channel: "whatsapp",
      channelConfigId: configId,
      status: "active",
      lastInboundAt: now,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, userId, humanId, agentId, leadId, conversationId };
  });
}

type Seed = Awaited<ReturnType<typeof seedOrg>>;

/** Inbound do cliente (áudio já transcrito ou texto) + item da fila pronto. */
async function enqueueInbound(t: TestConvex<typeof schema>, seed: Seed, kind: "audio" | "text") {
  const messageId = await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(seed.conversationId, { lastInboundAt: now });
    return await ctx.db.insert("messages", {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      leadId: seed.leadId,
      direction: "inbound",
      senderType: "contact",
      content: kind === "audio" ? "[mensagem de voz]" : "Oi, tem horário amanhã?",
      contentType: kind,
      isInternal: false,
      ...(kind === "audio"
        ? {
            transcriptText: "Oi, tem horário amanhã?",
            metadata: {
              transcription: { status: "done", text: "Oi, tem horário amanhã?", engine: "faster-whisper", at: now },
            },
          }
        : {}),
      createdAt: now,
    });
  });
  await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
  const item = await t.run(async (ctx) =>
    (await ctx.db.query("aiReplyQueue").collect()).find((i) => i.status === "pending")
  );
  expect(item).toBeTruthy();
  await t.run(async (ctx) => {
    await ctx.db.patch(item!._id, { nextAttemptAt: Date.now() - 1_000 });
  });
  return item!._id;
}

/** PCM s16le 24 kHz mono com `seconds` de "fala" (onda dente de serra). */
function fakePcm(seconds: number): Uint8Array {
  const samples = Math.round(seconds * 24_000);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, ((i % 200) - 100) * 150, true);
  return out;
}

type ReplyTurn = { tools: Array<{ name: string; args: Record<string, unknown> }> } | { text: string };

function llmResponse(turn: ReplyTurn, index: number): Response {
  const message =
    "tools" in turn
      ? {
          role: "assistant",
          content: null,
          tool_calls: turn.tools.map((tc, i) => ({
            id: `call_${index}_${i}`,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        }
      : { role: "assistant", content: turn.text };
  return new Response(
    JSON.stringify({
      choices: [{ message, finish_reason: "tools" in turn ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function stubNetwork(opts: {
  llm: ReplyTurn[];
  tts?: () => Response;
  convert?: () => Response;
  ttsSeconds?: number;
}) {
  let llmCall = 0;
  const fetchMock = vi.fn(async (input: unknown, _init?: unknown) => {
    const url = String(input);
    if (url.includes("/chat/completions")) {
      const turn = opts.llm[Math.min(llmCall, opts.llm.length - 1)];
      return llmResponse(turn, llmCall++);
    }
    if (url.includes("/audio/speech")) {
      return opts.tts
        ? opts.tts()
        : new Response(fakePcm(opts.ttsSeconds ?? 2), {
            status: 200,
            headers: { "Content-Type": "audio/pcm;rate=24000;channels=1" },
          });
    }
    if (url.includes("/convert")) {
      return opts.convert ? opts.convert() : new Response(OGG_BYTES, { status: 200 });
    }
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function reply(text: string): ReplyTurn {
  return { tools: [{ name: "replyToCustomer", args: { text } }] };
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, fragment: string) {
  return (fetchMock.mock.calls as Array<[unknown, RequestInit | undefined]>).filter(([u]) => String(u).includes(fragment));
}

function ttsBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return callsTo(fetchMock, "/audio/speech").map(([, init]) => JSON.parse(String(init!.body)));
}

async function outbound(t: TestConvex<typeof schema>, seed: Seed) {
  return await t.run(async (ctx) =>
    (
      await ctx.db
        .query("messages")
        .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", seed.conversationId))
        .collect()
    ).filter((m) => m.direction === "outbound")
  );
}

async function ttsRuns(t: TestConvex<typeof schema>, seed: Seed) {
  return await t.run(async (ctx) =>
    (
      await ctx.db.query("agentRuns").collect()
    ).filter((r) => r.kind === "tts" && r.organizationId === seed.organizationId)
  );
}

const PLAIN_REPLY = "Tenho sim! Amanhã às dez ou às quatorze horas. Qual prefere?";

describe("resposta em áudio no runtime do atendente", () => {
  test("cliente mandou áudio → mensagem de áudio com o texto, ogg anexado e custo medido", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    const itemId = await enqueueInbound(t, seed, "audio");
    const fetchMock = stubNetwork({ llm: [reply(PLAIN_REPLY)], ttsSeconds: 2 });

    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });

    // TTS: modelo e voz padrão, PCM, trava de retenção, texto falável.
    const [body] = ttsBodies(fetchMock);
    expect(body).toMatchObject({
      model: "google/gemini-3.8-flash-tts",
      voice: "Kore",
      response_format: "pcm",
      input: PLAIN_REPLY,
      provider: { data_collection: "deny" },
    });
    const ttsHeaders = callsTo(fetchMock, "/audio/speech")[0][1]!.headers as Record<string, string>;
    expect(ttsHeaders.Authorization).toBe("Bearer sk-test-openrouter-fake-000");

    // Conversor da VPS recebe WAV (RIFF) e o token do serviço.
    const [convertUrl, convertInit] = callsTo(fetchMock, "/convert")[0];
    expect(String(convertUrl)).toBe(`${WHISPER_URL}/convert?target=ogg-opus`);
    const file = (convertInit!.body as FormData).get("file") as File;
    const head = new Uint8Array(await file.arrayBuffer()).subarray(0, 12);
    expect(String.fromCharCode(...head.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...head.subarray(8, 12))).toBe("WAVE");

    const msgs = await outbound(t, seed);
    expect(msgs).toHaveLength(1);
    const msg = msgs[0];
    expect(msg.contentType).toBe("audio");
    expect(msg.content).toBe(PLAIN_REPLY);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.metadata?.voiceNote.seconds).toBe(2);
    expect(msg.metadata?.voiceNote.waveform).toHaveLength(64);
    expect(msg.metadata?.voiceReply).toEqual({ mode: "audio" });
    const stored = await t.run(async (ctx) => {
      const f = await ctx.db.get(msg.attachments![0]);
      const blob = f ? await ctx.storage.get(f.storageId) : null;
      return { f, bytes: blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : null };
    });
    expect(stored.f!.mimeType).toBe("audio/ogg");
    expect(stored.f!.messageId).toBe(msg._id);
    expect(stored.bytes).toEqual(Array.from(OGG_BYTES));

    // Custo: run `tts` + medidor mensal pela porta única.
    const runs = await ttsRuns(t, seed);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("done");
    expect(runs[0].costUsdEstimate).toBeGreaterThan(0);
    expect(runs[0].completionTokens).toBe(50); // 2 s × 25 tokens/s
    const usage = await t.run(async (ctx) =>
      (await ctx.db.query("aiUsageMonthly").collect()).find((u) => u.organizationId === seed.organizationId)
    );
    expect(usage!.byKind.tts.runs).toBe(1);
    expect(usage!.byKind.tts.costUsdMicros).toBeGreaterThan(0);
  });

  test("cliente mandou texto → resposta em texto, sem TTS", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    const itemId = await enqueueInbound(t, seed, "text");
    const fetchMock = stubNetwork({ llm: [reply(PLAIN_REPLY)] });

    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });

    expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(0);
    const [msg] = await outbound(t, seed);
    expect(msg.contentType).toBe("text");
    expect(msg.attachments).toBeUndefined();
    expect(msg.metadata?.voiceReply).toEqual({ mode: "text", reason: "cliente_mandou_texto" });
  });

  test("voz desligada ou ausente na org → nunca áudio, nem rastro", async () => {
    for (const voice of [false, "absent"] as const) {
      const t = convexTest(schema, modules);
      const seed = await seedOrg(t, { voice });
      const itemId = await enqueueInbound(t, seed, "audio");
      const fetchMock = stubNetwork({ llm: [reply(PLAIN_REPLY)] });
      await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
      expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(0);
      const [msg] = await outbound(t, seed);
      expect(msg.contentType).toBe("text");
      expect(msg.metadata?.voiceReply).toBeUndefined();
    }
  });

  test("modo sugestão (rascunho) nunca sintetiza", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t, { mode: "suggest" });
    const itemId = await enqueueInbound(t, seed, "audio");
    const fetchMock = stubNetwork({ llm: [reply(PLAIN_REPLY)] });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(0);
  });

  test("Pix + link: fala o resto e manda os dados em texto logo depois", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    const itemId = await enqueueInbound(t, seed, "audio");
    const text = [
      "Combinado, reservei amanhã às dez para você.",
      "O Pix é a chave pagamentos@clinica.example.",
      "Qualquer coisa me chama por aqui.",
    ].join("\n");
    const fetchMock = stubNetwork({ llm: [reply(text)] });

    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });

    const [body] = ttsBodies(fetchMock);
    expect(body.input).not.toMatch(/pix|@/i);
    expect(body.input).toContain("reservei amanhã");
    const msgs = await outbound(t, seed);
    expect(msgs).toHaveLength(2);
    const [audio, data] = msgs.sort((a, b) => a.createdAt - b.createdAt);
    expect(audio.contentType).toBe("audio");
    expect(audio.content).not.toContain("pagamentos@");
    expect(audio.metadata?.voiceReply).toEqual({ mode: "audio", split: true });
    expect(data.contentType).toBe("text");
    expect(data.content).toContain("pagamentos@clinica.example");
    expect(data.metadata?.voiceReply).toMatchObject({ mode: "text", reason: "dado_em_texto", audioMessageId: audio._id });
  });

  test("resposta só de valor/link → tudo em texto (dado_sensivel), sem TTS", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    const itemId = await enqueueInbound(t, seed, "audio");
    const fetchMock = stubNetwork({ llm: [reply("A consulta custa R$ 250,00: https://pagar.example.com/x")] });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(0);
    const msgs = await outbound(t, seed);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].contentType).toBe("text");
    expect(msgs[0].metadata?.voiceReply).toEqual({ mode: "text", reason: "dado_sensivel" });
  });

  test("texto longo → texto", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    const itemId = await enqueueInbound(t, seed, "audio");
    const long = "Posso te explicar com calma como funciona o atendimento aqui na clínica. ".repeat(12);
    const fetchMock = stubNetwork({ llm: [reply(long)] });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(0);
    const [msg] = await outbound(t, seed);
    expect(msg.metadata?.voiceReply).toEqual({ mode: "text", reason: "longo" });
  });

  test("TTS falhou → texto (nunca silêncio); run de erro sem custo", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    const itemId = await enqueueInbound(t, seed, "audio");
    const fetchMock = stubNetwork({ llm: [reply(PLAIN_REPLY)], tts: () => new Response("boom", { status: 502 }) });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    expect(callsTo(fetchMock, "/convert")).toHaveLength(0);
    const [msg] = await outbound(t, seed);
    expect(msg.contentType).toBe("text");
    expect(msg.content).toBe(PLAIN_REPLY);
    expect(msg.metadata?.voiceReply).toEqual({ mode: "text", reason: "falha_tts" });
    const [run] = await ttsRuns(t, seed);
    expect(run.status).toBe("error");
    expect(run.costUsdEstimate ?? 0).toBe(0);
  });

  test("conversão falhou → texto; o áudio gerado entra no custo e nada fica no storage", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    const itemId = await enqueueInbound(t, seed, "audio");
    stubNetwork({ llm: [reply(PLAIN_REPLY)], convert: () => new Response("erro", { status: 500 }) });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const [msg] = await outbound(t, seed);
    expect(msg.contentType).toBe("text");
    expect(msg.metadata?.voiceReply).toEqual({ mode: "text", reason: "falha_conversao" });
    const [run] = await ttsRuns(t, seed);
    expect(run.status).toBe("done");
    expect(run.costUsdEstimate).toBeGreaterThan(0);
    const files = await t.run(async (ctx) =>
      (await ctx.db.query("files").collect()).filter((f) => f.organizationId === seed.organizationId)
    );
    expect(files).toHaveLength(0);
  });

  test("sem conversor configurado → texto sem pagar o TTS", async () => {
    vi.stubEnv("WHISPER_SERVICE_URL", "");
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    const itemId = await enqueueInbound(t, seed, "audio");
    const fetchMock = stubNetwork({ llm: [reply(PLAIN_REPLY)] });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(0);
    const [msg] = await outbound(t, seed);
    expect(msg.metadata?.voiceReply).toEqual({ mode: "text", reason: "sem_conversor" });
    expect(await ttsRuns(t, seed)).toHaveLength(0);
  });

  test("áudio gerado longo demais → texto", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    const itemId = await enqueueInbound(t, seed, "audio");
    const fetchMock = stubNetwork({ llm: [reply(PLAIN_REPLY)], ttsSeconds: 50 });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    expect(callsTo(fetchMock, "/convert")).toHaveLength(0);
    const [msg] = await outbound(t, seed);
    expect(msg.metadata?.voiceReply).toEqual({ mode: "text", reason: "audio_longo" });
  });

  test("output guard roda ANTES do TTS: a rodada vazada é descartada e só o texto limpo é sintetizado", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    const itemId = await enqueueInbound(t, seed, "audio");
    const leaked = "Claro! <tool_call>{\"name\":\"consultarAgenda\"}</tool_call>";
    const fetchMock = stubNetwork({ llm: [reply(leaked), reply(PLAIN_REPLY)] });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const bodies = ttsBodies(fetchMock);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].input).toBe(PLAIN_REPLY);
    expect(bodies[0].input).not.toContain("tool_call");
  });

  test("voz escolhida pela org e aviso de voz sintética só no primeiro áudio", async () => {
    const t = convexTest(schema, modules);
    const notice = "Esta resposta usa voz gerada por inteligência artificial.";
    const seed = await seedOrg(t, { voiceName: "Puck", notice });
    const first = await enqueueInbound(t, seed, "audio");
    const fetchMock = stubNetwork({ llm: [reply(PLAIN_REPLY)] });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: first });

    const [b1] = ttsBodies(fetchMock);
    expect(b1.voice).toBe("Puck");
    expect(b1.input.startsWith(notice)).toBe(true);
    const conv = await t.run(async (ctx) => ctx.db.get(seed.conversationId));
    expect(conv!.aiVoiceNoticeAt).toBeTypeOf("number");
    const [m1] = await outbound(t, seed);
    expect(m1.content.startsWith(notice)).toBe(true);
    expect(m1.metadata?.voiceReply).toEqual({ mode: "audio", notice: true });

    vi.setSystemTime(Date.now() + 60_000);
    const second = await enqueueInbound(t, seed, "audio");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: second });
    const bodies = ttsBodies(fetchMock);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].input).toBe(PLAIN_REPLY);
  });

  test("o histórico seguinte do atendente lê a resposta em áudio como texto", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    const first = await enqueueInbound(t, seed, "audio");
    stubNetwork({ llm: [reply(PLAIN_REPLY)] });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: first });
    vi.setSystemTime(Date.now() + 60_000);
    const second = await enqueueInbound(t, seed, "text");
    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: second,
      runId: "run-historico",
    });
    if (claim.kind !== "run") throw new Error("esperava run");
    const texts = (claim.context.history as Array<{ texto: string }>).map((h) => h.texto);
    expect(texts).toContain(`[resposta em áudio]: ${PLAIN_REPLY}`);
    expect(claim.context.voiceReply?.lastInboundWasAudio).toBe(false);
  });
});

describe("travas da revisão do P4.1", () => {
  test("org com strictZdr → texto (zdr_nao_validado), sem chamar o TTS", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t, { strictZdr: true });
    const itemId = await enqueueInbound(t, seed, "audio");
    const fetchMock = stubNetwork({ llm: [reply(PLAIN_REPLY)] });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(0);
    const [msg] = await outbound(t, seed);
    expect(msg.contentType).toBe("text");
    expect(msg.metadata?.voiceReply).toEqual({ mode: "text", reason: "zdr_nao_validado" });
  });

  test("atendente em outro idioma → texto (idioma)", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t, { language: "en" });
    const itemId = await enqueueInbound(t, seed, "audio");
    const fetchMock = stubNetwork({ llm: [reply("Sure! Tomorrow at ten works. Shall I book it?")] });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(0);
    const [msg] = await outbound(t, seed);
    expect(msg.metadata?.voiceReply).toEqual({ mode: "text", reason: "idioma" });
  });

  test("divulgação de IA na primeira resposta: falada E por escrito", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t, { disclosureFirstReply: true });
    const itemId = await enqueueInbound(t, seed, "audio");
    const fetchMock = stubNetwork({ llm: [reply(PLAIN_REPLY)] });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const [body] = ttsBodies(fetchMock);
    expect(body.input).toContain("assistente virtual");
    const msgs = (await outbound(t, seed)).sort((a, b) => a.createdAt - b.createdAt);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].contentType).toBe("audio");
    expect(msgs[1].contentType).toBe("text");
    expect(msgs[1].content).toContain("assistente virtual");
    // Nada duplicado no áudio: a divulgação aparece uma vez no texto falado.
    expect(msgs[0].content.split("assistente virtual").length).toBe(2);
  });

  test("Cloud API (Meta) fica no texto até a validação viva", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    await t.run(async (ctx) => {
      const conv = (await ctx.db.get(seed.conversationId))!;
      await ctx.db.patch(conv.channelConfigId!, { provider: "meta", phoneNumberId: "555000333" });
    });
    const itemId = await enqueueInbound(t, seed, "audio");
    const fetchMock = stubNetwork({ llm: [reply(PLAIN_REPLY)] });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    expect(callsTo(fetchMock, "/audio/speech")).toHaveLength(0);
    const [msg] = await outbound(t, seed);
    expect(msg.metadata?.voiceReply).toEqual({ mode: "text", reason: "canal" });
  });
});

describe("configuração (aiSettings.setFeatureToggles + voiceReply.getVoiceReplySettings)", () => {
  test("liga, escolhe voz e aviso; voz fora do catálogo é recusada; aviso vazio remove; tudo auditado", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t, { voice: "absent" });
    const asAdmin = t.withIdentity({ subject: `${seed.userId}|s1` });

    const before = await asAdmin.query(api.voiceReply.getVoiceReplySettings, { organizationId: seed.organizationId });
    expect(before).toMatchObject({ enabled: false, voice: "Kore", notice: null, aiActive: true, platformReady: true });
    expect(before!.voices).toContain("Puck");

    await asAdmin.mutation(api.aiSettings.setFeatureToggles, {
      organizationId: seed.organizationId,
      voiceReplyEnabled: true,
      voiceReplyVoice: "Puck",
      voiceReplyNotice: "  Voz gerada por IA.  ",
    });
    const after = await asAdmin.query(api.voiceReply.getVoiceReplySettings, { organizationId: seed.organizationId });
    expect(after).toMatchObject({ enabled: true, voice: "Puck", notice: "Voz gerada por IA." });

    await expect(
      asAdmin.mutation(api.aiSettings.setFeatureToggles, {
        organizationId: seed.organizationId,
        voiceReplyVoice: "voz-clonada-do-dono",
      })
    ).rejects.toThrow(/Voz desconhecida/);
    await expect(
      asAdmin.mutation(api.aiSettings.setFeatureToggles, {
        organizationId: seed.organizationId,
        voiceReplyNotice: "x".repeat(201),
      })
    ).rejects.toThrow(/até 200/);

    // O aviso é falado: dado (número, link, e-mail…) é recusado.
    await expect(
      asAdmin.mutation(api.aiSettings.setFeatureToggles, {
        organizationId: seed.organizationId,
        voiceReplyNotice: "Voz gerada por IA. Dúvidas: www.clinica.example",
      })
    ).rejects.toThrow(/não pode ter números, links/);

    await asAdmin.mutation(api.aiSettings.setFeatureToggles, {
      organizationId: seed.organizationId,
      voiceReplyNotice: "",
    });
    const cleared = await t.run(async (ctx) => (await ctx.db.get(seed.organizationId))!.settings.aiConfig!);
    expect(cleared.voiceReplyNotice).toBeUndefined();
    expect(cleared.voiceReplyVoice).toBe("Puck");

    const audits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).filter(
        (a) => a.organizationId === seed.organizationId && a.metadata?.aiConfig === true
      )
    );
    expect(audits).toHaveLength(2);
    expect(audits[0].metadata?.via).toBe("settings");
    expect(audits[0].changes?.after).toMatchObject({ voiceReplyEnabled: true, voiceReplyVoice: "Puck" });
    expect(audits[1].changes?.before).toMatchObject({ voiceReplyNotice: "Voz gerada por IA." });
    expect(audits[1].changes?.after).toMatchObject({ voiceReplyNotice: null });
  });

  test("membro de fora não lê a configuração", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedOrg(t);
    const outsider = await t.run(async (ctx) => ctx.db.insert("users", { email: "fora@voz.example" }));
    await expect(
      t.withIdentity({ subject: `${outsider}|s1` }).query(api.voiceReply.getVoiceReplySettings, {
        organizationId: seed.organizationId,
      })
    ).rejects.toThrow();
  });
});

