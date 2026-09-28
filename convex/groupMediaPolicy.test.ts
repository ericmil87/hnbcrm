/// <reference types="vite/client" />
/**
 * Política de download de mídia em grupos (v0.62).
 *
 * O teste central é o de que a política decide ANTES do download: com o
 * default "mentions", a foto que um membro posta no grupo de compra e venda não
 * gera nenhuma chamada ao gateway, nenhum byte no storage e nenhuma visão —
 * só um `mediaDeferred` na mensagem e o descriptor CIFRADO numa tabela isolada.
 * O resto trava o download sob demanda (feliz, idempotente, expirado,
 * cross-org, trava de corrida), o cron de expiração, a limpeza (dryRun vs
 * real), a cascata e o histórico que a IA lê.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { historyTextOf, hasMediaAwaitingEnrichment } from "./attendant";
import { EXCLUDED_BACKUP_TABLES } from "./lib/exportSanitize";
import { BACKUP_TABLES } from "./exports";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const INSTANCE_ID = "org_media_instance";
const BRIDGE_TOKEN = "fake-instance-token";
const BRIDGE_BASE_URL = "https://wa-gw.example.test";
const GROUP_JID = "120363431849092219@g.us";
const OUR_LID = "92965187932215@lid";
const OUR_PHONE = "558192985729";
const ERIC_LID = "180002129735765@lid";
const ERIC_PHONE = "558181392929";
const MEDIA_KEY = "TUVESUFLRVktU0VDUkVUTw==";
const SMALL_B64 = btoa("0123456789abcdef"); // 16 bytes
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type TestClient =
  | TestConvex<typeof schema>
  | ReturnType<TestConvex<typeof schema>["withIdentity"]>;

async function seedOrg(t: TestConvex<typeof schema>, slug: string) {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: `Org ${slug}`,
      slug,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminUserId, adminId };
  });
  const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|session-${slug}` });
  return { ...seeded, asAdmin };
}

async function seed(t: TestConvex<typeof schema>) {
  const org = await seedOrg(t, "media-org");
  const configId = await org.asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: org.organizationId,
    channel: "whatsapp",
    provider: "bridge",
    displayName: "Bridge number",
    bridgeBaseUrl: BRIDGE_BASE_URL,
    bridgeInstanceId: INSTANCE_ID,
    bridgeToken: BRIDGE_TOKEN,
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(configId, { bridgeLid: OUR_LID, bridgePhone: OUR_PHONE });
  });
  await org.asAdmin.mutation(api.groupChats.acceptGroupsAck, { channelConfigId: configId });
  await org.asAdmin.mutation(api.groupChats.setGroupsEnabled, {
    channelConfigId: configId,
    enabled: true,
  });
  const groupChatId = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("groupChats", {
      organizationId: org.organizationId,
      channelConfigId: configId,
      jid: GROUP_JID,
      subject: "Compra e venda",
      monitored: false,
      participants: [
        { lid: OUR_LID, phone: OUR_PHONE, isAdmin: false, isSuperAdmin: false },
        { lid: ERIC_LID, phone: ERIC_PHONE, isAdmin: true, isSuperAdmin: true },
      ],
      participantsCount: 2,
      createdAt: now,
      updatedAt: now,
    });
  });
  await org.asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
  return { ...org, configId, groupChatId };
}

type MediaKind = "image" | "audio" | "video" | "document" | "sticker";

function groupMediaMessage(
  opts: {
    externalId?: string;
    kind?: MediaKind;
    fromMe?: boolean;
    content?: string;
    mentions?: string[];
    quoteParticipant?: string;
  } = {}
) {
  const kind = opts.kind ?? "image";
  const contentType =
    kind === "image" || kind === "sticker" ? "image" : kind === "audio" ? "audio" : "file";
  const defaults: Record<MediaKind, string> = {
    image: "[imagem]",
    sticker: "[figurinha]",
    audio: "[mensagem de voz]",
    video: "[vídeo]",
    document: "catalogo.pdf",
  };
  return {
    chatJid: GROUP_JID,
    externalId: opts.externalId ?? "3EB0MEDIA01",
    fromMe: opts.fromMe ?? false,
    ...(opts.fromMe ? {} : { senderLid: ERIC_LID, senderPhone: ERIC_PHONE, senderName: "Eric" }),
    timestamp: Date.now(),
    contentType: contentType as "image" | "audio" | "file",
    content: opts.content ?? defaults[kind],
    media: {
      kind,
      mimeType:
        kind === "audio" ? "audio/ogg" : kind === "document" ? "application/pdf" : kind === "video" ? "video/mp4" : "image/jpeg",
      ...(kind === "document" ? { filename: "catalogo.pdf" } : {}),
      descriptor: {
        directPath: "/v/fake",
        mediaKey: MEDIA_KEY,
        url: "https://cdn/fake",
        fileEncSha256: "ZW5jLXNoYQ==",
        fileLength: 16,
      },
    },
    ...(opts.mentions ? { mentions: opts.mentions } : {}),
    ...(opts.quoteParticipant
      ? { quote: { stanzaId: "3EB0OURS", participant: opts.quoteParticipant } }
      : {}),
    metadata: { bridgeType: kind },
  };
}

function downloadOkMock(mime = "image/jpeg") {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(
      JSON.stringify({
        code: 200,
        success: true,
        data: { Data: `data:${mime};base64,${SMALL_B64}`, Mimetype: mime },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
}

function downloadCalls(fetchMock: ReturnType<typeof downloadOkMock>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/chat/download"));
}

async function ingest(
  t: TestConvex<typeof schema>,
  configId: Id<"channelConfigs">,
  message: ReturnType<typeof groupMediaMessage>
) {
  await t.action(internal.bridge.internalIngestGroupMessage, { configId, message });
}

async function getMessage(t: TestConvex<typeof schema>, externalId = "3EB0MEDIA01") {
  return await t.run(async (ctx) => {
    const all = await ctx.db.query("messages").collect();
    return all.find((m) => m.externalId === externalId) ?? null;
  });
}

async function deferredRows(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => ctx.db.query("deferredGroupMedia").collect());
}

async function scheduledNames(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).map((j) => j.name)
  );
}

async function setNumberPolicy(
  asAdmin: TestClient,
  organizationId: Id<"organizations">,
  channelConfigId: Id<"channelConfigs">,
  mode: "all" | "mentions" | "off"
) {
  await asAdmin.mutation(api.groupChats.setGroupMediaDefaults, {
    organizationId,
    channelConfigId,
    policy: { image: mode, audio: mode, video: mode, document: mode },
  });
}

describe("decisão antes do download", () => {
  test("default mentions: foto de membro NÃO é baixada — mediaDeferred sem chave", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await ingest(t, configId, groupMediaMessage());

    expect(downloadCalls(fetchMock)).toHaveLength(0);
    const message = await getMessage(t);
    expect(message!.attachments).toBeUndefined();
    expect(message!.metadata!.mediaDeferred).toMatchObject({
      kind: "image",
      mimeType: "image/jpeg",
      fileLength: 16,
      reason: "policy",
    });
    expect(message!.metadata!.mediaDeferred.expiresAt).toBe(Date.now() + 14 * DAY);
    // Não é falha: nada de pending/skipped/error.
    expect(message!.metadata!.mediaPending).toBeUndefined();
    expect(message!.metadata!.mediaSkipped).toBeUndefined();
    expect(message!.metadata!.mediaError).toBeUndefined();
    // A chave NUNCA vai para `messages`.
    expect(JSON.stringify(message)).not.toContain(MEDIA_KEY);

    const rows = await deferredRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageId: message!._id, kind: "image", channelConfigId: configId });
    expect(rows[0].descriptorEncrypted).not.toContain(MEDIA_KEY);
    expect(rows[0].expiresAt).toBe(Date.now() + 14 * DAY);

    const files = await t.run(async (ctx) => ctx.db.query("files").collect());
    expect(files).toHaveLength(0);
    // Leitura segue o download: sem anexo, sem visão.
    expect((await scheduledNames(t)).some((n) => n.includes("autoDescribe"))).toBe(false);
  });

  test("menção ao nosso número: baixa e agenda a visão", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await ingest(t, configId, groupMediaMessage({ mentions: [OUR_LID] }));

    expect(downloadCalls(fetchMock)).toHaveLength(1);
    const message = await getMessage(t);
    expect(message!.attachments).toHaveLength(1);
    expect(message!.metadata!.mediaDeferred).toBeUndefined();
    expect(await deferredRows(t)).toHaveLength(0);
    expect((await scheduledNames(t)).some((n) => n.includes("autoDescribe"))).toBe(true);
  });

  test("resposta (quote) a uma mensagem nossa: baixa", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await ingest(
      t,
      configId,
      groupMediaMessage({ quoteParticipant: `${OUR_PHONE}@s.whatsapp.net` })
    );
    expect(downloadCalls(fetchMock)).toHaveLength(1);
  });

  test("palavra-chave da IA do grupo: baixa com a IA ligada, não com ela desligada", async () => {
    const t = convexTest(schema, modules);
    const { configId, groupChatId } = await seed(t);
    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await t.run(async (ctx) => {
      await ctx.db.patch(groupChatId, {
        ai: { mode: "off", replyMode: "inherit", keywords: ["orcamento"] },
      });
    });
    await ingest(t, configId, groupMediaMessage({ externalId: "K1", content: "Orçamento disso?" }));
    expect(downloadCalls(fetchMock)).toHaveLength(0);

    await t.run(async (ctx) => {
      await ctx.db.patch(groupChatId, {
        ai: { mode: "mention", replyMode: "inherit", keywords: ["orcamento"] },
      });
    });
    await ingest(t, configId, groupMediaMessage({ externalId: "K2", content: "Orçamento disso?" }));
    expect(downloadCalls(fetchMock)).toHaveLength(1);
  });

  test("fromMe (nosso celular) baixa em mentions, mas não em off", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await ingest(t, configId, groupMediaMessage({ externalId: "ME1", fromMe: true }));
    expect(downloadCalls(fetchMock)).toHaveLength(1);
    const mine = await getMessage(t, "ME1");
    expect(mine!.direction).toBe("outbound");
    expect(mine!.attachments).toHaveLength(1);

    await setNumberPolicy(asAdmin, organizationId, configId, "off");
    await ingest(t, configId, groupMediaMessage({ externalId: "ME2", fromMe: true }));
    expect(downloadCalls(fetchMock)).toHaveLength(1);
    expect((await getMessage(t, "ME2"))!.metadata!.mediaDeferred).toMatchObject({ kind: "image" });
  });

  test("padrão do número all: baixa tudo; override do grupo vence", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin, groupChatId } = await seed(t);
    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await setNumberPolicy(asAdmin, organizationId, configId, "all");
    await ingest(t, configId, groupMediaMessage({ externalId: "A1" }));
    expect(downloadCalls(fetchMock)).toHaveLength(1);

    await asAdmin.mutation(api.groupChats.setGroupMediaPolicy, {
      organizationId,
      groupChatId,
      policy: { image: "off", audio: "inherit", video: "inherit", document: "inherit" },
    });
    await ingest(t, configId, groupMediaMessage({ externalId: "A2", mentions: [OUR_LID] }));
    expect(downloadCalls(fetchMock)).toHaveLength(1); // imagem off no grupo
    await ingest(t, configId, groupMediaMessage({ externalId: "A3", kind: "audio" }));
    expect(downloadCalls(fetchMock)).toHaveLength(2); // áudio herda "all"

    const group = await asAdmin.query(api.groupChats.getGroup, { groupChatId });
    expect(group!.mediaPolicy).toEqual({
      image: "off",
      audio: "inherit",
      video: "inherit",
      document: "inherit",
    });
    expect(group!.effectiveMedia).toEqual({
      image: "off",
      audio: "all",
      video: "all",
      document: "all",
    });
    const list = await asAdmin.query(api.groupChats.listGroups, { organizationId });
    expect(list[0].effectiveMedia.image).toBe("off");
    const settings = await asAdmin.query(api.groupChats.listChannelGroupSettings, {
      organizationId,
    });
    expect(settings[0].groupMedia).toEqual({
      image: "all",
      audio: "all",
      video: "all",
      document: "all",
    });

    // Tudo "inherit" apaga o override.
    await asAdmin.mutation(api.groupChats.setGroupMediaPolicy, {
      organizationId,
      groupChatId,
      policy: { image: "inherit", audio: "inherit", video: "inherit", document: "inherit" },
    });
    const cleared = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(cleared!.mediaPolicy).toBeUndefined();

    const audits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).filter((a) =>
        a.description?.includes("Política de mídia")
      )
    );
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });

  test("listChannelGroupSettings devolve o default resolvido sem configuração", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, asAdmin } = await seed(t);
    const settings = await asAdmin.query(api.groupChats.listChannelGroupSettings, {
      organizationId,
    });
    expect(settings[0].groupMedia).toEqual({
      image: "mentions",
      audio: "mentions",
      video: "mentions",
      document: "mentions",
    });
  });

  test("figurinha nunca baixa automático, nem com all e menção", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);
    await setNumberPolicy(asAdmin, organizationId, configId, "all");

    await ingest(t, configId, groupMediaMessage({ kind: "sticker", mentions: [OUR_LID] }));
    expect(downloadCalls(fetchMock)).toHaveLength(0);
    expect((await getMessage(t))!.metadata!.mediaDeferred).toMatchObject({ kind: "sticker" });
  });

  test("setGroupMediaDefaults/Policy: gate settings:manage e org conferida", async () => {
    const t = convexTest(schema, modules);
    const { configId, groupChatId } = await seed(t);
    const other = await seedOrg(t, "other-org");
    await expect(
      other.asAdmin.mutation(api.groupChats.setGroupMediaDefaults, {
        organizationId: other.organizationId,
        channelConfigId: configId,
        policy: { image: "all", audio: "all", video: "all", document: "all" },
      })
    ).rejects.toThrow(/Canal não encontrado/);
    await expect(
      other.asAdmin.mutation(api.groupChats.setGroupMediaPolicy, {
        organizationId: other.organizationId,
        groupChatId,
        policy: { image: "all", audio: "all", video: "all", document: "all" },
      })
    ).rejects.toThrow(/Grupo não encontrado/);
  });
});

describe("download sob demanda", () => {
  test("feliz: anexa, tira mediaDeferred, apaga a linha e agenda a visão", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);
    await ingest(t, configId, groupMediaMessage());
    const message = await getMessage(t);

    const result = await asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(result).toEqual({ ok: true });
    expect(downloadCalls(fetchMock)).toHaveLength(1);
    // O descriptor decifrado chegou ao gateway.
    const body = JSON.parse(String(downloadCalls(fetchMock)[0][1]!.body));
    expect(body.MediaKey).toBe(MEDIA_KEY);

    const after = await getMessage(t);
    expect(after!.attachments).toHaveLength(1);
    expect(after!.metadata!.mediaDeferred).toBeUndefined();
    expect(await deferredRows(t)).toHaveLength(0);
    const file = await t.run(async (ctx) => ctx.db.get(after!.attachments![0]));
    expect(file!.messageId).toBe(after!._id);
    expect((await scheduledNames(t)).some((n) => n.includes("autoDescribe"))).toBe(true);

    // Idempotente: o segundo clique é sucesso e não baixa de novo.
    const again = await asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(again).toEqual({ ok: true });
    expect(downloadCalls(fetchMock)).toHaveLength(1);
    const files = await t.run(async (ctx) => ctx.db.query("files").collect());
    expect(files).toHaveLength(1);
  });

  test("áudio baixado sob demanda agenda a transcrição", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock("audio/ogg"));
    await ingest(t, configId, groupMediaMessage({ kind: "audio" }));
    const message = await getMessage(t);

    const result = await asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(result).toEqual({ ok: true });
    expect((await scheduledNames(t)).some((n) => n.includes("autoTranscribe"))).toBe(true);
  });

  test("dois pedidos simultâneos: a trava deixa só um baixar", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await ingest(t, configId, groupMediaMessage());
    const message = await getMessage(t);

    const first = await t.mutation(internal.groupMedia.internalClaimDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    const second = await t.mutation(internal.groupMedia.internalClaimDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(first.state).toBe("claimed");
    expect(second.state).toBe("busy");

    // Trava vencida (action morreu no meio): o próximo reassume.
    vi.setSystemTime(Date.now() + 3 * 60 * 1000);
    const third = await t.mutation(internal.groupMedia.internalClaimDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(third.state).toBe("claimed");
  });

  test("expirado: recusa com motivo e marca mediaDeferred.expired", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);
    await ingest(t, configId, groupMediaMessage());
    const message = await getMessage(t);

    vi.setSystemTime(Date.now() + 15 * DAY);
    const result = await asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/não está mais disponível/);
    expect(downloadCalls(fetchMock)).toHaveLength(0);
    expect((await getMessage(t))!.metadata!.mediaDeferred.expired).toBe(true);
    expect(await deferredRows(t)).toHaveLength(0);
  });

  test("gateway diz que o blob sumiu (404): vira expirado", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await ingest(t, configId, groupMediaMessage());
    const message = await getMessage(t);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: "download failed with status code 404" }), {
          status: 500,
        })
      )
    );
    const result = await asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(result.ok).toBe(false);
    expect((await getMessage(t))!.metadata!.mediaDeferred.expired).toBe(true);
  });

  test("falha transitória: solta a trava e deixa tentar de novo", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await ingest(t, configId, groupMediaMessage());
    const message = await getMessage(t);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const failed = await asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).toMatch(/Tente de novo/);
    const rows = await deferredRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].claimedUntil).toBeUndefined();

    vi.stubGlobal("fetch", downloadOkMock());
    const ok = await asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(ok).toEqual({ ok: true });
  });

  test("cross-org: mensagem de outra org não é baixada nem confirmada", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId } = await seed(t);
    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);
    await ingest(t, configId, groupMediaMessage());
    const message = await getMessage(t);
    const other = await seedOrg(t, "intruder-org");

    const result = await other.asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId: other.organizationId,
      messageId: message!._id,
    });
    expect(result).toEqual({ ok: false, reason: "Mensagem não encontrada" });
    // Nem passando o id da org alheia: não é membro dela.
    await expect(
      other.asAdmin.action(api.groupChats.downloadDeferredMedia, {
        organizationId,
        messageId: message!._id,
      })
    ).rejects.toThrow();
    expect(downloadCalls(fetchMock)).toHaveLength(0);
    expect(await deferredRows(t)).toHaveLength(1);
  });

  test("sem sessão: recusa", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await ingest(t, configId, groupMediaMessage());
    const message = await getMessage(t);
    await expect(
      t.action(api.groupChats.downloadDeferredMedia, { organizationId, messageId: message!._id })
    ).rejects.toThrow();
  });
});

describe("expiração e limpeza", () => {
  test("cron: apaga a linha vencida e marca expired; a que não venceu fica", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await ingest(t, configId, groupMediaMessage({ externalId: "OLD" }));
    vi.setSystemTime(Date.now() + 10 * DAY);
    await ingest(t, configId, groupMediaMessage({ externalId: "NEW" }));
    vi.setSystemTime(Date.now() + 5 * DAY);

    const expired = await t.mutation(internal.groupMedia.internalExpireDeferredMedia, {});
    expect(expired).toBe(1);
    expect((await getMessage(t, "OLD"))!.metadata!.mediaDeferred.expired).toBe(true);
    expect((await getMessage(t, "NEW"))!.metadata!.mediaDeferred.expired).toBeUndefined();
    expect(await deferredRows(t)).toHaveLength(1);
  });

  test("purge: dryRun só conta; real apaga blob/arquivo e marca mediaPurged; direcionada fica", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await setNumberPolicy(asAdmin, organizationId, configId, "all");
    await ingest(t, configId, groupMediaMessage({ externalId: "P1" }));
    await ingest(t, configId, groupMediaMessage({ externalId: "P2", mentions: [OUR_LID] }));
    vi.setSystemTime(Date.now() + 8 * DAY);

    const dry = await t.mutation(internal.groupMediaCleanup.internalPurgeGroupMedia, {
      organizationId,
    });
    expect(dry).toMatchObject({ scanned: 2, matched: 1, bytes: 16, deleted: 0, nextCursor: null });
    expect(await t.run(async (ctx) => ctx.db.query("files").collect())).toHaveLength(2);

    const real = await t.mutation(internal.groupMediaCleanup.internalPurgeGroupMedia, {
      organizationId,
      dryRun: false,
    });
    expect(real).toMatchObject({ matched: 1, deleted: 1 });
    const p1 = await getMessage(t, "P1");
    expect(p1!.attachments).toEqual([]);
    expect(p1!.metadata!.mediaPurged).toMatchObject({ kind: "image" });
    const p2 = await getMessage(t, "P2");
    expect(p2!.attachments).toHaveLength(1);
    expect(await t.run(async (ctx) => ctx.db.query("files").collect())).toHaveLength(1);

    // keepDirected:false leva a direcionada também; filtro de tipo respeitado.
    const audioOnly = await t.mutation(internal.groupMediaCleanup.internalPurgeGroupMedia, {
      organizationId,
      keepDirected: false,
      kinds: ["audio"],
    });
    expect(audioOnly.matched).toBe(0);
    const all = await t.mutation(internal.groupMediaCleanup.internalPurgeGroupMedia, {
      organizationId,
      keepDirected: false,
    });
    expect(all.matched).toBe(1);
  });

  test("purge respeita a idade mínima", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await setNumberPolicy(asAdmin, organizationId, configId, "all");
    await ingest(t, configId, groupMediaMessage());
    const dry = await t.mutation(internal.groupMediaCleanup.internalPurgeGroupMedia, {
      organizationId,
    });
    expect(dry.matched).toBe(0);
  });

  test("cascata do canal apaga o descriptor cifrado junto com a mensagem", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await ingest(t, configId, groupMediaMessage());
    expect(await deferredRows(t)).toHaveLength(1);

    await t.mutation(internal.groupChats.internalCascadeDeleteChannelGroups, {
      channelConfigId: configId,
    });
    expect(await deferredRows(t)).toHaveLength(0);
    expect(await getMessage(t)).toBeNull();
  });
});

describe("IA e backup", () => {
  test("histórico diz 'não baixada', nunca o placeholder", () => {
    const deferred = (kind: string, extra: Record<string, unknown> = {}) => ({
      mediaDeferred: { kind, expiresAt: 0, reason: "policy", ...extra },
    });
    const inbound = { direction: "inbound" as const };
    expect(
      historyTextOf({ ...inbound, contentType: "image", content: "[imagem]", metadata: deferred("image") }, { visionEnabled: true })
    ).toBe("[imagem não baixada]");
    expect(
      historyTextOf({ ...inbound, contentType: "image", content: "Vendo bike", metadata: deferred("image") })
    ).toBe('[imagem não baixada] — legenda: "Vendo bike"');
    expect(
      historyTextOf({ ...inbound, contentType: "audio", content: "[mensagem de voz]", metadata: deferred("audio") })
    ).toBe("[áudio não baixado]");
    expect(
      historyTextOf({ ...inbound, contentType: "file", content: "[vídeo]", metadata: deferred("video") })
    ).toBe("[vídeo não baixado]");
    expect(
      historyTextOf({
        ...inbound,
        contentType: "file",
        content: "catalogo.pdf",
        metadata: deferred("document", { filename: "catalogo.pdf" }),
      })
    ).toBe("[arquivo não baixado: catalogo.pdf]");
  });

  test("mídia deferida não faz o agente esperar enriquecimento", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await ingest(t, configId, groupMediaMessage({ kind: "audio" }));
    const message = await getMessage(t);
    const waiting = await t.run(async (ctx) =>
      hasMediaAwaitingEnrichment(ctx as never, message!.conversationId, 0, { visionEnabled: true })
    );
    expect(waiting).toBe(false);
  });

  test("deferredGroupMedia nunca entra no backup", () => {
    expect(EXCLUDED_BACKUP_TABLES).toContain("deferredGroupMedia");
    expect(BACKUP_TABLES).not.toContain("deferredGroupMedia");
  });
});

// ─── Achados da revisão independente ────────────────────────────────────────

async function storeLooseFile(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["0123456789abcdef"], { type: "image/jpeg" }));
    return await ctx.db.insert("files", {
      organizationId,
      storageId,
      name: "x.jpg",
      mimeType: "image/jpeg",
      size: 16,
      fileType: "message_attachment",
      createdAt: Date.now(),
    });
  });
}

describe("revisão: trava por token (M1)", () => {
  test("clique cuja trava venceu não solta a do outro nem anexa segundo arquivo", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await ingest(t, configId, groupMediaMessage());
    const message = await getMessage(t);

    const a = await t.mutation(internal.groupMedia.internalClaimDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    vi.setSystemTime(Date.now() + 3 * 60 * 1000); // trava de A venceu
    const b = await t.mutation(internal.groupMedia.internalClaimDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    if (a.state !== "claimed" || b.state !== "claimed") throw new Error("claim esperado");
    expect(a.claimToken).not.toBe(b.claimToken);

    // A falha depois de B pegar a trava: o release de A não mexe na de B.
    await t.mutation(internal.groupMedia.internalReleaseDeferredClaim, {
      rowId: a.rowId,
      claimToken: a.claimToken,
    });
    expect((await deferredRows(t))[0].claimedUntil).toBe(b.claimToken);

    // A conclui (atrasado): arquivo descartado, nada anexado.
    const fileA = await storeLooseFile(t, organizationId);
    const outA = await t.mutation(internal.groupMedia.internalCompleteDeferredMedia, {
      rowId: a.rowId,
      claimToken: a.claimToken,
      messageId: message!._id,
      fileId: fileA,
    });
    expect(outA).toBe("stale");
    expect(await t.run(async (ctx) => ctx.db.get(fileA))).toBeNull();

    // B conclui: anexa.
    const fileB = await storeLooseFile(t, organizationId);
    const outB = await t.mutation(internal.groupMedia.internalCompleteDeferredMedia, {
      rowId: b.rowId,
      claimToken: b.claimToken,
      messageId: message!._id,
      fileId: fileB,
    });
    expect(outB).toBe("attached");

    // Um terceiro atrasado depois do anexo: duplicado, descartado.
    const fileC = await storeLooseFile(t, organizationId);
    const outC = await t.mutation(internal.groupMedia.internalCompleteDeferredMedia, {
      rowId: b.rowId,
      claimToken: b.claimToken,
      messageId: message!._id,
      fileId: fileC,
    });
    expect(outC).toBe("duplicate");
    expect(await t.run(async (ctx) => ctx.db.get(fileC))).toBeNull();

    const after = await getMessage(t);
    expect(after!.attachments).toEqual([fileB]);
    const visionJobs = (await scheduledNames(t)).filter((n) => n.includes("autoDescribe"));
    expect(visionJobs).toHaveLength(1);
  });

  test("fetch do sob demanda tem timeout menor que a trava", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await ingest(t, configId, groupMediaMessage());
    const message = await getMessage(t);

    const { DEFERRED_CLAIM_MS, DEFERRED_FETCH_TIMEOUT_MS } = await import("./groupMedia");
    expect(DEFERRED_FETCH_TIMEOUT_MS).toBeLessThan(DEFERRED_CLAIM_MS);

    // Avançar o relógio dispararia o agendado do seed (refresh do grupo) fora
    // de transação no convex-test — cancela antes.
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    // Gateway pendurado: só termina quando o sinal aborta.
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    vi.stubGlobal("fetch", hanging);
    const pending = asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    await vi.advanceTimersByTimeAsync(DEFERRED_FETCH_TIMEOUT_MS + 1000);
    const result = await pending;
    const download = hanging.mock.calls.find(([url]) => String(url).includes("/chat/download"));
    expect(download?.[1]?.signal).toBeDefined();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/não respondeu/);
    const rows = await deferredRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].claimedUntil).toBeUndefined();
  });
});

describe("revisão: 404 do gateway não é mídia expirada (M2)", () => {
  test.each([
    ["HTTP 404 cru", new Response("", { status: 404 })],
    ["corpo de proxy", new Response(JSON.stringify({ error: "404 page not found" }), { status: 404 })],
    ["410 do gateway", new Response("", { status: 410 })],
  ])("%s: falha transitória, descriptor preservado", async (_label, response) => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await ingest(t, configId, groupMediaMessage());
    const message = await getMessage(t);

    vi.stubGlobal("fetch", vi.fn(async () => response));
    const result = await asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Tente de novo/);
    expect((await getMessage(t))!.metadata!.mediaDeferred.expired).toBeUndefined();
    expect(await deferredRows(t)).toHaveLength(1);
  });

  test("regex só casa o erro do whatsmeow", async () => {
    const { looksLikeGoneFromCdn } = await import("./groupChats");
    expect(looksLikeGoneFromCdn("download failed with status code 404")).toBe(true);
    expect(looksLikeGoneFromCdn("failed to download: download failed with status code 410")).toBe(true);
    expect(looksLikeGoneFromCdn("Falha ao baixar mídia (HTTP 404)")).toBe(false);
    expect(looksLikeGoneFromCdn("404 page not found")).toBe(false);
  });
});

describe("revisão: estados finais sem botão (L1)", () => {
  test("mídia > 25 MB nasce tooBig, sem descriptor guardado", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);
    const msg = groupMediaMessage({ kind: "video" });
    msg.media.descriptor.fileLength = 40 * 1024 * 1024;
    await ingest(t, configId, msg);

    const message = await getMessage(t);
    expect(message!.metadata!.mediaDeferred).toMatchObject({
      kind: "video",
      tooBig: true,
      fileLength: 40 * 1024 * 1024,
    });
    expect(await deferredRows(t)).toHaveLength(0);
    const result = await asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/grande demais/);
    expect(downloadCalls(fetchMock)).toHaveLength(0);
  });

  test("tipo recusado pela allowlist no sob demanda vira final (rejected)", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    const fetchMock = downloadOkMock("application/x-msdownload");
    vi.stubGlobal("fetch", fetchMock);
    const msg = groupMediaMessage({ kind: "document" });
    msg.media.mimeType = "application/x-msdownload";
    await ingest(t, configId, msg);
    const message = await getMessage(t);

    const first = await asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(first.ok).toBe(false);
    const after = await getMessage(t);
    expect(typeof after!.metadata!.mediaDeferred.rejected).toBe("string");
    expect(await deferredRows(t)).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("files").collect())).toHaveLength(0);

    const second = await asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId,
      messageId: message!._id,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/Tipo de arquivo não aceito/);
    expect(downloadCalls(fetchMock)).toHaveLength(1);
  });
});

describe("revisão: bytes do purge só do blob que sai (L2)", () => {
  test("blob com cópia encaminhada fica e conta em sharedKept", async () => {
    const t = convexTest(schema, modules);
    const { configId, organizationId, asAdmin } = await seed(t);
    vi.stubGlobal("fetch", downloadOkMock());
    await setNumberPolicy(asAdmin, organizationId, configId, "all");
    await ingest(t, configId, groupMediaMessage());
    const message = await getMessage(t);
    const original = await t.run(async (ctx) => ctx.db.get(message!.attachments![0]));
    // Cópia (como o encaminhamento faz), fora do escopo do purge.
    await t.run(async (ctx) => {
      await ctx.db.insert("files", {
        organizationId,
        storageId: original!.storageId,
        name: "encaminhada.jpg",
        mimeType: "image/jpeg",
        size: 16,
        fileType: "other",
        createdAt: Date.now(),
      });
    });
    vi.setSystemTime(Date.now() + 8 * DAY);

    const dry = await t.mutation(internal.groupMediaCleanup.internalPurgeGroupMedia, {
      organizationId,
    });
    expect(dry).toMatchObject({ matched: 1, bytes: 0, sharedKept: 1, deleted: 0 });

    const real = await t.mutation(internal.groupMediaCleanup.internalPurgeGroupMedia, {
      organizationId,
      dryRun: false,
    });
    expect(real).toMatchObject({ matched: 1, bytes: 0, sharedKept: 1, deleted: 1 });
    const blobKept = await t.run(
      async (ctx) => (await ctx.storage.get(original!.storageId as never)) !== null
    );
    expect(blobKept).toBe(true);
  });
});
