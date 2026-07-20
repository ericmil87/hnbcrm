import { expect, test, describe } from "vitest";
import {
  extractPhoneNumberId,
  parseWebhookPayload,
  verifyWebhookSignature,
} from "./lib/whatsappParse";

const PHONE_NUMBER_ID = "111000111000111";

function payloadWith(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "222000222000222",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: PHONE_NUMBER_ID },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

const SENDER = {
  contacts: [{ profile: { name: "Maria Teste" }, wa_id: "15550000001" }],
};

function inbound(message: Record<string, unknown>) {
  return payloadWith({ ...SENDER, messages: [{ from: "15550000001", id: "wamid.X1", timestamp: "1700000000", ...message }] });
}

describe("extractPhoneNumberId", () => {
  test("finds the routing key in a standard delivery", () => {
    expect(extractPhoneNumberId(payloadWith({}))).toBe(PHONE_NUMBER_ID);
  });

  test("returns null for malformed payloads", () => {
    expect(extractPhoneNumberId({})).toBeNull();
    expect(extractPhoneNumberId(null)).toBeNull();
    expect(extractPhoneNumberId({ entry: [{ changes: [{ value: {} }] }] })).toBeNull();
  });
});

describe("parseWebhookPayload — message types", () => {
  test("text", () => {
    const { messages } = parseWebhookPayload(inbound({ type: "text", text: { body: "Olá!" } }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      externalId: "wamid.X1",
      from: "15550000001",
      profileName: "Maria Teste",
      contentType: "text",
      content: "Olá!",
      timestamp: 1700000000000,
    });
    expect(messages[0].media).toBeUndefined();
  });

  test("image with caption", () => {
    const { messages } = parseWebhookPayload(
      inbound({ type: "image", image: { id: "media-1", mime_type: "image/jpeg", caption: "Veja isso" } })
    );
    expect(messages[0]).toMatchObject({
      contentType: "image",
      content: "Veja isso",
      media: { id: "media-1", mimeType: "image/jpeg" },
    });
  });

  test("document falls back to filename", () => {
    const { messages } = parseWebhookPayload(
      inbound({ type: "document", document: { id: "media-2", mime_type: "application/pdf", filename: "orcamento.pdf" } })
    );
    expect(messages[0]).toMatchObject({
      contentType: "file",
      content: "orcamento.pdf",
      media: { id: "media-2", filename: "orcamento.pdf" },
    });
  });

  test("audio voice note", () => {
    const { messages } = parseWebhookPayload(
      inbound({ type: "audio", audio: { id: "media-3", mime_type: "audio/ogg", voice: true } })
    );
    expect(messages[0]).toMatchObject({ contentType: "audio", content: "[mensagem de voz]" });
  });

  test("interactive button reply", () => {
    const { messages } = parseWebhookPayload(
      inbound({
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "opt-1", title: "Sim, quero" } },
      })
    );
    expect(messages[0]).toMatchObject({ contentType: "text", content: "Sim, quero" });
    expect(messages[0].metadata).toMatchObject({ interactiveType: "button_reply", replyId: "opt-1" });
  });

  test("location becomes readable text with raw payload in metadata", () => {
    const { messages } = parseWebhookPayload(
      inbound({ type: "location", location: { latitude: -23.55, longitude: -46.63, name: "Escritório" } })
    );
    expect(messages[0].content).toContain("-23.55");
    expect(messages[0].content).toContain("Escritório");
    expect(messages[0].metadata.location).toMatchObject({ latitude: -23.55 });
  });

  test("shared contacts", () => {
    const { messages } = parseWebhookPayload(
      inbound({
        type: "contacts",
        contacts: [{ name: { formatted_name: "João Silva" }, phones: [{ phone: "+15550000099" }] }],
      })
    );
    expect(messages[0].content).toContain("João Silva");
    expect(messages[0].content).toContain("+15550000099");
  });

  test("reaction", () => {
    const { messages } = parseWebhookPayload(
      inbound({ type: "reaction", reaction: { message_id: "wamid.PREV", emoji: "👍" } })
    );
    expect(messages[0].content).toContain("👍");
    expect(messages[0].metadata.reactionTo).toBe("wamid.PREV");
  });

  test("unknown type falls back with raw payload", () => {
    const { messages } = parseWebhookPayload(inbound({ type: "order", order: { catalog_id: "x" } }));
    expect(messages[0].content).toBe("[unsupported message type: order]");
    expect(messages[0].metadata.raw).toBeDefined();
  });
});

describe("parseWebhookPayload — statuses", () => {
  test("parses delivery statuses including error details", () => {
    const { statuses } = parseWebhookPayload(
      payloadWith({
        statuses: [
          { id: "wamid.A", status: "delivered", timestamp: "1700000001", recipient_id: "15550000001" },
          {
            id: "wamid.B",
            status: "failed",
            errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "24h window closed" } }],
          },
        ],
      })
    );
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({ externalId: "wamid.A", status: "delivered" });
    expect(statuses[1].status).toBe("failed");
    expect(statuses[1].errorDetail).toContain("131047");
    expect(statuses[1].errorDetail).toContain("24h window closed");
  });

  test("ignores unknown status values and non-message fields", () => {
    const result = parseWebhookPayload({
      entry: [
        { changes: [{ field: "account_update", value: { messages: [{ from: "1", id: "w", type: "text", text: { body: "x" } }] } }] },
        { changes: [{ field: "messages", value: { statuses: [{ id: "wamid.C", status: "warning" }] } }] },
      ],
    });
    expect(result.messages).toHaveLength(0);
    expect(result.statuses).toHaveLength(0);
  });
});

describe("verifyWebhookSignature", () => {
  async function sign(body: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return "sha256=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  test("accepts a valid signature", async () => {
    const body = JSON.stringify(payloadWith({}));
    const header = await sign(body, "fake-app-secret");
    expect(await verifyWebhookSignature(body, header, "fake-app-secret")).toBe(true);
  });

  test("rejects wrong secret, tampered body, and missing header", async () => {
    const body = JSON.stringify(payloadWith({}));
    const header = await sign(body, "fake-app-secret");
    expect(await verifyWebhookSignature(body, header, "other-secret")).toBe(false);
    expect(await verifyWebhookSignature(body + " ", header, "fake-app-secret")).toBe(false);
    expect(await verifyWebhookSignature(body, null, "fake-app-secret")).toBe(false);
    expect(await verifyWebhookSignature(body, "sha256=zz", "fake-app-secret")).toBe(false);
  });
});
