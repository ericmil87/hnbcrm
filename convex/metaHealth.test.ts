/// <reference types="vite/client" />
/**
 * Saúde diária da credencial Meta Messaging (F4, D8): `debug_token` → estado da
 * conexão, `emitChannelDegraded` (dedupe), purga e paginação do cron.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";
import { evaluateHealth, parseDebugToken } from "./lib/metaHealth";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  vi.stubEnv("META_MESSAGING_APP_ID", "fake-app-id");
  vi.stubEnv("META_MESSAGING_APP_SECRET", "fake-meta-app-secret");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Org = { organizationId: Id<"organizations">; memberId: Id<"teamMembers"> };

async function seedOrg(t: TestConvex<typeof schema>, opts: { demo?: boolean; webhook?: boolean } = {}): Promise<Org> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: `org-${Math.random().toString(36).slice(2, 8)}`,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        modules: { metaMessaging: true },
        ...(opts.demo ? { demoMode: true } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "a@example.test" });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Ana",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    if (opts.webhook) {
      await ctx.db.insert("webhooks", {
        organizationId,
        name: "wh",
        url: "https://example.test/hook",
        events: ["*"],
        secret: "fake-hmac-secret-1",
        isActive: true,
        createdAt: now,
      });
    }
    return { organizationId, memberId };
  });
}

/** Conexão + os dois configs (messenger e instagram). Token = `tok-<n>`. */
async function seedConnection(t: TestConvex<typeof schema>, org: Org, n: number) {
  const tokenEncrypted = await encryptSecret(`tok-${n}`);
  return await t.run(async (ctx) => {
    const now = Date.now();
    const connectionId = await ctx.db.insert("metaConnections", {
      organizationId: org.organizationId,
      authMethod: "facebook_login",
      tokenKind: "page",
      tokenEncrypted,
      tokenLast4: "0001",
      pageId: `10000000000${String(n).padStart(5, "0")}`,
      pageName: "Página",
      igAccountId: `20000000000${String(n).padStart(5, "0")}`,
      igUsername: "conta",
      scopes: [],
      authState: "ok",
      subscribedAt: now,
      connectedByMemberId: org.memberId,
      createdAt: now,
      updatedAt: now,
    });
    const messengerId = await ctx.db.insert("channelConfigs", {
      organizationId: org.organizationId,
      channel: "messenger",
      displayName: "Página",
      status: "active",
      metaConnectionId: connectionId,
      messengerPageId: `10000000000${String(n).padStart(5, "0")}`,
      createdAt: now,
      updatedAt: now,
    });
    const instagramId = await ctx.db.insert("channelConfigs", {
      organizationId: org.organizationId,
      channel: "instagram",
      displayName: "@conta",
      status: "active",
      metaConnectionId: connectionId,
      instagramAccountId: `20000000000${String(n).padStart(5, "0")}`,
      createdAt: now,
      updatedAt: now,
    });
    return { connectionId, messengerId, instagramId };
  });
}

type Debug = { is_valid: boolean; scopes?: string[]; data_access_expires_at?: number; expires_at?: number };
const GOOD_SCOPES = ["pages_messaging", "instagram_manage_messages", "pages_show_list"];

/** fetch stubado: `debug_token` por token de entrada (`tok-n`); `default` vale para os demais. */
function stubDebug(byToken: Record<string, Debug | "network" | { status: number; body: unknown }>, fallback?: Debug) {
  const urls: string[] = [];
  const fn = vi.fn(async (url: string | URL) => {
    const u = String(url);
    urls.push(u);
    const token = new URL(u).searchParams.get("input_token") ?? "";
    const r = byToken[token] ?? fallback;
    if (r === "network") throw new TypeError("fetch failed");
    if (r && "status" in r) return new Response(JSON.stringify(r.body), { status: r.status });
    if (!r) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ data: { app_id: "fake-app-id", ...r } }), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, urls };
}

async function cancelPendingJobs(t: TestConvex<typeof schema>) {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
}

async function counts(t: TestConvex<typeof schema>, connectionId: Id<"metaConnections">) {
  return await t.run(async (ctx) => {
    const notifications = (await ctx.db.query("notifications").collect()).filter(
      (n) => n.type === "channel_session_lost"
    );
    const audits = (await ctx.db.query("auditLogs").collect()).filter(
      (a) => a.entityType === "metaConnection" && a.entityId === connectionId && a.severity === "high"
    );
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    const hooks = jobs.filter(
      (j) => j.name.includes("triggerWebhooks") && JSON.stringify(j.args).includes("channel.session_lost")
    );
    return { notifications: notifications.length, audits: audits.length, hooks };
  });
}

const tick = (t: TestConvex<typeof schema>, args: { cursor?: string | null; pageSize?: number } = {}) =>
  t.action(internal.metaMessaging.internalHealthTick, args);

describe("lib/metaHealth (puro)", () => {
  test("evaluateHealth: inválido, escopo ausente, escopos vazios (desconhecido) e janela de 14 dias", () => {
    const now = 1_000_000_000_000;
    const base = { isValid: true, scopes: GOOD_SCOPES };
    expect(evaluateHealth({ observation: { ...base, isValid: false }, channels: ["messenger"], now }).kind).toBe("invalid");
    expect(
      evaluateHealth({ observation: { isValid: true, scopes: ["pages_messaging"] }, channels: ["instagram"], now }).kind
    ).toBe("missing_scope");
    // IG não exige pages_messaging e Messenger não exige o escopo do IG.
    expect(
      evaluateHealth({ observation: { isValid: true, scopes: ["instagram_manage_messages"] }, channels: ["instagram"], now }).kind
    ).toBe("ok");
    expect(evaluateHealth({ observation: { isValid: true, scopes: [] }, channels: ["messenger"], now }).kind).toBe("ok");
    const near = evaluateHealth({
      observation: { ...base, dataAccessExpiresAt: now + 10 * DAY },
      channels: ["messenger"],
      now,
    });
    expect(near).toEqual({ kind: "ok", expiring: true });
    const far = evaluateHealth({
      observation: { ...base, dataAccessExpiresAt: now + 60 * DAY },
      channels: ["messenger"],
      now,
    });
    expect(far).toEqual({ kind: "ok", expiring: false });
  });

  test("parseDebugToken: token inválido e 190 contam; app secret errado e 5xx não", () => {
    expect(parseDebugToken(200, { data: { is_valid: false } })).toMatchObject({
      kind: "observation",
      observation: { isValid: false },
    });
    expect(parseDebugToken(400, { error: { code: 190 } })).toMatchObject({ kind: "observation" });
    expect(parseDebugToken(400, { error: { code: 101 } }).kind).toBe("unavailable");
    expect(parseDebugToken(503, {}).kind).toBe("unavailable");
    const ok = parseDebugToken(200, { data: { is_valid: true, scopes: ["a"], data_access_expires_at: 2_000_000_000, expires_at: 0 } });
    expect(ok).toEqual({
      kind: "observation",
      observation: { isValid: true, scopes: ["a"], dataAccessExpiresAt: 2_000_000_000_000 },
    });
  });
});

describe("internalHealthTick", () => {
  test("debug_token inválido: reauth_required, 1 aviso, 1 audit, webhooks por config e sem re-notificar", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, { webhook: true });
    const c = await seedConnection(t, org, 1);
    const { urls } = stubDebug({ "tok-1": { is_valid: false } });

    await tick(t);
    const conn1 = await t.run((ctx) => ctx.db.get(c.connectionId));
    expect(conn1?.authState).toBe("reauth_required");
    expect(conn1?.authDetail).toBeTruthy();
    expect(conn1?.authAlertedAt).toBeTypeOf("number");
    expect(conn1?.lastHealthAt).toBeTypeOf("number");
    // O app secret vai na consulta do debug_token; o token do cliente nunca é logado/devolvido.
    expect(urls[0]).toContain("/debug_token?");

    const first = await counts(t, c.connectionId);
    expect(first.notifications).toBe(1);
    expect(first.audits).toBe(1);
    expect(first.hooks).toHaveLength(2);
    const payloads = first.hooks.map((j) => JSON.stringify(j.args));
    expect(payloads.some((p) => p.includes('"provider":"messenger"'))).toBe(true);
    expect(payloads.some((p) => p.includes('"provider":"instagram"'))).toBe(true);
    expect(payloads.join("")).not.toContain("tok-1");

    // Notificação: cópia da Página, e o status dos configs NÃO muda.
    const note = await t.run(async (ctx) => (await ctx.db.query("notifications").first())!);
    expect(note.title).toBe("Página Página / @conta precisa ser reconectada");
    const configs = await t.run(async (ctx) => [await ctx.db.get(c.messengerId), await ctx.db.get(c.instagramId)]);
    expect(configs.every((cfg) => cfg?.status === "active")).toBe(true);

    await tick(t);
    const second = await counts(t, c.connectionId);
    expect(second.notifications).toBe(1);
    expect(second.audits).toBe(1);
    expect(second.hooks).toHaveLength(2);
    await cancelPendingJobs(t);
  });

  test("escopo de mensagens ausente: reauth_required", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    const c = await seedConnection(t, org, 1);
    stubDebug({ "tok-1": { is_valid: true, scopes: ["pages_show_list", "instagram_manage_messages"] } });
    await tick(t);
    const conn = await t.run((ctx) => ctx.db.get(c.connectionId));
    expect(conn?.authState).toBe("reauth_required");
    expect(conn?.authDetail).toContain("permissão");
    await cancelPendingJobs(t);
  });

  test("válido depois de inválido: volta a ok e limpa o alerta", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    const c = await seedConnection(t, org, 1);
    stubDebug({ "tok-1": { is_valid: false } });
    await tick(t);
    stubDebug({ "tok-1": { is_valid: true, scopes: GOOD_SCOPES } });
    await tick(t);
    const conn = await t.run((ctx) => ctx.db.get(c.connectionId));
    expect(conn?.authState).toBe("ok");
    expect(conn?.authDetail).toBeUndefined();
    expect(conn?.authAlertedAt).toBeUndefined();
    // Uma NOVA queda volta a notificar (o marcador foi limpo).
    stubDebug({ "tok-1": { is_valid: false } });
    await tick(t);
    expect((await counts(t, c.connectionId)).notifications).toBe(2);
    await cancelPendingJobs(t);
  });

  test("data_access_expires_at em 10 dias: aviso informativo único, sem trocar o estado", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    const c = await seedConnection(t, org, 1);
    const exp = Math.floor((Date.now() + 10 * DAY) / 1000);
    stubDebug({ "tok-1": { is_valid: true, scopes: GOOD_SCOPES, data_access_expires_at: exp } });
    await tick(t);
    await tick(t);
    const conn = await t.run((ctx) => ctx.db.get(c.connectionId));
    expect(conn?.authState).toBe("ok");
    expect(conn?.authDetail).toBe("data_access_expiring");
    expect(conn?.dataAccessExpiresAt).toBe(exp * 1000);
    const n = await t.run(async (ctx) => await ctx.db.query("notifications").collect());
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe("Reconecte Página / @conta para manter o acesso");

    // A Meta renovou: o aviso some sozinho.
    const far = Math.floor((Date.now() + 80 * DAY) / 1000);
    stubDebug({ "tok-1": { is_valid: true, scopes: GOOD_SCOPES, data_access_expires_at: far } });
    await tick(t);
    const after = await t.run((ctx) => ctx.db.get(c.connectionId));
    expect(after?.authDetail).toBeUndefined();
    expect(after?.authAlertedAt).toBeUndefined();
    await cancelPendingJobs(t);
  });

  test("erro de rede, 5xx e app secret recusado NÃO marcam a credencial como inválida", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    const a = await seedConnection(t, org, 1);
    const b = await seedConnection(t, org, 2);
    const d = await seedConnection(t, org, 3);
    stubDebug({
      "tok-1": "network",
      "tok-2": { status: 503, body: {} },
      "tok-3": { status: 400, body: { error: { code: 101, message: "Invalid app secret" } } },
    });
    const r = await tick(t);
    expect(r).toMatchObject({ checked: 0, unavailable: 3 });
    for (const id of [a.connectionId, b.connectionId, d.connectionId]) {
      const conn = await t.run((ctx) => ctx.db.get(id));
      expect(conn?.authState).toBe("ok");
      expect(conn?.lastHealthAt).toBeUndefined();
    }
    await cancelPendingJobs(t);
  });

  test("cronsDisabled: não chama a Meta nem grava", async () => {
    vi.stubEnv("CRONS_DISABLED", "1");
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    const c = await seedConnection(t, org, 1);
    const { fn } = stubDebug({ "tok-1": { is_valid: false } });
    expect(await tick(t)).toEqual({ checked: 0, unavailable: 0, skipped: 0 });
    expect(fn).not.toHaveBeenCalled();
    expect((await t.run((ctx) => ctx.db.get(c.connectionId)))?.authState).toBe("ok");
  });

  test("pula org demo e conexão revogada", async () => {
    const t = convexTest(schema, modules);
    const demo = await seedOrg(t, { demo: true });
    const real = await seedOrg(t);
    const d = await seedConnection(t, demo, 1);
    const r = await seedConnection(t, real, 2);
    const revoked = await seedConnection(t, real, 3);
    await t.run((ctx) => ctx.db.patch(revoked.connectionId, { authState: "revoked", tokenEncrypted: "" }));
    const { urls } = stubDebug({}, { is_valid: true, scopes: GOOD_SCOPES });
    const res = await tick(t);
    expect(res.checked).toBe(1);
    expect(res.skipped).toBe(2);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("tok-2");
    expect((await t.run((ctx) => ctx.db.get(d.connectionId)))?.lastHealthAt).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(r.connectionId)))?.lastHealthAt).toBeTypeOf("number");
  });

  test("paginação por cursor: 120 conexões com pageSize pequeno são todas sondadas", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    const ids: Id<"metaConnections">[] = [];
    for (let i = 1; i <= 120; i++) ids.push((await seedConnection(t, org, i)).connectionId);
    const { fn } = stubDebug({}, { is_valid: true, scopes: GOOD_SCOPES });
    await tick(t, { pageSize: 25 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fn).toHaveBeenCalledTimes(120);
    const stamped = await t.run(async (ctx) => (await ctx.db.query("metaConnections").collect()).filter((c) => c.lastHealthAt));
    expect(stamped).toHaveLength(120);
  });

  test("purga: metaSentMids > 7 dias, oauthStates e pending vencidos; o recente fica", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: org.organizationId,
        channel: "instagram",
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      const messageId = await ctx.db.insert("messages", {
        organizationId: org.organizationId,
        conversationId,
        direction: "outbound",
        senderType: "human",
        content: "oi",
        contentType: "text",
        isInternal: false,
        createdAt: now,
      });
      for (const [mid, age] of [
        ["m-old", 8 * DAY],
        ["m-new", 1 * DAY],
      ] as const) {
        await ctx.db.insert("metaSentMids", { organizationId: org.organizationId, mid, messageId, createdAt: now - age });
      }
      const stateBase = {
        organizationId: org.organizationId,
        memberId: org.memberId,
        provider: "meta" as const,
        returnPath: "/app/configuracoes",
        createdAt: now,
      };
      const expiredState = await ctx.db.insert("oauthStates", { ...stateBase, nonceHash: "h1", expiresAt: now - 1000 });
      await ctx.db.insert("oauthStates", { ...stateBase, nonceHash: "h2", expiresAt: now + 600_000 });
      await ctx.db.insert("metaOAuthPending", {
        organizationId: org.organizationId,
        memberId: org.memberId,
        stateId: expiredState,
        pages: [],
        scopes: [],
        expiresAt: now - 1000,
        createdAt: now,
      });
    });
    stubDebug({});
    await tick(t);
    const left = await t.run(async (ctx) => ({
      mids: (await ctx.db.query("metaSentMids").collect()).map((m) => m.mid),
      states: (await ctx.db.query("oauthStates").collect()).map((s) => s.nonceHash),
      pending: (await ctx.db.query("metaOAuthPending").collect()).length,
    }));
    expect(left).toEqual({ mids: ["m-new"], states: ["h2"], pending: 0 });
  });

  test("erro 190 no envio dispara emitChannelDegraded uma vez", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, { webhook: true });
    const c = await seedConnection(t, org, 1);
    await t.mutation(internal.metaMessaging.internalMarkConnectionReauthRequired, {
      connectionId: c.connectionId,
      detail: "token expirado",
    });
    await t.mutation(internal.metaMessaging.internalMarkConnectionReauthRequired, {
      connectionId: c.connectionId,
      detail: "token expirado",
    });
    const conn = await t.run((ctx) => ctx.db.get(c.connectionId));
    expect(conn?.authState).toBe("reauth_required");
    expect(conn?.authAlertedAt).toBeTypeOf("number");
    const res = await counts(t, c.connectionId);
    expect(res.notifications).toBe(1);
    expect(res.audits).toBe(1);
    expect(res.hooks).toHaveLength(2);
    await cancelPendingJobs(t);
  });
});
