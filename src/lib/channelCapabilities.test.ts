import { describe, expect, it } from "vitest";
import {
  channelSupports,
  deliveryTicksMode,
  formatTextCounter,
  textLimitFor,
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
    expect(channelSupports("instagram", "instagram", "reactionsSend")).toBe(false);
    expect(channelSupports("instagram", "instagram", "reactionsReceive")).toBe(true);
    expect(channelSupports("instagram", "instagram", "replyQuote")).toBe(true);
    expect(channelSupports("messenger", "messenger", "replyQuote")).toBe(false);
    expect(channelSupports("messenger", "messenger", "forward")).toBe(true);
    for (const c of ["instagram", "messenger"]) {
      expect(channelSupports(c, c, "voiceRecorder")).toBe(false);
      expect(channelSupports(c, c, "templates")).toBe(false);
      expect(channelSupports(c, c, "newConversation")).toBe(false);
      expect(channelSupports(c, c, "serviceWindow")).toBe(true);
      expect(channelSupports(c, c, "aiAttendant")).toBe(true);
      expect(channelSupports(c, c, "typingIndicator")).toBe(false);
    }
  });
});

describe("text counter", () => {
  it("limits", () => {
    expect(textLimitFor("whatsapp", "meta")).toBeNull();
    expect(textLimitFor("instagram", "instagram")).toEqual({ unit: "bytes", max: 1000 });
    expect(textLimitFor("messenger", "messenger")).toEqual({ unit: "chars", max: 2000 });
  });

  it("counts bytes for instagram and parts above the limit", () => {
    const ig = textLimitFor("instagram")!;
    expect(textPartsCount("a".repeat(1000), ig)).toBe(1);
    expect(textPartsCount("a".repeat(1001), ig)).toBe(2);
    expect(textPartsCount("ã".repeat(501), ig)).toBe(2);
    expect(textPartsCount("", ig)).toBe(1);
  });

  it("formats", () => {
    expect(formatTextCounter(812, textLimitFor("instagram")!)).toBe("812 / 1000 bytes");
    expect(formatTextCounter(1230, textLimitFor("messenger")!)).toBe("1.230 / 2000");
  });
});
