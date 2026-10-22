/// <reference types="vite/client" />
/**
 * Meta Messaging F2: mídia recebida baixada primeiro (D7), tipos ricos e a
 * regra "a mensagem nunca se perde". `fetch` é stubado, inclusive o download.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";
import { parseMetaMessagingWebhook } from "./lib/metaMessagingParse";
import { FILE_QUOTAS } from "./lib/fileQuotas";
import { readStorageUsage } from "./lib/storageUsage";
import { validateInboundMimeType } from "./lib/fileValidation";
import { isSticker } from "./lib/mediaEnrichment";
import igImage from "./__fixtures__/meta/instagram-message-image.json";
import igStory from "./__fixtures__/meta/instagram-story-mention.json";
import igStoryReply from "./__fixtures__/meta/instagram-story-reply.json";
import igPost from "./__fixtures__/meta/instagram-ig-post.json";
import igLike from "./__fixtures__/meta/instagram-like-heart.json";
import pageFile from "./__fixtures__/meta/page-message-attachment.json";
import pageSticker from "./__fixtures__/meta/page-message-sticker.json";
import pageFallback from "./__fixtures__/meta/page-message-fallback.json";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const PAGE_ID = "1000000000000001";
const IG_ID = "1000000000000003";

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

async function seed(t: TestConvex<typeof schema>) {
  const token = await encryptSecret("fake-page-token");
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
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Default",
      color: "#6366f1",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "New",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    const connectionId = await ctx.db.insert("metaConnections", {
      organizationId,
      authMethod: "facebook_login",
      tokenKind: "page",
      tokenEncrypted: token,
      tokenLast4: "oken",
      pageId: PAGE_ID,
      pageName: "Página",
      igAccountId: IG_ID,
      scopes: [],
      authState: "ok",
      connectedByMemberId: memberId,
      createdAt: now,
      updatedAt: now,
    });
    const messengerId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "messenger",
      displayName: "Página",
      status: "active",
      metaConnectionId: connectionId,
      messengerPageId: PAGE_ID,
      createdAt: now,
      updatedAt: now,
    });
    const instagramId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "instagram",
      displayName: "@conta",
      status: "active",
      metaConnectionId: connectionId,
      instagramAccountId: IG_ID,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, instagramId, messengerId };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

/** Perfil da Graph = 200 vazio; qualquer outra URL cai na rota casada por prefixo. */
function stubFetch(media: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith("https://graph.facebook.com")) return new Response("{}", { status: 200 });
    for (const [prefix, make] of Object.entries(media)) if (u.startsWith(prefix)) return await make();
    return new Response("nope", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls, mediaCalls: () => calls.filter((c) => !c.startsWith("https://graph.facebook.com")) };
}

const bytes = (n = 64) => new Uint8Array(n).fill(7);
const reply = (mime: string, body: Uint8Array = bytes(), headers: Record<string, string> = {}) => () =>
  new Response(body as BodyInit, { status: 200, headers: { "content-type": mime, ...headers } });

async function ingest(t: TestConvex<typeof schema>, s: Seed, fixture: unknown, which: "instagram" | "messenger") {
  const { events } = parseMetaMessagingWebhook(fixture);
  await t.action(internal.metaMessaging.internalIngestEvent, {
    configId: which === "instagram" ? s.instagramId : s.messengerId,
    event: events[0],
  });
}

async function scheduledNames(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((j) => j.name));
}

async function messages(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => await ctx.db.query("messages").collect());
}

async function drain(t: TestConvex<typeof schema>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("mídia recebida: baixa primeiro", () => {
  test("imagem: baixada, files + contentType image, visão agendada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubFetch({ "https://cdn.example.test/image-fake.jpg": reply("image/jpeg", bytes(128)) });
    await ingest(t, s, igImage, "instagram");

    const [m] = await messages(t);
    expect(m).toMatchObject({ contentType: "image", content: "[imagem]", direction: "inbound" });
    expect(m.attachments).toHaveLength(1);
    expect(m.metadata).toMatchObject({ metaType: "image" });
    expect(m.metadata?.mediaUnavailable).toBeUndefined();
    expect(m.metadata?.mediaPending).toBeUndefined();
    const files = await t.run(async (ctx) => await ctx.db.query("files").collect());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      mimeType: "image/jpeg",
      size: 128,
      fileType: "message_attachment",
      messageId: m._id,
    });
    expect(net.mediaCalls()).toEqual(["https://cdn.example.test/image-fake.jpg"]);
    // Sem o token da Meta na requisição de mídia (a URL do CDN já vem assinada).
    const init = net.fn.mock.calls.find((c) => String(c[0]).startsWith("https://cdn"))![1] as RequestInit | undefined;
    expect(init?.headers).toBeUndefined();
    expect(await scheduledNames(t)).toContain("vision:autoDescribe");
    await drain(t);
  });

  test("URL 404: a mensagem fica, sem anexo, com mediaUnavailable e a lista para reprocessar", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({ "https://cdn.example.test/": () => new Response("gone", { status: 404 }) });
    await ingest(t, s, igImage, "instagram");
    const [m] = await messages(t);
    expect(m).toMatchObject({ contentType: "text", content: "[imagem]" });
    expect(m.attachments).toBeUndefined();
    expect(m.metadata).toMatchObject({ metaType: "image", mediaUnavailable: "expired" });
    expect(m.metadata?.metaAttachments).toEqual([
      { type: "image", url: "https://cdn.example.test/image-fake.jpg" },
    ]);
    expect(await t.run(async (ctx) => await ctx.db.query("files").collect())).toHaveLength(0);
    expect(await scheduledNames(t)).not.toContain("vision:autoDescribe");
    await drain(t);
  });

  test("timeout (fetch lança): a mensagem nunca se perde", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({
      "https://cdn.example.test/": () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await ingest(t, s, igImage, "instagram");
    } finally {
      // O log não pode carregar a URL nem o mid.
      for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain("cdn.example.test");
      warn.mockRestore();
    }
    const all = await messages(t);
    expect(all).toHaveLength(1);
    expect(all[0].metadata).toMatchObject({ mediaUnavailable: "expired" });
    await drain(t);
  });

  test("corpo vazio de lib de rede quebrada (stream que lança) também não perde a mensagem", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({
      "https://cdn.example.test/": () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("conexão caiu"));
            },
          }),
          { status: 200, headers: { "content-type": "image/jpeg" } }
        ),
    });
    await ingest(t, s, igImage, "instagram");
    const all = await messages(t);
    expect(all).toHaveLength(1);
    expect(all[0].metadata?.mediaUnavailable).toBe("error");
    await drain(t);
  });

  test("mime recusado: mensagem sem anexo, com o motivo; o blob não fica", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({ "https://cdn.example.test/": reply("application/x-msdownload") });
    await ingest(t, s, pageFile, "messenger");
    const [m] = await messages(t);
    expect(m.attachments).toBeUndefined();
    expect(m.metadata?.mediaUnavailable).toBe("mime");
    expect(m.metadata?.mediaUnavailableDetail).toContain("tipo de mídia não permitido");
    expect(await t.run(async (ctx) => await ctx.db.query("files").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => await ctx.db.system.query("_storage").collect())).toHaveLength(0);
    await drain(t);
  });

  test("cota estourada: mensagem sem anexo, com o motivo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("files", {
        organizationId: s.organizationId,
        storageId: "blob-antigo",
        name: "antigo.pdf",
        mimeType: "application/pdf",
        size: FILE_QUOTAS.free.totalStorage - 10,
        fileType: "message_attachment",
        createdAt: Date.now(),
      });
    });
    stubFetch({ "https://cdn.example.test/": reply("image/jpeg", bytes(500)) });
    await ingest(t, s, igImage, "instagram");
    const [m] = await messages(t);
    expect(m.attachments).toBeUndefined();
    expect(m.metadata?.mediaUnavailable).toBe("quota");
    expect(m.metadata?.mediaUnavailableDetail).toContain("cota de armazenamento");
    await drain(t);
  });

  test("content-length acima de 25 MB é recusado sem ler o corpo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({ "https://cdn.example.test/": reply("image/jpeg", bytes(8), { "content-length": String(30 * 1024 * 1024) }) });
    await ingest(t, s, igImage, "instagram");
    const [m] = await messages(t);
    expect(m.attachments).toBeUndefined();
    expect(m.metadata?.mediaUnavailable).toBe("too_large");
    expect(m.metadata?.mediaUnavailableDetail).toContain("25 MB");
    await drain(t);
  });

  test("áudio do IG (m4a): contentType audio e transcrição agendada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({ "https://cdn.example.test/": reply("audio/mp4", bytes(256)) });
    const audio = {
      object: "instagram",
      entry: [
        {
          id: IG_ID,
          messaging: [
            {
              sender: { id: "1000000000000004" },
              recipient: { id: IG_ID },
              timestamp: 10,
              message: {
                mid: "ig_fake_mid_000020",
                attachments: [{ type: "audio", payload: { url: "https://cdn.example.test/voz-fake.m4a" } }],
              },
            },
          ],
        },
      ],
    };
    await ingest(t, s, audio, "instagram");
    const [m] = await messages(t);
    expect(m).toMatchObject({ contentType: "audio", content: "[áudio]" });
    expect(m.attachments).toHaveLength(1);
    expect(await scheduledNames(t)).toContain("transcription:autoTranscribe");
    expect(await scheduledNames(t)).not.toContain("vision:autoDescribe");
    await drain(t);
  });

  test("vídeo: contentType file com metaType video (o front escolhe o player pelo mime)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({ "https://cdn.example.test/": reply("video/mp4", bytes(512)) });
    const video = {
      object: "instagram",
      entry: [
        {
          id: IG_ID,
          messaging: [
            {
              sender: { id: "1000000000000004" },
              recipient: { id: IG_ID },
              timestamp: 10,
              message: {
                mid: "ig_fake_mid_000021",
                attachments: [{ type: "video", payload: { url: "https://cdn.example.test/clipe-fake.mp4" } }],
              },
            },
          ],
        },
      ],
    };
    await ingest(t, s, video, "instagram");
    const [m] = await messages(t);
    expect(m).toMatchObject({ contentType: "file", content: "[vídeo]" });
    expect(m.metadata).toMatchObject({ metaType: "video" });
    const files = await t.run(async (ctx) => await ctx.db.query("files").collect());
    expect(files[0].mimeType).toBe("video/mp4");
    expect(await scheduledNames(t)).not.toContain("vision:autoDescribe");
    await drain(t);
  });

  test("arquivo no Messenger: contentType file, PDF salvo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({ "https://cdn.example.test/": reply("application/pdf", bytes(300)) });
    await ingest(t, s, pageFile, "messenger");
    const [m] = await messages(t);
    expect(m).toMatchObject({ contentType: "file", content: "[arquivo]" });
    const files = await t.run(async (ctx) => await ctx.db.query("files").collect());
    expect(files[0]).toMatchObject({ mimeType: "application/pdf" });
    await drain(t);
  });

  test("story mention: imagem baixada, metaType story_mention", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({ "https://cdn.example.test/": reply("image/jpeg") });
    await ingest(t, s, igStory, "instagram");
    const [m] = await messages(t);
    expect(m).toMatchObject({ contentType: "image", content: "[menção em story]" });
    expect(m.metadata).toMatchObject({ metaType: "story_mention" });
    expect(m.attachments).toHaveLength(1);
    await drain(t);
  });

  test("story mention em vídeo vira file", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({ "https://cdn.example.test/": reply("video/mp4") });
    await ingest(t, s, igStory, "instagram");
    const [m] = await messages(t);
    expect(m.contentType).toBe("file");
    expect(m.metadata).toMatchObject({ metaType: "story_mention" });
    await drain(t);
  });
});

describe("tipos ricos sem download", () => {
  test("like_heart: [curtiu], sem download e sem visão", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubFetch({});
    await ingest(t, s, igLike, "instagram");
    const [m] = await messages(t);
    expect(m).toMatchObject({ contentType: "text", content: "[curtiu]" });
    expect(m.metadata).toMatchObject({ metaType: "like_heart" });
    expect(m.attachments).toBeUndefined();
    expect(net.mediaCalls()).toHaveLength(0);
    expect(await scheduledNames(t)).not.toContain("vision:autoDescribe");
    expect(isSticker(m.metadata)).toBe(true);
    await drain(t);
  });

  test("sticker do Messenger: [sticker], sem download", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubFetch({});
    await ingest(t, s, pageSticker, "messenger");
    const [m] = await messages(t);
    expect(m).toMatchObject({ contentType: "text", content: "[sticker]" });
    expect(m.metadata).toMatchObject({ metaType: "sticker" });
    expect(net.mediaCalls()).toHaveLength(0);
    expect(isSticker(m.metadata)).toBe(true);
    await drain(t);
  });

  test("ig_post: [post] sem download, com metaLink", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubFetch({});
    await ingest(t, s, igPost, "instagram");
    const [m] = await messages(t);
    expect(m).toMatchObject({ contentType: "text", content: "[post]" });
    expect(m.metadata).toMatchObject({
      metaType: "ig_post",
      metaLink: { url: "https://www.instagram.example.test/p/fake/", title: "Legenda do post" },
    });
    expect(net.mediaCalls()).toHaveLength(0);
    await drain(t);
  });

  test("fallback: o texto traz título e link", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubFetch({});
    await ingest(t, s, pageFallback, "messenger");
    const [m] = await messages(t);
    expect(m.content).toBe("Link de exemplo\nhttps://example.test/link");
    expect(m.metadata).toMatchObject({ metaType: "fallback", metaLink: { url: "https://example.test/link" } });
    expect(net.mediaCalls()).toHaveLength(0);
    await drain(t);
  });

  test("resposta a story: texto da mensagem + storyReply, sem baixar a URL do story", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const net = stubFetch({});
    await ingest(t, s, igStoryReply, "instagram");
    const [m] = await messages(t);
    expect(m.content).toBe("Adorei!");
    expect(m.metadata?.storyReply).toEqual({ url: "https://cdn.example.test/story-fake.jpg", id: "1000000000000099" });
    expect(net.mediaCalls()).toHaveLength(0);
    await drain(t);
  });

  test("redelivery do mesmo mid não duplica mensagem nem arquivo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({ "https://cdn.example.test/": reply("image/jpeg") });
    await ingest(t, s, igImage, "instagram");
    await ingest(t, s, igImage, "instagram");
    expect(await messages(t)).toHaveLength(1);
    expect(await t.run(async (ctx) => await ctx.db.query("files").collect())).toHaveLength(1);
    await drain(t);
  });
});

describe("entrega repetida em paralelo", () => {
  test("segundo ingest do mesmo mid descarta o arquivo e o blob que baixou: 1 mensagem, 1 files, cota certa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const save = async (size: number) => {
      const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob([new Uint8Array(size)])));
      const saved = await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
        organizationId: s.organizationId,
        storageId,
        name: "a.jpg",
        mimeType: "image/jpeg",
        size,
      });
      if (!saved.ok) throw new Error("falhou");
      return saved.fileId;
    };
    const lead = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("leads", {
        organizationId: s.organizationId,
        title: "L",
        boardId: (await ctx.db.query("boards").first())!._id,
        stageId: (await ctx.db.query("stages").first())!._id,
        value: 0,
        currency: "BRL",
        priority: "medium",
        temperature: "cold",
        tags: [],
        customFields: {},
        conversationStatus: "new",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    const receive = async (fileId: Awaited<ReturnType<typeof save>>) =>
      await t.mutation(internal.conversations.internalReceiveMessage, {
        organizationId: s.organizationId,
        leadId: lead,
        channel: "instagram",
        channelConfigId: s.instagramId,
        content: "[imagem]",
        contentType: "image",
        attachments: [fileId],
        externalId: "ig_dup_mid",
      });
    const f1 = await save(100);
    const f2 = await save(200);
    const m1 = await receive(f1);
    const m2 = await receive(f2);

    expect(m2).toBe(m1);
    expect(await messages(t)).toHaveLength(1);
    const files = await t.run(async (ctx) => await ctx.db.query("files").collect());
    expect(files.map((f) => f._id)).toEqual([f1]);
    expect(await t.run(async (ctx) => await ctx.db.system.query("_storage").collect())).toHaveLength(1);
    expect(await t.run(async (ctx) => await readStorageUsage(ctx, s.organizationId))).toEqual({ bytes: 100, count: 1 });
    await drain(t);
  });
});

describe("allowlist de mime e isSticker", () => {
  test("áudio e vídeo do Instagram passam na allowlist de mídia recebida", () => {
    for (const mime of [
      "audio/mp4",
      "audio/aac",
      "audio/x-m4a",
      "video/mp4",
      "video/quicktime",
      "video/webm",
      "audio/mp4; codecs=mp4a.40.2",
    ]) {
      expect(validateInboundMimeType(mime), mime).toBe(true);
    }
    expect(validateInboundMimeType("application/x-msdownload")).toBe(false);
  });

  test("isSticker cobre like_heart e sticker da Meta sem mudar o WhatsApp", () => {
    expect(isSticker({ metaType: "like_heart" })).toBe(true);
    expect(isSticker({ metaType: "sticker" })).toBe(true);
    expect(isSticker({ metaType: "image" })).toBe(false);
    expect(isSticker({ bridgeType: "sticker" })).toBe(true);
    expect(isSticker(undefined)).toBe(false);
  });
});
