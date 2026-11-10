import { describe, expect, it } from "vitest";
import {
  defaultScheduleValue,
  deriveContentType,
  hasContentToSend,
  isSendKey,
  isSendKeyFor,
  composerMaxRows,
  autoGrowHeight,
  placeholderFor,
  isComposerBlocked,
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

  it("modo leitura: placeholder próprio, vence qualquer outro modo", () => {
    for (const internal of [true, false]) {
      expect(placeholderFor({ internal, blocked: true, group: false, readOnly: true })).toContain("Conta em modo leitura");
    }
    expect(placeholderFor({ internal: false, blocked: false, group: false, readOnly: false })).toBe("Digite uma mensagem...");
  });
});

describe("isComposerBlocked", () => {
  it("modo leitura trava a mensagem ao cliente nos canais que despacham", () => {
    for (const channel of ["whatsapp", "instagram", "messenger"]) {
      expect(isComposerBlocked({ windowBlocked: false, readOnly: true, internal: false, channel })).toBe(true);
    }
    expect(isComposerBlocked({ windowBlocked: false, readOnly: true, internal: false })).toBe(true);
  });
  it("modo leitura não trava nota interna nem canal sem despacho (webchat)", () => {
    expect(isComposerBlocked({ windowBlocked: false, readOnly: true, internal: true, channel: "whatsapp" })).toBe(false);
    expect(isComposerBlocked({ windowBlocked: false, readOnly: true, internal: false, channel: "webchat" })).toBe(false);
  });
  it("janela fechada só trava a mensagem ao cliente", () => {
    expect(isComposerBlocked({ windowBlocked: true, readOnly: false, internal: false })).toBe(true);
    expect(isComposerBlocked({ windowBlocked: true, readOnly: false, internal: true })).toBe(false);
  });
  it("livre quando nada trava", () => {
    expect(isComposerBlocked({ windowBlocked: false, readOnly: false, internal: false })).toBe(false);
  });
});

describe("isSendKeyFor", () => {
  const enter = { key: "Enter", shiftKey: false };
  it("desktop: Enter envia, Shift+Enter não", () => {
    expect(isSendKeyFor(enter, false)).toBe(true);
    expect(isSendKeyFor({ ...enter, shiftKey: true }, false)).toBe(false);
  });
  it("toque: Enter só quebra a linha; Ctrl/Cmd+Enter ainda envia", () => {
    expect(isSendKeyFor(enter, true)).toBe(false);
    expect(isSendKeyFor({ ...enter, ctrlKey: true }, true)).toBe(true);
    expect(isSendKeyFor({ ...enter, metaKey: true }, true)).toBe(true);
  });
  it("composição IME nunca envia", () => {
    expect(isSendKeyFor({ ...enter, nativeEvent: { isComposing: true } }, false)).toBe(false);
  });
});

describe("autoGrowHeight", () => {
  const base = { lineHeight: 24, paddingY: 20, maxRows: 6 };
  it("uma linha fica na altura mínima", () => {
    expect(autoGrowHeight({ ...base, scrollHeight: 44 })).toEqual({ height: 44, scrollable: false });
    expect(autoGrowHeight({ ...base, scrollHeight: 10 })).toEqual({ height: 44, scrollable: false });
  });
  it("cresce com o conteúdo até o limite", () => {
    expect(autoGrowHeight({ ...base, scrollHeight: 92 })).toEqual({ height: 92, scrollable: false });
    expect(autoGrowHeight({ ...base, scrollHeight: 164 })).toEqual({ height: 164, scrollable: false });
  });
  it("passou de maxRows: trava e rola por dentro", () => {
    expect(autoGrowHeight({ ...base, scrollHeight: 500 })).toEqual({ height: 164, scrollable: true });
  });
  it("conta a borda", () => {
    expect(autoGrowHeight({ ...base, borderY: 2, scrollHeight: 44 })).toEqual({ height: 46, scrollable: false });
  });
  it("limites por aparelho", () => {
    expect(composerMaxRows(false)).toBe(6);
    expect(composerMaxRows(true)).toBe(10);
  });
});
