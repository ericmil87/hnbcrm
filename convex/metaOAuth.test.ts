/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  META_OAUTH_ERROR_CODES,
  REQUIRED_SCOPES,
  buildAuthorizeUrl,
  missingScopes,
  pickUsablePages,
  redirectUrlFor,
} from "./lib/metaOAuth";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const SITE = "https://example.convex.site";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", btoa("A".repeat(32)));
  vi.stubEnv("META_MESSAGING_APP_ID", "fake-app-id");
  vi.stubEnv("META_MESSAGING_APP_SECRET", "fake-app-secret");
  vi.stubEnv("META_MESSAGING_LOGIN_CONFIG_ID", "fake-login-config");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("APP_URL", "https://app.example.test");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ── Puro ──

describe("lib/metaOAuth", () => {
  test("buildAuthorizeUrl usa config_id e response_type=code, sem scope", () => {
    const url = new URL(buildAuthorizeUrl({ appId: "app1", redirectUri: `${SITE}/oauth/meta/callback`, configId: "cfg1", state: "st1" }));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(url.searchParams.get("config_id")).toBe("cfg1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st1");
    expect(url.searchParams.get("redirect_uri")).toBe(`${SITE}/oauth/meta/callback`);
    expect(url.searchParams.has("scope")).toBe(false);
  });

  test("REQUIRED_SCOPES tem as 8 e missingScopes aponta a faltante", () => {
    expect(REQUIRED_SCOPES).toHaveLength(8);
    expect(missingScopes([...REQUIRED_SCOPES])).toEqual([]);
    expect(missingScopes(REQUIRED_SCOPES.filter((s) => s !== "pages_messaging"))).toEqual(["pages_messaging"]);
  });

  test("pickUsablePages marca tasksOk e assume true quando tasks não vem", () => {
    const pages = pickUsablePages([
      { id: "p1", name: "Ok", access_token: "t1", tasks: ["MESSAGING", "MODERATE", "ANALYZE"], instagram_business_account: { id: "ig1", username: "u1" } },
      { id: "p2", name: "Parcial", access_token: "t2", tasks: ["MESSAGING"] },
      { id: "p3", name: "Sem tasks", access_token: "t3" },
      { id: "p4", name: "Sem token" },
      null,
    ]);
    expect(pages.map((p) => [p.pageId, p.tasksOk])).toEqual([["p1", true], ["p2", false], ["p3", true]]);
    expect(pages[0]).toMatchObject({ igAccountId: "ig1", igUsername: "u1" });
    expect(pickUsablePages("x")).toEqual([]);
  });

  test("redirectUrlFor", () => {
    expect(META_OAUTH_ERROR_CODES).toContain("conta_em_uso");
    expect(redirectUrlFor("https://a.test/", "ok")).toBe("https://a.test/app/configuracoes?secao=channels&meta=ok");
    expect(redirectUrlFor("https://a.test", "sem_pagina")).toBe("https://a.test/app/configuracoes?secao=channels&meta=sem_pagina");
    expect(redirectUrlFor("https://a.test", { selecionar: true, pendenteId: "abc" })).toBe(
      "https://a.test/app/configuracoes?secao=channels&meta=selecionar&pendente=abc"
    );
  });
});

// ── Backend ──

async function seedOrg(t: TestConvex<typeof schema>, slug: string, opts: { moduleOn?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: slug,
      slug,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        ...(opts.moduleOn === false ? {} : { modules: { metaMessaging: true } }),
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", { email: `${slug}@example.test` });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin Fake",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const managerUserId = await ctx.db.insert("users", { email: `${slug}-mgr@example.test` });
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId: managerUserId,
      name: "Gerente",
      role: "manager",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminUserId, adminId, managerUserId };
  });
}

type FakePage = { id: string; name: string; token: string; tasks?: string[]; ig?: { id: string; username: string } };
const page1: FakePage = { id: "1000000000000001", name: "Página Um", token: "fake-page-token-1", tasks: ["MESSAGING", "MODERATE"], ig: { id: "1000000000000003", username: "marina_um" } };
const page2: FakePage = { id: "1000000000000011", name: "Página Dois", token: "fake-page-token-2", tasks: ["MESSAGING", "MODERATE"] };
const pageNoTasks: FakePage = { id: "1000000000000021", name: "Sem Tarefas", token: "fake-page-token-3", tasks: ["ANALYZE"] };

function stubMeta(opts: {
  pages?: FakePage[];
  granted?: readonly string[];
  subscribeOk?: boolean;
  failAt?: string;
}) {
  const calls: { url: string; method: string; auth?: string }[] = [];
  const granted = opts.granted ?? REQUIRED_SCOPES;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url, method, auth });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (opts.failAt && url.includes(opts.failAt)) return json({ error: { message: "boom" } }, 500);
    if (url.includes("/oauth/access_token") && url.includes("grant_type=fb_exchange_token")) return json({ access_token: "fake-user-long" });
    if (url.includes("/oauth/access_token")) return json({ access_token: "fake-user-short" });
    if (url.includes("/me/permissions")) return json({ data: granted.map((p) => ({ permission: p, status: "granted" })) });
    if (url.includes("/me/accounts")) {
      return json({
        data: (opts.pages ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          access_token: p.token,
          ...(p.tasks ? { tasks: p.tasks } : {}),
          ...(p.ig ? { instagram_business_account: { id: p.ig.id, username: p.ig.username } } : {}),
        })),
      });
    }
    if (url.includes("/me?fields=id")) return json({ id: "7000000000000009" });
    if (url.includes("/debug_token")) return json({ data: { is_valid: true, scopes: [...REQUIRED_SCOPES], data_access_expires_at: 1900000000, user_id: "7000000000000008" } });
    if (url.includes("/subscribed_apps")) return opts.subscribeOk === false ? json({ error: { code: 200 } }, 400) : json({ success: true });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

async function startState(t: TestConvex<typeof schema>, s: { organizationId: Id<"organizations">; adminUserId: Id<"users"> }, connectionId?: Id<"metaConnections">) {
  const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
  const { url } = await asAdmin.action(api.metaMessaging.startMetaConnect, { organizationId: s.organizationId, connectionId });
  return new URL(url).searchParams.get("state")!;
}

async function callback(t: TestConvex<typeof schema>, state: string, extra = "code=fake-code") {
  const res = await t.fetch(`/oauth/meta/callback?${extra}&state=${state}`);
  return { status: res.status, location: res.headers.get("Location") ?? "" };
}

const OK = "https://app.example.test/app/configuracoes?secao=channels&meta=ok";
const metaUrl = (code: string) => `https://app.example.test/app/configuracoes?secao=channels&meta=${code}`;

describe("startMetaConnect e state", () => {
  test("monta a URL, grava só o hash do nonce e exige permissão", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    const state = await startState(t, s);
    const rows = await t.run(async (ctx) => await ctx.db.query("oauthStates").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].nonceHash).not.toBe(state);
    expect(rows[0].returnPath).toBe("/app/configuracoes?secao=channels");
    expect(rows[0].expiresAt - rows[0].createdAt).toBe(10 * 60 * 1000);

    const asManager = t.withIdentity({ subject: `${s.managerUserId}|s1` });
    await expect(asManager.action(api.metaMessaging.startMetaConnect, { organizationId: s.organizationId })).rejects.toThrow(/Permissão insuficiente/);

    const other = await seedOrg(t, "b");
    const asOtherAdmin = t.withIdentity({ subject: `${other.adminUserId}|s1` });
    await expect(asOtherAdmin.action(api.metaMessaging.startMetaConnect, { organizationId: s.organizationId })).rejects.toThrow();
  });

  test("sem envs da Meta = ConvexError claro", async () => {
    vi.stubEnv("META_MESSAGING_APP_ID", "");
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    await expect(asAdmin.action(api.metaMessaging.startMetaConnect, { organizationId: s.organizationId })).rejects.toThrow(/não está configurado/);
  });

  test("state é single-use, expira e desconhecido vira expirado", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    const state = await startState(t, s);
    expect((await callback(t, state)).location).toBe(OK);
    expect((await callback(t, state)).location).toBe(metaUrl("expirado"));
    expect((await callback(t, "nao-existe")).location).toBe(metaUrl("expirado"));

    const state2 = await startState(t, s);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect((await callback(t, state2)).location).toBe(metaUrl("expirado"));
  });

  test("error na query = cancelado; membro sem papel ou módulo off no callback", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    const res = await t.fetch("/oauth/meta/callback?error=access_denied&state=x");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(metaUrl("cancelado"));

    const st1 = await startState(t, s);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.adminId, { removedAt: Date.now() });
    });
    expect((await callback(t, st1)).location).toBe(metaUrl("sem_papel"));

    await t.run(async (ctx) => {
      await ctx.db.patch(s.adminId, { removedAt: undefined });
    });
    const st2 = await startState(t, s);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.organizationId, { settings: { timezone: "America/Sao_Paulo", currency: "BRL" } });
    });
    expect((await callback(t, st2)).location).toBe(metaUrl("modulo_off"));
  });
});

describe("callback: troca de token e Páginas", () => {
  test("permissão faltando = sem_permissao e nada é gravado", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1], granted: REQUIRED_SCOPES.filter((p) => p !== "instagram_manage_messages") });
    expect((await callback(t, await startState(t, s))).location).toBe(metaUrl("sem_permissao"));
    expect(await t.run(async (ctx) => (await ctx.db.query("metaConnections").collect()).length)).toBe(0);
  });

  test("0 Páginas = sem_pagina; Página sem MESSAGING+MODERATE = sem_papel", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [] });
    expect((await callback(t, await startState(t, s))).location).toBe(metaUrl("sem_pagina"));
    stubMeta({ pages: [pageNoTasks] });
    expect((await callback(t, await startState(t, s))).location).toBe(metaUrl("sem_papel"));
  });

  test("falha de rede ou da Meta = falha_meta", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1], failAt: "/me/accounts" });
    expect((await callback(t, await startState(t, s))).location).toBe(metaUrl("falha_meta"));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("rede caiu"); }));
    expect((await callback(t, await startState(t, s))).location).toBe(metaUrl("falha_meta"));
  });

  test("1 Página: conecta direto, cria messenger + instagram, inscreve e cifra o token", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    const { calls } = stubMeta({ pages: [page1] });
    expect((await callback(t, await startState(t, s))).location).toBe(OK);

    const data = await t.run(async (ctx) => ({
      conns: await ctx.db.query("metaConnections").collect(),
      configs: await ctx.db.query("channelConfigs").collect(),
      pending: await ctx.db.query("metaOAuthPending").collect(),
    }));
    expect(data.conns).toHaveLength(1);
    const conn = data.conns[0];
    expect(conn).toMatchObject({ pageId: page1.id, igAccountId: "1000000000000003", igUsername: "marina_um", authState: "ok", tokenKind: "page", tokenLast4: "en-1" });
    expect(conn.tokenEncrypted).toMatch(/^v1:/);
    expect(conn.tokenEncrypted).not.toContain("fake-page-token-1");
    expect(conn.subscribedAt).toBeTypeOf("number");
    expect(conn.dataAccessExpiresAt).toBe(1900000000 * 1000);
    expect(conn.connectedByMemberId).toEqual(s.adminId);
    expect(data.configs.map((c) => c.channel).sort()).toEqual(["instagram", "messenger"]);
    const messenger = data.configs.find((c) => c.channel === "messenger")!;
    const instagram = data.configs.find((c) => c.channel === "instagram")!;
    expect(messenger).toMatchObject({ messengerPageId: page1.id, status: "active", displayName: "Página Um", metaConnectionId: conn._id });
    expect(instagram).toMatchObject({ instagramAccountId: "1000000000000003", status: "active", displayName: "@marina_um", metaAccountHandle: "@marina_um" });
    expect(messenger.provider).toBeUndefined();
    expect(data.pending).toHaveLength(0);

    const sub = calls.find((c) => c.url.includes("/subscribed_apps"))!;
    expect(sub.method).toBe("POST");
    expect(sub.url).toContain("subscribed_fields=messages,message_echoes,message_deliveries,message_reads,messaging_postbacks,message_reactions,message_edits,messaging_referrals,standby");
    expect(sub.auth).toBe("Bearer fake-page-token-1");
    // token de usuário só em header, nunca persistido
    expect(JSON.stringify(data)).not.toContain("fake-user-long");
    expect(JSON.stringify(data)).not.toContain("fake-user-short");
  });

  test("metaUserId: /me é a fonte preferida; debug_token.user_id é o fallback", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    expect((await callback(t, await startState(t, s))).location).toBe(OK);
    const first = await t.run(async (ctx) => (await ctx.db.query("metaConnections").collect())[0]);
    expect(first.metaUserId).toBe("7000000000000009");

    const t2 = convexTest(schema, modules);
    const s2 = await seedOrg(t2, "a");
    stubMeta({ pages: [page1], failAt: "/me?fields=id" });
    expect((await callback(t2, await startState(t2, s2))).location).toBe(OK);
    const second = await t2.run(async (ctx) => (await ctx.db.query("metaConnections").collect())[0]);
    expect(second.metaUserId).toBe("7000000000000008");
  });

  test("falha no subscribed_apps grava a conexão sem subscribedAt", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1], subscribeOk: false });
    expect((await callback(t, await startState(t, s))).location).toBe(OK);
    const conn = (await t.run(async (ctx) => await ctx.db.query("metaConnections").collect()))[0];
    expect(conn.subscribedAt).toBeUndefined();
  });

  test("audit e getChannelConfigs não vazam token", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    await callback(t, await startState(t, s));
    const audits = await t.run(async (ctx) => await ctx.db.query("auditLogs").collect());
    expect(audits.length).toBeGreaterThanOrEqual(3);
    const dump = JSON.stringify(audits);
    expect(dump).not.toContain("EAA");
    expect(dump).not.toContain("fake-page-token");
    expect(dump).not.toContain("v1:");
    expect(audits.filter((a) => a.entityType === "metaConnection").every((a) => a.severity === "high")).toBe(true);

    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    const list = await asAdmin.query(api.channelConfigs.getChannelConfigs, { organizationId: s.organizationId });
    const out = JSON.stringify(list);
    expect(out).not.toContain("fake-page-token");
    expect(out).not.toContain("v1:");
    expect(out).not.toContain("tokenEncrypted");
    const messenger = list.find((c: { channel: string }) => c.channel === "messenger");
    expect(messenger).toMatchObject({
      transport: "messenger",
      provider: null,
      hasMetaToken: true,
      metaAuthState: "ok",
      metaSubscribed: true,
      messengerPageId: page1.id,
      metaConnectedBy: { memberId: s.adminId, name: "Admin Fake" },
    });
    const instagram = list.find((c: { channel: string }) => c.channel === "instagram");
    expect(instagram).toMatchObject({ transport: "instagram", instagramAccountId: "1000000000000003" });
  });

  test("exclusividade: mesma Página ou mesma conta IG em outra org = conta_em_uso", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const b = await seedOrg(t, "b");
    const { calls } = stubMeta({ pages: [page1] });
    expect((await callback(t, await startState(t, a))).location).toBe(OK);

    calls.length = 0;
    expect((await callback(t, await startState(t, b))).location).toBe(metaUrl("conta_em_uso"));
    expect(calls.some((c) => c.url.includes("/subscribed_apps"))).toBe(false); // nem reinscreve
    // Página diferente, mesma conta IG
    stubMeta({ pages: [{ ...page2, ig: { id: "1000000000000003", username: "marina_um" } }] });
    expect((await callback(t, await startState(t, b))).location).toBe(metaUrl("conta_em_uso"));
    expect(await t.run(async (ctx) => (await ctx.db.query("metaConnections").collect()).length)).toBe(1);
  });

  test("reconectar: mesma Página atualiza; Página diferente falha", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    await callback(t, await startState(t, s));
    const conn = (await t.run(async (ctx) => await ctx.db.query("metaConnections").collect()))[0];
    await t.run(async (ctx) => {
      await ctx.db.patch(conn._id, { authState: "reauth_required" });
    });

    stubMeta({ pages: [page1, page2] }); // várias, mas a reconexão só olha a Página da conexão
    expect((await callback(t, await startState(t, s, conn._id))).location).toBe(OK);
    const after = await t.run(async (ctx) => ({ conns: await ctx.db.query("metaConnections").collect(), configs: await ctx.db.query("channelConfigs").collect() }));
    expect(after.conns).toHaveLength(1);
    expect(after.conns[0].authState).toBe("ok");
    expect(after.configs).toHaveLength(2);

    stubMeta({ pages: [page2] });
    expect((await callback(t, await startState(t, s, conn._id))).location).toBe(metaUrl("sem_pagina"));
  });
});

describe("N Páginas: seleção", () => {
  async function toPending(t: TestConvex<typeof schema>, s: Awaited<ReturnType<typeof seedOrg>>, pages: FakePage[]) {
    stubMeta({ pages });
    const { location } = await callback(t, await startState(t, s));
    const m = location.match(/meta=selecionar&pendente=([^&]+)/);
    expect(m).toBeTruthy();
    return decodeURIComponent(m![1]) as Id<"metaOAuthPending">;
  }

  test("grava pending cifrado; getPendingSelection não devolve token e só atende a org dona", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    const other = await seedOrg(t, "b");
    const pendingId = await toPending(t, s, [page1, page2, pageNoTasks]);

    const raw = await t.run(async (ctx) => await ctx.db.get(pendingId));
    expect(raw?.pages).toHaveLength(3);
    expect(raw!.pages.every((p) => p.tokenEncrypted.startsWith("v1:"))).toBe(true);
    expect(raw!.expiresAt - raw!.createdAt).toBe(15 * 60 * 1000);

    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    const sel = await asAdmin.query(api.metaMessaging.getPendingSelection, { organizationId: s.organizationId, pendingId });
    expect(sel!.pages.map((p) => [p.pageId, p.tasksOk])).toEqual([[page1.id, true], [page2.id, true], [pageNoTasks.id, false]]);
    expect(JSON.stringify(sel)).not.toMatch(/token|v1:/i);

    const asOther = t.withIdentity({ subject: `${other.adminUserId}|s1` });
    expect(await asOther.query(api.metaMessaging.getPendingSelection, { organizationId: other.organizationId, pendingId })).toBeNull();
    await expect(asOther.query(api.metaMessaging.getPendingSelection, { organizationId: s.organizationId, pendingId })).rejects.toThrow();
  });

  test("N Páginas: o metaUserId viaja no pending e chega às conexões", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    const pendingId = await toPending(t, s, [page1, page2]);
    const pending = await t.run(async (ctx) => await ctx.db.get(pendingId));
    expect(pending?.metaUserId).toBe("7000000000000009");
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    await asAdmin.action(api.metaMessaging.finalizeMetaSelection, {
      organizationId: s.organizationId,
      pendingId,
      picks: [{ pageId: page2.id, messenger: true, instagram: false }],
    });
    const conns = await t.run(async (ctx) => await ctx.db.query("metaConnections").collect());
    expect(conns.map((c) => c.metaUserId)).toEqual(["7000000000000009"]);
  });

  test("finalizeMetaSelection cria só o que foi marcado e apaga o pending", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    const pendingId = await toPending(t, s, [page1, page2]);
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    const res = await asAdmin.action(api.metaMessaging.finalizeMetaSelection, {
      organizationId: s.organizationId,
      pendingId,
      picks: [
        { pageId: page1.id, messenger: false, instagram: true },
        { pageId: page2.id, messenger: true, instagram: false },
      ],
    });
    expect(res.ok).toBe(true);
    const data = await t.run(async (ctx) => ({
      configs: await ctx.db.query("channelConfigs").collect(),
      conns: await ctx.db.query("metaConnections").collect(),
      pending: await ctx.db.get(pendingId),
    }));
    expect(data.configs.map((c) => `${c.channel}:${c.displayName}`).sort()).toEqual(["instagram:@marina_um", "messenger:Página Dois"]);
    expect(data.conns).toHaveLength(2);
    expect(data.pending).toBeNull();
  });

  test("Página sem tarefas não passa; pending de outro membro ou expirado não passa", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    const pendingId = await toPending(t, s, [page1, pageNoTasks]);
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    const bad = await asAdmin.action(api.metaMessaging.finalizeMetaSelection, {
      organizationId: s.organizationId,
      pendingId,
      picks: [{ pageId: pageNoTasks.id, messenger: true, instagram: false }],
    });
    expect(bad).toEqual({ ok: false, code: "sem_papel" });

    vi.advanceTimersByTime(16 * 60 * 1000);
    const expired = await asAdmin.action(api.metaMessaging.finalizeMetaSelection, {
      organizationId: s.organizationId,
      pendingId,
      picks: [{ pageId: page1.id, messenger: true, instagram: true }],
    });
    expect(expired).toEqual({ ok: false, code: "expirado" });
  });

  test("seleção que bate em Página de outra org devolve conta_em_uso", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const b = await seedOrg(t, "b");
    stubMeta({ pages: [page1] });
    await callback(t, await startState(t, a));
    const pendingId = await toPending(t, b, [page1, page2]);
    const asB = t.withIdentity({ subject: `${b.adminUserId}|s1` });
    const res = await asB.action(api.metaMessaging.finalizeMetaSelection, {
      organizationId: b.organizationId,
      pendingId,
      picks: [{ pageId: page1.id, messenger: true, instagram: true }],
    });
    expect(res).toEqual({ ok: false, code: "conta_em_uso" });
  });
});

describe("desconectar e apagar", () => {
  test("disconnect revoga a conexão e desativa os configs; deleteChannelConfig apaga a conexão quando é o último", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    await callback(t, await startState(t, s));
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    const state = await t.run(async (ctx) => ({ conn: (await ctx.db.query("metaConnections").collect())[0], configs: await ctx.db.query("channelConfigs").collect() }));

    await asAdmin.mutation(api.metaMessaging.disconnectMetaConnection, { organizationId: s.organizationId, connectionId: state.conn._id });
    const after = await t.run(async (ctx) => ({ conn: await ctx.db.get(state.conn._id), configs: await ctx.db.query("channelConfigs").collect() }));
    expect(after.conn).toMatchObject({ authState: "revoked", tokenEncrypted: "", tokenLast4: "" });
    expect(after.configs.every((c) => c.status === "disabled")).toBe(true);

    await asAdmin.mutation(api.channelConfigs.deleteChannelConfig, { configId: state.configs[0]._id });
    expect(await t.run(async (ctx) => await ctx.db.get(state.conn._id))).not.toBeNull();
    await asAdmin.mutation(api.channelConfigs.deleteChannelConfig, { configId: state.configs[1]._id });
    expect(await t.run(async (ctx) => await ctx.db.get(state.conn._id))).toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("não reativa config Meta com módulo off nem conexão revogada", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    await callback(t, await startState(t, s));
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    const { conn, cfg } = await t.run(async (ctx) => ({ conn: (await ctx.db.query("metaConnections").collect())[0], cfg: (await ctx.db.query("channelConfigs").collect())[0] }));
    await asAdmin.mutation(api.metaMessaging.disconnectMetaConnection, { organizationId: s.organizationId, connectionId: conn._id });
    await expect(asAdmin.mutation(api.channelConfigs.setChannelConfigStatus, { configId: cfg._id, status: "active" })).rejects.toThrow(/Reconecte/);
  });
});

describe("seleção de Páginas: robustez", () => {
  async function toPending(t: TestConvex<typeof schema>, s: Awaited<ReturnType<typeof seedOrg>>, pages: FakePage[]) {
    stubMeta({ pages });
    const { location } = await callback(t, await startState(t, s));
    return decodeURIComponent(location.match(/meta=selecionar&pendente=([^&]+)/)![1]) as Id<"metaOAuthPending">;
  }

  test("valida todas as Páginas antes de conectar a primeira", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const b = await seedOrg(t, "b");
    stubMeta({ pages: [page2] });
    await callback(t, await startState(t, a)); // org A fica com a Página 2
    const pendingId = await toPending(t, b, [page1, page2]);
    const asB = t.withIdentity({ subject: `${b.adminUserId}|s1` });
    const res = await asB.action(api.metaMessaging.finalizeMetaSelection, {
      organizationId: b.organizationId,
      pendingId,
      picks: [
        { pageId: page1.id, messenger: true, instagram: true }, // livre
        { pageId: page2.id, messenger: true, instagram: false }, // da org A
      ],
    });
    expect(res).toEqual({ ok: false, code: "conta_em_uso" });
    const conns = await t.run(async (ctx) => await ctx.db.query("metaConnections").collect());
    expect(conns.map((c) => c.organizationId)).toEqual([a.organizationId]); // nada foi conectado na B
  });

  test("falha no meio devolve o que já conectou e apaga a pendência", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const b = await seedOrg(t, "b");
    const pendingId = await toPending(t, b, [page1, page2]);
    // Corrida: enquanto a Página 1 é inscrita, a org A conecta a Página 2.
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(`/${page1.id}/subscribed_apps`)) {
        await t.run(async (ctx) => {
          const now = Date.now();
          await ctx.db.insert("metaConnections", {
            organizationId: a.organizationId,
            authMethod: "facebook_login",
            tokenKind: "page",
            tokenEncrypted: "v1:x:y",
            tokenLast4: "0000",
            pageId: page2.id,
            scopes: [],
            authState: "ok",
            connectedByMemberId: a.adminId,
            createdAt: now,
            updatedAt: now,
          });
        });
      }
      return await inner(input, init);
    });
    const asB = t.withIdentity({ subject: `${b.adminUserId}|s1` });
    const res = await asB.action(api.metaMessaging.finalizeMetaSelection, {
      organizationId: b.organizationId,
      pendingId,
      picks: [
        { pageId: page1.id, messenger: true, instagram: false },
        { pageId: page2.id, messenger: true, instagram: false },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("conta_em_uso");
      expect(res.configIds).toHaveLength(1);
    }
    expect(await t.run(async (ctx) => await ctx.db.get(pendingId))).toBeNull();
  });

  test("getPendingSelection só atende o membro que iniciou a conexão", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    const pendingId = await toPending(t, s, [page1, page2]);
    const otherAdminUserId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "outro-admin@example.test" });
      await ctx.db.insert("teamMembers", {
        organizationId: s.organizationId,
        userId,
        name: "Outro Admin",
        role: "admin",
        type: "human",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return userId;
    });
    const asOther = t.withIdentity({ subject: `${otherAdminUserId}|s1` });
    await expect(
      asOther.query(api.metaMessaging.getPendingSelection, { organizationId: s.organizationId, pendingId })
    ).rejects.toThrow(/pertence a outro usuário/);
    const asOwner = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    expect(await asOwner.query(api.metaMessaging.getPendingSelection, { organizationId: s.organizationId, pendingId })).not.toBeNull();
  });
});
