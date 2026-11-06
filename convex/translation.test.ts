/// <reference types="vite/client" />
/**
 * Tradução automática (F1): integração com convex-test. `fetch` mockado para o
 * LibreTranslate e para o LLM (OpenRouter). Cobre: org SEM módulo idêntica a
 * antes, inbound traduzido/pulado, outbound retido até `done` e despachado uma
 * vez, falha sem envio, "enviar sem tradução" auditado, retry, apagada pelo
 * cliente, exibição da resposta da IA, áudio encadeado, args `translation` e
 * `language` do sendMessage, watchdog e ops de presas.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { scheduleMessageTranslation } from "./lib/translationOps";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
const LT_URL = "https://lt.test";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  vi.stubEnv("OPENCODE_GO_API", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("LIBRETRANSLATE_URL", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type T = TestConvex<typeof schema>;

async function seed(t: T, opts: { module?: boolean; ai?: boolean; convLang?: string } = {}) {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", { email: "admin@teste.com" });
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Tradução",
      slug: "org-traducao",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        ...(opts.module ? { modules: { translation: true } } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const aiId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Guia",
      role: "ai",
      type: "ai",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    if (opts.ai) {
      await ctx.db.patch(organizationId, {
        settings: {
          timezone: "America/Sao_Paulo",
          currency: "BRL",
          ...(opts.module ? { modules: { translation: true } } : {}),
          aiConfig: {
            enabled: true,
            autoAssign: false,
            handoffThreshold: 0.5,
            lgpdAck: { acceptedAt: now, acceptedBy: adminId },
            attendantEnabled: false,
          },
        },
      });
    }
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Número principal",
      phoneNumberId: "555000444",
      status: "active",
      autoTranscribeAudio: true,
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Cliente", phone: "34612345678", tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Cliente", contactId, boardId, stageId, value: 0, currency: "BRL",
      priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId, status: "active",
      lastInboundAt: now, messageCount: 0, createdAt: now, updatedAt: now,
      ...(opts.convLang ? { translation: { lang: opts.convLang, source: "auto" as const, mode: "auto" as const } } : {}),
    });
    return { organizationId, adminUserId, adminId, aiId, configId, contactId, leadId, conversationId };
  });
  return { ...seeded, asAdmin: t.withIdentity({ subject: `${seeded.adminUserId}|s1` }) };
}

function ltResponse(translatedText: string, detected?: string) {
  return new Response(
    JSON.stringify({ translatedText, ...(detected ? { detectedLanguage: { language: detected, confidence: 92 } } : {}) }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
function llmResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-teste",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function scheduledNames(t: T): Promise<string[]> {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((j) => j.state.kind === "pending").map((j) => j.name);
  });
}
const isWaDispatch = (n: string) => n.includes("whatsapp") && n.includes("internalDispatchMessage");
const isTranslationJob = (n: string) => n.startsWith("translation");

async function cancelPendingJobs(t: T) {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
  });
  await t.finishInProgressScheduledFunctions();
}

/** Roda só os jobs de tradução pendentes (o dispatcher do WhatsApp fica de fora). */
async function runTranslationJobs(t: T) {
  const jobs = await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (j) => j.state.kind === "pending" && (j.name.includes("autoTranslate") || j.name.includes("translateAndDispatch"))
    )
  );
  for (const job of jobs) {
    await t.run(async (ctx) => ctx.scheduler.cancel(job._id));
    const fn = job.name.split(":")[1];
    if (fn === "autoTranslateInbound") await t.action(internal.translation.autoTranslateInbound, job.args[0] as any);
    if (fn === "autoTranslateDisplay") await t.action(internal.translation.autoTranslateDisplay, job.args[0] as any);
    if (fn === "autoTranslateDraft") await t.action(internal.translation.autoTranslateDraft, job.args[0] as any);
    if (fn === "translateAndDispatch") await t.action(internal.translation.translateAndDispatch, job.args[0] as any);
  }
}

async function receive(t: T, s: Awaited<ReturnType<typeof seed>>, content: string) {
  return (await t.mutation(internal.conversations.internalReceiveMessage, {
    organizationId: s.organizationId,
    leadId: s.leadId,
    channel: "whatsapp",
    channelConfigId: s.configId,
    content,
    skipAiEnqueue: true,
  }))!;
}
const getMsg = (t: T, id: Id<"messages">) => t.run(async (ctx) => (await ctx.db.get(id))!);

const ES = "Hola, quiero saber el precio del apartamento por favor";
const PT_OUT = "Olá! O apartamento custa R$ 500 mil e tem 3 quartos.";

describe("org SEM o módulo: nada muda", () => {
  test("receiver não agenda tradução nem grava metadados", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await receive(t, s, ES);
    expect((await scheduledNames(t)).some(isTranslationJob)).toBe(false);
    const m = await getMsg(t, id);
    expect(m.translatedText).toBeUndefined();
    expect(m.metadata?.translation).toBeUndefined();
    await cancelPendingJobs(t);
  });

  test("sendMessage despacha direto, sem metadata de tradução", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    const names = await scheduledNames(t);
    expect(names.filter(isWaDispatch)).toHaveLength(1);
    expect(names.some(isTranslationJob)).toBe(false);
    const m = await getMsg(t, id);
    expect(m.metadata).toBeUndefined();
    expect(m.translatedText).toBeUndefined();
    expect(m.content).toBe(PT_OUT);
    await cancelPendingJobs(t);
  });
});

describe("inbound com o módulo (LibreTranslate)", () => {
  test("traduz, grava translatedText e o idioma da conversa/contato numa escrita", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const fetchSpy = vi.fn(async () => ltResponse("Olá, quero saber o preço do apartamento por favor"));
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    const id = await receive(t, s, ES);
    expect((await scheduledNames(t)).some((n) => n.includes("autoTranslateInbound"))).toBe(true);
    await runTranslationJobs(t);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${LT_URL}/translate`);
    expect(JSON.parse(init.body as string)).toMatchObject({ source: "es", target: "pt", format: "text" });
    const m = await getMsg(t, id);
    expect(m.content).toBe(ES);
    expect(m.translatedText).toBe("Olá, quero saber o preço do apartamento por favor");
    expect(m.metadata?.translation).toMatchObject({ status: "done", role: "inbound", sourceLang: "es", targetLang: "pt-BR", engine: "libretranslate" });
    const conv = await t.run(async (ctx) => (await ctx.db.get(s.conversationId))!);
    expect(conv.translation).toMatchObject({ lang: "es", source: "auto" });
    const contact = await t.run(async (ctx) => (await ctx.db.get(s.contactId))!);
    expect(contact).toMatchObject({ preferredLanguage: "es", languageSource: "auto" });
    await cancelPendingJobs(t);
  });

  test("mesma língua da equipe numa conversa ATIVA: skipped, zero chamada ao provedor", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await receive(t, s, "Olá, boa tarde! Vocês têm disponibilidade para o fim de semana?");
    await runTranslationJobs(t);
    expect(fetchSpy).not.toHaveBeenCalled();
    const m = await getMsg(t, id);
    expect(m.metadata?.translation).toMatchObject({ status: "skipped", role: "inbound", sourceLang: "pt-BR" });
    expect(m.translatedText).toBeUndefined();
    await cancelPendingJobs(t);
  });

  test("apagada pelo cliente antes do resultado: descarta", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    vi.stubGlobal("fetch", vi.fn(async () => ltResponse("Olá, quero saber o preço")));
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    const id = await receive(t, s, ES);
    await t.run(async (ctx) => ctx.db.patch(id, { metadata: { deletedByCustomer: true } }));
    await runTranslationJobs(t);
    const m = await getMsg(t, id);
    expect(m.translatedText).toBeUndefined();
    expect(m.metadata?.translation).toBeUndefined();
    await cancelPendingJobs(t);
  });

  test("grupo nunca é traduzido", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    const groupConv = await t.run(async (ctx) =>
      ctx.db.insert("conversations", {
        organizationId: s.organizationId, kind: "group", channel: "whatsapp", channelConfigId: s.configId,
        status: "active", messageCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const scheduled = await t.run(async (ctx) => {
      const mid = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: groupConv, direction: "inbound", senderType: "contact",
        content: ES, contentType: "text", isInternal: false, createdAt: Date.now(),
      });
      return await scheduleMessageTranslation(ctx, { messageId: mid, role: "inbound" });
    });
    expect(scheduled).toBe(false);
  });

  test("áudio: transcrição concluída encadeia a tradução com a dica do Whisper", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const fetchSpy = vi.fn(async () => ltResponse("Bom dia, quero visitar o imóvel amanhã"));
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    const id = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "inbound",
        senderType: "contact", content: "[áudio]", contentType: "audio", isInternal: false, createdAt: Date.now(),
      })
    );
    await t.mutation(internal.transcription.internalSetTranscriptionResult, {
      messageId: id, status: "done", text: "Buenos días, quiero visitar el inmueble mañana", language: "es",
    });
    expect((await scheduledNames(t)).some((n) => n.includes("autoTranslateInbound"))).toBe(true);
    await runTranslationJobs(t);
    const m = await getMsg(t, id);
    expect(m.translatedText).toBe("Bom dia, quero visitar o imóvel amanhã");
    expect(m.metadata?.translation).toMatchObject({ status: "done", sourceLang: "es" });
    await cancelPendingJobs(t);
  });
});

describe("outbound com o módulo", () => {
  test("não despacha antes de done; despacha exatamente uma vez depois", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const fetchSpy = vi.fn(async () => ltResponse("¡Hola! El apartamento cuesta R$ 500 mil y tiene 3 habitaciones."));
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    let names = await scheduledNames(t);
    expect(names.filter(isWaDispatch)).toHaveLength(0);
    expect(names.some((n) => n.includes("translateAndDispatch"))).toBe(true);
    expect((await getMsg(t, id)).metadata?.translation).toMatchObject({ status: "pending", role: "outbound", sourceLang: "pt-BR", targetLang: "es" });

    await runTranslationJobs(t);
    const m = await getMsg(t, id);
    expect(m.content).toBe("¡Hola! El apartamento cuesta R$ 500 mil y tiene 3 habitaciones.");
    expect(m.translatedText).toBe(PT_OUT);
    expect(m.metadata?.translation).toMatchObject({ status: "done", role: "outbound", engine: "libretranslate" });
    const conv = await t.run(async (ctx) => (await ctx.db.get(s.conversationId))!);
    expect(conv.lastMessagePreview).toContain("¡Hola!");
    names = await scheduledNames(t);
    expect(names.filter(isWaDispatch)).toHaveLength(1);

    // Idempotente: reaplicar a mesma tentativa não despacha de novo.
    const again = await t.mutation(internal.translation.internalApplyOutbound, {
      messageId: id, expectedAt: (m.metadata!.translation as { at: number }).at, translatedText: "x",
    });
    expect(again).toBe(false);
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(1);
    await cancelPendingJobs(t);
  });

  test("LibreTranslate recebe tokens {n}/XEMOnX, nunca ⟦…⟧ nem emoji, e a saída volta com tudo", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const original = "Oi! 👋\nA casa é linda 😍 e fica perto da praia.\nMe chama no (11) 98765-4321 🙏";
    // Resposta real do servidor (pt → en, 06/11/2026) para o texto protegido.
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      ltResponse("Hello!\nThe house is beautiful XEMO2X and is close to the beach.\nCall me in {1}")
    );
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "en" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: original });
    await runTranslationJobs(t);
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).q as string;
    expect(sent).toBe("Oi!\nA casa é linda XEMO2X e fica perto da praia.\nMe chama no {1}");
    const m = await getMsg(t, id);
    expect(m.content).toBe("Hello! 👋\nThe house is beautiful 😍 and is close to the beach.\nCall me in (11) 98765-4321 🙏");
    expect(m.metadata?.translation).toMatchObject({ status: "done", engine: "libretranslate" });
    await cancelPendingJobs(t);
  });

  test("só emoji: o servidor nem é chamado e a mensagem sai igual", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const fetchSpy = vi.fn(async () => ltResponse("x"));
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "en" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: "👍🏽🙏" });
    await runTranslationJobs(t);
    expect(fetchSpy).not.toHaveBeenCalled();
    const m = await getMsg(t, id);
    expect(m.content).toBe("👍🏽🙏");
    expect(m.metadata?.translation).toMatchObject({ status: "done", engine: "libretranslate" });
    await cancelPendingJobs(t);
  });

  test("falha do provedor: failed legível, sem despacho; enviar sem tradução despacha e audita", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    await runTranslationJobs(t);
    let m = await getMsg(t, id);
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.translation).toMatchObject({ status: "failed", role: "outbound" });
    expect(String(m.metadata?.deliveryError)).toMatch(/Tradução falhou/);
    expect(m.content).toBe(PT_OUT);
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(0);

    // Ops de presas não reenvia a falha.
    await t.mutation(internal.opsMigration.internalRedispatchStuckOutbound, { sinceMs: 3_600_000, dryRun: false });
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(0);

    // Tentar de novo: volta a pending e reagenda.
    await s.asAdmin.mutation(api.translation.retryOutbound, { messageId: id });
    m = await getMsg(t, id);
    expect(m.deliveryStatus).toBeUndefined();
    expect(m.metadata?.translation).toMatchObject({ status: "pending" });
    expect(m.metadata?.deliveryError).toBeUndefined();
    expect((await scheduledNames(t)).some((n) => n.includes("translateAndDispatch"))).toBe(true);

    // Enviar em português assim mesmo.
    await s.asAdmin.mutation(api.translation.sendUntranslated, { messageId: id });
    m = await getMsg(t, id);
    expect(m.metadata?.translation).toMatchObject({ status: "skipped", role: "outbound" });
    expect(m.content).toBe(PT_OUT);
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(1);
    const audits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", "message").eq("entityId", id)).collect())
    );
    expect(audits.some((a) => a.severity === "medium" && /sem tradução/.test(a.description ?? ""))).toBe(true);
    // A tradução que estava em voo chega tarde: não troca nada nem despacha de novo.
    await runTranslationJobs(t);
    expect((await getMsg(t, id)).content).toBe(PT_OUT);
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(1);
    await cancelPendingJobs(t);
  });

  test("sem provedor nenhum: falha legível, nunca envia sozinho", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    await runTranslationJobs(t);
    const m = await getMsg(t, id);
    expect(m.metadata?.translation).toMatchObject({ status: "failed", error: "Nenhum provedor de tradução disponível" });
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(0);
    await cancelPendingJobs(t);
  });

  test("arg translation: nasce done, sem desvio", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, {
      conversationId: s.conversationId,
      content: "Hola, ¿cómo estás?",
      translation: { authoredText: "Olá, tudo bem?", sourceLang: "pt-BR", targetLang: "es", edited: true },
    });
    const m = await getMsg(t, id);
    expect(m.translatedText).toBe("Olá, tudo bem?");
    expect(m.metadata?.translation).toMatchObject({ status: "done", role: "outbound", edited: true });
    const names = await scheduledNames(t);
    expect(names.some(isTranslationJob)).toBe(false);
    expect(names.filter(isWaDispatch)).toHaveLength(1);
    await cancelPendingJobs(t);
  });

  test('language:"off" pula; código sobrescreve o destino', async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const off = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT, language: "off" });
    expect((await getMsg(t, off)).metadata?.translation).toMatchObject({ status: "skipped" });
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(1);
    const fr = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT, language: "fr" });
    expect((await getMsg(t, fr)).metadata?.translation).toMatchObject({ status: "pending", targetLang: "fr" });
    await cancelPendingJobs(t);
  });

  test("conversa sem idioma conhecido (só dica do DDI): não traduz", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    expect((await getMsg(t, id)).metadata).toBeUndefined();
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(1);
    await cancelPendingJobs(t);
  });

  test("nota interna nunca é traduzida", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT, isInternal: true });
    expect((await getMsg(t, id)).metadata).toBeUndefined();
    expect((await scheduledNames(t)).some(isTranslationJob)).toBe(false);
    await cancelPendingJobs(t);
  });

  test("watchdog: pending velho vira failed; ops também", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const a = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    const b = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT + " 2" });
    expect(await t.mutation(internal.translation.internalExpirePendingOutbound, { messageId: a })).toBe(false);
    // Sem os jobs agendados (o watchdog por mensagem dispararia sozinho com o relógio).
    await cancelPendingJobs(t);
    vi.advanceTimersByTime(3 * 60 * 1000);
    expect(await t.mutation(internal.translation.internalExpirePendingOutbound, { messageId: a })).toBe(true);
    expect((await getMsg(t, a)).metadata?.translation).toMatchObject({ status: "failed" });
    const plan = await t.mutation(internal.opsMigration.internalRedispatchStuckOutbound, { sinceMs: 3_600_000, dryRun: false });
    expect(plan.find((p) => p.messageId === b)?.action).toBe("translation_failed");
    expect((await getMsg(t, b)).deliveryStatus).toBe("failed");
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(0);
    await cancelPendingJobs(t);
  });
});

describe("watchdog agendado", () => {
  test("o job por mensagem reprova a pending sozinho depois do prazo", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    // A tradução em si nunca roda (provedor travado): só o watchdog.
    await t.run(async (ctx) => {
      for (const j of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (j.state.kind === "pending" && j.name.includes("translateAndDispatch")) await ctx.scheduler.cancel(j._id);
      }
    });
    vi.advanceTimersByTime(3 * 60 * 1000);
    await t.finishInProgressScheduledFunctions();
    const m = await getMsg(t, id);
    expect(m.metadata?.translation).toMatchObject({ status: "failed" });
    expect(m.deliveryStatus).toBe("failed");
    await cancelPendingJobs(t);
  });
});

describe("LLM como provedor", () => {
  test("traduz pela cadeia de IA e registra agentRuns kind translation sem memberId", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test-fake-openrouter");
    const fetchSpy = vi.fn(async () => llmResponse('{"lang":"es","text":"Olá, quero saber o preço do apartamento por favor"}'));
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, ai: true });
    const id = await receive(t, s, ES);
    await runTranslationJobs(t);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(body.messages[1])).toContain("crm_data");
    const m = await getMsg(t, id);
    expect(m.metadata?.translation).toMatchObject({ status: "done", engine: "llm", sourceLang: "es" });
    const runs = await t.run(async (ctx) => ctx.db.query("agentRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "translation", status: "done", conversationId: s.conversationId });
    expect(runs[0].memberId).toBeUndefined();
    await cancelPendingJobs(t);
  });

  test("raciocínio desligado na rota OpenRouter e resposta cortada repete com teto máximo", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test-fake-openrouter");
    let call = 0;
    const fetchSpy = vi.fn(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-teste",
            choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" }],
            usage: { prompt_tokens: 120, completion_tokens: 600 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return llmResponse('{"lang":"es","text":"Olá, quero saber o preço do apartamento por favor"}');
    });
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, ai: true });
    const id = await receive(t, s, ES);
    await runTranslationJobs(t);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const bodies = fetchSpy.mock.calls.map((c) => JSON.parse(((c as unknown as [string, RequestInit])[1].body as string)));
    expect(bodies[0].reasoning).toEqual({ enabled: false });
    expect(bodies[0].max_tokens).toBeGreaterThanOrEqual(512);
    expect(bodies[1].max_tokens).toBe(4000);
    expect((await getMsg(t, id)).metadata?.translation).toMatchObject({ status: "done", engine: "llm" });
    await cancelPendingJobs(t);
  });

  test("marcação vazada do modelo: 1 retry e depois falha", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test-fake-openrouter");
    const leak = '{"lang":"es","text":"<|tool_call_begin|>functions.replyToCustomer:0<|tool_call_argument_begin|>{}"}';
    const fetchSpy = vi.fn(async () => llmResponse(leak));
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, ai: true });
    const id = await receive(t, s, ES);
    await runTranslationJobs(t);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const m = await getMsg(t, id);
    expect(m.metadata?.translation).toMatchObject({ status: "failed" });
    expect(m.translatedText).toBeUndefined();
    await cancelPendingJobs(t);
  });

  test("LibreTranslate cai → LLM assume (self-hosted primeiro)", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test-fake-openrouter");
    const fetchSpy = vi.fn(async (url: string) =>
      url.startsWith(LT_URL)
        ? new Response("{}", { status: 503 })
        : llmResponse('{"lang":"es","text":"Olá, quero saber o preço do apartamento por favor"}')
    );
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, ai: true });
    const id = await receive(t, s, ES);
    await runTranslationJobs(t);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((await getMsg(t, id)).metadata?.translation).toMatchObject({ status: "done", engine: "llm" });
    await cancelPendingJobs(t);
  });
});

describe("exibição da resposta da IA", () => {
  test("role display grava a versão da equipe sem tocar o content", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    vi.stubGlobal("fetch", vi.fn(async () => ltResponse("Claro! O apartamento tem três quartos e varanda.")));
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const text = "¡Claro! El apartamento tiene tres habitaciones y balcón.";
    const id = await t.run(async (ctx) => {
      const mid = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.aiId, senderType: "ai", content: text, contentType: "text", isInternal: false, createdAt: Date.now(),
      });
      expect(await scheduleMessageTranslation(ctx, { messageId: mid, role: "display" })).toBe(true);
      return mid;
    });
    await runTranslationJobs(t);
    const m = await getMsg(t, id);
    expect(m.content).toBe(text);
    expect(m.translatedText).toBe("Claro! O apartamento tem três quartos e varanda.");
    expect(m.metadata?.translation).toMatchObject({ status: "done", role: "display" });
    await cancelPendingJobs(t);
  });
});

describe("funções públicas", () => {
  test("setConversationLanguage manual + aplicar ao contato", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    await s.asAdmin.mutation(api.translation.setConversationLanguage, {
      conversationId: s.conversationId, lang: "fr", mode: "manual", applyToContact: true,
    });
    const conv = await t.run(async (ctx) => (await ctx.db.get(s.conversationId))!);
    expect(conv.translation).toMatchObject({ lang: "fr", mode: "manual", source: "manual" });
    const contact = await t.run(async (ctx) => (await ctx.db.get(s.contactId))!);
    expect(contact).toMatchObject({ preferredLanguage: "fr", languageSource: "manual" });
    await expect(
      s.asAdmin.mutation(api.translation.setConversationLanguage, { conversationId: s.conversationId, mode: "manual" })
    ).rejects.toThrow(/Escolha o idioma/);
    await s.asAdmin.mutation(api.translation.setConversationLanguage, { conversationId: s.conversationId, mode: "off" });
    expect((await t.run(async (ctx) => (await ctx.db.get(s.conversationId))!)).translation?.mode).toBe("off");
  });

  test("getSettings com defaults e updateSettings auditado", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    const before = await s.asAdmin.query(api.translation.getSettings, { organizationId: s.organizationId });
    expect(before).toMatchObject({ moduleEnabled: true, providers: { libretranslate: true, llm: false } });
    expect(before.settings.teamLanguage).toBe("pt-BR");
    await s.asAdmin.mutation(api.translation.updateSettings, {
      organizationId: s.organizationId,
      patch: { tone: "formal", glossary: [" Mar Azul ", "mar azul"], teamLanguage: "pt" },
    });
    const after = await s.asAdmin.query(api.translation.getSettings, { organizationId: s.organizationId });
    expect(after.settings).toMatchObject({ tone: "formal", glossary: ["Mar Azul"], teamLanguage: "pt-BR" });
    await expect(
      s.asAdmin.mutation(api.translation.updateSettings, { organizationId: s.organizationId, patch: { teamLanguage: "xx" } })
    ).rejects.toThrow(/não suportado/);
  });

  test("getInboxSettings: qualquer membro lê os defaults; outra org não", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    const agentUser = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "agente@teste.com" });
      await ctx.db.insert("teamMembers", {
        organizationId: s.organizationId, userId, name: "Agente", role: "agent", type: "human", status: "active",
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      return userId;
    });
    const asAgent = t.withIdentity({ subject: `${agentUser}|s1` });
    expect(await asAgent.query(api.translation.getInboxSettings, { organizationId: s.organizationId })).toEqual({
      moduleEnabled: true, teamLanguage: "pt-BR", inboundMode: "auto", outboundMode: "quick_review",
    });
    await expect(asAgent.query(api.translation.getSettings, { organizationId: s.organizationId })).rejects.toThrow();
    const stranger = await t.run(async (ctx) => ctx.db.insert("users", { email: "x@teste.com" }));
    await expect(
      t.withIdentity({ subject: `${stranger}|s1` }).query(api.translation.getInboxSettings, { organizationId: s.organizationId })
    ).rejects.toThrow();
  });

  test("setOrgModules liga o módulo e audita", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const out = await s.asAdmin.mutation(api.orgModules.setOrgModules, { organizationId: s.organizationId, modules: { translation: true } });
    expect(out.translation).toBe(true);
  });

  test("setOrgModules exige conta com e-mail para ligar a tradução", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const anon = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("teamMembers", {
        organizationId: s.organizationId, userId, name: "Sem e-mail", role: "admin", type: "human", status: "active",
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      return userId;
    });
    await expect(
      t.withIdentity({ subject: `${anon}|s1` }).mutation(api.orgModules.setOrgModules, {
        organizationId: s.organizationId, modules: { translation: true },
      })
    ).rejects.toThrow(/conta com e-mail/);
  });

  test("outra org não acessa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    const other = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "outro@teste.com" });
      const orgId = await ctx.db.insert("organizations", {
        name: "Outra", slug: "outra", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: 1, updatedAt: 1,
      });
      await ctx.db.insert("teamMembers", {
        organizationId: orgId, userId, name: "X", role: "admin", type: "human", status: "active", createdAt: 1, updatedAt: 1,
      });
      return userId;
    });
    await expect(
      t.withIdentity({ subject: `${other}|s1` }).mutation(api.translation.setConversationLanguage, {
        conversationId: s.conversationId, lang: "es", mode: "manual",
      })
    ).rejects.toThrow();
  });

  test("translateMessage manual (Traduzir) numa inbound pulada", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const fetchSpy = vi.fn(async () => ltResponse("Olá, preço?", "es"));
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    const id = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "inbound",
        senderType: "contact", content: "Hola, ¿precio?", contentType: "text", isInternal: false, createdAt: Date.now(),
        metadata: { translation: { status: "skipped", role: "inbound", at: 1 } },
      })
    );
    const res = await s.asAdmin.action(api.translation.translateMessage, { messageId: id });
    expect(res).toMatchObject({ status: "done", translatedText: "Olá, preço?" });
    expect((await getMsg(t, id)).translatedText).toBe("Olá, preço?");
  });
});

describe("REST: preferredLanguage em /contacts/create e /contacts/update", () => {
  const API_KEY = "hnb_test_translation_admin_1";
  async function sha256Hex(input: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function withKey(t: T) {
    const s = await seed(t);
    await t.run(async (ctx) =>
      ctx.db.insert("apiKeys", {
        organizationId: s.organizationId, teamMemberId: s.adminId, name: "k",
        keyHash: await sha256Hex(API_KEY), isActive: true, createdAt: Date.now(),
      })
    );
    return s;
  }
  const post = (t: T, path: string, body: unknown) =>
    t.fetch(path, { method: "POST", headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("cria e atualiza com código do catálogo; \"\" limpa; inválido = 400", async () => {
    const t = convexTest(schema, modules);
    const s = await withKey(t);
    const created = await post(t, "/api/v1/contacts/create", { firstName: "Ana", preferredLanguage: "es" });
    expect(created.status).toBe(201);
    const { contactId } = (await created.json()) as { contactId: Id<"contacts"> };
    const read = () => t.run(async (ctx) => (await ctx.db.get(contactId))!);
    expect(await read()).toMatchObject({ preferredLanguage: "es", languageSource: "manual" });

    const bad = await post(t, "/api/v1/contacts/create", { firstName: "Bia", preferredLanguage: "klingon" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/preferredLanguage inválido/);

    expect((await post(t, "/api/v1/contacts/update", { contactId, preferredLanguage: "pt" })).status).toBe(200);
    expect((await read()).preferredLanguage).toBe("pt-BR");
    expect((await post(t, "/api/v1/contacts/update", { contactId, preferredLanguage: 42 })).status).toBe(400);
    expect((await post(t, "/api/v1/contacts/update", { contactId, preferredLanguage: "" })).status).toBe(200);
    const cleared = await read();
    expect(cleared.preferredLanguage).toBeUndefined();
    expect(cleared.languageSource).toBeUndefined();

    // Sem o campo: nada muda no contato.
    await post(t, "/api/v1/contacts/update", { contactId, firstName: "Ana Maria" });
    expect((await read()).preferredLanguage).toBeUndefined();
    void s;
  });

  test("updateContact (app) grava escolha manual", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await s.asAdmin.mutation(api.contacts.updateContact, { contactId: s.contactId, preferredLanguage: "en" });
    expect(await t.run(async (ctx) => (await ctx.db.get(s.contactId))!)).toMatchObject({ preferredLanguage: "en", languageSource: "manual" });
    await expect(s.asAdmin.mutation(api.contacts.updateContact, { contactId: s.contactId, preferredLanguage: "xx" })).rejects.toThrow(/não suportado/);
  });
});

// ── F3: fluidez ──────────────────────────────────────────────────────────────

describe("F3: prévia no composer", () => {
  test("texto já no idioma do lead: skipped sem chamar provedor; pt-BR traduz", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const fetchSpy = vi.fn(async () => ltResponse("¡Hola! El apartamento cuesta R$ 500 mil y tiene 3 habitaciones."));
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const same = await s.asAdmin.action(api.translation.preview, { conversationId: s.conversationId, text: ES });
    expect(same).toMatchObject({ skipped: true, reason: "same_language", text: ES, engine: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    const out = await s.asAdmin.action(api.translation.preview, { conversationId: s.conversationId, text: PT_OUT });
    expect(out).toMatchObject({ skipped: false, text: "¡Hola! El apartamento cuesta R$ 500 mil y tiene 3 habitaciones.", sourceLang: "pt-BR", targetLang: "es" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // A prévia não grava nada nem agenda nada.
    expect((await scheduledNames(t)).some(isTranslationJob)).toBe(false);
  });

  test("provedor fora: a prévia lança erro legível (o composer cai no desvio do servidor)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    await expect(s.asAdmin.action(api.translation.preview, { conversationId: s.conversationId, text: PT_OUT })).rejects.toThrow(
      /Nenhum provedor/
    );
  });

  test("sendMessage com a prévia: nasce done, sem job de tradução nem patch extra", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, {
      conversationId: s.conversationId,
      content: "Hola, el apartamento cuesta R$ 500 mil.",
      translation: { authoredText: PT_OUT, sourceLang: "pt-BR", targetLang: "es" },
    });
    const m = await getMsg(t, id);
    expect(m).toMatchObject({ content: "Hola, el apartamento cuesta R$ 500 mil.", translatedText: PT_OUT });
    expect(m.metadata?.translation).toMatchObject({ status: "done", role: "outbound", sourceLang: "pt-BR", targetLang: "es" });
    expect(m.metadata?.translation?.edited).toBeUndefined();
    const names = await scheduledNames(t);
    expect(names.some(isTranslationJob)).toBe(false);
    expect(names.filter(isWaDispatch)).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    await cancelPendingJobs(t);
  });

  test("padrão da org agora é quick_review", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    const res = await s.asAdmin.query(api.translation.getSettings, { organizationId: s.organizationId });
    expect(res.settings.outboundMode).toBe("quick_review");
  });
});

describe("F3: motivo do skipped", () => {
  test("mesma língua, curta sem idioma, modo perguntar e language off gravam o motivo", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    vi.stubGlobal("fetch", vi.fn());
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    // Curta numa conversa com idioma só CANDIDATO (ativa, review #10/#11): `short`.
    await t.run(async (ctx) =>
      ctx.db.patch(s.conversationId, { translation: { candidateLang: "es", divergentStreak: 1, source: "auto" } })
    );
    const short = await receive(t, s, "ok");
    await runTranslationJobs(t);
    expect((await getMsg(t, short)).metadata?.translation).toMatchObject({ status: "skipped", reason: "short", candidateLang: "es" });
    await t.run(async (ctx) => ctx.db.patch(s.conversationId, { translation: { lang: "es", source: "auto", mode: "auto" } }));
    const same = await receive(t, s, "Olá, boa tarde! Vocês têm disponibilidade para o fim de semana?");
    await runTranslationJobs(t);
    expect((await getMsg(t, same)).metadata?.translation).toMatchObject({ status: "skipped", reason: "same_language" });
    await t.run(async (ctx) => ctx.db.patch(s.conversationId, { translation: undefined }));

    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, { settings: { ...org.settings, translation: { inboundMode: "ask" } } });
    });
    const ask = await receive(t, s, ES);
    await runTranslationJobs(t);
    expect((await getMsg(t, ask)).metadata?.translation).toMatchObject({ status: "skipped", reason: "ask_mode", sourceLang: "es" });

    const off = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT, language: "off" });
    expect((await getMsg(t, off)).metadata?.translation).toMatchObject({ status: "skipped", reason: "language_off" });
    await cancelPendingJobs(t);
  });
});

describe("F3: rascunho da IA legível em pt-BR", () => {
  async function insertDraft(t: T, s: Awaited<ReturnType<typeof seed>>, content: string) {
    return await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "internal",
        senderId: s.aiId, senderType: "ai", content, contentType: "text", isInternal: true, createdAt: Date.now(),
        metadata: { aiDraft: { status: "pending", proposedActions: [] } },
      })
    );
  }

  test("conversa em espanhol: aiDraft.translatedText gravado, content intacto", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    vi.stubGlobal("fetch", vi.fn(async () => ltResponse("Claro! O apartamento tem três quartos e varanda.")));
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const text = "¡Claro! El apartamento tiene tres habitaciones y balcón.";
    const id = await insertDraft(t, s, text);
    expect(await t.run(async (ctx) => scheduleMessageTranslation(ctx, { messageId: id, role: "draft" }))).toBe(true);
    await runTranslationJobs(t);
    const m = await getMsg(t, id);
    expect(m.content).toBe(text);
    expect(m.metadata?.aiDraft).toMatchObject({
      status: "pending",
      translatedText: "Claro! O apartamento tem três quartos e varanda.",
      translatedTo: "pt-BR",
    });
    expect(m.metadata?.translation).toBeUndefined();
    expect(m.translatedText).toBeUndefined();
  });

  test("sem idioma estrangeiro, sem módulo ou rascunho já resolvido: nada agendado", async () => {
    const t = convexTest(schema, modules);
    const pt = await seed(t, { module: true });
    const a = await insertDraft(t, pt, "Claro! O apartamento tem três quartos.");
    expect(await t.run(async (ctx) => scheduleMessageTranslation(ctx, { messageId: a, role: "draft" }))).toBe(false);

    const t2 = convexTest(schema, modules);
    const noModule = await seed(t2, { convLang: "es" });
    const b = await insertDraft(t2, noModule, "¡Claro! El apartamento tiene tres habitaciones.");
    expect(await t2.run(async (ctx) => scheduleMessageTranslation(ctx, { messageId: b, role: "draft" }))).toBe(false);

    // Resolvido entre o agendamento e o resultado: a escrita é descartada.
    const t3 = convexTest(schema, modules);
    const es = await seed(t3, { module: true, convLang: "es" });
    const c = await insertDraft(t3, es, "¡Claro! El apartamento tiene tres habitaciones.");
    await t3.run(async (ctx) => ctx.db.patch(c, { metadata: { aiDraft: { status: "approved" } } }));
    expect(
      await t3.mutation(internal.translation.internalSetDraftTranslation, {
        messageId: c, translatedText: "x", targetLang: "pt-BR", expectedContent: "¡Claro! El apartamento tiene tres habitaciones.",
      })
    ).toBe(false);
  });
});

describe("F3: agendadas traduzem ao agendar (D9)", () => {
  test("com a prévia: guarda as duas versões e a entrega sai done, sem desvio", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const scheduledId = await s.asAdmin.mutation(api.scheduledMessages.schedule, {
      conversationId: s.conversationId,
      content: "Hola, ¿mañana a las 10?",
      scheduledAt: Date.now() + 5 * 60_000,
      translation: { authoredText: "Olá, amanhã às 10?", sourceLang: "pt-BR", targetLang: "es", edited: true },
    });
    const pending = await s.asAdmin.query(api.scheduledMessages.listPending, { conversationId: s.conversationId });
    expect(pending[0]).toMatchObject({ content: "Hola, ¿mañana a las 10?", authoredText: "Olá, amanhã às 10?", targetLang: "es" });
    await cancelPendingJobs(t);
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: scheduledId });
    const row = await t.run(async (ctx) => (await ctx.db.get(scheduledId))!);
    const m = await getMsg(t, row.sentMessageId!);
    expect(m).toMatchObject({ content: "Hola, ¿mañana a las 10?", translatedText: "Olá, amanhã às 10?" });
    expect(m.metadata).toMatchObject({ scheduled: true, translation: { status: "done", role: "outbound", edited: true } });
    const names = await scheduledNames(t);
    expect(names.some(isTranslationJob)).toBe(false);
    expect(names.filter(isWaDispatch)).toHaveLength(1);
    await cancelPendingJobs(t);
  });

  test("sem prévia: comportamento da F1 (desvio na entrega)", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const scheduledId = await s.asAdmin.mutation(api.scheduledMessages.schedule, {
      conversationId: s.conversationId, content: PT_OUT, scheduledAt: Date.now() + 5 * 60_000,
    });
    await cancelPendingJobs(t);
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: scheduledId });
    const row = await t.run(async (ctx) => (await ctx.db.get(scheduledId))!);
    const m = await getMsg(t, row.sentMessageId!);
    expect(m.metadata).toMatchObject({ scheduled: true, translation: { status: "pending", targetLang: "es" } });
    expect((await scheduledNames(t)).some((n) => n.includes("translateAndDispatch"))).toBe(true);
    await cancelPendingJobs(t);
  });

  test("tradução desligada na conversa antes da entrega: sai o que a equipe escreveu", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const scheduledId = await s.asAdmin.mutation(api.scheduledMessages.schedule, {
      conversationId: s.conversationId,
      content: "Hola, ¿mañana a las 10?",
      scheduledAt: Date.now() + 5 * 60_000,
      translation: { authoredText: "Olá, amanhã às 10?", sourceLang: "pt-BR", targetLang: "es" },
    });
    await cancelPendingJobs(t);
    await s.asAdmin.mutation(api.translation.setConversationLanguage, { conversationId: s.conversationId, mode: "off" });
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: scheduledId });
    const row = await t.run(async (ctx) => (await ctx.db.get(scheduledId))!);
    const m = await getMsg(t, row.sentMessageId!);
    expect(m.content).toBe("Olá, amanhã às 10?");
    expect(m.metadata?.translation).toMatchObject({ status: "skipped", reason: "language_off" });
    await cancelPendingJobs(t);
  });

  test("idioma fora do catálogo é recusado ao agendar", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    await expect(
      s.asAdmin.mutation(api.scheduledMessages.schedule, {
        conversationId: s.conversationId, content: "x y z", scheduledAt: Date.now() + 5 * 60_000, language: "xx",
      })
    ).rejects.toThrow(/não suportado/);
  });
});
