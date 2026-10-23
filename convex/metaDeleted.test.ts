/// <reference types="vite/client" />
/**
 * Meta Messaging F2: mensagem apagada e editada pelo cliente (conteúdo, descrição,
 * transcrição e blob somem; audit high sem texto; histórico de edição).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";
import { parseMetaMessagingWebhook } from "./lib/metaMessagingParse";
import igText from "./__fixtures__/meta/instagram-message-text.json";
import igImage from "./__fixtures__/meta/instagram-message-image.json";
import igLike from "./__fixtures__/meta/instagram-like-heart.json";
import igDeleted from "./__fixtures__/meta/instagram-deleted.json";
import igEdit from "./__fixtures__/meta/instagram-message-edit.json";

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
    return { organizationId, userId, memberId, connectionId, instagramId, messengerId };
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


async function messages(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => await ctx.db.query("messages").collect());
}

async function messageAudits(t: TestConvex<typeof schema>) {
  const all = await t.run(async (ctx) => await ctx.db.query("auditLogs").collect());
  return all.filter((a) => a.entityType === "message");
}

async function drain(t: TestConvex<typeof schema>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

function deletedPayload(mid: string) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        messaging: [
          {
            sender: { id: "1000000000000004" },
            recipient: { id: IG_ID },
            timestamp: 20,
            message: { mid, is_deleted: true },
          },
        ],
      },
    ],
  };
}

function editPayload(mid: string, text: string) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        messaging: [
          {
            sender: { id: "1000000000000004" },
            recipient: { id: IG_ID },
            timestamp: 30,
            message_edit: { mid, text, num_edit: 1 },
          },
        ],
      },
    ],
  };
}

const IMAGE_MID = "ig_fake_mid_000010";

describe("mensagem apagada pelo cliente", () => {
  test("texto: some o conteúdo, marca deletedByCustomer e a prévia da conversa muda", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({});
    await ingest(t, s, igText, "instagram");
    const before = await t.run(async (ctx) => (await ctx.db.query("conversations").first())!);
    expect(before.lastMessagePreview).toBe("Oi, vocês atendem aos sábados?");

    await ingest(t, s, igDeleted, "instagram");
    const [m] = await messages(t);
    expect(m.content).toBe("Mensagem apagada pelo cliente");
    expect(m.metadata?.deletedByCustomer).toBe(true);
    expect(typeof m.metadata?.deletedAt).toBe("number");
    expect(m.metadata?.revoked).toBeUndefined();
    const conv = await t.run(async (ctx) => (await ctx.db.get(m.conversationId))!);
    expect(conv.lastMessagePreview).toBe("Mensagem apagada pelo cliente");
    await drain(t);
  });

  test("mídia: conteúdo, descrição, transcrição, arquivos e blob saem; audit high sem texto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({ "https://cdn.example.test/": reply("image/jpeg", bytes(200)) });
    await ingest(t, s, igImage, "instagram");
    await t.run(async (ctx) => {
      const m = (await ctx.db.query("messages").first())!;
      await ctx.db.patch(m._id, {
        imageDescription: "RG de Fulano 123.456.789-00",
        transcriptText: "meu cpf é 123",
        metadata: {
          ...m.metadata,
          vision: { text: "RG de Fulano 123.456.789-00" },
          transcription: { text: "meu cpf é 123" },
          reactions: [{ emoji: "❤️", sender: "contact", at: 1 }],
        },
      });
    });
    expect(await t.run(async (ctx) => await ctx.db.system.query("_storage").collect())).toHaveLength(1);

    await ingest(t, s, deletedPayload(IMAGE_MID), "instagram");

    const [m] = await messages(t);
    expect(m).toMatchObject({ content: "Mensagem apagada pelo cliente", contentType: "text" });
    expect(m.attachments).toBeUndefined();
    expect(m.imageDescription).toBeUndefined();
    expect(m.transcriptText).toBeUndefined();
    expect(m.metadata?.vision).toBeUndefined();
    expect(m.metadata?.transcription).toBeUndefined();
    expect(m.metadata?.metaType).toBeUndefined();
    expect(m.metadata?.reactions).toHaveLength(1); // a reação não guarda o texto
    expect(await t.run(async (ctx) => await ctx.db.query("files").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => await ctx.db.system.query("_storage").collect())).toHaveLength(0);

    const audits = await messageAudits(t);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ severity: "high", entityType: "message", action: "delete", actorType: "system" });
    const dump = JSON.stringify(audits[0]);
    expect(dump).not.toContain("RG de Fulano");
    expect(dump).not.toContain("meu cpf");
    expect(dump).not.toContain(IMAGE_MID);
    expect(audits[0].metadata).toMatchObject({ midLast4: "0010", filesRemoved: 1, blobsRemoved: 1 });
    await drain(t);
  });

  test("resultado tardio de visão/transcrição não ressuscita o conteúdo apagado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({ "https://cdn.example.test/": reply("image/jpeg", bytes(50)) });
    await ingest(t, s, igImage, "instagram");
    await ingest(t, s, deletedPayload(IMAGE_MID), "instagram");
    const id = (await messages(t))[0]._id;

    await t.mutation(internal.vision.internalSetVisionResult, { messageId: id, status: "done", text: "RG de Fulano" });
    await t.mutation(internal.transcription.internalSetTranscriptionResult, {
      messageId: id,
      status: "done",
      text: "meu cpf é 123",
    });
    await t.mutation(internal.transcription.internalSetTranscriptionPending, { messageId: id });
    const claim = await t.mutation(internal.vision.internalClaimVisionPending, { messageId: id });

    expect(claim.claimed).toBe(false);
    const m = (await messages(t))[0];
    expect(m.imageDescription).toBeUndefined();
    expect(m.transcriptText).toBeUndefined();
    expect(m.metadata?.vision).toBeUndefined();
    expect(m.metadata?.transcription).toBeUndefined();
    expect(m.metadata?.deletedByCustomer).toBe(true);
    await drain(t);
  });

  test("blob compartilhado por encaminhamento NÃO é apagado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({ "https://cdn.example.test/": reply("image/jpeg", bytes(200)) });
    await ingest(t, s, igImage, "instagram");
    const forwardedFileId = await t.run(async (ctx) => {
      const original = (await ctx.db.query("files").first())!;
      return await ctx.db.insert("files", {
        organizationId: original.organizationId,
        storageId: original.storageId,
        name: "encaminhado.jpg",
        mimeType: original.mimeType,
        size: original.size,
        fileType: "message_attachment",
        createdAt: Date.now(),
      });
    });

    await ingest(t, s, deletedPayload(IMAGE_MID), "instagram");

    expect(await t.run(async (ctx) => await ctx.db.system.query("_storage").collect())).toHaveLength(1);
    const files = await t.run(async (ctx) => await ctx.db.query("files").collect());
    expect(files.map((f) => f._id)).toEqual([forwardedFileId]);
    const audit = (await messageAudits(t))[0];
    expect(audit.metadata).toMatchObject({ filesRemoved: 1, blobsRemoved: 0 });
    await drain(t);
  });

  test("não era a última mensagem: a prévia da conversa não muda", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({});
    await ingest(t, s, igText, "instagram");
    vi.advanceTimersByTime(1000);
    await ingest(t, s, igLike, "instagram");
    await ingest(t, s, igDeleted, "instagram"); // apaga a primeira (ig_fake_mid_000001)
    const conv = await t.run(async (ctx) => (await ctx.db.query("conversations").first())!);
    expect(conv.lastMessagePreview).toBe("[curtiu]");
    await drain(t);
  });

  test("mensagem NOSSA (outbound) não é apagada; config de outro canal também não", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({});
    await ingest(t, s, igText, "instagram");
    const outId = await t.run(async (ctx) => {
      const inbound = (await ctx.db.query("messages").first())!;
      return await ctx.db.insert("messages", {
        organizationId: inbound.organizationId,
        conversationId: inbound.conversationId,
        leadId: inbound.leadId,
        direction: "outbound",
        senderType: "human",
        content: "Atendemos sim!",
        contentType: "text",
        externalId: "ig_out_mid_1",
        isInternal: false,
        createdAt: Date.now(),
      });
    });
    expect(
      await t.mutation(internal.metaMessaging.internalApplyMetaDeleted, { configId: s.instagramId, mid: "ig_out_mid_1" })
    ).toBeNull();
    expect((await t.run(async (ctx) => (await ctx.db.get(outId))!)).content).toBe("Atendemos sim!");

    // O mid é do Instagram: o config do Messenger da mesma org não alcança.
    expect(
      await t.mutation(internal.metaMessaging.internalApplyMetaDeleted, {
        configId: s.messengerId,
        mid: "ig_fake_mid_000001",
      })
    ).toBeNull();
    const inbound = (await messages(t)).find((m) => m.externalId === "ig_fake_mid_000001")!;
    expect(inbound.content).toBe("Oi, vocês atendem aos sábados?");
    expect(await messageAudits(t)).toHaveLength(0);
    await drain(t);
  });

  test("evento repetido é idempotente (um audit só)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({});
    await ingest(t, s, igText, "instagram");
    await ingest(t, s, igDeleted, "instagram");
    await ingest(t, s, igDeleted, "instagram");
    expect(await messageAudits(t)).toHaveLength(1);
    await drain(t);
  });

  test("mid desconhecido: nada acontece", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({});
    await ingest(t, s, igDeleted, "instagram");
    expect(await messageAudits(t)).toHaveLength(0);
  });
});

describe("mensagem editada pelo cliente", () => {
  test("troca o texto, marca edited e guarda a versão anterior; a prévia acompanha", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({});
    await ingest(t, s, igText, "instagram");
    await ingest(t, s, igEdit, "instagram");
    const [m] = await messages(t);
    expect(m.content).toBe("Texto editado");
    expect(m.metadata).toMatchObject({ edited: true });
    expect(typeof m.metadata?.editedAt).toBe("number");
    expect(m.metadata?.editHistory).toEqual([
      { content: "Oi, vocês atendem aos sábados?", at: m.metadata?.editedAt },
    ]);
    const conv = await t.run(async (ctx) => (await ctx.db.get(m.conversationId))!);
    expect(conv.lastMessagePreview).toBe("Texto editado");
    await drain(t);
  });

  test("o histórico guarda só as 5 versões mais recentes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({});
    await ingest(t, s, igText, "instagram");
    for (let i = 1; i <= 7; i++) {
      await ingest(t, s, editPayload("ig_fake_mid_000001", `versão ${i}`), "instagram");
    }
    const [m] = await messages(t);
    expect(m.content).toBe("versão 7");
    const history = m.metadata?.editHistory as Array<{ content: string }>;
    expect(history.map((h) => h.content)).toEqual(["versão 2", "versão 3", "versão 4", "versão 5", "versão 6"]);
    await drain(t);
  });

  test("texto igual não grava; edição de mensagem apagada é ignorada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubFetch({});
    await ingest(t, s, igText, "instagram");
    await ingest(t, s, editPayload("ig_fake_mid_000001", "Oi, vocês atendem aos sábados?"), "instagram");
    expect((await messages(t))[0].metadata?.edited).toBeUndefined();
    await ingest(t, s, igDeleted, "instagram");
    await ingest(t, s, igEdit, "instagram");
    expect((await messages(t))[0].content).toBe("Mensagem apagada pelo cliente");
    await drain(t);
  });
});
