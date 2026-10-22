import { describe, expect, it } from "vitest";
import { Facebook, Instagram, MessageCircle } from "lucide-react";
import { channelBadgeVariant, channelIcon, channelLabel } from "./channelAccounts";

describe("channelAccounts", () => {
  it("maps channels to lucide icons", () => {
    expect(channelIcon("whatsapp")).toBe(MessageCircle);
    expect(channelIcon("instagram", "instagram")).toBe(Instagram);
    expect(channelIcon("messenger", "messenger")).toBe(Facebook);
    expect(channelIcon("telegram")).toBe(MessageCircle);
  });

  it("labels channels, falling back to the raw value", () => {
    expect(channelLabel("whatsapp")).toBe("WhatsApp");
    expect(channelLabel("instagram")).toBe("Instagram");
    expect(channelLabel("messenger")).toBe("Messenger");
    expect(channelLabel("outro")).toBe("outro");
  });

  it("keeps the previous badge variants", () => {
    expect(channelBadgeVariant("whatsapp")).toBe("success");
    expect(channelBadgeVariant("telegram")).toBe("info");
    expect(channelBadgeVariant("email")).toBe("brand");
    expect(channelBadgeVariant("webchat")).toBe("default");
    expect(channelBadgeVariant("instagram")).toBe("brand");
  });
});
