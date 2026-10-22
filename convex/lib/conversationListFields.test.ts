import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import {
  LIST_PREVIEW_MAX,
  groupParticipantsCountOf,
  groupSummaryPatchFor,
  lastMessageFieldsFor,
  lastMessageFieldsFromConversation,
  lastMessageFieldsPatch,
  lastMessagePatchFor,
  listFieldsBackfillPatch,
  isPreviewMessage,
  previewTextOf,
} from "./conversationListFields";

const MSG_ID = "msg1" as Id<"messages">;

function msg(over: Partial<Parameters<typeof previewTextOf>[0]> = {}) {
  return {
    content: "Olá",
    contentType: "text" as const,
    direction: "inbound" as const,
    isInternal: false,
    createdAt: 1000,
    ...over,
  };
}

function conv(over: Partial<Doc<"conversations">> = {}): Doc<"conversations"> {
  return {
    _id: "c1" as Id<"conversations">,
    _creationTime: 0,
    organizationId: "o1" as Id<"organizations">,
    channel: "whatsapp",
    status: "active",
    messageCount: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Doc<"conversations">;
}

describe("prévia da última mensagem", () => {
  test("placeholder de mídia por contentType e bridgeType", () => {
    expect(previewTextOf(msg({ content: "", contentType: "image" }))).toBe("[imagem]");
    expect(previewTextOf(msg({ content: "  ", contentType: "audio" }))).toBe("[mensagem de voz]");
    expect(previewTextOf(msg({ content: "", contentType: "file" }))).toBe("[arquivo]");
    expect(
      previewTextOf(msg({ content: "", contentType: "image", metadata: { bridgeType: "sticker" } }))
    ).toBe("[figurinha]");
    expect(
      previewTextOf(msg({ content: "", contentType: "file", metadata: { bridgeType: "video" } }))
    ).toBe("[vídeo]");
    expect(previewTextOf(msg({ content: "", contentType: "text" }))).toBe("");
    // Legenda vence o placeholder.
    expect(previewTextOf(msg({ content: "foto da casa", contentType: "image" }))).toBe("foto da casa");
  });

  test('nota interna ganha o prefixo "Nota: "', () => {
    expect(previewTextOf(msg({ content: "ligar amanhã", isInternal: true, direction: "internal" }))).toBe(
      "Nota: ligar amanhã"
    );
  });

  test("nota interna e rascunho da IA não viram prévia (onda 2 de I/O)", () => {
    expect(isPreviewMessage(msg())).toBe(true);
    expect(isPreviewMessage(msg({ direction: "outbound" }))).toBe(true);
    expect(isPreviewMessage(msg({ isInternal: true, direction: "internal" }))).toBe(false);
    expect(isPreviewMessage(msg({ isInternal: false, direction: "internal" }))).toBe(false);
    expect(
      lastMessagePatchFor({}, MSG_ID, msg({ isInternal: true, direction: "internal", createdAt: 9999 }))
    ).toBeNull();
    // Backfill: última "mensagem" interna = sem prévia; desconhecida = não mexe.
    const c = conv({ lastMessagePreview: "Oi", lastMessagePreviewAt: 1, lastMessageId: MSG_ID });
    expect(listFieldsBackfillPatch(c, { lastMessage: undefined, group: null, config: null }).lastMessage).toBe(false);
  });

  test("trunca em 80 com reticências", () => {
    const long = "a".repeat(200);
    const out = previewTextOf(msg({ content: long }));
    expect(out).toHaveLength(LIST_PREVIEW_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(previewTextOf(msg({ content: "b".repeat(80) }))).toBe("b".repeat(80));
  });

  test("patch e campos lidos da conversa batem com o caminho antigo (exceto bridgeExtra)", () => {
    const m = msg({
      content: "",
      contentType: "text",
      metadata: { bridgeType: "poll", bridgeExtra: { question: "?" }, revoked: true },
    });
    const old = lastMessageFieldsFor(m);
    const patch = lastMessageFieldsPatch(MSG_ID, m);
    const fromConv = lastMessageFieldsFromConversation(conv(patch as Partial<Doc<"conversations">>));
    expect(fromConv).toEqual({ ...old, lastMessageBridgeExtra: null });
    expect(old.lastMessageBridgeExtra).toEqual({ question: "?" });
  });

  test("patch limpa bridgeType/revoked da mensagem anterior", () => {
    const patch = lastMessageFieldsPatch(MSG_ID, msg());
    expect("lastMessageBridgeType" in patch).toBe(true);
    expect(patch.lastMessageBridgeType).toBeUndefined();
    expect(patch.lastMessageRevoked).toBeUndefined();
  });
});

describe('regra "não anda para trás"', () => {
  test("mensagem mais antiga que a prévia não sobrescreve", () => {
    expect(lastMessagePatchFor({ lastMessagePreviewAt: 2000 }, MSG_ID, msg({ createdAt: 1999 }))).toBeNull();
  });
  test("empate e mais nova sobrescrevem", () => {
    expect(lastMessagePatchFor({ lastMessagePreviewAt: 2000 }, MSG_ID, msg({ createdAt: 2000 }))).not.toBeNull();
    expect(lastMessagePatchFor({ lastMessagePreviewAt: 2000 }, MSG_ID, msg({ createdAt: 2001 }))).not.toBeNull();
  });
  test("conversa sem prévia aceita qualquer uma", () => {
    expect(lastMessagePatchFor({}, MSG_ID, msg({ createdAt: 1 }))!.lastMessagePreviewAt).toBe(1);
  });
});

describe("grupo", () => {
  test("contagem recontada da lista, fallback participantsCount", () => {
    expect(
      groupParticipantsCountOf({
        subject: "x",
        participants: [{}, { leftAt: 1 }, {}],
        participantsCount: 99,
      })
    ).toBe(2);
    expect(groupParticipantsCountOf({ subject: "x", participantsCount: 7 })).toBe(7);
    expect(groupParticipantsCountOf({ subject: "x" })).toBe(0);
  });
  test("patch só com o que mudou", () => {
    expect(
      groupSummaryPatchFor({ groupSubject: "A", groupParticipantsCount: 2 }, { subject: "A", participantsCount: 2 })
    ).toBeNull();
    expect(
      groupSummaryPatchFor({ groupSubject: "A", groupParticipantsCount: 2 }, { subject: "B", participantsCount: 2 })
    ).toEqual({ groupSubject: "B" });
  });
});

describe("backfill (cálculo)", () => {
  test("idempotente: aplicar o patch e recalcular dá patch vazio", () => {
    const c = conv({ kind: "group", groupChatId: "g1" as Id<"groupChats">, channelConfigId: "cfg" as Id<"channelConfigs"> });
    const source = {
      lastMessage: { ...msg({ createdAt: 50 }), _id: MSG_ID },
      group: { _id: "g1" as Id<"groupChats">, subject: "Sala", participantsCount: 3 },
      config: { provider: "bridge" as const },
    };
    const first = listFieldsBackfillPatch(c, source);
    expect(first.lastMessage && first.group && first.provider).toBe(true);
    const after = conv({ ...c, ...(first.patch as Partial<Doc<"conversations">>) });
    const second = listFieldsBackfillPatch(after, source);
    expect(second.patch).toEqual({});
  });
  test("conversa sem mensagem e sem campos: nada a gravar", () => {
    const out = listFieldsBackfillPatch(conv({ messageCount: 0 }), {
      lastMessage: null,
      group: null,
      config: null,
    });
    expect(out.patch).toEqual({});
  });
});
