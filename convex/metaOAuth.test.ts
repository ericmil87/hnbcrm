/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
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
    expect(redirectUrlFor("https://a.test", { finalizar: true, state: "n 1" })).toBe(
      "https://a.test/app/configuracoes?secao=channels&meta=finalizar&state=n%201"
    );
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

/** Só a perna 1 (GET /oauth/meta/callback). */
async function rawCallback(t: TestConvex<typeof schema>, state: string, extra = "code=fake-code") {
  const res = await t.fetch(`/oauth/meta/callback?${extra}&state=${state}`);
  return { status: res.status, location: res.headers.get("Location") ?? "" };
}

function finalizeStateFrom(location: string): string | null {
  const m = location.match(/meta=finalizar&state=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Usuário que iniciou o state que está esperando a perna 2. */
async function initiatorIdentity(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("oauthStates").collect();
    const st = rows.find((r) => r.codeEncrypted !== undefined && r.usedAt === undefined)!;
    const member = (await ctx.db.get(st.memberId))!;
    return { organizationId: st.organizationId, subject: `${member.userId}|s1` };
  });
}

/** As duas pernas: callback + `finalizeMetaOAuth` pelo próprio iniciador; devolve a URL equivalente. */
async function callback(t: TestConvex<typeof schema>, state: string, extra = "code=fake-code") {
  const first = await rawCallback(t, state, extra);
  const next = finalizeStateFrom(first.location);
  if (!next) return first;
  const who = await initiatorIdentity(t);
  const res = await t
    .withIdentity({ subject: who.subject })
    .action(api.metaMessaging.finalizeMetaOAuth, { organizationId: who.organizationId, state: next });
  const location =
    res.code === "selecionar"
      ? `https://app.example.test/app/configuracoes?secao=channels&meta=selecionar&pendente=${res.pendingId}`
      : metaUrl(res.code);
  return { status: first.status, location };
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
    const next1 = finalizeStateFrom((await rawCallback(t, st1)).location)!;
    await t.run(async (ctx) => {
      await ctx.db.patch(s.adminId, { removedAt: Date.now() });
    });
    await expect(
      t.withIdentity({ subject: `${s.adminUserId}|s1` }).action(api.metaMessaging.finalizeMetaOAuth, { organizationId: s.organizationId, state: next1 })
    ).rejects.toThrow();

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

describe("OAuth em duas pernas: preso ao usuário que iniciou (F6)", () => {
  async function addAdmin(t: TestConvex<typeof schema>, organizationId: Id<"organizations">, email: string) {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email });
      await ctx.db.insert("teamMembers", {
        organizationId,
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
  }
  const counts = (t: TestConvex<typeof schema>) =>
    t.run(async (ctx) => ({
      conns: (await ctx.db.query("metaConnections").collect()).length,
      configs: (await ctx.db.query("channelConfigs").collect()).length,
      pending: (await ctx.db.query("metaOAuthPending").collect()).length,
    }));

  test("o callback não finaliza: guarda o code cifrado, troca o nonce e redireciona com meta=finalizar", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    const { calls } = stubMeta({ pages: [page1] });
    const state = await startState(t, s);
    const res = await rawCallback(t, state, "code=fake-code-segredo");
    expect(res.status).toBe(302);
    const next = finalizeStateFrom(res.location);
    expect(next).toBeTruthy();
    expect(next).not.toBe(state); // o nonce original não serve para finalizar
    expect(res.location).not.toContain("fake-code-segredo");
    expect(calls).toHaveLength(0); // nenhuma chamada à Meta na perna 1
    expect(await counts(t)).toEqual({ conns: 0, configs: 0, pending: 0 });
    const row = (await t.run(async (ctx) => await ctx.db.query("oauthStates").collect()))[0];
    expect(row.usedAt).toBeUndefined();
    expect(row.codeEncrypted).toMatch(/^v1:/);
    expect(row.codeReceivedAt).toBeTypeOf("number");
    expect(JSON.stringify(row)).not.toContain("fake-code-segredo");
    // replay do callback com o mesmo nonce: já recebeu code
    expect((await rawCallback(t, state, "code=outro")).location).toBe(metaUrl("expirado"));
  });

  test("ataque: quem iniciou não finaliza com o nonce original; outro admin da org ganha sem_papel e nada é gravado", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    const state = await startState(t, s);
    const next = finalizeStateFrom((await rawCallback(t, state)).location)!;
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    // O iniciador conhece o nonce original (gerou a URL), não o novo que foi para o navegador da vítima.
    expect(await asAdmin.action(api.metaMessaging.finalizeMetaOAuth, { organizationId: s.organizationId, state })).toEqual({ code: "expirado" });

    const otherUserId = await addAdmin(t, s.organizationId, "outro-admin@example.test");
    const asOther = t.withIdentity({ subject: `${otherUserId}|s1` });
    expect(await asOther.action(api.metaMessaging.finalizeMetaOAuth, { organizationId: s.organizationId, state: next })).toEqual({ code: "sem_papel" });
    expect(await counts(t)).toEqual({ conns: 0, configs: 0, pending: 0 });
    const row = (await t.run(async (ctx) => await ctx.db.query("oauthStates").collect()))[0];
    expect(row.usedAt).toBeUndefined(); // não consumiu

    // pelo usuário certo: conecta; reutilizar o state = expirado
    expect(await asAdmin.action(api.metaMessaging.finalizeMetaOAuth, { organizationId: s.organizationId, state: next })).toEqual({ code: "ok" });
    expect(await counts(t)).toMatchObject({ conns: 1, configs: 2 });
    expect(await asAdmin.action(api.metaMessaging.finalizeMetaOAuth, { organizationId: s.organizationId, state: next })).toEqual({ code: "expirado" });
    const used = (await t.run(async (ctx) => await ctx.db.query("oauthStates").collect()))[0];
    expect(used.usedAt).toBeTypeOf("number");
    expect(used.codeEncrypted).toBeUndefined(); // o code sai do banco ao ser usado
  });

  test("outra org: admin da org B não finaliza o state da org A (nem passando a org A)", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const b = await seedOrg(t, "b");
    stubMeta({ pages: [page1] });
    const next = finalizeStateFrom((await rawCallback(t, await startState(t, a))).location)!;
    const asB = t.withIdentity({ subject: `${b.adminUserId}|s1` });
    expect(await asB.action(api.metaMessaging.finalizeMetaOAuth, { organizationId: b.organizationId, state: next })).toEqual({ code: "expirado" });
    await expect(asB.action(api.metaMessaging.finalizeMetaOAuth, { organizationId: a.organizationId, state: next })).rejects.toThrow();
    expect(await counts(t)).toEqual({ conns: 0, configs: 0, pending: 0 });
    const row = (await t.run(async (ctx) => await ctx.db.query("oauthStates").collect()))[0];
    expect(row.usedAt).toBeUndefined();
  });

  test("TTL conta do início: finalizar depois de 10 min = expirado", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    const next = finalizeStateFrom((await rawCallback(t, await startState(t, s))).location)!;
    vi.advanceTimersByTime(11 * 60 * 1000);
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    expect(await asAdmin.action(api.metaMessaging.finalizeMetaOAuth, { organizationId: s.organizationId, state: next })).toEqual({ code: "expirado" });
    expect(await counts(t)).toEqual({ conns: 0, configs: 0, pending: 0 });
  });
});

describe("excluir e reconectar canal Meta (F6)", () => {
  async function seedThread(t: TestConvex<typeof schema>, organizationId: Id<"organizations">, configId: Id<"channelConfigs">, externalId: string) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "Cliente", tags: [], createdAt: now, updatedAt: now } as any);
      const identityId = await ctx.db.insert("contactChannelIdentities", { organizationId, contactId, channelConfigId: configId, kind: "messenger", externalId, createdAt: now });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId, channel: "messenger", channelConfigId: configId, status: "active", messageCount: 0, createdAt: now, updatedAt: now,
      } as any);
      return { contactId, identityId, conversationId };
    });
  }

  test("Excluir canal Meta com conversas é recusado (Desconectar preserva)", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    await callback(t, await startState(t, s));
    const messenger = (await t.run(async (ctx) => await ctx.db.query("channelConfigs").collect())).find((c) => c.channel === "messenger")!;
    await seedThread(t, s.organizationId, messenger._id, "1000000000000101");
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    const err = await asAdmin
      .mutation(api.channelConfigs.deleteChannelConfig, { configId: messenger._id })
      .then(() => null, (e: unknown) => (e as { data?: unknown }).data);
    // convex-test entrega `data` serializado; o runtime real entrega o objeto.
    const data = (typeof err === "string" ? JSON.parse(err) : err) as { code?: string; conversations?: number };
    expect(data.code).toBe("has_conversations");
    expect(data.conversations).toBe(1);
    expect(await t.run(async (ctx) => await ctx.db.get(messenger._id))).not.toBeNull();

    // Com force: exclui e audita forced + contagem.
    await asAdmin.mutation(api.channelConfigs.deleteChannelConfig, { configId: messenger._id, force: true });
    expect(await t.run(async (ctx) => await ctx.db.get(messenger._id))).toBeNull();
    const audit = (await t.run(async (ctx) => await ctx.db.query("auditLogs").collect())).find(
      (l) => l.action === "delete" && l.entityId === messenger._id
    );
    expect(audit?.metadata).toMatchObject({ forced: true, conversations: 1 });
  });

  test("config apagado no passado: reconectar religa identidades e conversas órfãs ao config novo", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    await callback(t, await startState(t, s));
    const messenger = (await t.run(async (ctx) => await ctx.db.query("channelConfigs").collect())).find((c) => c.channel === "messenger")!;
    const thread = await seedThread(t, s.organizationId, messenger._id, "1000000000000101");
    // Exclusão legada (antes da trava): o config some e deixa tudo apontando para ele.
    await t.run(async (ctx) => {
      await ctx.db.delete(messenger._id);
    });
    // órfão de OUTRA org não é tocado
    const b = await seedOrg(t, "b");
    const foreign = await seedThread(t, b.organizationId, messenger._id, "1000000000000102");

    stubMeta({ pages: [page1] });
    expect((await callback(t, await startState(t, s))).location).toBe(OK);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await t.run(async (ctx) => ({
      configs: await ctx.db.query("channelConfigs").collect(),
      ident: await ctx.db.get(thread.identityId),
      conv: await ctx.db.get(thread.conversationId),
      foreignIdent: await ctx.db.get(foreign.identityId),
      foreignConv: await ctx.db.get(foreign.conversationId),
      contacts: (await ctx.db.query("contacts").collect()).filter((c) => c.organizationId === s.organizationId),
    }));
    const fresh = after.configs.find((c) => c.channel === "messenger" && c.organizationId === s.organizationId)!;
    expect(fresh._id).not.toEqual(messenger._id);
    expect(after.ident!.channelConfigId).toEqual(fresh._id);
    expect(after.conv!.channelConfigId).toEqual(fresh._id);
    expect(after.foreignIdent!.channelConfigId).toEqual(messenger._id);
    expect(after.foreignConv!.channelConfigId).toEqual(messenger._id);
    expect(after.contacts).toHaveLength(1);
  });

  test("com outra conta viva do mesmo canal na org, órfãos não são religados (PSID é por conta)", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1, page2] });
    const { location } = await callback(t, await startState(t, s));
    const pendingId = decodeURIComponent(location.match(/pendente=([^&]+)/)![1]) as Id<"metaOAuthPending">;
    const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
    await asAdmin.action(api.metaMessaging.finalizeMetaSelection, {
      organizationId: s.organizationId,
      pendingId,
      picks: [{ pageId: page1.id, messenger: true, instagram: false }, { pageId: page2.id, messenger: true, instagram: false }],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const cfgs = await t.run(async (ctx) => await ctx.db.query("channelConfigs").collect());
    const m1 = cfgs.find((c) => c.messengerPageId === page1.id)!;
    const thread = await seedThread(t, s.organizationId, m1._id, "1000000000000101");
    await t.run(async (ctx) => {
      await ctx.db.delete(m1._id);
    });
    stubMeta({ pages: [page1] });
    expect((await callback(t, await startState(t, s))).location).toBe(OK);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const ident = await t.run(async (ctx) => await ctx.db.get(thread.identityId));
    expect(ident!.channelConfigId).toEqual(m1._id);
  });
});

describe("config Instagram órfão não fica roteável (F6)", () => {
  test("reconectar sem IG desativa o config instagram e limpa o id", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    await callback(t, await startState(t, s));
    const conn = (await t.run(async (ctx) => await ctx.db.query("metaConnections").collect()))[0];
    stubMeta({ pages: [{ ...page1, ig: undefined }] });
    expect((await callback(t, await startState(t, s, conn._id))).location).toBe(OK);
    const ig = (await t.run(async (ctx) => await ctx.db.query("channelConfigs").collect())).find((c) => c.channel === "instagram")!;
    expect(ig.status).toBe("disabled");
    expect(ig.instagramAccountId).toBeUndefined();
    expect(await t.query(internal.metaMessaging.internalGetConfigForMetaAccount, { surface: "instagram", accountId: "1000000000000003" })).toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("IG trocado: config novo para a conta nova; o antigo é desativado sem id", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    stubMeta({ pages: [page1] });
    await callback(t, await startState(t, s));
    const conn = (await t.run(async (ctx) => await ctx.db.query("metaConnections").collect()))[0];
    const oldIg = (await t.run(async (ctx) => await ctx.db.query("channelConfigs").collect())).find((c) => c.channel === "instagram")!;
    stubMeta({ pages: [{ ...page1, ig: { id: "1000000000000004", username: "marina_dois" } }] });
    expect((await callback(t, await startState(t, s, conn._id))).location).toBe(OK);
    const igs = (await t.run(async (ctx) => await ctx.db.query("channelConfigs").collect())).filter((c) => c.channel === "instagram");
    expect(igs).toHaveLength(2);
    const oldAfter = igs.find((c) => c._id === oldIg._id)!;
    expect(oldAfter.status).toBe("disabled");
    expect(oldAfter.instagramAccountId).toBeUndefined();
    expect(igs.find((c) => c._id !== oldIg._id)).toMatchObject({ status: "active", instagramAccountId: "1000000000000004" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("dois configs ATIVOS da mesma conta em orgs diferentes: o roteamento descarta", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const b = await seedOrg(t, "b");
    await t.run(async (ctx) => {
      const now = Date.now();
      for (const organizationId of [a.organizationId, b.organizationId]) {
        await ctx.db.insert("channelConfigs", { organizationId, channel: "messenger", displayName: "x", status: "active", messengerPageId: page1.id, createdAt: now, updatedAt: now });
      }
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await t.query(internal.metaMessaging.internalGetConfigForMetaAccount, { surface: "messenger", accountId: page1.id })).toBeNull();
      expect(err.mock.calls.join(" ")).not.toContain(page1.id);
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  });
});
