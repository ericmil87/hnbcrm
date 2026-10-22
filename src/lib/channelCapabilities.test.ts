import { describe, expect, it } from "vitest";
import {
  channelSupports,
  deliveryTicksMode,
  formatTextCounter,
  textLimitFor,
  mediaSendBlocked,
  allowedReactionEmojis,
  acceptedUploadMimes,
  maxUploadBytes,
  validateUpload,
  textNeedsSplit,
  textPartsCount,
} from "./channelCapabilities";

describe("channelSupports", () => {
  it("keeps WhatsApp identical to the old channelIsWhatsapp for reply/react/forward/ticks", () => {
    for (const t of ["bridge", "meta", undefined, null]) {
      for (const f of [
        "deliveryTicks",
        "reactionsSend",
        "reactionsReceive",
        "replyQuote",
        "forward",
        "voiceRecorder",
        "aiAttendant",
      ] as const) {
        expect(channelSupports("whatsapp", t, f)).toBe(true);
      }
    }
  });

  it("unsupported channels have no capabilities", () => {
    for (const c of ["telegram", "email", "webchat", "internal", undefined]) {
      for (const f of ["deliveryTicks", "forward", "replyQuote", "serviceWindow", "typingIndicator"] as const) {
        expect(channelSupports(c, "meta", f)).toBe(false);
      }
    }
  });

  it("service window differs between bridge and meta; typing stays on for both", () => {
    expect(channelSupports("whatsapp", "bridge", "serviceWindow")).toBe(false);
    expect(channelSupports("whatsapp", "meta", "serviceWindow")).toBe(true);
    expect(channelSupports("whatsapp", "bridge", "typingIndicator")).toBe(true);
    expect(channelSupports("whatsapp", "meta", "typingIndicator")).toBe(true);
  });

  it("instagram and messenger follow the matrix", () => {
    expect(deliveryTicksMode("instagram", "instagram")).toBe("read");
    expect(deliveryTicksMode("messenger", "messenger")).toBe("full");
    expect(deliveryTicksMode("telegram")).toBe(false);
    expect(channelSupports("instagram", "instagram", "reactionsSend")).toBe(true);
    expect(channelSupports("instagram", "instagram", "reactionsReceive")).toBe(true);
    expect(channelSupports("instagram", "instagram", "replyQuote")).toBe(true);
    expect(channelSupports("messenger", "messenger", "replyQuote")).toBe(false);
    expect(channelSupports("messenger", "messenger", "forward")).toBe(true);
    for (const c of ["instagram", "messenger"]) {
      expect(channelSupports(c, c, "voiceRecorder")).toBe(false);
      expect(channelSupports(c, c, "templates")).toBe(false);
      expect(channelSupports(c, c, "newConversation")).toBe(false);
      expect(channelSupports(c, c, "serviceWindow")).toBe(true);
      // F3: IA ainda não responde nesses canais
      expect(channelSupports(c, c, "aiAttendant")).toBe(false);
      expect(channelSupports(c, c, "mediaSend")).toBe(true);
      expect(channelSupports(c, c, "typingIndicator")).toBe(true);
    }
  });
});

describe("text counter", () => {
  it("limits", () => {
    expect(textLimitFor("whatsapp", "meta")).toBeNull();
    expect(textLimitFor("instagram", "instagram")).toEqual({ unit: "bytes", max: 1000, part: 1000 });
    expect(textLimitFor("messenger", "messenger")).toEqual({ unit: "chars", max: 2000, part: 1900 });
  });

  it("counts bytes for instagram and parts above the limit", () => {
    const ig = textLimitFor("instagram")!;
    expect(textPartsCount("a".repeat(1000), ig)).toBe(1);
    expect(textPartsCount("a".repeat(1001), ig)).toBe(2);
    expect(textPartsCount("ã".repeat(501), ig)).toBe(2);
    expect(textPartsCount("", ig)).toBe(1);
  });

  it("messenger splits at 1900 chars, like the backend", () => {
    const ms = textLimitFor("messenger")!;
    expect(textNeedsSplit("a".repeat(1900), ms)).toBe(false);
    expect(textNeedsSplit("a".repeat(1901), ms)).toBe(true);
    expect(textPartsCount("a".repeat(1900), ms)).toBe(1);
    expect(textPartsCount("a".repeat(1901), ms)).toBe(2);
    expect(textNeedsSplit("a".repeat(1000), textLimitFor("instagram")!)).toBe(false);
    expect(textNeedsSplit("a".repeat(1001), textLimitFor("instagram")!)).toBe(true);
  });

  it("whatsapp, instagram and messenger send media", () => {
    expect(channelSupports("whatsapp", "bridge", "mediaSend")).toBe(true);
    expect(channelSupports("whatsapp", "meta", "mediaSend")).toBe(true);
    expect(mediaSendBlocked("instagram", "instagram")).toBe(false);
    expect(mediaSendBlocked("messenger", "messenger")).toBe(false);
    // canais fora da matriz mantêm o comportamento de antes
    expect(mediaSendBlocked("telegram", null)).toBe(false);
    expect(mediaSendBlocked("email", null)).toBe(false);
    expect(mediaSendBlocked("whatsapp", "meta")).toBe(false);
    expect(mediaSendBlocked(undefined)).toBe(false);
  });

  it("formats", () => {
    expect(formatTextCounter(812, textLimitFor("instagram")!)).toBe("812 / 1000 bytes");
    expect(formatTextCounter(1230, textLimitFor("messenger")!)).toBe("1.230 / 2000");
  });
});

describe("F2 reactions and uploads", () => {
  it("reaction emojis per channel", () => {
    expect(allowedReactionEmojis("instagram", "instagram")).toEqual(["❤️"]);
    expect(allowedReactionEmojis("messenger", "messenger")).toEqual([]);
    expect(allowedReactionEmojis("whatsapp", "bridge")).toBeNull();
    expect(allowedReactionEmojis("whatsapp", "meta")).toBeNull();
    expect(channelSupports("messenger", "messenger", "reactionsSend")).toBe(false);
    expect(channelSupports("instagram", "instagram", "reactionsSend")).toBe(true);
  });

  it("whatsapp is untouched", () => {
    expect(acceptedUploadMimes("whatsapp", "bridge")).toBeNull();
    expect(maxUploadBytes("whatsapp", "meta", "image/png")).toBeNull();
    expect(validateUpload("whatsapp", "bridge", { name: "a.gif", type: "image/gif", size: 99e6 })).toBeNull();
    expect(validateUpload(undefined, null, { name: "a", type: "x/y", size: 1e9 })).toBeNull();
  });

  it("instagram limits", () => {
    const MB = 1024 * 1024;
    expect(maxUploadBytes("instagram", "instagram", "image/jpeg")).toBe(8 * MB);
    expect(maxUploadBytes("instagram", "instagram", "video/mp4")).toBe(25 * MB);
    expect(acceptedUploadMimes("instagram", "instagram")).toContain("application/pdf");
    expect(validateUpload("instagram", "instagram", { name: "a.gif", type: "image/gif", size: 10 })).toMatch(/formato/);
    expect(validateUpload("instagram", "instagram", { name: "a.png", type: "image/png", size: 9 * MB })).toMatch(/8 MB/);
    expect(validateUpload("instagram", "instagram", { name: "a.mp4", type: "video/mp4", size: 20 * MB })).toBeNull();
  });

  it("messenger limits", () => {
    const MB = 1024 * 1024;
    expect(acceptedUploadMimes("messenger", "messenger")).toBeNull();
    expect(validateUpload("messenger", "messenger", { name: "a.zip", type: "application/zip", size: 24 * MB })).toBeNull();
    expect(validateUpload("messenger", "messenger", { name: "a.mp4", type: "video/mp4", size: 26 * MB })).toMatch(/25 MB/);
  });
});
