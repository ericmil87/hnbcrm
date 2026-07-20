import { expect, test, describe } from "vitest";
import {
  extractBridgeInstanceId,
  parseBridgeEvent,
  verifyBridgeSignature,
} from "./lib/bridgeParse";

// ── Fixtures — ALL fake (fake numbers, tokens, JIDs). VALIDAR com payload real no piloto (U6). ──
const INSTANCE_ID = "org_fake_instance";
const SENDER_JID = "15550000001@s.whatsapp.net"; // fake
const GROUP_JID = "120363000000000000@g.us"; // fake

// Assumed wuzapi envelope: { type, token/instanceId, event: <whatsmeow event> }.
function messageEnvelope(waMessage: Record<string, unknown>, infoOverrides: Record<string, unknown> = {}) {
  return {
    type: "Message",
    instanceId: INSTANCE_ID,
    token: "fake-instance-token",
    event: {
      Info: {
        ID: "3EB0FAKEID01",
        Chat: SENDER_JID,
        Sender: SENDER_JID,
        IsFromMe: false,
        IsGroup: false,
        PushName: "Maria Teste",
        Timestamp: "2026-07-19T12:00:00Z",
        Type: "text",
        ...infoOverrides,
      },
      Message: waMessage,
    },
  };
}

function receiptEnvelope(event: Record<string, unknown>) {
  return { type: "ReadReceipt", instanceId: INSTANCE_ID, event };
}

describe("extractBridgeInstanceId", () => {
  test("finds the routing key from the instance field", () => {
    expect(extractBridgeInstanceId(messageEnvelope({ conversation: "oi" }))).toBe(INSTANCE_ID);
  });

  test("falls back to token when no explicit instance field", () => {
    expect(extractBridgeInstanceId({ type: "Message", token: "fake-tok", event: {} })).toBe("fake-tok");
  });

  test("returns null for malformed payloads", () => {
    expect(extractBridgeInstanceId(null)).toBeNull();
    expect(extractBridgeInstanceId({})).toBeNull();
    expect(extractBridgeInstanceId("nope")).toBeNull();
  });
});

describe("parseBridgeEvent — messages", () => {
  test("plain text (conversation)", () => {
    const res = parseBridgeEvent(messageEnvelope({ conversation: "Olá, quero um orçamento" }));
    expect(res.kind).toBe("message");
    if (res.kind !== "message") return;
    expect(res.message).toMatchObject({
      externalId: "3EB0FAKEID01",
      from: "15550000001",
      profileName: "Maria Teste",
      contentType: "text",
      content: "Olá, quero um orçamento",
      timestamp: Date.parse("2026-07-19T12:00:00Z"),
    });
    expect(res.message.media).toBeUndefined();
  });

  test("extended text message", () => {
    const res = parseBridgeEvent(
      messageEnvelope({ extendedTextMessage: { text: "com link https://x.y" } })
    );
    expect(res.kind).toBe("message");
    if (res.kind !== "message") return;
    expect(res.message).toMatchObject({ contentType: "text", content: "com link https://x.y" });
  });

  test("image with caption carries a media reference", () => {
    const res = parseBridgeEvent(
      messageEnvelope({
        imageMessage: {
          caption: "Veja isso",
          mimetype: "image/jpeg",
          url: "https://mmg.example/fake",
          directPath: "/v/fake",
          mediaKey: "ZmFrZWtleQ==",
        },
      })
    );
    expect(res.kind).toBe("message");
    if (res.kind !== "message") return;
    expect(res.message).toMatchObject({ contentType: "image", content: "Veja isso" });
    expect(res.message.media).toMatchObject({ kind: "image", mimeType: "image/jpeg" });
    // Full descriptor is preserved for U4 to download later
    expect(res.message.media!.descriptor).toMatchObject({ directPath: "/v/fake", mediaKey: "ZmFrZWtleQ==" });
  });

  test("audio voice note (PTT) placeholder", () => {
    const res = parseBridgeEvent(
      messageEnvelope({ audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, url: "https://m/fake" } })
    );
    expect(res.kind).toBe("message");
    if (res.kind !== "message") return;
    expect(res.message).toMatchObject({ contentType: "audio", content: "[mensagem de voz]" });
    expect(res.message.media).toMatchObject({ kind: "audio", mimeType: "audio/ogg; codecs=opus" });
  });

  test("document falls back to filename", () => {
    const res = parseBridgeEvent(
      messageEnvelope({
        documentMessage: { fileName: "orcamento.pdf", mimetype: "application/pdf", url: "https://m/fake" },
      })
    );
    expect(res.kind).toBe("message");
    if (res.kind !== "message") return;
    expect(res.message).toMatchObject({ contentType: "file", content: "orcamento.pdf" });
    expect(res.message.media).toMatchObject({ kind: "document", filename: "orcamento.pdf" });
  });

  test("sticker becomes an image placeholder", () => {
    const res = parseBridgeEvent(messageEnvelope({ stickerMessage: { mimetype: "image/webp", url: "https://m/fake" } }));
    expect(res.kind).toBe("message");
    if (res.kind !== "message") return;
    expect(res.message).toMatchObject({ contentType: "image", content: "[figurinha]" });
  });

  test("tolerates PascalCase (Go struct) serialization", () => {
    const res = parseBridgeEvent({
      type: "Message",
      instanceId: INSTANCE_ID,
      event: {
        Info: { ID: "3EB0FAKEID02", Sender: SENDER_JID, Chat: SENDER_JID, IsFromMe: false, IsGroup: false },
        Message: { Conversation: "casing test" },
      },
    });
    expect(res.kind).toBe("message");
    if (res.kind !== "message") return;
    expect(res.message).toMatchObject({ externalId: "3EB0FAKEID02", content: "casing test" });
  });

  test("fromMe echo is ignored", () => {
    const res = parseBridgeEvent(messageEnvelope({ conversation: "eco" }, { IsFromMe: true }));
    expect(res).toEqual({ kind: "ignored", reason: "fromMe" });
  });

  test("group message is ignored (by IsGroup flag)", () => {
    const res = parseBridgeEvent(messageEnvelope({ conversation: "grupo" }, { IsGroup: true }));
    expect(res).toEqual({ kind: "ignored", reason: "group" });
  });

  test("group message is ignored (by @g.us JID)", () => {
    const res = parseBridgeEvent(messageEnvelope({ conversation: "grupo" }, { Chat: GROUP_JID, Sender: GROUP_JID }));
    expect(res).toEqual({ kind: "ignored", reason: "group" });
  });

  test("strips AD-JID device/agent suffix from the sender", () => {
    const res = parseBridgeEvent(
      messageEnvelope({ conversation: "oi" }, { Sender: "15550000001.0:1@s.whatsapp.net" })
    );
    expect(res.kind).toBe("message");
    if (res.kind !== "message") return;
    expect(res.message.from).toBe("15550000001");
  });
});

describe("parseBridgeEvent — receipts", () => {
  test("delivered (empty Type) maps to delivered", () => {
    const res = parseBridgeEvent(
      receiptEnvelope({ MessageIDs: ["3EB0OUT01"], Type: "", Sender: SENDER_JID, IsFromMe: false })
    );
    expect(res).toEqual({ kind: "receipt", receipt: { status: "delivered", externalIds: ["3EB0OUT01"] } });
  });

  test("read maps to read", () => {
    const res = parseBridgeEvent(
      receiptEnvelope({ MessageIDs: ["3EB0OUT01", "3EB0OUT02"], Type: "read", Sender: SENDER_JID })
    );
    expect(res).toEqual({
      kind: "receipt",
      receipt: { status: "read", externalIds: ["3EB0OUT01", "3EB0OUT02"] },
    });
  });

  test("played maps to read", () => {
    const res = parseBridgeEvent(receiptEnvelope({ MessageIDs: ["3EB0OUT03"], Type: "played" }));
    expect(res).toEqual({ kind: "receipt", receipt: { status: "read", externalIds: ["3EB0OUT03"] } });
  });

  test("server-error maps to failed", () => {
    const res = parseBridgeEvent(receiptEnvelope({ MessageIDs: ["3EB0OUT04"], Type: "server-error" }));
    expect(res).toEqual({ kind: "receipt", receipt: { status: "failed", externalIds: ["3EB0OUT04"] } });
  });

  test("read-self is ignored (own other device)", () => {
    const res = parseBridgeEvent(receiptEnvelope({ MessageIDs: ["3EB0OUT05"], Type: "read-self" }));
    expect(res.kind).toBe("ignored");
  });

  test("receipt with no message ids is ignored", () => {
    const res = parseBridgeEvent(receiptEnvelope({ MessageIDs: [], Type: "read" }));
    expect(res.kind).toBe("ignored");
  });
});

describe("parseBridgeEvent — defensive", () => {
  test("unknown event type is ignored, never throws", () => {
    expect(parseBridgeEvent({ type: "Presence", event: { From: SENDER_JID } }).kind).toBe("ignored");
    expect(parseBridgeEvent({ type: "HistorySync", event: {} }).kind).toBe("ignored");
  });

  test("empty / malformed payloads are ignored", () => {
    expect(parseBridgeEvent(null).kind).toBe("ignored");
    expect(parseBridgeEvent({}).kind).toBe("ignored");
    expect(parseBridgeEvent("garbage").kind).toBe("ignored");
    expect(parseBridgeEvent({ type: "Message", event: { Info: {} } }).kind).toBe("ignored");
  });

  test("unrecognized message content falls back to a placeholder", () => {
    const res = parseBridgeEvent(messageEnvelope({ pollCreationMessage: { name: "?" } }));
    expect(res.kind).toBe("message");
    if (res.kind !== "message") return;
    expect(res.message.content).toBe("[mensagem não suportada]");
    expect(res.message.metadata.bridgeType).toBe("unknown");
  });
});

describe("verifyBridgeSignature", () => {
  async function sign(body: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  test("accepts a valid raw-hex signature", async () => {
    const body = JSON.stringify(messageEnvelope({ conversation: "x" }));
    expect(await verifyBridgeSignature(body, await sign(body, "fake-hmac-secret"), "fake-hmac-secret")).toBe(true);
  });

  test("accepts an optional sha256= prefix", async () => {
    const body = JSON.stringify(messageEnvelope({ conversation: "x" }));
    const sig = "sha256=" + (await sign(body, "fake-hmac-secret"));
    expect(await verifyBridgeSignature(body, sig, "fake-hmac-secret")).toBe(true);
  });

  test("rejects wrong secret, tampered body, and missing header", async () => {
    const body = JSON.stringify(messageEnvelope({ conversation: "x" }));
    const header = await sign(body, "fake-hmac-secret");
    expect(await verifyBridgeSignature(body, header, "other-secret")).toBe(false);
    expect(await verifyBridgeSignature(body + " ", header, "fake-hmac-secret")).toBe(false);
    expect(await verifyBridgeSignature(body, null, "fake-hmac-secret")).toBe(false);
    expect(await verifyBridgeSignature(body, "zz", "fake-hmac-secret")).toBe(false);
  });
});

// Fixture derivada do envelope REAL capturado no piloto U6 (2026-07-19),
// sanitizada: números fake (15550000000), LIDs fake, sem certificados.
describe("piloto U6 — envelope real do wuzapi", () => {
  const realEnvelope = {
    event: {
      Info: {
        Chat: "180000000000001@lid",
        ID: "3EB0FAKEFAKEFAKEFAKE01",
        IsFromMe: false,
        IsGroup: false,
        PushName: "Contato Teste",
        Sender: "180000000000001:87@lid",
        SenderAlt: "15550000000:87@s.whatsapp.net",
        Timestamp: "2026-07-19T16:03:13-03:00",
        Type: "text",
      },
      IsEphemeral: false,
      Message: {
        conversation: "oie2",
        messageContextInfo: { deviceListMetadataVersion: 2 },
      },
    },
    instanceName: "org_fakeorg123_mrs5qd4o",
    type: "Message",
    userID: 7,
  };

  test("routing key vem de instanceName", () => {
    expect(extractBridgeInstanceId(realEnvelope)).toBe("org_fakeorg123_mrs5qd4o");
  });

  test("sender @lid resolve o telefone via SenderAlt", () => {
    const parsed = parseBridgeEvent(realEnvelope);
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") return;
    expect(parsed.message.from).toBe("15550000000");
    expect(parsed.message.externalId).toBe("3EB0FAKEFAKEFAKEFAKE01");
    expect(parsed.message.content).toBe("oie2");
    expect(parsed.message.profileName).toBe("Contato Teste");
  });

  test("sender só-LID (sem SenderAlt) é ignorado, não vira contato falso", () => {
    const lidOnly = JSON.parse(JSON.stringify(realEnvelope));
    delete lidOnly.event.Info.SenderAlt;
    const parsed = parseBridgeEvent(lidOnly);
    expect(parsed.kind).toBe("ignored");
  });
});
