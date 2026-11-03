/// <reference types="vite/client" />
/**
 * Presença global do bridge: o celular do cliente continua tocando.
 *
 * O wuzapi anuncia `available` a cada `Connected`, e o WhatsApp silencia o
 * celular enquanto um aparelho vinculado está "available". O CRM anuncia
 * `unavailable` por padrão (`bridgePhoneNotifications` ausente/true) e só
 * `available` quando o canal desliga explicitamente (false).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildBridgeGlobalPresenceRequest, desiredBridgePresence } from "./lib/bridgeSend";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

// base64 de 32 bytes — chave determinística de teste, não é segredo real
const TEST_KEY = btoa("A".repeat(32));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Call = { url: string; method: string; body?: string; token?: string };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Gateway falso: status conectado; `/user/presence` responde `presenceStatus`. */
function stubGateway(opts?: { presenceStatus?: number }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
        token: headers.token,
      });
      if (String(url).endsWith("/user/presence")) {
        const status = opts?.presenceStatus ?? 200;
        return status === 200
          ? jsonResponse({ code: 200, success: true, data: { Details: "Presence set successfuly" } })
          : jsonResponse({ code: status, success: false, error: "failure sending presence" }, status);
      }
      return jsonResponse({ success: true, data: { Connected: true, LoggedIn: true, Jid: "" } });
    })
  );
  return calls;
}

const presenceCalls = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/user/presence"));

async function cancelPendingJobs(t: TestConvex<typeof schema>) {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
}

async function presenceJobs(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((j) => j.name.includes("internalBridgeApplyPresence"));
  });
}

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", { email: "admin@test.hnbcrm.com" });
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminUserId };
  });
}

async function seedConnectedBridge(
  t: TestConvex<typeof schema>,
  organizationId: Id<"organizations">,
  extra?: { bridgePhoneNotifications?: boolean }
) {
  const { encryptSecret } = await import("./lib/secretCrypto");
  const tokenEncrypted = await encryptSecret("tok-fake-loja");
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "WhatsApp Loja",
      bridgeBaseUrl: "https://wa-gw.example.test/",
      bridgeInstanceId: "inst_loja",
      bridgeTokenEncrypted: tokenEncrypted,
      bridgeTokenLast4: "loja",
      bridgeSessionState: "connected",
      bridgeConnectedAt: now,
      status: "active",
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
  });
}

describe("puros", () => {
  test("buildBridgeGlobalPresenceRequest monta POST /user/presence com token e type minúsculo", () => {
    const req = buildBridgeGlobalPresenceRequest({
      baseUrl: "https://gw.example.test//",
      token: "tok-fake",
      type: "unavailable",
    });
    expect(req.url).toBe("https://gw.example.test/user/presence");
    expect(req.headers).toEqual({ "Content-Type": "application/json", token: "tok-fake" });
    expect(JSON.parse(req.body)).toEqual({ type: "unavailable" });
    expect(
      JSON.parse(buildBridgeGlobalPresenceRequest({ baseUrl: "https://x", token: "t", type: "available" }).body)
    ).toEqual({ type: "available" });
  });

  test("desiredBridgePresence: só false explícito volta a available", () => {
    expect(desiredBridgePresence({})).toBe("unavailable");
    expect(desiredBridgePresence({ bridgePhoneNotifications: undefined })).toBe("unavailable");
    expect(desiredBridgePresence({ bridgePhoneNotifications: true })).toBe("unavailable");
    expect(desiredBridgePresence({ bridgePhoneNotifications: false })).toBe("available");
  });
});

describe("cron de saúde reafirma a presença", () => {
  test("padrão (campo ausente) anuncia unavailable com o token decifrado", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seed(t);
    await seedConnectedBridge(t, organizationId);
    const calls = stubGateway();

    const result = await t.action(internal.channelHealth.internalChannelHealthTick, {});
    expect(result).toEqual({ checked: 1, probeErrors: 0 });
    const presence = presenceCalls(calls);
    expect(presence).toHaveLength(1);
    expect(presence[0]).toMatchObject({
      url: "https://wa-gw.example.test/user/presence",
      method: "POST",
      token: "tok-fake-loja",
    });
    expect(JSON.parse(presence[0].body!)).toEqual({ type: "unavailable" });
    await cancelPendingJobs(t);
  });

  test("bridgePhoneNotifications=false anuncia available", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seed(t);
    await seedConnectedBridge(t, organizationId, { bridgePhoneNotifications: false });
    const calls = stubGateway();

    await t.action(internal.channelHealth.internalChannelHealthTick, {});
    const presence = presenceCalls(calls);
    expect(presence).toHaveLength(1);
    expect(JSON.parse(presence[0].body!)).toEqual({ type: "available" });
    await cancelPendingJobs(t);
  });

  test("falha (500) no POST de presença não derruba o tick nem conta como erro de sonda", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seed(t);
    const configId = await seedConnectedBridge(t, organizationId);
    const calls = stubGateway({ presenceStatus: 500 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await t.action(internal.channelHealth.internalChannelHealthTick, {});
      expect(result).toEqual({ checked: 1, probeErrors: 0 });
      expect(presenceCalls(calls)).toHaveLength(1);
      const stored = await t.run(async (ctx) => ctx.db.get(configId));
      expect(stored!.bridgeSessionState).toBe("connected");
      // O log nunca carrega o token.
      expect(JSON.stringify(warn.mock.calls)).not.toContain("tok-fake-loja");
    } finally {
      warn.mockRestore();
    }
    await cancelPendingJobs(t);
  });

  test("canal fora do ar não recebe POST de presença", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seed(t);
    await seedConnectedBridge(t, organizationId);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return jsonResponse({ success: true, data: { Connected: false, LoggedIn: false } });
      })
    );
    await t.action(internal.channelHealth.internalChannelHealthTick, {});
    expect(calls).toEqual(["https://wa-gw.example.test/session/status"]);
    await cancelPendingJobs(t);
  });
});

describe("internalBridgeApplyPresence", () => {
  test("aplica a presença desejada; sai calado em canal desativado e em Meta", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seed(t);
    const configId = await seedConnectedBridge(t, organizationId, { bridgePhoneNotifications: false });
    const calls = stubGateway();

    expect(await t.action(internal.channelHealth.internalBridgeApplyPresence, { configId })).toEqual({
      applied: true,
      presence: "available",
    });
    expect(presenceCalls(calls)).toHaveLength(1);

    await t.run(async (ctx) => ctx.db.patch(configId, { status: "disabled" }));
    expect(await t.action(internal.channelHealth.internalBridgeApplyPresence, { configId })).toMatchObject({
      applied: false,
      reason: "inactive",
    });

    const metaId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("channelConfigs", {
        organizationId,
        channel: "whatsapp",
        provider: "meta",
        displayName: "Meta",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    });
    expect(await t.action(internal.channelHealth.internalBridgeApplyPresence, { configId: metaId })).toMatchObject({
      applied: false,
      reason: "not_bridge",
    });
    expect(presenceCalls(calls)).toHaveLength(1);
  });

  test("gateway com erro devolve applied:false sem lançar", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seed(t);
    const configId = await seedConnectedBridge(t, organizationId);
    stubGateway({ presenceStatus: 500 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await t.action(internal.channelHealth.internalBridgeApplyPresence, { configId });
      expect(res).toMatchObject({ applied: false, presence: "unavailable" });
      expect(res.reason).toContain("failure sending presence");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("toggle e leitura mascarada", () => {
  const BRIDGE_ARGS = {
    channel: "whatsapp" as const,
    provider: "bridge" as const,
    displayName: "Bridge number",
    bridgeBaseUrl: "https://wuzapi.example.com",
    bridgeInstanceId: "inst_fake_01",
    bridgeToken: "tok_fake_wxyz",
  };

  test("getChannelConfigs mostra bridgePhoneNotifications: true quando o campo está ausente", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, adminUserId } = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });
    const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      ...BRIDGE_ARGS,
    });
    const stored = await t.run(async (ctx) => ctx.db.get(configId));
    expect(stored!.bridgePhoneNotifications).toBeUndefined();
    const configs = await asAdmin.query(api.channelConfigs.getChannelConfigs, { organizationId });
    expect(configs[0].bridgePhoneNotifications).toBe(true);
    await cancelPendingJobs(t);
  });

  test("updateChannelConfig grava o campo, audita e aplica a presença no gateway", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, adminUserId } = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });
    const configId = await seedConnectedBridge(t, organizationId);
    const calls = stubGateway();

    await asAdmin.action(api.channelConfigs.updateChannelConfig, {
      configId,
      bridgePhoneNotifications: false,
    });
    const stored = await t.run(async (ctx) => ctx.db.get(configId));
    expect(stored!.bridgePhoneNotifications).toBe(false);

    const audit = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityId === configId)
    );
    expect(audit).toHaveLength(1);
    expect((audit[0].metadata as { changedFields: string[] }).changedFields).toEqual([
      "bridgePhoneNotifications",
    ]);
    // Booleano não é segredo: o audit guarda antes/depois (ausente = null).
    expect(audit[0].changes).toEqual({
      before: { bridgePhoneNotifications: null },
      after: { bridgePhoneNotifications: false },
    });

    const configs = await asAdmin.query(api.channelConfigs.getChannelConfigs, { organizationId });
    expect(configs[0].bridgePhoneNotifications).toBe(false);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const presence = presenceCalls(calls);
    expect(presence).toHaveLength(1);
    expect(JSON.parse(presence[0].body!)).toEqual({ type: "available" });
  });

  test("canal Meta recusa bridgePhoneNotifications (campo de bridge)", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, adminUserId } = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });
    const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId,
      channel: "whatsapp",
      displayName: "Main number",
      phoneNumberId: "111000111000111",
      wabaId: "222000222000222",
      verifyToken: "test-verify-token",
      appSecret: "fake-app-secret-abcd",
      accessToken: "EAAFakeAccessToken9876",
    });
    await expect(
      asAdmin.action(api.channelConfigs.updateChannelConfig, { configId, bridgePhoneNotifications: false })
    ).rejects.toThrow(/Campos de bridge não se aplicam a um canal Meta/);
    expect(await presenceJobs(t)).toHaveLength(0);
  });

  test("getBridgeQrCode já conectado agenda a presença ~2 s e ~30 s depois", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, adminUserId } = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });
    const configId = await seedConnectedBridge(t, organizationId);
    stubGateway();

    const before = Date.now();
    const res = await asAdmin.action(api.channelConfigs.getBridgeQrCode, { configId });
    expect(res.state).toBe("connected");
    const jobs = (await presenceJobs(t)).sort((a, b) => a.scheduledTime - b.scheduledTime);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) expect(job.args[0]).toEqual({ configId });
    expect(jobs[0].scheduledTime - before).toBeGreaterThanOrEqual(2000);
    expect(jobs[0].scheduledTime - before).toBeLessThan(30_000);
    expect(jobs[1].scheduledTime - before).toBeGreaterThanOrEqual(30_000);
    await cancelPendingJobs(t);
  });

  test("getBridgeQrCode recém-pareado (QR diz loggedIn) também agenda", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, adminUserId } = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });
    const configId = await seedConnectedBridge(t, organizationId);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/session/status")) {
          return jsonResponse({ success: true, data: { Connected: false, LoggedIn: false } });
        }
        if (String(url).endsWith("/session/qr")) {
          // Logou entre o status e o QR: sem QRCode, LoggedIn true.
          return jsonResponse({ success: true, data: { LoggedIn: true } });
        }
        return jsonResponse({ success: true, data: {} });
      })
    );
    const res = await asAdmin.action(api.channelConfigs.getBridgeQrCode, { configId });
    expect(res.state).toBe("connected");
    const jobs = await presenceJobs(t);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) expect(job.args[0]).toEqual({ configId });
    await cancelPendingJobs(t);
  });

  test("Testar conexão conectado agenda a presença", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, adminUserId } = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });
    const configId = await seedConnectedBridge(t, organizationId);
    stubGateway();
    const ok = await asAdmin.action(api.channelConfigs.checkChannelHealth, { configId });
    expect(ok.ok).toBe(true);
    expect(await presenceJobs(t)).toHaveLength(1);
    await cancelPendingJobs(t);
  });
});

describe("prazo do tick", () => {
  test("passou de 420 s: para e reagenda a MESMA página pulando os já sondados", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seed(t);
    for (let i = 0; i < 3; i++) await seedConnectedBridge(t, organizationId);
    let statusCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/session/status")) {
          statusCalls++;
          // Cada sonda "leva" 250 s: depois da 2ª o tick já passou do prazo.
          vi.setSystemTime(Date.now() + 250_000);
          return jsonResponse({ success: true, data: { Connected: true, LoggedIn: true, Jid: "" } });
        }
        return jsonResponse({ code: 200, success: true, data: {} });
      })
    );

    const result = await t.action(internal.channelHealth.internalChannelHealthTick, {});
    expect(result).toEqual({ checked: 2, probeErrors: 0 });
    expect(statusCalls).toBe(2);
    const jobs = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) =>
        j.name.includes("internalChannelHealthTick")
      )
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].args[0]).toEqual({ cursor: null, skip: 2 });

    // A retomada sonda só o canal que faltou.
    const resumed = await t.action(internal.channelHealth.internalChannelHealthTick, { cursor: null, skip: 2 });
    expect(resumed).toEqual({ checked: 1, probeErrors: 0 });
    expect(statusCalls).toBe(3);
    await cancelPendingJobs(t);
  });
});

describe("colchete de presença no digitando", () => {
  // A espera do digitando é um setTimeout real dentro da action: relógio real
  // e atraso de poucos ms.
  beforeEach(() => {
    vi.useRealTimers();
  });
  async function seedConversation(
    t: TestConvex<typeof schema>,
    extra?: { bridgePhoneNotifications?: boolean }
  ) {
    const { organizationId } = await seed(t);
    const configId = await seedConnectedBridge(t, organizationId, extra);
    return await t.run(async (ctx) => {
      const now = Date.now();
      const humanId = (await ctx.db.query("teamMembers").first())!._id;
      const aiMemberId = await ctx.db.insert("teamMembers", {
        organizationId, name: "IA", role: "ai", type: "ai", status: "active", createdAt: now, updatedAt: now,
      });
      const boardId = await ctx.db.insert("boards", {
        organizationId, name: "Default", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        organizationId, boardId, name: "New", color: "#6366f1", order: 0,
        isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
      });
      const contactId = await ctx.db.insert("contacts", {
        organizationId, firstName: "Maria", phone: "15550000001", whatsappNumber: "15550000001",
        tags: [], createdAt: now, updatedAt: now,
      });
      const leadId = await ctx.db.insert("leads", {
        organizationId, title: "Maria", contactId, boardId, stageId, value: 0, currency: "BRL",
        priority: "medium", temperature: "cold", tags: [], customFields: {},
        conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId, leadId, channel: "whatsapp", channelConfigId: configId,
        status: "active", messageCount: 0, createdAt: now, updatedAt: now,
      });
      return { configId, conversationId, aiMemberId, humanId };
    });
  }

  /** Grava a sequência (caminho + corpo) das chamadas ao gateway. */
  function stubSendGateway() {
    const seq: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (path === "/user/presence") seq.push(`presence ${body.type}`);
        else if (path === "/chat/presence") seq.push(`chat ${body.State}`);
        else seq.push(path);
        return jsonResponse({ code: 200, success: true, data: { Id: "3EB0FAKE01", Details: "Sent" } });
      })
    );
    return seq;
  }

  async function dispatchWithTyping(
    t: TestConvex<typeof schema>,
    messageId: Id<"messages">,
    typingDelayMs?: number
  ) {
    // O envio já agendou o próprio dispatch: cancela e dispara à mão.
    await cancelPendingJobs(t);
    const p = t.action(internal.whatsapp.internalDispatchMessage, {
      messageId,
      ...(typingDelayMs ? { typingDelayMs } : {}),
    });
    await p;
  }

  test("padrão: available → composing → envio → unavailable", async () => {
    const t = convexTest(schema, modules);
    const { conversationId, aiMemberId } = await seedConversation(t);
    const messageId = await t.mutation(internal.conversations.internalSendMessage, {
      conversationId, content: "Olá!", teamMemberId: aiMemberId,
    });
    const seq = stubSendGateway();
    await dispatchWithTyping(t, messageId, 5);
    expect(seq).toEqual(["presence available", "chat composing", "/chat/send/text", "presence unavailable"]);
    const msg = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(msg!.deliveryStatus).toBe("sent");
    await cancelPendingJobs(t);
  });

  test("envio que falha ainda fecha o colchete", async () => {
    const t = convexTest(schema, modules);
    const { conversationId, aiMemberId } = await seedConversation(t);
    const messageId = await t.mutation(internal.conversations.internalSendMessage, {
      conversationId, content: "Olá!", teamMemberId: aiMemberId,
    });
    const seq: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (path === "/chat/send/text") {
          seq.push(path);
          throw new Error("rede caiu");
        }
        seq.push(path === "/user/presence" ? `presence ${body.type}` : `chat ${body.State}`);
        return jsonResponse({ code: 200, success: true, data: {} });
      })
    );
    await dispatchWithTyping(t, messageId, 5);
    expect(seq).toEqual(["presence available", "chat composing", "/chat/send/text", "presence unavailable"]);
    await cancelPendingJobs(t);
  });

  test("bridgePhoneNotifications=false: nenhum /user/presence", async () => {
    const t = convexTest(schema, modules);
    const { conversationId, aiMemberId } = await seedConversation(t, { bridgePhoneNotifications: false });
    const messageId = await t.mutation(internal.conversations.internalSendMessage, {
      conversationId, content: "Olá!", teamMemberId: aiMemberId,
    });
    const seq = stubSendGateway();
    await dispatchWithTyping(t, messageId, 5);
    expect(seq).toEqual(["chat composing", "/chat/send/text"]);
    await cancelPendingJobs(t);
  });

  test("envio humano sem typingDelay: só unavailable DEPOIS do envio (sem available)", async () => {
    const t = convexTest(schema, modules);
    const { conversationId, humanId } = await seedConversation(t);
    const messageId = await t.mutation(internal.conversations.internalSendMessage, {
      conversationId, content: "Olá!", teamMemberId: humanId,
    });
    const seq = stubSendGateway();
    await dispatchWithTyping(t, messageId);
    expect(seq).toEqual(["/chat/send/text", "presence unavailable"]);
    await cancelPendingJobs(t);
  });

  test("envio humano no modo legado: nenhum /user/presence", async () => {
    const t = convexTest(schema, modules);
    const { conversationId, humanId } = await seedConversation(t, { bridgePhoneNotifications: false });
    const messageId = await t.mutation(internal.conversations.internalSendMessage, {
      conversationId, content: "Olá!", teamMemberId: humanId,
    });
    const seq = stubSendGateway();
    await dispatchWithTyping(t, messageId);
    expect(seq).toEqual(["/chat/send/text"]);
    await cancelPendingJobs(t);
  });

  test("digitando do operador: composing abre available; paused fecha unavailable", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seedConversation(t);
    const seq = stubSendGateway();
    await t.action(internal.whatsapp.internalBridgeSendPresence, {
      configId, toPhone: "15550000001", state: "composing",
    });
    await t.action(internal.whatsapp.internalBridgeSendPresence, {
      configId, toPhone: "15550000001", state: "paused",
    });
    expect(seq).toEqual(["presence available", "chat composing", "chat paused", "presence unavailable"]);
  });

  test("digitando do operador no modo legado não mexe na presença global", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seedConversation(t, { bridgePhoneNotifications: false });
    const seq = stubSendGateway();
    await t.action(internal.whatsapp.internalBridgeSendPresence, {
      configId, toPhone: "15550000001", state: "composing",
    });
    await t.action(internal.whatsapp.internalBridgeSendPresence, {
      configId, toPhone: "15550000001", state: "paused",
    });
    expect(seq).toEqual(["chat composing", "chat paused"]);
  });
});
