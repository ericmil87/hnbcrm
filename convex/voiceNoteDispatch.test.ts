/// <reference types="vite/client" />
// Nota de voz gravada no navegador (P0.0 áudio no iPhone): conversão para
// ogg/opus, reserva do bridge (documento, nunca data:audio/mp4|webm no
// endpoint de áudio) e checagem prévia na API oficial (Meta recusa webm).
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
// Fake fixtures only.
const BRIDGE_BASE_URL = "https://wuzapi.example.com";
const WHISPER_URL = "https://whisper.example.com";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function withWhisper() {
  vi.stubEnv("WHISPER_SERVICE_URL", WHISPER_URL);
  vi.stubEnv("WHISPER_SERVICE_TOKEN", "fake-whisper-token");
}

async function seedOrg(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Test Org",
      slug: "test-org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", { email: "admin@teste.com" });
    await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin", type: "human",
      status: "active", createdAt: now, updatedAt: now,
    });
    const aiMemberId = await ctx.db.insert("teamMembers", {
      organizationId, name: "AI Agent", role: "ai", type: "ai", status: "active",
      createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Default", color: "#6366f1", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "New", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Maria", phone: "15550000001", whatsappNumber: "15550000001",
      tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Maria", contactId, boardId, stageId, value: 0, currency: "BRL",
      priority: "medium", temperature: "cold", tags: [], customFields: {},
      conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    return { organizationId, adminUserId, aiMemberId, leadId };
  });
}

async function seedChannel(t: TestConvex<typeof schema>, provider: "bridge" | "meta") {
  const seeded = await seedOrg(t);
  const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|session1` });
  const configId = await asAdmin.action(
    api.channelConfigs.createChannelConfig,
    provider === "bridge"
      ? {
          organizationId: seeded.organizationId,
          channel: "whatsapp",
          provider: "bridge",
          displayName: "Bridge number",
          bridgeBaseUrl: BRIDGE_BASE_URL,
          bridgeInstanceId: "org_fake_instance",
          bridgeToken: "fake-instance-token",
        }
      : {
          organizationId: seeded.organizationId,
          channel: "whatsapp",
          displayName: "Main number",
          phoneNumberId: "111000111000111",
          wabaId: "222000222000222",
          verifyToken: "test-verify-token",
          appSecret: "fake-app-secret-abcd",
          accessToken: "EAAFakeAccessToken9876",
        }
  );
  const conversationId = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("conversations", {
      organizationId: seeded.organizationId, leadId: seeded.leadId, channel: "whatsapp",
      channelConfigId: configId, status: "active", messageCount: 0, createdAt: now, updatedAt: now,
    });
  });
  return { ...seeded, conversationId };
}

async function sendVoiceNote(
  t: TestConvex<typeof schema>,
  seeded: { organizationId: Id<"organizations">; aiMemberId: Id<"teamMembers">; conversationId: Id<"conversations"> },
  mimeType: string,
  name: string
): Promise<Id<"messages">> {
  const fileId = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([new Uint8Array(16).fill(7)], { type: mimeType }));
    return await ctx.db.insert("files", {
      organizationId: seeded.organizationId,
      storageId,
      name,
      mimeType,
      size: 16,
      fileType: "message_attachment",
      createdAt: Date.now(),
    });
  });
  return await t.mutation(internal.conversations.internalSendMessage, {
    conversationId: seeded.conversationId,
    content: "",
    contentType: "audio",
    teamMemberId: seeded.aiMemberId,
    attachments: [fileId],
  });
}

/** Answers /convert (fake ogg bytes or 500), the Graph API and the bridge. */
function networkMock(convertOk = true) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/convert")) {
      return convertOk
        ? new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]), { status: 200 })
        : new Response("erro", { status: 500 });
    }
    if (u.includes("graph.facebook.com")) {
      return new Response(JSON.stringify({ messages: [{ id: "wamid.VOICE1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ code: 200, success: true, data: { Id: "3EB0VOICE1", Details: "Sent" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

type FetchMock = ReturnType<typeof networkMock>;

function callTo(fetchMock: FetchMock, fragment: string): [string, RequestInit] | undefined {
  return (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(([u]) =>
    String(u).includes(fragment)
  );
}

function jsonBody(call: [string, RequestInit] | undefined): Record<string, unknown> {
  expect(call).toBeDefined();
  return JSON.parse(call![1].body as string);
}

describe("nota de voz no bridge", () => {
  test("m4a do iPhone convertido → /chat/send/audio com ogg; /convert recebe voice-note.m4a", async () => {
    withWhisper();
    const t = convexTest(schema, modules);
    const seeded = await seedChannel(t, "bridge");
    const messageId = await sendVoiceNote(t, seeded, "audio/mp4", "nota-de-voz-1.m4a");

    const fetchMock = networkMock(true);
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const convert = callTo(fetchMock, "/convert");
    expect(convert).toBeDefined();
    expect(((convert![1].body as FormData).get("file") as File).name).toBe("voice-note.m4a");

    const send = callTo(fetchMock, "/chat/send/");
    expect(send![0]).toBe(`${BRIDGE_BASE_URL}/chat/send/audio`);
    expect(String(jsonBody(send).Audio)).toMatch(/^data:audio\/ogg; codecs=opus;base64,/);

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("sent");
    expect(message!.metadata?.dispatchNote).toBeUndefined();
  });

  test("webm do Chrome mantém o nome voice-note no /convert", async () => {
    withWhisper();
    const t = convexTest(schema, modules);
    const seeded = await seedChannel(t, "bridge");
    const messageId = await sendVoiceNote(t, seeded, "audio/webm", "nota-de-voz-1.webm");

    const fetchMock = networkMock(true);
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const convert = callTo(fetchMock, "/convert");
    expect(((convert![1].body as FormData).get("file") as File).name).toBe("voice-note");
    expect(callTo(fetchMock, "/chat/send/")![0]).toBe(`${BRIDGE_BASE_URL}/chat/send/audio`);
  });

  test("sem conversão: m4a sai como documento .m4a, nunca data:audio/mp4 no endpoint de áudio", async () => {
    // Sem WHISPER_SERVICE_URL: a conversão não roda.
    const t = convexTest(schema, modules);
    const seeded = await seedChannel(t, "bridge");
    // Gravação antiga do iPhone: tipo audio/mp4 com nome .webm.
    const messageId = await sendVoiceNote(t, seeded, "audio/mp4", "nota-de-voz-1.webm");

    const fetchMock = networkMock(true);
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    expect(callTo(fetchMock, "/convert")).toBeUndefined();
    expect(callTo(fetchMock, "/chat/send/audio")).toBeUndefined();
    const body = jsonBody(callTo(fetchMock, "/chat/send/document"));
    expect(String(body.Document)).toMatch(/^data:audio\/mp4;base64,/);
    expect(body.FileName).toBe("nota-de-voz-1.m4a");

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("sent");
    expect(String(message!.metadata!.dispatchNote)).toContain("arquivo de áudio");
  });

  test("conversão falhou: webm sai como documento .webm", async () => {
    withWhisper();
    const t = convexTest(schema, modules);
    const seeded = await seedChannel(t, "bridge");
    const messageId = await sendVoiceNote(t, seeded, "audio/webm", "nota-de-voz-1.webm");

    const fetchMock = networkMock(false);
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    expect(callTo(fetchMock, "/chat/send/audio")).toBeUndefined();
    const body = jsonBody(callTo(fetchMock, "/chat/send/document"));
    expect(String(body.Document)).toMatch(/^data:audio\/webm;base64,/);
    expect(body.FileName).toBe("nota-de-voz-1.webm");
  });

  test("ogg vai direto para /chat/send/audio sem passar pelo /convert", async () => {
    withWhisper();
    const t = convexTest(schema, modules);
    const seeded = await seedChannel(t, "bridge");
    const messageId = await sendVoiceNote(t, seeded, "audio/ogg", "nota-de-voz-1.ogg");

    const fetchMock = networkMock(true);
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    expect(callTo(fetchMock, "/convert")).toBeUndefined();
    const body = jsonBody(callTo(fetchMock, "/chat/send/audio"));
    expect(String(body.Audio)).toMatch(/^data:audio\/ogg;base64,/);
    // Áudio humano: o corpo não ganhou campos novos (PTT segue o padrão do gateway).
    expect(body.PTT).toBeUndefined();
    expect(body.Seconds).toBeUndefined();
    expect(body.Waveform).toBeUndefined();
    expect(body.MimeType).toBeUndefined();
  });

  test("resposta em áudio da IA (P4.1): PTT + Seconds + Waveform (base64 de 64 bytes) + MimeType", async () => {
    withWhisper();
    const t = convexTest(schema, modules);
    const seeded = await seedChannel(t, "bridge");
    const waveform = Array.from({ length: 64 }, (_, i) => (i * 3) % 101);
    const messageId = await insertAiVoiceReply(t, seeded, { seconds: 7, waveform });

    const fetchMock = networkMock(true);
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    // Já é ogg: nada de /convert no envio (a conversão aconteceu na geração).
    expect(callTo(fetchMock, "/convert")).toBeUndefined();
    const body = jsonBody(callTo(fetchMock, "/chat/send/audio"));
    expect(String(body.Audio)).toMatch(/^data:audio\/ogg;base64,/);
    expect(body.PTT).toBe(true);
    expect(body.Seconds).toBe(7);
    expect(body.MimeType).toBe("audio/ogg; codecs=opus");
    const decoded = atob(String(body.Waveform));
    expect(decoded.length).toBe(64);
    expect(Array.from(decoded, (c) => c.charCodeAt(0))).toEqual(waveform);
    // Áudio não leva legenda: o texto falado fica só no histórico.
    expect(body.Caption).toBeUndefined();
    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("sent");
  });
});

/** Mensagem como o commit do atendente grava a resposta em áudio (P4.1). */
async function insertAiVoiceReply(
  t: TestConvex<typeof schema>,
  seeded: { organizationId: Id<"organizations">; aiMemberId: Id<"teamMembers">; conversationId: Id<"conversations">; leadId: Id<"leads"> },
  voiceNote: { seconds: number; waveform: number[] }
): Promise<Id<"messages">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const storageId = await ctx.storage.store(new Blob([new Uint8Array([0x4f, 0x67, 0x67, 0x53, 9, 9])], { type: "audio/ogg" }));
    const messageId = await ctx.db.insert("messages", {
      organizationId: seeded.organizationId,
      conversationId: seeded.conversationId,
      leadId: seeded.leadId,
      direction: "outbound",
      senderId: seeded.aiMemberId,
      senderType: "ai",
      content: "Tenho sim, amanhã às dez.",
      contentType: "audio",
      isInternal: false,
      metadata: { voiceNote, voiceReply: { mode: "audio" } },
      createdAt: now,
    });
    const fileId = await ctx.db.insert("files", {
      organizationId: seeded.organizationId,
      storageId,
      name: "resposta-em-audio.ogg",
      mimeType: "audio/ogg",
      size: 6,
      fileType: "message_attachment",
      messageId,
      createdAt: now,
    });
    await ctx.db.patch(messageId, { attachments: [fileId] });
    return messageId;
  });
}

describe("nota de voz na API oficial (Meta)", () => {
  test("m4a do iPhone vai direto como link de áudio", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedChannel(t, "meta");
    const messageId = await sendVoiceNote(t, seeded, "audio/mp4", "nota-de-voz-1.m4a");

    const fetchMock = networkMock();
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const body = jsonBody(callTo(fetchMock, "graph.facebook.com")) as { type: string; audio: { link: unknown } };
    expect(body.type).toBe("audio");
    expect(typeof body.audio.link).toBe("string");
    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("sent");
  });

  test("resposta em áudio da IA sai como áudio (link do ogg), sem campos do bridge", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedChannel(t, "meta");
    const messageId = await insertAiVoiceReply(t, seeded, { seconds: 4, waveform: new Array(64).fill(10) });

    const fetchMock = networkMock();
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const body = jsonBody(callTo(fetchMock, "graph.facebook.com")) as Record<string, any>;
    expect(body.type).toBe("audio");
    expect(typeof body.audio.link).toBe("string");
    expect(body.audio.caption).toBeUndefined();
    expect(body.PTT).toBeUndefined();
  });

  test("webm do Chrome falha antes do envio, sem chamar a Graph", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedChannel(t, "meta");
    const messageId = await sendVoiceNote(t, seeded, "audio/webm", "nota-de-voz-1.webm");

    const fetchMock = networkMock();
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    expect(fetchMock).not.toHaveBeenCalled();
    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("failed");
    expect(String(message!.metadata!.deliveryError)).toContain("webm");
  });
});
