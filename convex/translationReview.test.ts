/// <reference types="vite/client" />
/**
 * Tradução automática — correções do review (backend). Integração com
 * convex-test: saída longa retida, corridas tardias (expirada/enviada sem
 * tradução), retry, REST `language`, RBAC/cross-org, rascunho da IA editado,
 * módulo desligado, custo do inbound em pt-BR, regra do 1º idioma e audits.
 * Helpers copiados de `translation.test.ts` (o projeto não tem helper comum).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { translationInsertFieldsFor } from "./lib/translationOps";

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
const LONG_PT = Array.from({ length: 90 }, (_, i) => `Parágrafo ${i}: o apartamento tem varanda e vista para o mar.`).join("\n\n");
const ES_OUT = "¡Hola! El apartamento cuesta R$ 500 mil y tiene 3 habitaciones.";

async function auditsOf(t: T, entityType: string, entityId: string) {
  return await t.run(async (ctx) =>
    ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", entityType).eq("entityId", entityId)).collect()
  );
}

async function memberOf(t: T, organizationId: Id<"organizations">, opts: { inbox?: "view_own" | "reply"; otherOrg?: boolean } = {}) {
  const userId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: `m${Math.random().toString(36).slice(2)}@teste.com` });
    const orgId = opts.otherOrg
      ? await ctx.db.insert("organizations", {
          name: "Outra", slug: `outra-${Math.random().toString(36).slice(2, 8)}`,
          settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { translation: true } }, createdAt: 1, updatedAt: 1,
        })
      : organizationId;
    await ctx.db.insert("teamMembers", {
      organizationId: orgId, userId, name: "Membro", role: opts.otherOrg ? "admin" : "agent", type: "human", status: "active",
      createdAt: 1, updatedAt: 1,
      ...(opts.inbox
        ? {
            permissions: {
              leads: "edit_own", contacts: "view", inbox: opts.inbox, tasks: "edit_own", reports: "view", team: "none",
              settings: "none", auditLogs: "none", apiKeys: "none", campaigns: "none",
            } as any,
          }
        : {}),
    });
    return userId;
  });
  return t.withIdentity({ subject: `${userId}|s1` });
}

describe("#1 saída longa demais", () => {
  test("fica retida como failed legível (long_text), sem job nem despacho; retry recusa; enviar sem traduzir despacha", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: LONG_PT });
    const m = await getMsg(t, id);
    expect(m.content).toBe(LONG_PT);
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.translation).toMatchObject({
      status: "failed", role: "outbound", reason: "long_text", targetLang: "es", error: "Mensagem longa demais para traduzir",
    });
    expect(String(m.metadata?.deliveryError)).toMatch(/Tradução falhou: Mensagem longa demais/);
    const names = await scheduledNames(t);
    expect(names.filter(isWaDispatch)).toHaveLength(0);
    expect(names.some(isTranslationJob)).toBe(false);
    await expect(s.asAdmin.mutation(api.translation.retryOutbound, { messageId: id })).rejects.toThrow(/longa demais/);
    await s.asAdmin.mutation(api.translation.sendUntranslated, { messageId: id });
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    await cancelPendingJobs(t);
  });

  test("conversa em pt-BR: texto longo segue direto, como antes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "pt-BR" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: LONG_PT });
    expect((await getMsg(t, id)).metadata?.translation).toBeUndefined();
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(1);
    await cancelPendingJobs(t);
  });

  test("legenda de arquivo é traduzida na saída", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, {
      conversationId: s.conversationId, content: "Segue o contrato assinado", contentType: "file",
    });
    expect((await getMsg(t, id)).metadata?.translation).toMatchObject({ status: "pending", role: "outbound" });
    await cancelPendingJobs(t);
  });
});

describe("corridas tardias da saída", () => {
  test("sucesso tardio depois de expirar (failed) é ignorado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    const at = ((await getMsg(t, id)).metadata!.translation as { at: number }).at;
    await cancelPendingJobs(t);
    vi.advanceTimersByTime(3 * 60 * 1000);
    expect(await t.mutation(internal.translation.internalExpirePendingOutbound, { messageId: id })).toBe(true);
    expect(await t.mutation(internal.translation.internalApplyOutbound, { messageId: id, expectedAt: at, translatedText: ES_OUT })).toBe(false);
    const m = await getMsg(t, id);
    expect(m.content).toBe(PT_OUT);
    expect(m.metadata?.translation).toMatchObject({ status: "failed" });
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(0);
  });

  test("enviar sem traduzir com a tradução pending + aplicação tardia: um despacho só", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    const at = ((await getMsg(t, id)).metadata!.translation as { at: number }).at;
    await s.asAdmin.mutation(api.translation.sendUntranslated, { messageId: id });
    expect(await t.mutation(internal.translation.internalApplyOutbound, { messageId: id, expectedAt: at, translatedText: ES_OUT })).toBe(false);
    expect((await getMsg(t, id)).content).toBe(PT_OUT);
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(1);
    await cancelPendingJobs(t);
  });

  test("retryOutbound: falhou → tentar de novo → done e despacha uma vez", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    let ok = false;
    vi.stubGlobal("fetch", vi.fn(async () => (ok ? ltResponse(ES_OUT) : new Response("{}", { status: 503 }))));
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    await runTranslationJobs(t);
    expect((await getMsg(t, id)).metadata?.translation).toMatchObject({ status: "failed" });
    ok = true;
    await s.asAdmin.mutation(api.translation.retryOutbound, { messageId: id });
    await runTranslationJobs(t);
    const m = await getMsg(t, id);
    expect(m).toMatchObject({ content: ES_OUT, translatedText: PT_OUT });
    expect(m.deliveryStatus).toBeUndefined();
    expect(m.metadata?.translation).toMatchObject({ status: "done" });
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(1);
    await cancelPendingJobs(t);
  });
});

describe("#4/#13 audits e timeline", () => {
  test('language:"off" numa conversa em espanhol audita medium; em pt-BR não', async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT, language: "off" });
    const audits = await auditsOf(t, "message", id);
    expect(audits.filter((a) => a.severity === "medium" && /sem tradução/.test(a.description ?? ""))).toHaveLength(1);
    await t.run(async (ctx) => ctx.db.patch(s.conversationId, { translation: { lang: "pt-BR", source: "auto", mode: "auto" } }));
    const plain = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT, language: "off" });
    expect((await auditsOf(t, "message", plain)).some((a) => a.severity === "medium")).toBe(false);
    await cancelPendingJobs(t);
  });

  test("sendUntranslated grava activity no lead; aplicar ao contato audita o contato", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    await s.asAdmin.mutation(api.translation.sendUntranslated, { messageId: id });
    const acts = await t.run(async (ctx) =>
      ctx.db.query("activities").withIndex("by_lead_and_created", (q) => q.eq("leadId", s.leadId)).collect()
    );
    expect(acts.some((a) => (a.metadata as any)?.sentUntranslated === true && a.content?.includes("sem tradução"))).toBe(true);
    await s.asAdmin.mutation(api.translation.setConversationLanguage, {
      conversationId: s.conversationId, lang: "en", mode: "manual", applyToContact: true,
    });
    const contactAudits = await auditsOf(t, "contact", s.contactId);
    expect(contactAudits).toHaveLength(1);
    expect(contactAudits[0].changes?.after).toMatchObject({ preferredLanguage: "en", languageSource: "manual" });
    await cancelPendingJobs(t);
  });
});

describe("#7 RBAC e cross-org", () => {
  test("outra org: sendUntranslated, retryOutbound, translateMessage, preview e setConversationLanguage recusados", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const out = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    const inbound = await receive(t, s, ES);
    const other = await memberOf(t, s.organizationId, { otherOrg: true });
    await expect(other.mutation(api.translation.sendUntranslated, { messageId: out })).rejects.toThrow();
    await expect(other.mutation(api.translation.retryOutbound, { messageId: out })).rejects.toThrow();
    await expect(other.action(api.translation.translateMessage, { messageId: inbound })).rejects.toThrow();
    await expect(other.action(api.translation.preview, { conversationId: s.conversationId, text: PT_OUT })).rejects.toThrow();
    await expect(
      other.mutation(api.translation.setConversationLanguage, { conversationId: s.conversationId, lang: "en", mode: "manual" })
    ).rejects.toThrow();
    expect((await getMsg(t, out)).metadata?.translation).toMatchObject({ status: "pending" });
    await cancelPendingJobs(t);
  });

  test("membro só com inbox:view_own não reenvia nem muda o idioma; com reply pode", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const out = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT });
    const viewer = await memberOf(t, s.organizationId, { inbox: "view_own" });
    await expect(viewer.mutation(api.translation.sendUntranslated, { messageId: out })).rejects.toThrow();
    await expect(viewer.mutation(api.translation.retryOutbound, { messageId: out })).rejects.toThrow();
    await expect(
      viewer.mutation(api.translation.setConversationLanguage, { conversationId: s.conversationId, mode: "off" })
    ).rejects.toThrow();
    const replier = await memberOf(t, s.organizationId, { inbox: "reply" });
    await replier.mutation(api.translation.sendUntranslated, { messageId: out });
    expect((await getMsg(t, out)).metadata?.translation).toMatchObject({ status: "skipped" });
    await cancelPendingJobs(t);
  });
});

describe("#8 REST /conversations/send", () => {
  const API_KEY = "hnb_test_translation_review_1";
  async function sha256Hex(input: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  test("language inválido ou translation com idioma fora do catálogo = 400; válido = 201", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    await t.run(async (ctx) =>
      ctx.db.insert("apiKeys", {
        organizationId: s.organizationId, teamMemberId: s.adminId, name: "k",
        keyHash: await sha256Hex(API_KEY), isActive: true, createdAt: Date.now(),
      })
    );
    const post = (body: unknown) =>
      t.fetch("/api/v1/conversations/send", {
        method: "POST", headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    const bad = await post({ conversationId: s.conversationId, content: PT_OUT, language: "klingon" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/language inválido.*pt-BR/);
    expect((await post({ conversationId: s.conversationId, content: PT_OUT, language: 42 })).status).toBe(400);
    const badT = await post({
      conversationId: s.conversationId, content: ES_OUT, translation: { authoredText: PT_OUT, sourceLang: "pt-BR", targetLang: "xx" },
    });
    expect(badT.status).toBe(400);
    expect((await post({ conversationId: s.conversationId, content: PT_OUT, language: "off" })).status).toBe(201);
    expect((await post({ conversationId: s.conversationId, content: PT_OUT, language: "EN" })).status).toBe(201);
    await cancelPendingJobs(t);
  });
});

describe("#3 rascunho da IA editado pelo humano", () => {
  async function insertDraft(t: T, s: Awaited<ReturnType<typeof seed>>, content: string) {
    return await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "internal",
        senderId: s.aiId, senderType: "ai", content, contentType: "text", isInternal: true, createdAt: Date.now(),
        metadata: { aiDraft: { status: "pending", proposedActions: [] } },
      })
    );
  }

  test("editado em pt-BR numa conversa em espanhol: sai traduzido", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    vi.stubGlobal("fetch", vi.fn(async () => ltResponse(ES_OUT)));
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const draft = await insertDraft(t, s, "¡Hola! El apartamento cuesta 500 mil.");
    const id = await s.asAdmin.mutation(api.attendant.acceptAiDraft, { draftMessageId: draft, editedText: PT_OUT });
    let m = await getMsg(t, id);
    expect(m.metadata?.aiDraft).toMatchObject({ edited: true, editedInTeamLanguage: true });
    expect(m.metadata?.translation).toMatchObject({ status: "pending", role: "outbound", targetLang: "es" });
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(0);
    await runTranslationJobs(t);
    m = await getMsg(t, id);
    expect(m).toMatchObject({ content: ES_OUT, translatedText: PT_OUT, senderType: "ai" });
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(1);
    await cancelPendingJobs(t);
  });

  test("aprovado sem edição (no idioma do lead): sai como a IA escreveu", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const draft = await insertDraft(t, s, ES_OUT);
    const id = await s.asAdmin.mutation(api.attendant.acceptAiDraft, { draftMessageId: draft });
    const m = await getMsg(t, id);
    expect(m.content).toBe(ES_OUT);
    expect(m.metadata?.aiDraft?.editedInTeamLanguage).toBeUndefined();
    expect((m.metadata?.translation as any)?.role).not.toBe("outbound");
    expect((await scheduledNames(t)).filter(isWaDispatch)).toHaveLength(1);
    await cancelPendingJobs(t);
  });
});

describe("#9 módulo desligado / grupo ignoram os args", () => {
  test("org sem módulo: translation e language não escrevem nada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { convLang: "es" });
    const a = await s.asAdmin.mutation(api.conversations.sendMessage, {
      conversationId: s.conversationId, content: ES_OUT, translation: { authoredText: PT_OUT, sourceLang: "pt-BR", targetLang: "es" },
    });
    const b = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT, language: "off" });
    const c = await s.asAdmin.mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: PT_OUT, language: "klingon" });
    for (const id of [a, b, c]) {
      const m = await getMsg(t, id);
      expect(m.translatedText).toBeUndefined();
      expect(m.metadata?.translation).toBeUndefined();
      expect(m.metadata?.translationTarget).toBeUndefined();
    }
    await cancelPendingJobs(t);
  });

  test("conversa de grupo: nenhum campo de tradução (módulo ligado)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    const res = await t.run(async (ctx) => {
      const conv = (await ctx.db.get(s.conversationId))!;
      return await translationInsertFieldsFor(
        ctx,
        { ...conv, kind: "group" },
        { metadata: { replyTo: "x" } },
        { translation: { authoredText: PT_OUT, sourceLang: "pt-BR", targetLang: "es" }, language: "off" },
        1
      );
    });
    expect(res).toEqual({ fields: { metadata: { replyTo: "x" } } });
  });
});

describe("#10 custo do inbound com o módulo ligado", () => {
  test("pt-BR (ou curta) numa conversa sem idioma estrangeiro: zero job, zero escrita", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    const before = await t.run(async (ctx) => (await ctx.db.get(s.contactId))!);
    const a = await receive(t, s, "Olá, boa tarde! Vocês têm disponibilidade para o fim de semana?");
    const b = await receive(t, s, "ok");
    expect((await scheduledNames(t)).some(isTranslationJob)).toBe(false);
    for (const id of [a, b]) expect((await getMsg(t, id)).metadata?.translation).toBeUndefined();
    expect((await t.run(async (ctx) => (await ctx.db.get(s.conversationId))!)).translation).toBeUndefined();
    expect((await t.run(async (ctx) => (await ctx.db.get(s.contactId))!)).preferredLanguage).toBe(before.preferredLanguage);
    await cancelPendingJobs(t);
  });
});

describe("#11 1º idioma da conversa", () => {
  test("sem evidência: traduz a mensagem mas só marca candidato; a 2ª consecutiva fixa conversa e contato", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    vi.stubGlobal("fetch", vi.fn(async () => ltResponse("Olá, quero o preço por favor")));
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true });
    // DDI brasileiro: nenhuma concordância com o espanhol.
    await t.run(async (ctx) => ctx.db.patch(s.contactId, { phone: "5581999990000" }));
    const short = "Hola, quiero el precio por favor"; // < 40 letras
    const first = await receive(t, s, short);
    await runTranslationJobs(t);
    expect((await getMsg(t, first)).metadata?.translation).toMatchObject({ status: "done", sourceLang: "es" });
    let conv = await t.run(async (ctx) => (await ctx.db.get(s.conversationId))!);
    expect(conv.translation?.lang).toBeUndefined();
    expect(conv.translation).toMatchObject({ candidateLang: "es", divergentStreak: 1 });
    expect((await t.run(async (ctx) => (await ctx.db.get(s.contactId))!)).preferredLanguage).toBeUndefined();

    await receive(t, s, "Hola, quiero el precio del piso");
    await runTranslationJobs(t);
    conv = await t.run(async (ctx) => (await ctx.db.get(s.conversationId))!);
    expect(conv.translation).toMatchObject({ lang: "es", source: "auto" });
    expect((await t.run(async (ctx) => (await ctx.db.get(s.contactId))!))).toMatchObject({ preferredLanguage: "es", languageSource: "auto" });
    await cancelPendingJobs(t);
  });
});

describe("#15 Traduzir mesmo assim", () => {
  test("force numa inbound detectada como pt-BR chama o provedor com source auto", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const fetchSpy = vi.fn(async () => ltResponse("Olá, tudo bem com vocês?", "es"));
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const id = await receive(t, s, "Olá, boa tarde! Vocês têm disponibilidade para o fim de semana?");
    await runTranslationJobs(t);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getMsg(t, id)).metadata?.translation).toMatchObject({ status: "skipped", reason: "same_language" });
    const res = await s.asAdmin.action(api.translation.translateMessage, { messageId: id });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ source: "auto" });
    expect(res.status).toBe("done");
    await cancelPendingJobs(t);
  });
});

describe("#2 prévia", () => {
  test("motivo em todo skipped; same_language só com detecção forte", async () => {
    vi.stubEnv("LIBRETRANSLATE_URL", LT_URL);
    const fetchSpy = vi.fn(async () => ltResponse("Hola, ¿todo bien?"));
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: true, convLang: "es" });
    const p = (text: string) => s.asAdmin.action(api.translation.preview, { conversationId: s.conversationId, text });
    expect(await p("   ")).toMatchObject({ skipped: true, reason: "no_text" });
    expect(await p(LONG_PT)).toMatchObject({ skipped: true, reason: "long_text" });
    expect(await p(ES)).toMatchObject({ skipped: true, reason: "same_language" });
    // Curta demais para detectar: traduz normalmente (nunca "já está em espanhol").
    expect(await p("Olá, tudo bem?")).toMatchObject({ skipped: false });
    await t.run(async (ctx) => ctx.db.patch(s.conversationId, { translation: { lang: "es", mode: "off" } }));
    expect(await p(PT_OUT)).toMatchObject({ skipped: true, reason: "language_off" });
  });
});
