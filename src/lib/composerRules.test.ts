import { describe, expect, it } from "vitest";
import {
  defaultScheduleValue,
  deriveContentType,
  hasContentToSend,
  isSendKey,
  placeholderFor,
  replyAuthorLabel,
  replyPreviewText,
} from "./composerRules";
import type { InboxMessage } from "@/components/inbox/types";

const msg = (over: Partial<InboxMessage>): InboxMessage => ({
  _id: "m1",
  conversationId: "c1",
  content: "oi",
  direction: "inbound",
  senderType: "contact",
  isInternal: false,
  createdAt: 1,
  ...over,
});

describe("composerRules", () => {
  it("deriva o tipo do primeiro anexo", () => {
    expect(deriveContentType([])).toBe("text");
    expect(deriveContentType([{ mimeType: "image/png" }, { mimeType: "audio/ogg" }])).toBe("image");
    expect(deriveContentType([{ mimeType: "audio/webm" }])).toBe("audio");
    expect(deriveContentType([{ mimeType: "application/pdf" }])).toBe("file");
  });

  it("Enter envia, Shift+Enter não", () => {
    expect(isSendKey({ key: "Enter", shiftKey: false })).toBe(true);
    expect(isSendKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isSendKey({ key: "a", shiftKey: false })).toBe(false);
    expect(isSendKey({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true } })).toBe(false);
  });

  it("só envia com texto ou anexo", () => {
    expect(hasContentToSend("  ", 0)).toBe(false);
    expect(hasContentToSend("", 1)).toBe(true);
    expect(hasContentToSend("oi", 0)).toBe(true);
  });

  it("prévia e autor da citação", () => {
    expect(replyPreviewText(null)).toBe("");
    expect(replyPreviewText(msg({ content: "olá" }))).toBe("olá");
    expect(replyAuthorLabel(msg({}), "Ana")).toBe("Ana");
    expect(replyAuthorLabel(msg({}), "")).toBe("Contato");
    expect(replyAuthorLabel(msg({ direction: "outbound", senderType: "user" }), "Ana")).toBe("Você");
  });

  it("sugere a próxima hora cheia depois de uma hora", () => {
    const now = new Date(2026, 10, 5, 10, 20).getTime();
    expect(defaultScheduleValue(now)).toBe("2026-11-05T11:00");
  });

  it("placeholder por modo", () => {
    expect(placeholderFor({ internal: true, blocked: true, group: true })).toContain("nota interna");
    expect(placeholderFor({ internal: false, blocked: true, group: true })).toContain("Janela fechada");
    expect(placeholderFor({ internal: false, blocked: false, group: true })).toContain("grupo");
    expect(placeholderFor({ internal: false, blocked: false, group: false })).toBe("Digite uma mensagem...");
  });
});
