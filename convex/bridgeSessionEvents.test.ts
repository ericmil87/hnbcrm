/// <reference types="vite/client" />
/**
 * T02 — ban/logout/cliente desatualizado do bridge + cron de saúde.
 * Fixture SINTÉTICA (ver o `_fixture` do JSON): ainda não capturada do gateway.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { parseBridgeEvent } from "./lib/bridgeParse";
import {
  decideCronObservation,
  describeSessionEvent,
  maskPhoneDisplay,
  UNHEALTHY_PERSIST_MS,
} from "./lib/channelHealthSignals";
import fixtures from "./__fixtures__/bridgeSessionEvents.json";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
  // A org semeada assina webhooks ("*"); quando um teste avança o relógio a
  // action de webhook roda — responde 200 na hora (sem rede, sem o backoff de
  // 2/5 s que nunca andaria sob relógio falso). Testes que sondam o gateway
  // sobrescrevem este stub.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("parser", () => {
  test("LoggedOut vira session_event com o código", () => {
    expect(parseBridgeEvent(fixtures.loggedOut)).toEqual({
      kind: "session_event",
      session: { event: "LoggedOut", code: 401 },
    });
  });

  test("TemporaryBan converte Expire (ns) em ms", () => {
    expect(parseBridgeEvent(fixtures.temporaryBan)).toEqual({
      kind: "session_event",
      session: { event: "TemporaryBan", code: 104, expiresInMs: 86_400_000 },
    });
  });

  test("ClientOutdated com corpo vazio ainda é reconhecido", () => {
    expect(parseBridgeEvent(fixtures.clientOutdated)).toEqual({
      kind: "session_event",
      session: { event: "ClientOutdated" },
    });
  });

  test("Disconnected/Connected seguem ignorados (transitórios)", () => {
    expect(parseBridgeEvent({ type: "Disconnected", event: {} }).kind).toBe("ignored");
    expect(parseBridgeEvent({ type: "Connected", event: {} }).kind).toBe("ignored");
  });
});

describe("puros", () => {
  test("describeSessionEvent calcula expiresAt e mapeia o motivo", () => {
    const d = describeSessionEvent({ event: "TemporaryBan", code: 104, expiresInMs: 7_200_000 }, 1000);
    expect(d.state).toBe("temporarily_banned");
    expect(d.expiresAt).toBe(1000 + 7_200_000);
    expect(d.detail).toContain("mesma mensagem");
    expect(describeSessionEvent({ event: "LoggedOut" }, 0).state).toBe("logged_out");
    expect(describeSessionEvent({ event: "ClientOutdated" }, 0).state).toBe("outdated");
  });

  test("maskPhoneDisplay mostra só os 4 últimos e some em self-hosted", () => {
    expect(maskPhoneDisplay("+55 11 94499-8753")).toBe("••••8753");
    expect(maskPhoneDisplay(undefined)).toBe("");
  });

  test("decideCronObservation: marca, alerta só se persistir, não repete", () => {
    const base = { storedState: "connected", alertedAt: undefined, now: 100 * 60_000 };
    expect(decideCronObservation({ ...base, connected: true, unhealthySince: 5 }).action).toBe("clear");
    expect(decideCronObservation({ ...base, connected: false, unhealthySince: undefined }).action).toBe("mark");
    // 1ª observação recente demais (queda transitória): nada.
    expect(
      decideCronObservation({ ...base, connected: false, unhealthySince: base.now - 60_000 }).action
    ).toBe("none");
    expect(
      decideCronObservation({ ...base, connected: false, unhealthySince: base.now - UNHEALTHY_PERSIST_MS }).action
    ).toBe("alert");
    expect(
      decideCronObservation({ ...base, connected: false, unhealthySince: 1, alertedAt: 2 }).action
    ).toBe("none");
    // webhook já gravou estado grave: o cron não rebaixa nem repete.
    expect(
      decideCronObservation({ ...base, storedState: "logged_out", connected: false, unhealthySince: 1 }).action
    ).toBe("none");
  });
});

async function cancelPendingJobs(t: TestConvex<typeof schema>) {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
}

async function seed(t: TestConvex<typeof schema>, opts?: { demo?: boolean }) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", ...(opts?.demo ? { demoMode: true } : {}) },
      createdAt: now,
      updatedAt: now,
    });
    const adminUser = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUser,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const agentUser = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId: agentUser,
      name: "Agente",
      role: "agent",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "WhatsApp Loja",
      bridgeBaseUrl: "https://wa-gw.example.test",
      bridgeInstanceId: "inst_loja",
      bridgeTokenEncrypted: "cifrado",
      bridgeTokenLast4: "aaaa",
      bridgePhone: "5511944998753",
      bridgeSessionState: "connected",
      bridgeConnectedAt: now,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const campaignId = await ctx.db.insert("campaigns", {
      organizationId,
      name: "Disparo",
      status: "running",
      channelConfigId: configId,
      provider: "bridge",
      content: { kind: "text", variants: [{ text: "oi" }] },
      audience: { source: "manual" },
      schedule: { timezone: "America/Sao_Paulo", windowStartHour: 9, windowEndHour: 20, days: [1, 2, 3, 4, 5] },
      pacing: { minDelaySec: 1, maxDelaySec: 3, batchSize: 0, batchPauseMin: 0, maxPerHour: 100, maxPerDay: 200 },
      safeMode: true,
      safety: { checkNumbersFirst: false },
      stats: { total: 1, pending: 1, queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0, optedOut: 0, consecutiveFailures: 0 },
      createdBy: adminId,
      createdAt: now,
      updatedAt: now,
    });
    // Gate de webhooks (lib/webhookDispatch): sem assinante ATIVO na org nada
    // é agendado — os testes daqui afirmam os eventos, então a org assina "*".
    await ctx.db.insert("webhooks", {
      organizationId,
      name: "Assinante de teste",
      url: "https://example.test/hook",
      events: ["*"],
      secret: "segredo-de-teste",
      isActive: true,
      createdAt: now,
    });
    return { organizationId, configId, campaignId, adminId };
  });
}

async function notifications(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("notifications").collect()).filter((n) => n.type === "channel_session_lost")
  );
}

async function sessionLostWebhooks(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter(
      (j) => j.name.includes("triggerWebhooks") && JSON.stringify(j.args).includes("channel.session_lost")
    );
  });
}

describe("webhook session_event", () => {
  test("LoggedOut grava estado, pausa campanha, audita, notifica admin e agenda webhook — e a repetição não duplica", async () => {
    const t = convexTest(schema, modules);
    const { configId, campaignId, organizationId, adminId } = await seed(t);

    const r1 = await t.mutation(internal.channelHealth.internalRecordSessionEvent, {
      configId,
      event: "LoggedOut",
      code: 401,
    });
    expect(r1.emitted).toBe(true);

    const cfg = await t.run(async (ctx) => ctx.db.get(configId));
    expect(cfg?.bridgeSessionState).toBe("logged_out");
    expect(cfg?.bridgeSessionDetail).toContain("desconectado");
    // O emissor não toca em `status`: o webhook de entrada só aceita canal "active".
    expect(cfg?.status).toBe("active");
    const routed = await t.query(internal.channelConfigs.internalGetConfigByBridgeInstanceId, {
      bridgeInstanceId: "inst_loja",
    });
    expect(routed?.status).toBe("active");

    const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
    expect(campaign?.status).toBe("paused");

    const notifs = await notifications(t);
    expect(notifs).toHaveLength(1); // só quem tem settings:manage (o agente não)
    expect(notifs[0].memberId).toBe(adminId);
    expect(notifs[0].organizationId).toBe(organizationId);

    const audits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityType === "channelConfig")
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].severity).toBe("high");

    const hooks = await sessionLostWebhooks(t);
    expect(hooks).toHaveLength(1);
    expect(JSON.stringify(hooks[0].args)).toContain("••••8753");
    expect(JSON.stringify(hooks[0].args)).not.toContain("5511944998753");

    // Repetição (o LoggedOut volta a cada reconexão): nada de nova notificação.
    const r2 = await t.mutation(internal.channelHealth.internalRecordSessionEvent, {
      configId,
      event: "LoggedOut",
    });
    expect(r2.emitted).toBe(false);
    expect(await notifications(t)).toHaveLength(1);
    expect(await sessionLostWebhooks(t)).toHaveLength(1);
    await cancelPendingJobs(t);
  });

  test("TemporaryBan grava expiresAt; mudar de estado volta a notificar", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    const now = Date.now();
    await t.mutation(internal.channelHealth.internalRecordSessionEvent, {
      configId,
      event: "TemporaryBan",
      code: 104,
      expiresInMs: 3_600_000,
    });
    const cfg = await t.run(async (ctx) => ctx.db.get(configId));
    expect(cfg?.bridgeSessionState).toBe("temporarily_banned");
    expect(cfg?.bridgeSessionExpiresAt).toBe(now + 3_600_000);

    await t.mutation(internal.channelHealth.internalRecordSessionEvent, { configId, event: "LoggedOut" });
    expect(await notifications(t)).toHaveLength(2);
    await cancelPendingJobs(t);
  });

  test("publicação de grupo ativa do canal é pausada com o motivo", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, adminId } = await seed(t);
    const postId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("groupPosts", {
        organizationId,
        name: "Bom dia",
        status: "active",
        channelConfigId: configId,
        targets: [],
        schedule: { times: ["09:00"], days: [1, 2, 3, 4, 5], timezone: "America/Sao_Paulo" },
        content: { kind: "library", library: { items: [{ text: "bom dia" }], order: "sequential" } },
        stats: { sent: 0, skipped: 0, failed: 0 },
        createdBy: adminId,
        createdAt: now,
        updatedAt: now,
      });
    });
    await t.mutation(internal.channelHealth.internalRecordSessionEvent, { configId, event: "ClientOutdated" });
    const post = await t.run(async (ctx) => ctx.db.get(postId));
    expect(post?.status).toBe("paused");
    expect(post?.pausedReason).toContain("desatualizado");
    await cancelPendingJobs(t);
  });

  test("reconectar limpa os marcadores e a próxima queda notifica de novo", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    await t.mutation(internal.channelHealth.internalRecordSessionEvent, { configId, event: "LoggedOut" });
    await t.mutation(internal.channelConfigs.internalRecordHealthCheck, {
      configId,
      ok: true,
      healthDetail: "Conectado",
      bridgeSessionState: "connected",
    });
    const cfg = await t.run(async (ctx) => ctx.db.get(configId));
    expect(cfg?.bridgeSessionAlertedAt).toBeUndefined();
    expect(cfg?.bridgeSessionState).toBe("connected");
    await t.mutation(internal.channelHealth.internalRecordSessionEvent, { configId, event: "LoggedOut" });
    expect(await notifications(t)).toHaveLength(2);
    await cancelPendingJobs(t);
  });

  test("respeita a preferência de opt-out do membro", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, adminId } = await seed(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("notificationPreferences", {
        organizationId,
        teamMemberId: adminId,
        invite: true,
        handoffRequested: true,
        handoffResolved: true,
        taskOverdue: true,
        taskAssigned: true,
        leadAssigned: true,
        newMessage: true,
        dailyDigest: true,
        channelSessionLost: false,
        createdAt: now,
        updatedAt: now,
      } as any);
    });
    await t.mutation(internal.channelHealth.internalRecordSessionEvent, { configId, event: "LoggedOut" });
    expect(await notifications(t)).toHaveLength(0);
    await cancelPendingJobs(t);
  });
});

describe("cron: observação fora do ar", () => {
  test("1ª observação só marca; a 2ª, depois do intervalo, alerta UMA vez; repetição não notifica", async () => {
    const t = convexTest(schema, modules);
    const { configId, campaignId } = await seed(t);
    const obs = () =>
      t.mutation(internal.channelHealth.internalApplyUnhealthyObservation, {
        configId,
        healthDetail: "Sessão pareada — reconectando ao WhatsApp…",
      });

    expect((await obs()).action).toBe("mark");
    expect(await notifications(t)).toHaveLength(0);

    // Logo em seguida (execução colada): ainda não persistiu.
    expect((await obs()).action).toBe("none");

    vi.advanceTimersByTime(15 * 60_000);
    expect((await obs()).action).toBe("alert");
    expect(await notifications(t)).toHaveLength(1);
    const cfg = await t.run(async (ctx) => ctx.db.get(configId));
    expect(cfg?.bridgeSessionState).toBe("disconnected");
    expect((await t.run(async (ctx) => ctx.db.get(campaignId)))?.status).toBe("paused");

    vi.advanceTimersByTime(15 * 60_000);
    expect((await obs()).action).toBe("none");
    expect(await notifications(t)).toHaveLength(1);
    expect(await sessionLostWebhooks(t)).toHaveLength(1);
    await cancelPendingJobs(t);
  });

  test("conectar no meio limpa a marca (queda transitória não alerta)", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    await t.mutation(internal.channelHealth.internalApplyUnhealthyObservation, { configId, healthDetail: "x" });
    await t.mutation(internal.channelConfigs.internalRecordHealthCheck, {
      configId,
      ok: true,
      healthDetail: "Conectado",
      bridgeSessionState: "connected",
    });
    vi.advanceTimersByTime(20 * 60_000);
    const r = await t.mutation(internal.channelHealth.internalApplyUnhealthyObservation, {
      configId,
      healthDetail: "x",
    });
    expect(r.action).toBe("mark"); // recomeça a contagem
    expect(await notifications(t)).toHaveLength(0);
    await cancelPendingJobs(t);
  });

  test("não rebaixa um estado grave já gravado pelo webhook", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    await t.mutation(internal.channelHealth.internalRecordSessionEvent, { configId, event: "TemporaryBan" });
    vi.advanceTimersByTime(30 * 60_000);
    await t.mutation(internal.channelHealth.internalApplyUnhealthyObservation, { configId, healthDetail: "x" });
    const cfg = await t.run(async (ctx) => ctx.db.get(configId));
    expect(cfg?.bridgeSessionState).toBe("temporarily_banned");
    expect(await notifications(t)).toHaveLength(1);
    await cancelPendingJobs(t);
  });
});

describe("cenário B e isolamento", () => {
  test("cron alerta disconnected; depois chega LoggedOut → estado sobe e re-notifica", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    const obs = () =>
      t.mutation(internal.channelHealth.internalApplyUnhealthyObservation, { configId, healthDetail: "x" });
    await obs();
    vi.advanceTimersByTime(15 * 60_000);
    expect((await obs()).action).toBe("alert");
    expect(await notifications(t)).toHaveLength(1);
    await t.mutation(internal.channelHealth.internalRecordSessionEvent, { configId, event: "LoggedOut" });
    const cfg = await t.run(async (ctx) => ctx.db.get(configId));
    expect(cfg?.bridgeSessionState).toBe("logged_out");
    expect(await notifications(t)).toHaveLength(2); // o estado mudou
    await cancelPendingJobs(t);
  });

  test("sonda dizendo banned grava banned", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    const obs = () =>
      t.mutation(internal.channelHealth.internalApplyUnhealthyObservation, {
        configId,
        healthDetail: "x",
        probedState: "banned",
      });
    await obs();
    vi.advanceTimersByTime(15 * 60_000);
    await obs();
    expect((await t.run(async (ctx) => ctx.db.get(configId)))?.bridgeSessionState).toBe("banned");
    await cancelPendingJobs(t);
  });

  test("admin de OUTRA org não é notificado; admin 'busy' é", async () => {
    const t = convexTest(schema, modules);
    const { configId, adminId } = await seed(t);
    const otherAdmin = await t.run(async (ctx) => {
      const now = Date.now();
      const org2 = await ctx.db.insert("organizations", {
        name: "Outra",
        slug: "outra",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now,
        updatedAt: now,
      });
      const u = await ctx.db.insert("users", {});
      await ctx.db.patch(adminId, { status: "busy" });
      return await ctx.db.insert("teamMembers", {
        organizationId: org2,
        userId: u,
        name: "Estranho",
        role: "admin",
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    });
    await t.mutation(internal.channelHealth.internalRecordSessionEvent, { configId, event: "LoggedOut" });
    const notifs = await notifications(t);
    expect(notifs.map((n) => n.memberId)).toEqual([adminId]);
    expect(notifs.some((n) => n.memberId === otherAdmin)).toBe(false);
    await cancelPendingJobs(t);
  });
});

describe("cron: listagem de canais", () => {
  test("pula Meta, desativado, nunca conectado e org demo", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId } = await seed(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      const base = {
        organizationId,
        channel: "whatsapp" as const,
        displayName: "x",
        createdAt: now,
        updatedAt: now,
      };
      await ctx.db.insert("channelConfigs", { ...base, provider: "meta", status: "active" });
      await ctx.db.insert("channelConfigs", {
        ...base,
        provider: "bridge",
        status: "disabled",
        bridgeBaseUrl: "https://x",
        bridgeInstanceId: "inst_disabled",
        bridgeTokenEncrypted: "c",
        bridgeConnectedAt: now,
      });
      await ctx.db.insert("channelConfigs", {
        ...base,
        provider: "bridge",
        status: "active",
        bridgeBaseUrl: "https://x",
        bridgeInstanceId: "inst_qr",
        bridgeTokenEncrypted: "c",
        bridgeSessionState: "qr",
      });
    });
    const page = await t.query(internal.channelHealth.internalListBridgeChannelsPage, {
      cursor: null,
      numItems: 50,
    });
    expect(page.targets.map((x) => x.configId)).toEqual([configId as Id<"channelConfigs">]);
    // O alvo da sonda vem na própria página (sem releitura por canal).
    expect(page.targets[0]).toMatchObject({
      baseUrl: "https://wa-gw.example.test",
      tokenEncrypted: "cifrado",
    });

    const demo = convexTest(schema, modules);
    await seed(demo, { demo: true });
    const demoPage = await demo.query(internal.channelHealth.internalListBridgeChannelsPage, {
      cursor: null,
      numItems: 50,
    });
    expect(demoPage.targets).toHaveLength(0);
    await cancelPendingJobs(t);
  });
});

describe("cron: tick sonda só os bridge elegíveis", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("canal Meta e bridge desativado não são sondados; bridge normal é", async () => {
    vi.stubEnv("CHANNEL_ENCRYPTION_KEY", btoa("A".repeat(32)));
    const { encryptSecret } = await import("./lib/secretCrypto");
    const t = convexTest(schema, modules);
    const { configId, organizationId } = await seed(t);
    const tokenEncrypted = await encryptSecret("tok-loja");
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(configId, { bridgeTokenEncrypted: tokenEncrypted });
      const base = {
        organizationId,
        channel: "whatsapp" as const,
        displayName: "x",
        createdAt: now,
        updatedAt: now,
      };
      // Meta com campos de bridge de sobra: ainda assim nunca é sondado.
      await ctx.db.insert("channelConfigs", {
        ...base,
        provider: "meta",
        status: "active",
        bridgeBaseUrl: "https://meta.example.test",
        bridgeInstanceId: "inst_meta",
        bridgeTokenEncrypted: tokenEncrypted,
        bridgeConnectedAt: now,
      });
      await ctx.db.insert("channelConfigs", {
        ...base,
        provider: "bridge",
        status: "disabled",
        bridgeBaseUrl: "https://disabled.example.test",
        bridgeInstanceId: "inst_off",
        bridgeTokenEncrypted: tokenEncrypted,
        bridgeConnectedAt: now,
      });
    });

    const probed: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        probed.push(String(url));
        return new Response(
          JSON.stringify({ success: true, data: { Connected: true, LoggedIn: true, Jid: "" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const result = await t.action(internal.channelHealth.internalChannelHealthTick, {});
    expect(result).toEqual({ checked: 1, probeErrors: 0 });
    expect(probed).toEqual(["https://wa-gw.example.test/session/status"]);
    await cancelPendingJobs(t);
  });
});

describe("cron: canal desativado entre a página e a sonda não reivindica o número", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function seedRival(t: TestConvex<typeof schema>) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const orgY = await ctx.db.insert("organizations", {
        name: "Org Y",
        slug: "org-y",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.insert("channelConfigs", {
        organizationId: orgY,
        channel: "whatsapp",
        provider: "bridge",
        displayName: "WhatsApp Y",
        bridgeBaseUrl: "https://wa-gw.example.test",
        bridgeInstanceId: "inst_y",
        bridgeTokenEncrypted: "cifrado-y",
        bridgeTokenLast4: "bbbb",
        bridgePhone: "5511944998753",
        bridgeSessionState: "connected",
        bridgeConnectedAt: now,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  async function logoutJobs(t: TestConvex<typeof schema>) {
    return await t.run(async (ctx) => {
      const jobs = await ctx.db.system.query("_scheduled_functions").collect();
      return jobs.filter((j) => j.name.includes("internalLogoutBridgeInstance"));
    });
  }

  test("gateway ainda diz connected: o rival segue active e nenhum logout é agendado", async () => {
    vi.stubEnv("CHANNEL_ENCRYPTION_KEY", btoa("A".repeat(32)));
    const { encryptSecret } = await import("./lib/secretCrypto");
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    const tokenEncrypted = await encryptSecret("tok-loja");
    // A (org X) ainda não estava "connected" no doc — o pior caso: sem a guarda,
    // a sonda veria a TRANSIÇÃO e chamaria claimBridgePhone(A).
    await t.run(async (ctx) => {
      await ctx.db.patch(configId, { bridgeTokenEncrypted: tokenEncrypted, bridgeSessionState: "disconnected" });
    });
    const rivalId = await seedRival(t);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // Entre a leitura da página e a resposta da sonda, A é desativado
        // (pelo claim da org Y ao parear o mesmo número).
        await t.run(async (ctx) => {
          await ctx.db.patch(configId, { status: "disabled" });
        });
        return new Response(
          JSON.stringify({
            success: true,
            data: { Connected: true, LoggedIn: true, Jid: "5511944998753.0:1@s.whatsapp.net" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    await t.action(internal.channelHealth.internalChannelHealthTick, {});

    const [a, rival] = await t.run(async (ctx) => [await ctx.db.get(configId), await ctx.db.get(rivalId)]);
    expect(rival?.status).toBe("active");
    expect(a?.status).toBe("disabled");
    // `skipIfDisabled`: o canal desativado não recebe nem o estado sondado.
    expect(a?.bridgeSessionState).toBe("disconnected");
    expect(await logoutJobs(t)).toHaveLength(0);
    await cancelPendingJobs(t);
  });

  test("'Testar conexão' (forceStamp) num canal desativado também não reivindica", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(configId, { status: "disabled" });
    });
    const rivalId = await seedRival(t);

    const displaced = await t.mutation(internal.channelConfigs.internalRecordHealthCheck, {
      configId,
      ok: true,
      healthDetail: "Conectado",
      bridgeSessionState: "connected",
      bridgePhone: "5511944998753",
      forceStamp: true,
    });
    expect(displaced).toEqual([]);
    const rival = await t.run(async (ctx) => await ctx.db.get(rivalId));
    expect(rival?.status).toBe("active");
    expect(await logoutJobs(t)).toHaveLength(0);
    await cancelPendingJobs(t);
  });

  test("bridge sem bridgeInstanceId fica fora da sonda (todo bridge criado tem instância)", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    // `createChannelConfig` recusa bridge sem `bridgeInstanceId` (channelConfigs.ts,
    // ramo "provider === bridge"), então o índice `by_bridge_instance` cobre
    // todo canal bridge real; um doc legado/anômalo sem instância nem é lido.
    await t.run(async (ctx) => {
      await ctx.db.patch(configId, { bridgeInstanceId: undefined });
    });
    const page = await t.query(internal.channelHealth.internalListBridgeChannelsPage, {
      cursor: null,
      numItems: 50,
    });
    expect(page.targets).toHaveLength(0);
    await cancelPendingJobs(t);
  });
});
