/// <reference types="vite/client" />
/**
 * Nota de voz do TIME também é transcrita (mesmo toggle do áudio do cliente):
 * inbox (`sendMessage`), REST/MCP (`internalSendMessage`), encaminhar, e o
 * celular pareado ao bridge (`internalReceiveDeviceMessage` e a variante de
 * grupo). Sem isso o atendente IA e os colegas só viam "[áudio enviado]".
 *
 * Fora da regra, de propósito: nota interna (não vai ao Whisper) e áudio que
 * veio da importação de histórico do aparelho (`metadata.importedFromHistory`).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { shouldScheduleAudioTranscription } from "./lib/mediaEnrichment";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Seed = Awaited<ReturnType<typeof seed>>;

async function seed(t: TestConvex<typeof schema>, opts?: { autoTranscribeAudio?: boolean }) {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Áudio Time",
      slug: "org-audio-time",
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
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Número principal",
      phoneNumberId: "555000333",
      status: "active",
      autoTranscribeAudio: opts?.autoTranscribeAudio ?? true,
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Vendas",
      color: "#6366f1",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "Novo",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "Cliente",
      phone: "5511977770000",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId,
      title: "Cliente WhatsApp",
      contactId,
      boardId,
      stageId,
      value: 0,
      currency: "BRL",
      priority: "medium",
      temperature: "warm",
      tags: [],
      customFields: {},
      conversationStatus: "active",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      leadId,
      channel: "whatsapp",
      channelConfigId: configId,
      status: "active",
      lastInboundAt: now,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminUserId, adminId, configId, leadId, conversationId };
  });
  const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|s1` });
  return { ...seeded, asAdmin };
}

async function storeAudio(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob(["fake-opus-bytes"], { type: "audio/webm;codecs=opus" })
    );
    return await ctx.db.insert("files", {
      organizationId,
      storageId,
      name: "voz.webm",
      mimeType: "audio/webm;codecs=opus",
      size: 15,
      fileType: "message_attachment",
      createdAt: Date.now(),
    });
  });
}

/** Jobs de transcrição agendados, pelo messageId. */
async function transcribeJobs(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((j) => j.name.includes("transcription") && j.name.includes("autoTranscribe"))
      .map((j) => (j.args[0] as { messageId: Id<"messages"> }).messageId)
  );
}

describe("gate puro shouldScheduleAudioTranscription", () => {
  test("só áudio com anexo, fora de nota interna e de histórico importado", () => {
    expect(shouldScheduleAudioTranscription({ contentType: "audio", attachments: ["f"] })).toBe(true);
    expect(shouldScheduleAudioTranscription({ contentType: "text", attachments: ["f"] })).toBe(false);
    expect(shouldScheduleAudioTranscription({ contentType: "audio", attachments: [] })).toBe(false);
    expect(shouldScheduleAudioTranscription({ contentType: "audio", attachments: undefined })).toBe(false);
    expect(
      shouldScheduleAudioTranscription({ contentType: "audio", attachments: ["f"], isInternal: true })
    ).toBe(false);
    expect(
      shouldScheduleAudioTranscription({
        contentType: "audio",
        attachments: ["f"],
        metadata: { importedFromHistory: true },
      })
    ).toBe(false);
  });
});

describe("áudio enviado pelo time no inbox", () => {
  test("sendMessage com áudio agenda a transcrição; texto não agenda nada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const fileId = await storeAudio(t, s.organizationId);

    const audioId = await s.asAdmin.mutation(api.conversations.sendMessage, {
      conversationId: s.conversationId,
      content: "[áudio]",
      contentType: "audio",
      attachments: [fileId],
    });
    await s.asAdmin.mutation(api.conversations.sendMessage, {
      conversationId: s.conversationId,
      content: "oi",
    });

    expect(await transcribeJobs(t)).toEqual([audioId]);
  });

  test("nota interna com áudio não agenda", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const fileId = await storeAudio(t, s.organizationId);

    await s.asAdmin.mutation(api.conversations.sendMessage, {
      conversationId: s.conversationId,
      content: "[áudio]",
      contentType: "audio",
      attachments: [fileId],
      isInternal: true,
    });
    expect(await transcribeJobs(t)).toEqual([]);
  });

  test("internalSendMessage (REST/MCP) com áudio agenda", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const fileId = await storeAudio(t, s.organizationId);

    const id = await t.mutation(internal.conversations.internalSendMessage, {
      conversationId: s.conversationId,
      content: "[áudio]",
      contentType: "audio",
      attachments: [fileId],
      teamMemberId: s.adminId,
    });
    expect(await transcribeJobs(t)).toEqual([id]);
  });
});

describe("áudio gravado no celular pareado (device)", () => {
  async function deviceAudio(
    t: TestConvex<typeof schema>,
    s: Seed,
    externalId: string,
    metadata?: Record<string, unknown>
  ) {
    const fileId = await storeAudio(t, s.organizationId);
    return await t.mutation(internal.conversations.internalReceiveDeviceMessage, {
      organizationId: s.organizationId,
      leadId: s.leadId,
      channelConfigId: s.configId,
      content: "[áudio]",
      contentType: "audio",
      attachments: [fileId],
      externalId,
      ...(metadata ? { metadata } : {}),
    });
  }

  test("agenda a transcrição e continua SEM enfileirar o atendente", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const id = await deviceAudio(t, s, "3EB0DEVAUDIO1");

    expect(await transcribeJobs(t)).toEqual([id]);
    const queued = await t.run(async (ctx) => ctx.db.query("aiReplyQueue").collect());
    expect(queued).toHaveLength(0);
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map((j) => j.name)
    );
    expect(scheduled.some((n) => n.includes("internalEnqueueFromInbound"))).toBe(false);
  });

  test("a mesma mensagem marcada importedFromHistory não agenda nada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const id = await deviceAudio(t, s, "3EB0DEVAUDIO2", { importedFromHistory: true });

    expect(await transcribeJobs(t)).toEqual([]);
    const message = await t.run(async (ctx) => ctx.db.get(id!));
    expect(message?.metadata?.importedFromHistory).toBe(true);
    expect(message?.metadata?.via).toBe("device");
  });

  test("áudio no GRUPO pelo celular também agenda", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const groupChatId = await t.run(async (ctx) => {
      const now = Date.now();
      const groupChatId = await ctx.db.insert("groupChats", {
        organizationId: s.organizationId,
        channelConfigId: s.configId,
        jid: "120363000000000001@g.us",
        subject: "Equipe",
        monitored: true,
        createdAt: now,
        updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: s.organizationId,
        kind: "group",
        externalChatId: "120363000000000001@g.us",
        groupChatId,
        channel: "whatsapp",
        channelConfigId: s.configId,
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(groupChatId, { conversationId });
      return groupChatId;
    });
    const fileId = await storeAudio(t, s.organizationId);

    const id = await t.mutation(internal.conversations.internalReceiveGroupDeviceMessage, {
      organizationId: s.organizationId,
      groupChatId,
      channelConfigId: s.configId,
      externalId: "3EB0GROUPAUDIO1",
      content: "[áudio]",
      contentType: "audio",
      attachments: [fileId],
    });
    expect(id).not.toBeNull();
    expect(await transcribeJobs(t)).toEqual([id]);
  });
});

describe("elegibilidade (internalGetAudioMessageIfEligible)", () => {
  async function insertAudio(
    t: TestConvex<typeof schema>,
    s: Seed,
    fields: { direction: "outbound" | "internal"; isInternal: boolean; metadata?: Record<string, unknown> }
  ) {
    const fileId = await storeAudio(t, s.organizationId);
    return await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId,
        conversationId: s.conversationId,
        leadId: s.leadId,
        direction: fields.direction,
        senderId: s.adminId,
        senderType: "human",
        content: "[áudio]",
        contentType: "audio",
        attachments: [fileId],
        isInternal: fields.isInternal,
        ...(fields.metadata ? { metadata: fields.metadata } : {}),
        createdAt: Date.now(),
      })
    );
  }

  test("áudio outbound com o toggle ligado devolve o arquivo (webm aceito)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const messageId = await insertAudio(t, s, { direction: "outbound", isInternal: false });
    const eligible = await t.query(internal.transcription.internalGetAudioMessageIfEligible, {
      messageId,
    });
    expect(eligible?.messageId).toBe(messageId);
    expect(eligible?.mimeType).toBe("audio/webm;codecs=opus");
  });

  test("toggle desligado e atendente inativo: null (gate único, sem mudança)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { autoTranscribeAudio: false });
    const messageId = await insertAudio(t, s, { direction: "outbound", isInternal: false });
    expect(
      await t.query(internal.transcription.internalGetAudioMessageIfEligible, { messageId })
    ).toBeNull();
  });

  test("nota interna, apagada pelo cliente e histórico importado: null", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const internalNote = await insertAudio(t, s, { direction: "internal", isInternal: true });
    const deleted = await insertAudio(t, s, {
      direction: "outbound",
      isInternal: false,
      metadata: { deletedByCustomer: true },
    });
    const imported = await insertAudio(t, s, {
      direction: "outbound",
      isInternal: false,
      metadata: { importedFromHistory: true, via: "device" },
    });
    for (const messageId of [internalNote, deleted, imported]) {
      expect(
        await t.query(internal.transcription.internalGetAudioMessageIfEligible, { messageId })
      ).toBeNull();
    }
  });
});

describe("importação de histórico do bridge", () => {
  test("ingest com fromHistory carimba metadata.importedFromHistory", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const bridgeConfigId = await s.asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId: s.organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "Bridge",
      bridgeBaseUrl: "https://wa-gw.example.test",
      bridgeInstanceId: "org_team_audio_instance",
      bridgeToken: "fake-instance-token",
    });

    await t.action(internal.bridge.internalIngestBridgeMessage, {
      configId: bridgeConfigId,
      fromHistory: true,
      message: {
        externalId: "3EB0HISTORY01",
        from: "15550000077",
        fromMe: true,
        timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000,
        contentType: "text",
        content: "mensagem antiga do celular",
      } as any,
    });

    const message = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find((m) => m.externalId === "3EB0HISTORY01")
    );
    expect(message?.metadata?.via).toBe("device");
    expect(message?.metadata?.importedFromHistory).toBe(true);
  });
});

describe("encaminhar áudio", () => {
  async function seedTarget(t: TestConvex<typeof schema>, s: Seed) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const lead = (await ctx.db.get(s.leadId))!;
      const contactId = await ctx.db.insert("contacts", {
        organizationId: s.organizationId,
        firstName: "Outro",
        phone: "5511977771111",
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
      const leadId = await ctx.db.insert("leads", {
        organizationId: s.organizationId,
        title: "Outro lead",
        contactId,
        boardId: lead.boardId,
        stageId: lead.stageId,
        value: 0,
        currency: "BRL",
        priority: "medium",
        temperature: "warm",
        tags: [],
        customFields: {},
        conversationStatus: "active",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.insert("conversations", {
        organizationId: s.organizationId,
        leadId,
        channel: "whatsapp",
        channelConfigId: s.configId,
        status: "active",
        lastInboundAt: now,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  async function insertInboundAudio(t: TestConvex<typeof schema>, s: Seed, transcribed: boolean) {
    const fileId = await storeAudio(t, s.organizationId);
    return await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId,
        conversationId: s.conversationId,
        leadId: s.leadId,
        direction: "inbound",
        senderType: "contact",
        content: "[áudio]",
        contentType: "audio",
        attachments: [fileId],
        isInternal: false,
        ...(transcribed
          ? {
              metadata: {
                transcription: {
                  status: "done",
                  text: "quero o plano anual",
                  engine: "faster-whisper",
                  at: Date.now(),
                },
              },
              transcriptText: "quero o plano anual",
            }
          : {}),
        createdAt: Date.now(),
      })
    );
  }

  async function forwarded(t: TestConvex<typeof schema>, sourceId: Id<"messages">) {
    return await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find(
        (m) => m.metadata?.forwardedFromMessageId === sourceId
      )
    );
  }

  test("copia a transcrição pronta e não re-transcreve", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const targetId = await seedTarget(t, s);
    const sourceId = await insertInboundAudio(t, s, true);

    await s.asAdmin.mutation(api.conversations.forwardMessage, {
      messageId: sourceId,
      targetConversationId: targetId,
    });

    const copy = await forwarded(t, sourceId);
    expect(copy?.transcriptText).toBe("quero o plano anual");
    expect(copy?.metadata?.transcription?.status).toBe("done");
    expect(copy?.metadata?.transcription?.text).toBe("quero o plano anual");
    expect(copy?.metadata?.forwarded).toBe(true);
    expect(await transcribeJobs(t)).toEqual([]);
  });

  test("sem transcrição na origem, a cópia agenda a sua", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const targetId = await seedTarget(t, s);
    const sourceId = await insertInboundAudio(t, s, false);

    await s.asAdmin.mutation(api.conversations.forwardMessage, {
      messageId: sourceId,
      targetConversationId: targetId,
    });

    const copy = await forwarded(t, sourceId);
    expect(copy?.transcriptText).toBeUndefined();
    expect(await transcribeJobs(t)).toEqual([copy!._id]);
  });
});

// ─── Grupo: mídia adiada pela política, baixada sob demanda ─────────────────

const GROUP_JID = "120363431849092299@g.us";
const OUR_LID = "92965187932299@lid";
const OUR_PHONE = "558192985799";
const SMALL_B64 = btoa("0123456789abcdef");

async function seedBridgeGroup(t: TestConvex<typeof schema>) {
  const s = await seed(t);
  const configId = await s.asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: s.organizationId,
    channel: "whatsapp",
    provider: "bridge",
    displayName: "Bridge grupos",
    bridgeBaseUrl: "https://wa-gw.example.test",
    bridgeInstanceId: "org_team_audio_groups",
    bridgeToken: "fake-instance-token",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(configId, { bridgeLid: OUR_LID, bridgePhone: OUR_PHONE });
  });
  await s.asAdmin.mutation(api.groupChats.acceptGroupsAck, { channelConfigId: configId });
  await s.asAdmin.mutation(api.groupChats.setGroupsEnabled, { channelConfigId: configId, enabled: true });
  // "off": nem a mídia do nosso celular é baixada na hora — fica adiada.
  await s.asAdmin.mutation(api.groupChats.setGroupMediaDefaults, {
    organizationId: s.organizationId,
    channelConfigId: configId,
    policy: { image: "off", audio: "off", video: "off", document: "off" },
  });
  const groupChatId = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("groupChats", {
      organizationId: s.organizationId,
      channelConfigId: configId,
      jid: GROUP_JID,
      subject: "Equipe",
      monitored: false,
      participants: [{ lid: OUR_LID, phone: OUR_PHONE, isAdmin: false, isSuperAdmin: false }],
      participantsCount: 1,
      createdAt: now,
      updatedAt: now,
    });
  });
  await s.asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
  return { ...s, bridgeConfigId: configId };
}

function ourGroupMedia(externalId: string, kind: "audio" | "image") {
  const mimeType = kind === "audio" ? "audio/ogg" : "image/jpeg";
  return {
    chatJid: GROUP_JID,
    externalId,
    fromMe: true,
    timestamp: Date.now(),
    contentType: kind,
    content: kind === "audio" ? "[mensagem de voz]" : "[imagem]",
    media: {
      kind,
      mimeType,
      descriptor: {
        directPath: "/v/fake",
        mediaKey: "TUVESUFLRVktU0VDUkVUTw==",
        url: "https://cdn/fake",
        fileEncSha256: "ZW5jLXNoYQ==",
        fileLength: 16,
      },
    },
    metadata: { bridgeType: kind },
  };
}

function downloadOkMock(mime: string) {
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

describe("grupo: mídia do nosso celular baixada sob demanda", () => {
  async function ingestAndDownload(
    t: TestConvex<typeof schema>,
    s: Awaited<ReturnType<typeof seedBridgeGroup>>,
    externalId: string,
    kind: "audio" | "image"
  ) {
    await t.action(internal.bridge.internalIngestGroupMessage, {
      configId: s.bridgeConfigId,
      message: ourGroupMedia(externalId, kind) as any,
    });
    const message = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find((m) => m.externalId === externalId)
    );
    expect(message?.direction).toBe("outbound");
    expect(message?.metadata?.mediaDeferred).toBeDefined();
    expect(message?.attachments).toBeUndefined();
    const result = await s.asAdmin.action(api.groupChats.downloadDeferredMedia, {
      organizationId: s.organizationId,
      messageId: message!._id,
    });
    expect(result).toEqual({ ok: true });
    return message!._id;
  }

  test("áudio outbound: autoTranscribe agendado depois do download", async () => {
    const t = convexTest(schema, modules);
    const s = await seedBridgeGroup(t);
    vi.stubGlobal("fetch", downloadOkMock("audio/ogg"));

    const messageId = await ingestAndDownload(t, s, "3EB0OURAUDIO1", "audio");

    expect(await transcribeJobs(t)).toEqual([messageId]);
  });

  test("imagem outbound: visão NÃO é agendada", async () => {
    const t = convexTest(schema, modules);
    const s = await seedBridgeGroup(t);
    vi.stubGlobal("fetch", downloadOkMock("image/jpeg"));

    await ingestAndDownload(t, s, "3EB0OURIMAGE1", "image");

    const names = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map((j) => j.name)
    );
    expect(names.some((n) => n.includes("autoDescribe"))).toBe(false);
    expect(await transcribeJobs(t)).toEqual([]);
  });
});

// ─── Whisper travado: timeout vira "failed", nunca "done" vazio ─────────────

describe("timeout do serviço Whisper", () => {
  test("fetch abortado por timeout grava status failed", async () => {
    vi.stubEnv("WHISPER_SERVICE_URL", "https://whisper.test.local");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const fileId = await storeAudio(t, s.organizationId);
    const messageId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId,
        conversationId: s.conversationId,
        leadId: s.leadId,
        direction: "outbound",
        senderId: s.adminId,
        senderType: "human",
        content: "[áudio]",
        contentType: "audio",
        attachments: [fileId],
        isInternal: false,
        createdAt: Date.now(),
      })
    );
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        throw new DOMException("The operation timed out.", "TimeoutError");
      })
    );

    const result = await t.action(internal.transcription.autoTranscribe, { messageId });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/não respondeu em 120s/);
    const stored = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(stored?.metadata?.transcription?.status).toBe("failed");
    expect(stored?.transcriptText).toBeUndefined();
  });

  test("timeout durante a leitura do corpo também é failed (não done vazio)", async () => {
    vi.stubEnv("WHISPER_SERVICE_URL", "https://whisper.test.local");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const fileId = await storeAudio(t, s.organizationId);
    const messageId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId,
        conversationId: s.conversationId,
        leadId: s.leadId,
        direction: "outbound",
        senderId: s.adminId,
        senderType: "human",
        content: "[áudio]",
        contentType: "audio",
        attachments: [fileId],
        isInternal: false,
        createdAt: Date.now(),
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new DOMException("The operation timed out.", "TimeoutError");
        },
      }))
    );

    const result = await t.action(internal.transcription.autoTranscribe, { messageId });

    expect(result.status).toBe("failed");
    const stored = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(stored?.metadata?.transcription?.status).toBe("failed");
  });
});
