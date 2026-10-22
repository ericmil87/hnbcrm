/// <reference types="vite/client" />
/**
 * Reconectar / concluir conexão / testar conexão / avatar / estatísticas por conta
 * do Meta Messaging (F4).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const PAGE_ID = "1000000000000001";
const IG_ID = "1000000000000003";
const GOOD_SCOPES = ["pages_messaging", "instagram_manage_messages"];

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
      igAccountId: IG_ID,
      igUsername: "loja",
      scopes: GOOD_SCOPES,
      authState: "ok",
      connectedByMemberId: memberId,
      createdAt: now,
      updatedAt: now,
    });
    const messengerId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "messenger",
      displayName: "Loja",
      status: "active",
      metaConnectionId: connectionId,
      messengerPageId: PAGE_ID,
      metaAccountLabel: "Loja",
      createdAt: now,
      updatedAt: now,
    });
    const instagramId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "instagram",
      displayName: "@loja",
      status: "active",
      metaConnectionId: connectionId,
      instagramAccountId: IG_ID,
      metaAccountLabel: "Loja",
      metaAccountHandle: "@loja",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, userId, memberId, connectionId, messengerId, instagramId };
  });
}

type Stub = {
  calls: { method: string; url: string }[];
  /** Muda o conteúdo da imagem servida para a Página (troca de avatar). */
  setPageImage: (bytes: number[]) => void;
};

/** Graph + CDN stubados. `subscribe`: resposta do POST subscribed_apps. */
function stubGraph(
  opts: {
    subscribe?: { status: number; body: unknown };
    debug?: Record<string, unknown>;
    profileStatus?: number;
    noPictures?: boolean;
  } = {}
): Stub {
  const calls: Stub["calls"] = [];
  let pageImage = [1, 2, 3, 4];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ method: init?.method ?? "GET", url: u });
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
      if (u.includes("/subscribed_apps")) {
        const r = opts.subscribe ?? { status: 200, body: { success: true } };
        return json(r.status, r.body);
      }
      if (u.includes("/debug_token")) {
        return json(200, { data: opts.debug ?? { is_valid: true, scopes: GOOD_SCOPES } });
      }
      if (u.startsWith("https://cdn.test/")) {
        const bytes = u.endsWith("page.png") ? pageImage : [9, 9, 9];
        return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/png" } });
      }
      if (u.includes("fields=picture")) {
        return opts.noPictures ? json(200, {}) : json(200, { picture: { data: { url: "https://cdn.test/page.png" } } });
      }
      if (u.includes("fields=profile_picture_url")) {
        return opts.noPictures ? json(200, {}) : json(200, { profile_picture_url: "https://cdn.test/ig.png" });
      }
      if (u.includes("fields=name")) return json(opts.profileStatus ?? 200, { name: "Loja Oficial" });
      if (u.includes("fields=username")) return json(opts.profileStatus ?? 200, { username: "loja" });
      return json(404, {});
    })
  );
  return { calls, setPageImage: (b) => (pageImage = b) };
}

const asAdmin = (t: TestConvex<typeof schema>, s: { userId: Id<"users"> }) =>
  t.withIdentity({ subject: `${s.userId}|s1` });

async function cancelPendingJobs(t: TestConvex<typeof schema>) {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
}

describe("completeMetaConnection", () => {
  test("refaz a inscrição com os 9 campos e grava subscribedAt", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const stub = stubGraph();
    const res = await asAdmin(t, s).action(api.metaMessaging.completeMetaConnection, {
      organizationId: s.organizationId,
      connectionId: s.connectionId,
    });
    expect(res).toEqual({ ok: true });
    const sub = stub.calls.find((c) => c.url.includes("/subscribed_apps"));
    expect(sub?.method).toBe("POST");
    const fields = new URL(sub!.url).searchParams.get("subscribed_fields")!.split(",");
    expect(fields).toHaveLength(9);
    const conn = await t.run((ctx) => ctx.db.get(s.connectionId));
    expect(conn?.subscribedAt).toBeTypeOf("number");
    expect(conn?.subscribedFields).toEqual(fields);
    await cancelPendingJobs(t);
  });

  test("190 na inscrição: reauth_required com aviso; falha comum não muda o estado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph({ subscribe: { status: 400, body: { error: { code: 190, message: "x" } } } });
    const res = await asAdmin(t, s).action(api.metaMessaging.completeMetaConnection, {
      organizationId: s.organizationId,
      connectionId: s.connectionId,
    });
    expect(res).toEqual({ ok: false, code: "reauth_required" });
    expect((await t.run((ctx) => ctx.db.get(s.connectionId)))?.authState).toBe("reauth_required");

    const s2 = await seed(t);
    stubGraph({ subscribe: { status: 500, body: {} } });
    const res2 = await asAdmin(t, s2).action(api.metaMessaging.completeMetaConnection, {
      organizationId: s2.organizationId,
      connectionId: s2.connectionId,
    });
    expect(res2).toEqual({ ok: false, code: "falha_meta" });
    const conn2 = await t.run((ctx) => ctx.db.get(s2.connectionId));
    expect(conn2?.authState).toBe("ok");
    expect(conn2?.subscribedAt).toBeUndefined();
    await cancelPendingJobs(t);
  });

  test("exige settings:manage e a conexão da própria org", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const other = await seed(t); // outra org (mesmo slug é irrelevante em teste)
    stubGraph();
    const viewer = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "v@example.test" });
      await ctx.db.insert("teamMembers", {
        organizationId: s.organizationId,
        userId,
        name: "Vera",
        role: "agent",
        type: "human",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return userId;
    });
    await expect(
      asAdmin(t, { userId: viewer }).action(api.metaMessaging.completeMetaConnection, {
        organizationId: s.organizationId,
        connectionId: s.connectionId,
      })
    ).rejects.toThrow();
    await expect(
      asAdmin(t, s).action(api.metaMessaging.completeMetaConnection, {
        organizationId: s.organizationId,
        connectionId: other.connectionId,
      })
    ).rejects.toThrow();
  });

  test("avatar: grava via files, troca na repetição sem deixar órfão", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const stub = stubGraph();
    const run = () =>
      asAdmin(t, s).action(api.metaMessaging.completeMetaConnection, {
        organizationId: s.organizationId,
        connectionId: s.connectionId,
      });
    await run();
    const first = await t.run(async (ctx) => {
      const m = await ctx.db.get(s.messengerId);
      const i = await ctx.db.get(s.instagramId);
      return { m: m?.metaAccountAvatarFileId, i: i?.metaAccountAvatarFileId };
    });
    expect(first.m).toBeTruthy();
    expect(first.i).toBeTruthy();
    const files1 = await t.run(async (ctx) => await ctx.db.query("files").collect());
    expect(files1).toHaveLength(2);
    expect(files1.every((f) => f.fileType === "other" && f.metadata?.kind === "channel_avatar")).toBe(true);
    expect(files1.every((f) => f.mimeType === "image/png")).toBe(true);
    const oldMessengerStorage = files1.find((f) => f._id === first.m)!.storageId;

    stub.setPageImage([7, 7, 7, 7, 7]);
    await run();
    const second = await t.run(async (ctx) => (await ctx.db.get(s.messengerId))?.metaAccountAvatarFileId);
    expect(second).not.toBe(first.m);
    const files2 = await t.run(async (ctx) => await ctx.db.query("files").collect());
    expect(files2).toHaveLength(2); // o antigo saiu: sem linha órfã
    expect(files2.some((f) => f._id === first.m)).toBe(false);
    const gone = await t.run(async (ctx) => await ctx.storage.getUrl(oldMessengerStorage as Id<"_storage">));
    expect(gone).toBeNull(); // nem o blob

    // Aparece nas duas leituras de UI, sem nunca expor token.
    const accounts = await asAdmin(t, s).query(api.channelConfigs.getInboxChannelAccounts, {
      organizationId: s.organizationId,
    });
    expect(accounts.every((a) => typeof a.avatarUrl === "string")).toBe(true);
    await cancelPendingJobs(t);
  });

  test("sem foto na Meta: segue sem avatar e a conclusão não falha", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph({ noPictures: true });
    const res = await asAdmin(t, s).action(api.metaMessaging.completeMetaConnection, {
      organizationId: s.organizationId,
      connectionId: s.connectionId,
    });
    expect(res.ok).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(s.messengerId)))?.metaAccountAvatarFileId).toBeUndefined();
    await cancelPendingJobs(t);
  });
});

describe("reconectar (mesma Página)", () => {
  test("volta a ok, limpa o alerta, reativa o config desativado e preserva a conta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // Credencial morta + config desativado (ex.: desconectado) por causa dela.
    await t.run(async (ctx) => {
      await ctx.db.patch(s.connectionId, {
        authState: "reauth_required",
        authDetail: "token expirado",
        authAlertedAt: Date.now(),
      });
      await ctx.db.patch(s.messengerId, { status: "disabled" });
    });
    const up = await t.mutation(internal.metaMessaging.internalUpsertMetaConnection, {
      organizationId: s.organizationId,
      memberId: s.memberId,
      connectionId: s.connectionId,
      pageId: PAGE_ID,
      pageName: "Loja",
      igAccountId: IG_ID,
      igUsername: "loja",
      tokenEncrypted: await encryptSecret("fake-new-token"),
      tokenLast4: "oken",
      scopes: GOOD_SCOPES,
      subscribedAt: Date.now(),
      subscribedFields: ["messages"],
    });
    expect(up).toMatchObject({ ok: true, connectionId: s.connectionId });
    await t.mutation(internal.metaMessaging.internalUpsertMetaChannelConfigs, {
      organizationId: s.organizationId,
      memberId: s.memberId,
      connectionId: s.connectionId,
      messenger: true,
      instagram: true,
    });
    const conn = await t.run((ctx) => ctx.db.get(s.connectionId));
    expect(conn?.authState).toBe("ok");
    expect(conn?.authDetail).toBeUndefined();
    expect(conn?.authAlertedAt).toBeUndefined();
    expect(conn?.subscribedAt).toBeTypeOf("number");
    expect((await t.run((ctx) => ctx.db.get(s.messengerId)))?.status).toBe("active");
    // Reconectar não duplica configs.
    const all = await t.run(async (ctx) => await ctx.db.query("channelConfigs").collect());
    expect(all).toHaveLength(2);

    // Um novo 190 volta a avisar (marcador limpo).
    await t.mutation(internal.metaMessaging.internalMarkConnectionReauthRequired, {
      connectionId: s.connectionId,
      detail: "de novo",
    });
    const notes = await t.run(async (ctx) => await ctx.db.query("notifications").collect());
    expect(notes).toHaveLength(1);
    await cancelPendingJobs(t);
  });
});

describe("checkChannelHealth (Instagram/Messenger)", () => {
  test("Messenger: grava healthDetail com o nome e aplica a observação, sem mexer no status", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const stub = stubGraph({ debug: { is_valid: true, scopes: GOOD_SCOPES } });
    const res = await asAdmin(t, s).action(api.channelConfigs.checkChannelHealth, { configId: s.messengerId });
    expect(res).toEqual({ ok: true, verifiedName: "Loja Oficial" });
    const cfg = await t.run((ctx) => ctx.db.get(s.messengerId));
    expect(cfg?.healthDetail).toBe("Conectado como Loja Oficial");
    expect(cfg?.lastHealthCheckAt).toBeTypeOf("number");
    expect(cfg?.status).toBe("active");
    expect((await t.run((ctx) => ctx.db.get(s.connectionId)))?.lastHealthAt).toBeTypeOf("number");
    // Nada da Graph do WhatsApp (v23.0): só a versão da Meta Messaging.
    expect(stub.calls.every((c) => !c.url.includes("v23.0"))).toBe(true);
  });

  test("Instagram: usa o @ da conta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    const res = await asAdmin(t, s).action(api.channelConfigs.checkChannelHealth, { configId: s.instagramId });
    expect(res).toEqual({ ok: true, verifiedName: "@loja" });
    expect((await t.run((ctx) => ctx.db.get(s.instagramId)))?.healthDetail).toBe("Conectado como @loja");
  });

  test("token inválido: erro PT-BR, reauth_required na conexão e status do config intacto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph({ debug: { is_valid: false } });
    const res = await asAdmin(t, s).action(api.channelConfigs.checkChannelHealth, { configId: s.messengerId });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Reconecte");
    expect((await t.run((ctx) => ctx.db.get(s.connectionId)))?.authState).toBe("reauth_required");
    const cfg = await t.run((ctx) => ctx.db.get(s.messengerId));
    expect(cfg?.status).toBe("active");
    expect(cfg?.healthDetail).toContain("Reconecte");
    await cancelPendingJobs(t);
  });

  test("perfil recusado pela Meta: ok:false sem derrubar a conexão", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph({ profileStatus: 403 });
    const res = await asAdmin(t, s).action(api.channelConfigs.checkChannelHealth, { configId: s.messengerId });
    expect(res.ok).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(s.connectionId)))?.authState).toBe("ok");
  });
});

describe("getChannelConfigs (maskConfig)", () => {
  test("campos de saúde e avatar, nunca token", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await asAdmin(t, s).action(api.metaMessaging.completeMetaConnection, {
      organizationId: s.organizationId,
      connectionId: s.connectionId,
    });
    await t.run((ctx) =>
      ctx.db.patch(s.connectionId, { lastHealthAt: 1234, dataAccessExpiresAt: 5678, authDetail: "data_access_expiring" })
    );
    const list = await asAdmin(t, s).query(api.channelConfigs.getChannelConfigs, { organizationId: s.organizationId });
    const messenger = list.find((c: { _id: Id<"channelConfigs"> }) => c._id === s.messengerId);
    expect(messenger).toMatchObject({
      metaAuthDetail: "data_access_expiring",
      metaLastHealthAt: 1234,
      metaDataAccessExpiresAt: 5678,
      hasMetaToken: true,
    });
    expect(typeof messenger?.metaAvatarUrl).toBe("string");
    const dump = JSON.stringify(list);
    expect(dump).not.toContain("tokenEncrypted");
    expect(dump).not.toContain("fake-page-token");
    await cancelPendingJobs(t);
  });
});

describe("getChannelStats por conta", () => {
  test("conta só as conversas do config pedido; WhatsApp segue igual", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      const mk = async (configId: Id<"channelConfigs">, channel: "messenger" | "instagram") =>
        await ctx.db.insert("conversations", {
          organizationId: s.organizationId,
          channel,
          channelConfigId: configId,
          channelProvider: channel,
          status: "active",
          messageCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      const msg = async (
        conversationId: Id<"conversations">,
        direction: "inbound" | "outbound",
        createdAt: number,
        deliveryStatus?: "sent" | "delivered" | "read" | "failed"
      ) =>
        await ctx.db.insert("messages", {
          organizationId: s.organizationId,
          conversationId,
          direction,
          senderType: direction === "inbound" ? "contact" : "human",
          content: "x",
          contentType: "text",
          isInternal: false,
          ...(deliveryStatus ? { deliveryStatus } : {}),
          createdAt,
        });
      const ms = await mk(s.messengerId, "messenger");
      const ig = await mk(s.instagramId, "instagram");
      await msg(ms, "inbound", now - 1000);
      await msg(ms, "outbound", now - 900, "delivered");
      await msg(ms, "outbound", now - 800, "read");
      await msg(ms, "outbound", now - 700, "failed");
      await msg(ms, "outbound", now - 30 * 24 * 3600 * 1000, "sent"); // fora da janela
      await msg(ig, "inbound", now - 500);
      await msg(ig, "inbound", now - 400);
    });
    const since = now - 7 * 24 * 3600 * 1000;
    const m = await asAdmin(t, s).query(api.channelConfigs.getChannelStats, {
      organizationId: s.organizationId,
      since,
      configId: s.messengerId,
    });
    expect(m).toMatchObject({ sent: 3, delivered: 2, read: 1, failed: 1, inbound: 1, sampled: false });
    expect(m.lastInboundAt).toBe(now - 1000);
    const i = await asAdmin(t, s).query(api.channelConfigs.getChannelStats, {
      organizationId: s.organizationId,
      since,
      configId: s.instagramId,
    });
    expect(i).toMatchObject({ sent: 0, inbound: 2 });
    // Sem config: o cálculo de sempre (só WhatsApp) não enxerga Instagram/Messenger.
    const wa = await asAdmin(t, s).query(api.channelConfigs.getChannelStats, {
      organizationId: s.organizationId,
      since,
    });
    expect(wa).toMatchObject({ sent: 0, inbound: 0 });
  });
});
