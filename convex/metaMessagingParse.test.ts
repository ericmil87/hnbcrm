import { describe, expect, test } from "vitest";
import {
  isTestPayload,
  parseMetaMessagingWebhook,
  verifyMetaSignature,
} from "./lib/metaMessagingParse";
import pageText from "./__fixtures__/meta/page-message-text.json";
import pageEcho from "./__fixtures__/meta/page-message-echo-app.json";
import pageDelivery from "./__fixtures__/meta/page-delivery.json";
import pageRead from "./__fixtures__/meta/page-read.json";
import pageStandby from "./__fixtures__/meta/page-standby.json";
import igText from "./__fixtures__/meta/instagram-message-text.json";
import igEcho from "./__fixtures__/meta/instagram-message-echo.json";
import igStory from "./__fixtures__/meta/instagram-story-mention.json";
import igRead from "./__fixtures__/meta/instagram-read.json";
import igDeleted from "./__fixtures__/meta/instagram-deleted.json";
import testPage from "./__fixtures__/meta/dashboard-test-page.json";
import testIg from "./__fixtures__/meta/dashboard-test-instagram.json";

describe("parseMetaMessagingWebhook", () => {
  test("page: texto vira message do messenger", () => {
    const { object, events } = parseMetaMessagingWebhook(pageText);
    expect(object).toBe("page");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      surface: "messenger",
      accountId: "1000000000000001",
      kind: "message",
      userId: "1000000000000002",
      mid: "m_fake_mid_000001",
      attachments: [],
    });
  });

  test("instagram: texto vira message do instagram", () => {
    const { object, events } = parseMetaMessagingWebhook(igText);
    expect(object).toBe("instagram");
    expect(events[0]).toMatchObject({
      surface: "instagram",
      accountId: "1000000000000003",
      kind: "message",
      userId: "1000000000000004",
    });
  });

  test("eco do Messenger (message_echoes): userId = recipient, appId e metadata", () => {
    const { events } = parseMetaMessagingWebhook(pageEcho);
    expect(events[0]).toMatchObject({
      kind: "echo",
      userId: "1000000000000002",
      appId: "1000000000000099",
      metadata: "hnb:fake_message_id",
      text: "Olá, Marina!",
    });
  });

  test("eco do Instagram (is_echo dentro de messages): sem appId", () => {
    const { events } = parseMetaMessagingWebhook(igEcho);
    expect(events[0]).toMatchObject({ kind: "echo", surface: "instagram", userId: "1000000000000004" });
    expect((events[0] as { appId?: string }).appId).toBeUndefined();
  });

  test("standby marca standby:true", () => {
    const { events } = parseMetaMessagingWebhook(pageStandby);
    expect(events[0]).toMatchObject({ kind: "message", standby: true });
  });

  test("delivery e read (Messenger watermark, IG mid)", () => {
    expect(parseMetaMessagingWebhook(pageDelivery).events[0]).toMatchObject({
      kind: "delivery",
      mids: ["m_fake_mid_000002"],
    });
    expect(parseMetaMessagingWebhook(pageRead).events[0]).toMatchObject({ kind: "read", watermark: 1760000002500 });
    expect(parseMetaMessagingWebhook(igRead).events[0]).toMatchObject({
      kind: "read",
      mid: "ig_fake_mid_000002",
    });
  });

  test("deleted e story_mention", () => {
    expect(parseMetaMessagingWebhook(igDeleted).events[0]).toMatchObject({
      kind: "deleted",
      mid: "ig_fake_mid_000001",
    });
    const story = parseMetaMessagingWebhook(igStory).events[0];
    expect(story).toMatchObject({ kind: "message" });
    expect((story as { attachments: unknown[] }).attachments).toEqual([
      { type: "story_mention", url: "https://cdn.example.test/story-fake.jpg" },
    ]);
  });

  test("is_unsupported, reaction, postback, referral, message_edit", () => {
    const body = {
      object: "instagram",
      entry: [
        {
          id: "1000000000000003",
          messaging: [
            { sender: { id: "u1" }, timestamp: 1, message: { mid: "a", is_unsupported: true } },
            { sender: { id: "u1" }, timestamp: 2, reaction: { mid: "a", action: "react", reaction: "love", emoji: "x" } },
            { sender: { id: "u1" }, timestamp: 3, postback: { title: "Oi", payload: "P" } },
            { sender: { id: "u1" }, timestamp: 4, referral: { source: "ADS", type: "OPEN_THREAD", ref: "r" } },
            { sender: { id: "u1" }, timestamp: 5, message_edit: { mid: "a", text: "novo" } },
          ],
        },
      ],
    };
    expect(parseMetaMessagingWebhook(body).events.map((e) => e.kind)).toEqual([
      "unsupported",
      "reaction",
      "postback",
      "referral",
      "edited",
    ]);
  });

  test("changes[]: edit vira edited, o resto unknown, sem lançar", () => {
    const body = {
      object: "page",
      entry: [
        {
          id: "1000000000000001",
          time: 5,
          changes: [
            { field: "message_edit", value: { mid: "m1", text: "x" } },
            { field: "feed", value: { anything: true } },
          ],
        },
      ],
    };
    const { events } = parseMetaMessagingWebhook(body);
    expect(events[0]).toMatchObject({ kind: "edited", mid: "m1" });
    expect(events[1]).toMatchObject({ kind: "unknown", field: "feed" });
  });

  test("lixo nunca lança", () => {
    for (const junk of [null, undefined, "texto", 42, [], {}, { object: "user" }, { object: "page" }, { object: "page", entry: "x" }]) {
      expect(() => parseMetaMessagingWebhook(junk)).not.toThrow();
      expect(parseMetaMessagingWebhook(junk)).toEqual({ object: null, events: [] });
    }
    const weird = parseMetaMessagingWebhook({ object: "page", entry: [null, 3, { id: "p", messaging: [null, "x", {}] }] });
    expect(weird.object).toBe("page");
    expect(weird.events.every((e) => e.kind === "unknown")).toBe(true);
  });

  test("ordena por timestamp dentro do lote", () => {
    const body = {
      object: "page",
      entry: [
        {
          id: "p",
          messaging: [
            { sender: { id: "u" }, timestamp: 300, message: { mid: "c", text: "3" } },
            { sender: { id: "u" }, timestamp: 100, message: { mid: "a", text: "1" } },
            { sender: { id: "u" }, timestamp: 200, message: { mid: "b", text: "2" } },
          ],
        },
      ],
    };
    expect(parseMetaMessagingWebhook(body).events.map((e) => (e as { mid: string }).mid)).toEqual(["a", "b", "c"]);
  });

  test("attachments: tipos, sticker curtir, share e reel", () => {
    const body = {
      object: "page",
      entry: [
        {
          id: "p",
          messaging: [
            {
              sender: { id: "u" },
              timestamp: 1,
              message: {
                mid: "m",
                attachments: [
                  { type: "image", payload: { url: "https://x.test/i.jpg" } },
                  { type: "image", payload: { url: "https://x.test/s.png", sticker_id: 369239263222822 } },
                  { type: "image", payload: { url: "https://x.test/s2.png", sticker_id: 1 } },
                  { type: "share", payload: { url: "https://x.test/p", ig_post_media_id: "99" }, title: "Post" },
                  { type: "reel", payload: { url: "https://x.test/r" } },
                  { type: "fallback", title: "Link", url: "https://x.test/l" },
                  { type: "coisa" },
                ],
              },
            },
          ],
        },
      ],
    };
    const att = (parseMetaMessagingWebhook(body).events[0] as { attachments: { type: string }[] }).attachments;
    expect(att.map((a) => a.type)).toEqual(["image", "like_heart", "sticker", "ig_post", "ig_reel", "fallback", "other"]);
  });
});

describe("isTestPayload", () => {
  test("reconhece os payloads do botão Testar", () => {
    expect(isTestPayload(testPage)).toBe(true);
    expect(isTestPayload(testIg)).toBe(true);
  });
  test("payload real e lixo não são teste", () => {
    expect(isTestPayload(pageText)).toBe(false);
    expect(isTestPayload(igText)).toBe(false);
    expect(isTestPayload(null)).toBe(false);
    expect(isTestPayload("x")).toBe(false);
    expect(isTestPayload({ entry: [] })).toBe(false);
  });
});

describe("verifyMetaSignature", () => {
  async function sign(body: string, secret: string) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return "sha256=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  test("aceita assinatura válida e rejeita o resto", async () => {
    const body = JSON.stringify(pageText);
    expect(await verifyMetaSignature(body, await sign(body, "fake-secret"), "fake-secret")).toBe(true);
    expect(await verifyMetaSignature(body, await sign(body, "outro"), "fake-secret")).toBe(false);
    expect(await verifyMetaSignature(body, null, "fake-secret")).toBe(false);
    expect(await verifyMetaSignature(body, "sha256=zz", "fake-secret")).toBe(false);
    expect(await verifyMetaSignature(body, await sign(body, "fake-secret"), "")).toBe(false);
  });
});
