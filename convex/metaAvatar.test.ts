/// <reference types="vite/client" />
/**
 * Foto do contato do Instagram/Messenger: aproveita a chamada de perfil do primeiro contato,
 * renova no máximo 1 vez por semana (uma chamada à Graph), mesmas validações de download do
 * WhatsApp, regra entre canais e foto manual vence. `fetch` simulado; bytes montados em código.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";
import { parseMetaMessagingWebhook } from "./lib/metaMessagingParse";
import { isAllowedMetaAvatarUrl } from "./lib/metaAvatar";
import pageText from "./__fixtures__/meta/page-message-text.json";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
const PAGE_ID = "1000000000000001";
const CDN = "https://scontent.xx.fbcdn.net/v/t1/pic.jpg?oh=abc";
const DAY = 24 * 3600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  vi.stubEnv("META_MESSAGING_APP_ID", "fake-app-id");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type T = TestConvex<typeof schema>;

async function seed(t: T) {
  const token = await encryptSecret("fake-page-token");
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org", slug: "org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { metaMessaging: true } },
      createdAt: now, updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "a@example.test" });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Ana", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Default", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("stages", {
      organizationId, boardId, name: "New", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false,
      createdAt: now, updatedAt: now,
    });
    const connectionId = await ctx.db.insert("metaConnections", {
      organizationId, authMethod: "facebook_login", tokenKind: "page", tokenEncrypted: token, tokenLast4: "oken",
      pageId: PAGE_ID, pageName: "Página", scopes: [], authState: "ok", connectedByMemberId: memberId,
      createdAt: now, updatedAt: now,
    });
    const messengerId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "messenger", displayName: "Página", status: "active",
      metaConnectionId: connectionId, messengerPageId: PAGE_ID, createdAt: now, updatedAt: now,
    });
    return { organizationId, messengerId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

function jpeg(size = 200): Uint8Array {
  const b = new Uint8Array(size).fill(5);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
}

type Net = { profile?: Record<string, unknown>; profileStatus?: number; image?: () => Response };
function stubNet(net: Net) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith("https://graph.facebook.com")) {
        return new Response(JSON.stringify(net.profile ?? {}), { status: net.profileStatus ?? 200 });
      }
      return net.image ? net.image() : new Response(jpeg() as BodyInit, { status: 200 });
    })
  );
  return {
    graph: () => calls.filter((c) => c.startsWith("https://graph.facebook.com")).length,
    cdn: () => calls.filter((c) => !c.startsWith("https://graph.facebook.com")).length,
  };
}

let seq = 0;
async function ingest(t: T, s: Seed, text?: string) {
  seq += 1;
  const body = JSON.parse(JSON.stringify(pageText));
  if (text) body.entry[0].messaging[0].message.text = text;
  body.entry[0].messaging[0].message.mid = `m_avatar_${seq}`;
  const { events } = parseMetaMessagingWebhook(body);
  await t.action(internal.metaMessaging.internalIngestEvent, { configId: s.messengerId, event: events[0] });
}

const state = (t: T) =>
  t.run(async (ctx) => {
    const row = await ctx.db.query("contactAvatars").first();
    const contact = await ctx.db.query("contacts").first();
    const file = row?.fileId ? await ctx.db.get(row.fileId) : null;
    return { row, contact, file, files: (await ctx.db.query("files").collect()).length };
  });

describe("allowlist de host", () => {
  test("só https nos CDNs da Meta", () => {
    expect(isAllowedMetaAvatarUrl("https://scontent.xx.fbcdn.net/a.jpg")).toBe(true);
    expect(isAllowedMetaAvatarUrl("https://scontent-gru2-1.cdninstagram.com/a.jpg")).toBe(true);
    expect(isAllowedMetaAvatarUrl("https://lookaside.fbsbx.com/a.jpg")).toBe(true);
    expect(isAllowedMetaAvatarUrl("http://scontent.xx.fbcdn.net/a.jpg")).toBe(false);
    expect(isAllowedMetaAvatarUrl("https://fbcdn.net.evil.test/a.jpg")).toBe(false);
    expect(isAllowedMetaAvatarUrl("https://evil.test/fbcdn.net")).toBe(false);
    expect(isAllowedMetaAvatarUrl("https://u:p@scontent.xx.fbcdn.net/a.jpg")).toBe(false);
  });
});

describe("primeiro contato", () => {
  test("perfil com profile_pic: UMA chamada à Graph, foto guardada e contacts.avatarUrl", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubNet({ profile: { first_name: "Ana", last_name: "Souza", profile_pic: CDN } });
    await ingest(t, s);
    expect(net.graph()).toBe(1);
    expect(net.cdn()).toBe(1);
    const st = await state(t);
    expect(st.row).toMatchObject({ status: "ok", source: "messenger" });
    expect(st.row?.url).toBeTypeOf("string");
    expect(st.contact?.avatarUrl).toBe(st.row?.url);
    expect(st.file).toMatchObject({ fileType: "other", createdAt: 0, metadata: { kind: "contact_avatar" } });
  });

  test("perfil sem profile_pic: none por 30 dias, sem download", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubNet({ profile: { first_name: "Ana" } });
    const before = Date.now();
    await ingest(t, s);
    expect(net.cdn()).toBe(0);
    const st = await state(t);
    expect(st.row).toMatchObject({ status: "none", source: "messenger" });
    expect(st.row!.nextCheckAt).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(st.contact?.avatarUrl).toBeUndefined();
  });

  test("host fora da allowlist é recusado (error), sem download", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubNet({ profile: { first_name: "Ana", profile_pic: "https://evil.example.test/p.jpg" } });
    await ingest(t, s);
    expect(net.cdn()).toBe(0);
    const st = await state(t);
    expect(st.row).toMatchObject({ status: "error", failures: 1 });
    expect(st.files).toBe(0);
  });

  test("imagem acima de 500 KB não é guardada (error com recuo)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubNet({ profile: { first_name: "Ana", profile_pic: CDN }, image: () => new Response(jpeg(600 * 1024) as BodyInit, { status: 200 }) });
    await ingest(t, s);
    const st = await state(t);
    expect(st.row).toMatchObject({ status: "error" });
    expect(st.files).toBe(0);
    expect(st.contact?.avatarUrl).toBeUndefined();
  });

  test("miniatura de 300 KB passa (teto Meta 500 KB, acima dos 200 KB do WhatsApp)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubNet({ profile: { first_name: "Ana", profile_pic: CDN }, image: () => new Response(jpeg(300 * 1024) as BodyInit, { status: 200 }) });
    await ingest(t, s);
    expect((await state(t)).row?.status).toBe("ok");
  });

  test("redirecionamento do CDN é recusado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubNet({ profile: { first_name: "Ana", profile_pic: CDN }, image: () => new Response(null, { status: 302, headers: { Location: "https://evil.test/x" } }) });
    await ingest(t, s);
    expect((await state(t)).row?.status).toBe("error");
  });
});

describe("renovação", () => {
  test("semanal: mensagem seguinte não chama a Graph; vencida chama UMA vez (só perfil) e atualiza", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubNet({ profile: { first_name: "Ana", profile_pic: CDN } });
    await ingest(t, s);
    await ingest(t, s);
    await ingest(t, s);
    expect(net.graph()).toBe(1);
    const first = (await state(t)).row!;
    vi.setSystemTime(Date.now() + 8 * DAY);
    stubNet({ profile: { first_name: "Ana", profile_pic: CDN }, image: () => new Response(jpeg(220) as BodyInit, { status: 200 }) });
    const net2 = stubNet({ profile: { first_name: "Ana", profile_pic: CDN }, image: () => new Response(jpeg(220) as BodyInit, { status: 200 }) });
    await ingest(t, s);
    await ingest(t, s);
    expect(net2.graph()).toBe(1);
    const second = (await state(t)).row!;
    expect(second.checkedAt).toBeGreaterThan(first.checkedAt);
    expect(second.nextCheckAt).toBeGreaterThan(first.nextCheckAt);
  });

  test("teto diário por conexão: acima dele não chama a Graph para foto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("channelAvatarPacing", {
        organizationId: s.organizationId, channelConfigId: s.messengerId, nextFetchAt: 0,
        day: new Date(Date.now()).toISOString().slice(0, 10), dayCount: 300,
      });
    });
    const net = stubNet({ profile: { first_name: "Ana", profile_pic: CDN } });
    await ingest(t, s);
    // O perfil de nome (primeiro contato) segue; a foto não.
    expect(net.cdn()).toBe(0);
    // Sem vaga: grava a linha com recuo de 1 h (não repete a cada mensagem), sem foto.
    const row = (await state(t)).row;
    expect(row).toMatchObject({ status: "none", checkedAt: 0 });
    expect(row?.url).toBeUndefined();
  });

  test("kill switch CONTACT_AVATAR_FETCH=0 não busca foto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    vi.stubEnv("CONTACT_AVATAR_FETCH", "0");
    const net = stubNet({ profile: { first_name: "Ana", profile_pic: CDN } });
    await ingest(t, s);
    expect(net.cdn()).toBe(0);
    expect((await state(t)).row).toBeNull();
  });
});

describe("regra entre canais e foto manual", () => {
  async function withWhatsappPhoto(t: T, s: Seed) {
    stubNet({ profile: { first_name: "Ana" } });
    await ingest(t, s);
    return await t.run(async (ctx) => {
      const row = (await ctx.db.query("contactAvatars").first())!;
      const contact = (await ctx.db.query("contacts").first())!;
      const storageId = await ctx.storage.store(new Blob([jpeg() as BlobPart], { type: "image/jpeg" }));
      const url = (await ctx.storage.getUrl(storageId))!;
      // Foto `ok` do WhatsApp (linha sem `source`), ainda válida por 7 dias.
      await ctx.db.patch(row._id, { status: "ok", source: undefined, url, storageId, pendingSince: undefined, nextCheckAt: Date.now() + 7 * DAY });
      await ctx.db.patch(contact._id, { avatarUrl: url });
      return { row, contact, url };
    });
  }

  test("foto ok de OUTRO canal ainda válida não é trocada nem apagada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const w = await withWhatsappPhoto(t, s);
    const key = { organizationId: s.organizationId, contactId: w.contact._id, channelConfigId: s.messengerId };
    // Não vence: nem reserva.
    expect(await t.mutation(internal.metaAvatar.internalReserveMetaAvatar, { ...key, source: "messenger" })).toBe(false);
    // Aplicação forçada (corrida) também recusa e apaga o blob novo.
    const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob([jpeg(150) as BlobPart], { type: "image/jpeg" })));
    expect(
      await t.mutation(internal.contactAvatar.internalApplyContactAvatar, { ...key, storageId, mimeType: "image/jpeg", size: 150, source: "messenger" })
    ).toBe(false);
    // "Sem foto" do Messenger não apaga a do WhatsApp.
    await t.mutation(internal.contactAvatar.internalRecordAvatarCheck, { ...key, outcome: "none", source: "messenger" });
    const st = await state(t);
    expect(st.row?.url).toBe(w.url);
    expect(st.contact?.avatarUrl).toBe(w.url);
  });

  test("vencida (ou sem foto) o canal Meta preenche; o mesmo canal troca livremente", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const w = await withWhatsappPhoto(t, s);
    await t.run(async (ctx) => ctx.db.patch(w.row._id, { nextCheckAt: Date.now() - 1000 }));
    const net = stubNet({ profile: { first_name: "Ana", profile_pic: CDN } });
    await ingest(t, s);
    expect(net.cdn()).toBe(1);
    const st = await state(t);
    expect(st.row?.source).toBe("messenger");
    expect(st.row?.fileId).toBeDefined();
    expect(st.contact?.avatarUrl).toBe(st.row?.url);
  });

  test("foto manual vence: avatarUrl do contato não muda", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubNet({ profile: { first_name: "Ana" } });
    await ingest(t, s);
    await t.run(async (ctx) => {
      const contact = (await ctx.db.query("contacts").first())!;
      const storageId = await ctx.storage.store(new Blob([jpeg() as BlobPart], { type: "image/jpeg" }));
      const fileId = await ctx.db.insert("files", {
        organizationId: s.organizationId, name: "manual.jpg", mimeType: "image/jpeg", size: 200,
        storageId, fileType: "other", createdAt: Date.now(),
      } as never);
      await ctx.db.patch(contact._id, { photoFileId: fileId, avatarUrl: "https://manual.example/x" });
      const row = (await ctx.db.query("contactAvatars").first())!;
      await ctx.db.patch(row._id, { nextCheckAt: 0 });
    });
    stubNet({ profile: { first_name: "Ana", profile_pic: CDN } });
    await ingest(t, s);
    const st = await state(t);
    expect(st.row?.status).toBe("ok");
    expect(st.contact?.avatarUrl).toBe("https://manual.example/x");
  });
});

describe("ordem no ingest e canal sem vaga", () => {
  test("o opt-out (\"pare\") é gravado ANTES da busca da foto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    let optedOutWhenFetched: boolean | null = null;
    stubNet({
      profile: { first_name: "Ana", profile_pic: CDN },
      image: () => {
        // A foto só é buscada depois do opt-out: lê o estado no momento do download.
        optedOutWhenFetched = (globalThis as any).__optedOut ?? null;
        return new Response(jpeg() as BodyInit, { status: 200 });
      },
    });
    const orig = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (!String(url).startsWith("https://graph.facebook.com")) {
        const identity = await t.run(async (ctx) => await ctx.db.query("contactChannelIdentities").first());
        (globalThis as any).__optedOut = identity?.optedOutAt !== undefined;
      }
      return orig(url as string, init);
    });
    await ingest(t, s, "pare");
    delete (globalThis as any).__optedOut;
    expect(optedOutWhenFetched).toBe(true);
  });

  test("canal no teto diário e contato sem linha: grava a linha com recuo de 1 h e não repete", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("channelAvatarPacing", {
        organizationId: s.organizationId, channelConfigId: s.messengerId, nextFetchAt: 0,
        day: new Date().toISOString().slice(0, 10), dayCount: 300,
      });
    });
    const net = stubNet({ profile: { first_name: "Ana", profile_pic: CDN } });
    const before = Date.now();
    await ingest(t, s);
    const st = await state(t);
    expect(st.row).toMatchObject({ status: "none", source: "messenger" });
    expect(st.row!.nextCheckAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(net.cdn()).toBe(0);
    const graphAfterFirst = net.graph();
    await ingest(t, s);
    expect(net.graph()).toBe(graphAfterFirst); // sem nova consulta de perfil/foto
  });
});
