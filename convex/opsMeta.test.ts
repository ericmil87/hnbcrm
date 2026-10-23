/// <reference types="vite/client" />
/**
 * Ops do Meta Messaging (F4): relatório mascarado, `internalMetaHealthNow` com
 * `dryRun` default e purga.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";
import { buildChannelSessionLostTemplate } from "./emailTemplates";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const DAY = 24 * 60 * 60 * 1000;
const PAGE_ID = "1000000000000001";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", btoa("A".repeat(32)));
  vi.stubEnv("META_MESSAGING_APP_ID", "fake-app-id");
  vi.stubEnv("META_MESSAGING_APP_SECRET", "fake-meta-app-secret");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seed(t: TestConvex<typeof schema>) {
  const tokenEncrypted = await encryptSecret("fake-page-token");
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { metaMessaging: true } },
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
    const connectionId = await ctx.db.insert("metaConnections", {
      organizationId,
      authMethod: "facebook_login",
      tokenKind: "page",
      tokenEncrypted,
      tokenLast4: "oken",
      pageId: PAGE_ID,
      pageName: "Loja",
      scopes: [],
      authState: "ok",
      connectedByMemberId: memberId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "messenger",
      displayName: "Loja",
      status: "active",
      metaConnectionId: connectionId,
      messengerPageId: PAGE_ID,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, memberId, connectionId };
  });
}

function stubDebug(body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify({ data: body }), { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("internalMetaConnectionsReport", () => {
  test("lista a conexão com o id da Página mascarado e sem token", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await t.query(internal.opsMeta.internalMetaConnectionsReport, {});
    expect(r.isDone).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      connectionId: s.connectionId,
      pageIdMasked: "····0001",
      authState: "ok",
      authDetail: null,
      lastHealthAt: null,
      dataAccessExpiresAt: null,
      configs: 1,
      notSubscribed: true,
    });
    const dump = JSON.stringify(r);
    expect(dump).not.toContain(PAGE_ID);
    expect(dump).not.toContain("oken");
  });

  test("pagina por cursor", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const base = (await ctx.db.get(s.connectionId))!;
      for (let i = 0; i < 4; i++) {
        const { _id, _creationTime, ...rest } = base;
        void _id;
        void _creationTime;
        await ctx.db.insert("metaConnections", rest);
      }
    });
    const p1 = await t.query(internal.opsMeta.internalMetaConnectionsReport, { pageSize: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.isDone).toBe(false);
    const p2 = await t.query(internal.opsMeta.internalMetaConnectionsReport, { pageSize: 2, cursor: p1.nextCursor });
    const p3 = await t.query(internal.opsMeta.internalMetaConnectionsReport, { pageSize: 2, cursor: p2.nextCursor });
    expect(p1.rows.length + p2.rows.length + p3.rows.length).toBe(5);
  });
});

describe("internalMetaHealthNow", () => {
  test("dryRun (padrão) mostra o debug_token e não grava", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const fn = stubDebug({ is_valid: false, scopes: ["pages_messaging"] });
    const r = await t.action(internal.opsMeta.internalMetaHealthNow, { connectionId: s.connectionId });
    expect(r.dryRun).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.rows).toEqual([
      {
        connectionId: s.connectionId,
        result: "observed",
        isValid: false,
        scopes: ["pages_messaging"],
        dataAccessExpiresAt: null,
        outcome: null,
      },
    ]);
    const conn = await t.run((ctx) => ctx.db.get(s.connectionId));
    expect(conn?.authState).toBe("ok");
    expect(conn?.lastHealthAt).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("fake-page-token");
  });

  test("dryRun:false aplica a observação", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubDebug({ is_valid: false });
    const r = await t.action(internal.opsMeta.internalMetaHealthNow, { connectionId: s.connectionId, dryRun: false });
    expect(r.rows[0].outcome).toBe("degraded");
    expect((await t.run((ctx) => ctx.db.get(s.connectionId)))?.authState).toBe("reauth_required");
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    await t.finishInProgressScheduledFunctions();
  });

  test("sem connectionId percorre a página de conexões", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const fn = stubDebug({ is_valid: true, scopes: ["pages_messaging"] });
    const r = await t.action(internal.opsMeta.internalMetaHealthNow, {});
    expect(r.rows).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("internalMetaPurge", () => {
  async function seedOld(t: TestConvex<typeof schema>) {
    const s = await seed(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: s.organizationId,
        channel: "messenger",
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      const messageId = await ctx.db.insert("messages", {
        organizationId: s.organizationId,
        conversationId,
        direction: "outbound",
        senderType: "human",
        content: "oi",
        contentType: "text",
        isInternal: false,
        createdAt: now,
      });
      await ctx.db.insert("metaSentMids", { organizationId: s.organizationId, mid: "old", messageId, createdAt: now - 9 * DAY });
      await ctx.db.insert("metaSentMids", { organizationId: s.organizationId, mid: "new", messageId, createdAt: now });
    });
  }

  test("dryRun (padrão) só conta", async () => {
    const t = convexTest(schema, modules);
    await seedOld(t);
    const r = await t.mutation(internal.opsMeta.internalMetaPurge, {});
    expect(r).toMatchObject({ dryRun: true, sentMids: 1, oauthStates: 0, oauthPending: 0, more: false });
    expect(await t.run(async (ctx) => (await ctx.db.query("metaSentMids").collect()).length)).toBe(2);
  });

  test("dryRun:false apaga só o antigo", async () => {
    const t = convexTest(schema, modules);
    await seedOld(t);
    const r = await t.mutation(internal.opsMeta.internalMetaPurge, { dryRun: false });
    expect(r.sentMids).toBe(1);
    const left = await t.run(async (ctx) => (await ctx.db.query("metaSentMids").collect()).map((m) => m.mid));
    expect(left).toEqual(["new"]);
  });
});

describe("e-mail channelSessionLost (Meta Messaging)", () => {
  test("cópia neutra, sem WhatsApp, sem número", () => {
    const reauth = buildChannelSessionLostTemplate({
      orgName: "Org",
      channelName: "Loja / @loja",
      provider: "meta_messaging",
      state: "reauth_required",
      detail: "A Meta informou que a autorização desta Página não é mais válida.",
    });
    expect(reauth.subject).toBe("Loja / @loja precisa ser reconectada");
    expect(reauth.html).not.toContain("WhatsApp");
    const expiring = buildChannelSessionLostTemplate({
      orgName: "Org",
      channelName: "Loja",
      provider: "meta_messaging",
      state: "data_access_expiring",
    });
    expect(expiring.subject).toBe("Reconecte Loja para manter o acesso");
    // Bridge intacto.
    expect(buildChannelSessionLostTemplate({ orgName: "Org", channelName: "Comercial", state: "logged_out" }).subject).toContain(
      "WhatsApp"
    );
  });
});
