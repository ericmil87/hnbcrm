import { describe, expect, test } from "vitest";
import {
  GROUP_MEDIA_DEFAULT_MODE,
  GROUP_MEDIA_KINDS,
  fillGroupMediaOverride,
  groupMediaKindOf,
  isGroupMessageDirectedToUs,
  resolveEffectiveGroupMedia,
  resolveGroupMediaMode,
  resolveNumberGroupMedia,
  shouldAutoDownloadGroupMedia,
} from "./groupMediaPolicy";

const OUR_LID = "92965187932215@lid";
const OUR_PHONE = "558192985729";

const base = {
  fromMe: false,
  content: "[imagem]",
  ourLid: OUR_LID,
  ourPhone: OUR_PHONE,
};

describe("resolução da política", () => {
  test("default é mentions e cobre os quatro tipos", () => {
    expect(GROUP_MEDIA_DEFAULT_MODE).toBe("mentions");
    expect(GROUP_MEDIA_KINDS).toEqual(["image", "audio", "video", "document"]);
    expect(resolveNumberGroupMedia(undefined)).toEqual({
      image: "mentions",
      audio: "mentions",
      video: "mentions",
      document: "mentions",
    });
  });

  test("override do grupo > padrão do número > default", () => {
    expect(resolveGroupMediaMode("image", { image: "all" })).toBe("all");
    expect(resolveGroupMediaMode("image", { image: "all" }, { image: "off" })).toBe("off");
    expect(resolveGroupMediaMode("image", { image: "all" }, { image: "inherit" })).toBe("all");
    expect(resolveGroupMediaMode("audio", { image: "all" }, {})).toBe("mentions");
  });

  test("forma da UI: override com sentinela e efetivo resolvido", () => {
    expect(fillGroupMediaOverride({ video: "off" })).toEqual({
      image: "inherit",
      audio: "inherit",
      video: "off",
      document: "inherit",
    });
    expect(resolveEffectiveGroupMedia({ audio: "all" }, { video: "off" })).toEqual({
      image: "mentions",
      audio: "all",
      video: "off",
      document: "mentions",
    });
  });

  test("tipo a partir do media.kind do parser, com fallback no contentType", () => {
    expect(groupMediaKindOf("image")).toBe("image");
    expect(groupMediaKindOf("sticker", "image")).toBe("sticker");
    expect(groupMediaKindOf("audio", "audio")).toBe("audio");
    expect(groupMediaKindOf("video", "file")).toBe("video");
    expect(groupMediaKindOf("document", "file")).toBe("document");
    expect(groupMediaKindOf(undefined, "file")).toBe("document");
    expect(groupMediaKindOf("estranho")).toBe("document");
    expect(groupMediaKindOf(undefined, "text")).toBeNull();
  });
});

describe("mensagem direcionada a nós", () => {
  test("menção por LID ou telefone, quote nosso, fromMe", () => {
    expect(isGroupMessageDirectedToUs({ ...base, mentions: [OUR_LID] })).toBe(true);
    expect(
      isGroupMessageDirectedToUs({ ...base, mentions: [`${OUR_PHONE}@s.whatsapp.net`] })
    ).toBe(true);
    expect(
      isGroupMessageDirectedToUs({ ...base, quotedParticipantJid: `${OUR_PHONE}@s.whatsapp.net` })
    ).toBe(true);
    expect(isGroupMessageDirectedToUs({ ...base, fromMe: true })).toBe(true);
    expect(isGroupMessageDirectedToUs({ ...base, mentions: ["111@lid"] })).toBe(false);
  });

  test("palavra-chave só conta com a IA do grupo ligada", () => {
    const msg = { ...base, content: "quero um orçamento", aiKeywords: ["orcamento"] };
    expect(isGroupMessageDirectedToUs({ ...msg, aiMode: "mention" })).toBe(true);
    expect(isGroupMessageDirectedToUs({ ...msg, aiMode: "off" })).toBe(false);
  });
});

describe("shouldAutoDownloadGroupMedia", () => {
  test("default mentions: baixa só o que é com a gente", () => {
    expect(shouldAutoDownloadGroupMedia({ ...base, mediaKind: "image" })).toEqual({
      download: false,
      reason: "not_directed",
      kind: "image",
    });
    expect(
      shouldAutoDownloadGroupMedia({ ...base, mediaKind: "image", mentions: [OUR_LID] })
    ).toEqual({ download: true, reason: "directed", kind: "image" });
  });

  test("all e off", () => {
    expect(
      shouldAutoDownloadGroupMedia({ ...base, mediaKind: "audio", numberDefault: { audio: "all" } })
        .download
    ).toBe(true);
    expect(
      shouldAutoDownloadGroupMedia({
        ...base,
        fromMe: true,
        mediaKind: "audio",
        numberDefault: { audio: "off" },
      })
    ).toEqual({ download: false, reason: "off", kind: "audio" });
  });

  test("override por grupo vence o número", () => {
    expect(
      shouldAutoDownloadGroupMedia({
        ...base,
        mediaKind: "document",
        numberDefault: { document: "off" },
        groupOverride: { document: "all" },
      }).reason
    ).toBe("all");
  });

  test("figurinha nunca baixa automático, nem com all nem mencionando", () => {
    expect(
      shouldAutoDownloadGroupMedia({
        ...base,
        fromMe: true,
        mentions: [OUR_LID],
        mediaKind: "sticker",
        contentType: "image",
        numberDefault: { image: "all" },
      })
    ).toEqual({ download: false, reason: "sticker", kind: "sticker" });
  });
});
