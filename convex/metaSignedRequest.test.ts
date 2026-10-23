/// <reference types="vite/client" />
/**
 * F5: callbacks da Meta (desautorizar / exclusão de dados). Parser puro do
 * `signed_request` + as três rotas HTTP. Trava: assinatura obrigatória (400),
 * só as conexões daquele `user_id` são revogadas, nada do CRM é apagado, o
 * `user_id` completo nunca é gravado (hash/máscara).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import schema from "./schema";
import { parseSignedRequest, signRequestPayload } from "./lib/metaSignedRequest";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const SECRET = "fake-meta-app-secret";
const NOW = Date.UTC(2026, 9, 20, 12, 0);
const USER_A = "7000000000000001";
const USER_B = "7000000000000002";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("META_MESSAGING_APP_SECRET", SECRET);
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const payload = (over: Record<string, unknown> = {}) => ({
  user_id: USER_A,
  algorithm: "HMAC-SHA256",
  issued_at: Math.floor(NOW / 1000),
  ...over,
});

describe("parseSignedRequest", () => {
  test("assinatura válida", async () => {
    const raw = await signRequestPayload(payload(), SECRET);
    const r = await parseSignedRequest(raw, SECRET, NOW);
    expect(r).toEqual({ ok: true, userId: USER_A, issuedAt: Math.floor(NOW / 1000) * 1000 });
  });

  test("assinatura inválida, segredo errado e formato quebrado", async () => {
    const raw = await signRequestPayload(payload(), SECRET);
    const [, body] = raw.split(".");
    expect(await parseSignedRequest(`AAAA.${body}`, SECRET, NOW)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(await parseSignedRequest(raw, "outro-segredo", NOW)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(await parseSignedRequest("sem-ponto", SECRET, NOW)).toMatchObject({ ok: false, reason: "malformed" });
    expect(await parseSignedRequest("", SECRET, NOW)).toMatchObject({ ok: false, reason: "malformed" });
    expect(await parseSignedRequest(null, SECRET, NOW)).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("algoritmo diferente", async () => {
    const raw = await signRequestPayload(payload({ algorithm: "HMAC-SHA1" }), SECRET);
    expect(await parseSignedRequest(raw, SECRET, NOW)).toMatchObject({ ok: false, reason: "bad_algorithm" });
  });

  test("payload quebrado (assinado, mas não é JSON / sem user_id)", async () => {
    const enc = btoa("isto não é json".replace(/ã/g, "a")).replace(/=+$/, "");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(enc)));
    const sig = btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await parseSignedRequest(`${sig}.${enc}`, SECRET, NOW)).toMatchObject({ ok: false, reason: "bad_payload" });
    const noUser = await signRequestPayload({ algorithm: "HMAC-SHA256", issued_at: Math.floor(NOW / 1000) }, SECRET);
    expect(await parseSignedRequest(noUser, SECRET, NOW)).toMatchObject({ ok: false, reason: "bad_payload" });
  });

  test("issued_at com mais de 24 h", async () => {
    const old = await signRequestPayload(payload({ issued_at: Math.floor(NOW / 1000) - 25 * 3600 }), SECRET);
    expect(await parseSignedRequest(old, SECRET, NOW)).toMatchObject({ ok: false, reason: "expired" });
    const ok = await signRequestPayload(payload({ issued_at: Math.floor(NOW / 1000) - 23 * 3600 }), SECRET);
    expect((await parseSignedRequest(ok, SECRET, NOW)).ok).toBe(true);
  });
});

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const mkOrg = async (slug: string) => {
      const organizationId = await ctx.db.insert("organizations", {
        name: slug,
        slug,
        settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { metaMessaging: true } },
        createdAt: now,
        updatedAt: now,
      });
      const userId = await ctx.db.insert("users", { email: `${slug}@example.test` });
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
      return { organizationId, memberId };
    };
    const mkConn = async (org: Awaited<ReturnType<typeof mkOrg>>, pageId: string, metaUserId: string) => {
      const connectionId = await ctx.db.insert("metaConnections", {
        organizationId: org.organizationId,
        authMethod: "facebook_login",
        tokenKind: "page",
        tokenEncrypted: "enc-token",
        tokenLast4: "oken",
        pageId,
        pageName: "Loja",
        scopes: [],
        authState: "ok",
        metaUserId,
        connectedByMemberId: org.memberId,
        createdAt: now,
        updatedAt: now,
      });
      const configId = await ctx.db.insert("channelConfigs", {
        organizationId: org.organizationId,
        channel: "messenger",
        displayName: "Loja",
        status: "active",
        metaConnectionId: connectionId,
        messengerPageId: pageId,
        createdAt: now,
        updatedAt: now,
      });
      return { connectionId, configId };
    };
    const orgA = await mkOrg("org-a");
    const orgB = await mkOrg("org-b");
    const target = await mkConn(orgA, "1000000000000001", USER_A);
    const otherUserSameOrg = await mkConn(orgA, "1000000000000002", USER_B);
    const otherOrg = await mkConn(orgB, "1000000000000003", USER_B);

    // Dados do CRM que precisam sobreviver.
    const contactId = await ctx.db.insert("contacts", {
      organizationId: orgA.organizationId,
      firstName: "Cliente",
      tags: [],
      createdAt: now,
      updatedAt: now,
    } as any);
    await ctx.db.insert("webhooks", {
      organizationId: orgA.organizationId,
      name: "w",
      url: "https://hooks.example.test/x",
      events: ["channel.session_lost"],
      secret: "s",
      isActive: true,
      createdAt: now,
    } as any);
    return { orgA, orgB, target, otherUserSameOrg, otherOrg, contactId };
  });
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

async function post(t: TestConvex<typeof schema>, path: string, signed: string | null, as: "form" | "json" = "form") {
  const body =
    signed === null
      ? ""
      : as === "form"
        ? new URLSearchParams({ signed_request: signed }).toString()
        : JSON.stringify({ signed_request: signed });
  return await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": as === "form" ? "application/x-www-form-urlencoded" : "application/json" },
    body,
  });
}

describe("POST /webhooks/meta-messaging/deauthorize", () => {
  test("revoga só as conexões do user_id, apaga token, desativa configs, 1 alerta e preserva o CRM", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const res = await post(t, "/webhooks/meta-messaging/deauthorize", await signRequestPayload(payload(), SECRET));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");

    const hooks = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.name.includes("triggerWebhooks"))
    );
    expect(hooks).toHaveLength(1);
    await cancelPendingJobs(t);

    const state = await t.run(async (ctx) => ({
      target: await ctx.db.get(s.target.connectionId),
      targetCfg: await ctx.db.get(s.target.configId),
      other: await ctx.db.get(s.otherUserSameOrg.connectionId),
      otherCfg: await ctx.db.get(s.otherUserSameOrg.configId),
      otherOrg: await ctx.db.get(s.otherOrg.connectionId),
      otherOrgCfg: await ctx.db.get(s.otherOrg.configId),
      contact: await ctx.db.get(s.contactId),
      notes: await ctx.db.query("notifications").collect(),
      audits: await ctx.db.query("auditLogs").collect(),
    }));
    expect(state.target).toMatchObject({ authState: "revoked", authSource: "deauthorize", tokenEncrypted: "", tokenLast4: "" });
    expect(state.targetCfg).toMatchObject({ status: "disabled" });
    expect((state.targetCfg as any).messengerPageId).toBeUndefined();
    expect(state.other).toMatchObject({ authState: "ok", tokenEncrypted: "enc-token" });
    expect(state.otherCfg).toMatchObject({ status: "active", messengerPageId: "1000000000000002" });
    expect(state.otherOrg).toMatchObject({ authState: "ok", tokenEncrypted: "enc-token" });
    expect(state.otherOrgCfg).toMatchObject({ status: "active" });
    expect(state.contact).not.toBeNull();
    expect(state.notes.filter((n) => n.type === "channel_session_lost")).toHaveLength(1);
    const audit = state.audits.filter((a) => a.entityType === "metaConnection");
    expect(audit).toHaveLength(1);
    expect(audit[0].severity).toBe("high");
    expect(audit[0].metadata).toMatchObject({ state: "revoked", source: "deauthorize", metaUserId: "····0001" });
    expect(state.target).toMatchObject({ metaUserId: USER_A }); // só a exclusão de dados limpa o id
    expect(JSON.stringify(state.audits)).not.toContain(USER_A);

    // Repetir não notifica de novo.
    const again = await post(t, "/webhooks/meta-messaging/deauthorize", await signRequestPayload(payload(), SECRET));
    expect(again.status).toBe(200);
    const notes2 = await t.run(async (ctx) => (await ctx.db.query("notifications").collect()).length);
    expect(notes2).toBe(state.notes.length);
  });

  test("user_id desconhecido: 200 vazio e nada muda", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const res = await post(
      t,
      "/webhooks/meta-messaging/deauthorize",
      await signRequestPayload(payload({ user_id: "7999999999999999" }), SECRET)
    );
    expect(res.status).toBe(200);
    const conn = await t.run(async (ctx) => await ctx.db.get(s.target.connectionId));
    expect(conn).toMatchObject({ authState: "ok" });
  });

  test("sem assinatura, assinatura inválida ou segredo ausente: 400", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    expect((await post(t, "/webhooks/meta-messaging/deauthorize", null)).status).toBe(400);
    expect((await post(t, "/webhooks/meta-messaging/deauthorize", await signRequestPayload(payload(), "outro"))).status).toBe(400);
    const signed = await signRequestPayload(payload({ user_id: "7999999999999999" }), SECRET);
    expect((await post(t, "/webhooks/meta-messaging/deauthorize", signed, "json")).status).toBe(200);
    vi.stubEnv("META_MESSAGING_APP_SECRET", "");
    expect((await post(t, "/webhooks/meta-messaging/deauthorize", signed)).status).toBe(400);
  });
});

describe("POST /webhooks/meta-messaging/data-deletion e GET /meta/deletion-status", () => {
  test("devolve {url, confirmation_code}, grava o pedido (só hash) e a página mostra o status", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const res = await post(t, "/webhooks/meta-messaging/data-deletion", await signRequestPayload(payload(), SECRET));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string; confirmation_code: string };
    expect(json.confirmation_code).toMatch(/^[0-9a-f]{16}$/);
    expect(json.url).toBe(`https://example.convex.site/meta/deletion-status?code=${json.confirmation_code}`);
    await cancelPendingJobs(t);

    const rows = await t.run(async (ctx) => await ctx.db.query("metaDeletionRequests").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ confirmationCode: json.confirmation_code, status: "done", connectionsRevoked: 1 });
    expect(rows[0].metaUserIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(USER_A);
    const conn = await t.run(async (ctx) => await ctx.db.get(s.target.connectionId));
    expect(conn).toMatchObject({ authState: "revoked", tokenEncrypted: "" });
    expect((conn as any).metaUserId).toBeUndefined();
    const audits = await t.run(async (ctx) => await ctx.db.query("auditLogs").collect());
    expect(audits.filter((a) => a.entityType === "metaConnection")).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(USER_A);

    // Repetir: o id já foi limpo, então nada a revogar e a página não diz "removidas".
    const again = (await (await post(t, "/webhooks/meta-messaging/data-deletion", await signRequestPayload(payload(), SECRET))).json()) as {
      confirmation_code: string;
    };
    const emptyPage = await (await t.fetch(`/meta/deletion-status?code=${again.confirmation_code}`, { method: "GET" })).text();
    expect(emptyPage).toContain("nenhuma credencial ativa estava associada");
    expect(emptyPage).not.toContain("removidas");
    await cancelPendingJobs(t);

    const page = await t.fetch(`/meta/deletion-status?code=${json.confirmation_code}`, { method: "GET" });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(json.confirmation_code);
    expect(html).toContain("1 conexões");
    expect(html).toContain("privacidade@hnbcrm.com");
    expect(html).not.toContain(USER_A);

    expect((await t.fetch("/meta/deletion-status?code=0000000000000000", { method: "GET" })).status).toBe(404);
    expect((await t.fetch("/meta/deletion-status?code=xyz", { method: "GET" })).status).toBe(404);
    expect((await t.fetch("/meta/deletion-status", { method: "GET" })).status).toBe(404);
  });

  test("conexão já revogada (deauthorize antes): a exclusão de dados ainda limpa o metaUserId", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await post(t, "/webhooks/meta-messaging/deauthorize", await signRequestPayload(payload(), SECRET));
    await cancelPendingJobs(t);
    const revoked = await t.run(async (ctx) => await ctx.db.get(s.target.connectionId));
    expect(revoked).toMatchObject({ authState: "revoked", tokenEncrypted: "", metaUserId: USER_A });

    const res = await post(t, "/webhooks/meta-messaging/data-deletion", await signRequestPayload(payload(), SECRET));
    expect(res.status).toBe(200);
    await cancelPendingJobs(t);
    const after = await t.run(async (ctx) => ({
      conn: await ctx.db.get(s.target.connectionId),
      other: await ctx.db.get(s.otherUserSameOrg.connectionId),
      req: (await ctx.db.query("metaDeletionRequests").collect())[0],
    }));
    expect((after.conn as any).metaUserId).toBeUndefined();
    expect(after.other).toMatchObject({ metaUserId: USER_B, authState: "ok" });
    expect(after.req.connectionsRevoked).toBe(0); // nada novo a revogar, mas o id saiu
  });

  test("sem assinatura: 400 e nenhum pedido gravado", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    expect((await post(t, "/webhooks/meta-messaging/data-deletion", null)).status).toBe(400);
    const n = await t.run(async (ctx) => (await ctx.db.query("metaDeletionRequests").collect()).length);
    expect(n).toBe(0);
  });
});

describe("saúde preenche o metaUserId ausente", () => {
  test("internalApplyHealthObservation grava userId só quando a conexão não tem", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { internal } = await import("./_generated/api");
    await t.run(async (ctx) => {
      await ctx.db.patch(s.target.connectionId, { metaUserId: undefined });
    });
    const obs = { isValid: true, scopes: ["pages_messaging"], userId: "7000000000000077" };
    await t.mutation(internal.metaMessaging.internalApplyHealthObservation, { connectionId: s.target.connectionId, observation: obs });
    expect((await t.run(async (ctx) => await ctx.db.get(s.target.connectionId)))?.metaUserId).toBe("7000000000000077");
    await t.mutation(internal.metaMessaging.internalApplyHealthObservation, {
      connectionId: s.target.connectionId,
      observation: { ...obs, userId: "7000000000000088" },
    });
    expect((await t.run(async (ctx) => await ctx.db.get(s.target.connectionId)))?.metaUserId).toBe("7000000000000077");
    await cancelPendingJobs(t);
  });
});
