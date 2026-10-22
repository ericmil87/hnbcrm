import { describe, expect, it } from "vitest";
import { Facebook, Instagram, MessageCircle } from "lucide-react";
import {
  accountBadgeLabel,
  accountFullLabel,
  accountChipOptions,
  channelBadgeVariant,
  channelIcon,
  channelLabel,
  parseStoredInboxFilter,
  sanitizeInboxFilter,
  shouldShowAccount,
  showChannelChip,
  viaLabel,
} from "./channelAccounts";

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

const acc = (
  id: string,
  channel: "whatsapp" | "instagram" | "messenger",
  label: string,
  handle: string | null = null
) => ({
  _id: id,
  channel,
  transport: channel === "whatsapp" ? ("meta" as const) : channel,
  label,
  handle,
  avatarUrl: null,
  status: "active" as const,
  authState: null,
});

describe("account labels and visibility", () => {
  it("labels accounts", () => {
    expect(accountBadgeLabel(acc("1", "instagram", "Casa Lumiar", "casalumiar"))).toBe("@casalumiar");
    expect(accountBadgeLabel(acc("1", "instagram", "Casa Lumiar", "@casalumiar"))).toBe("@casalumiar");
    expect(accountBadgeLabel(acc("2", "messenger", "Casa Lumiar"))).toBe("Casa Lumiar");
    expect(accountBadgeLabel(acc("3", "whatsapp", "Loja", "+55 11 99999-5729"))).toBe("Loja");
    expect(accountBadgeLabel(acc("3", "whatsapp", "", "+55 11 99999-5729"))).toBe("WhatsApp ····5729");
    expect(accountBadgeLabel(acc("4", "whatsapp", "Loja Centro"))).toBe("Loja Centro");
    expect(accountBadgeLabel(null)).toBe("");
  });

  it("shows the account only with 2+ accounts in the channel or 2+ channels", () => {
    expect(shouldShowAccount([acc("1", "whatsapp", "A")], "whatsapp")).toBe(false);
    expect(shouldShowAccount([acc("1", "whatsapp", "A"), acc("2", "whatsapp", "B")], "whatsapp")).toBe(true);
    expect(shouldShowAccount([acc("1", "whatsapp", "A"), acc("2", "instagram", "B")], "whatsapp")).toBe(true);
    expect(shouldShowAccount([], "whatsapp")).toBe(false);
  });

  it("builds chip visibility and options", () => {
    const one = [acc("1", "whatsapp", "A")];
    const two = [acc("1", "whatsapp", "A"), acc("2", "whatsapp", "B")];
    const mix = [...two, acc("3", "instagram", "C")];
    expect(showChannelChip(one)).toBe(false);
    expect(showChannelChip(two)).toBe(false);
    expect(showChannelChip(mix)).toBe(true);
    expect(accountChipOptions(one, null)).toEqual([]);
    expect(accountChipOptions(two, null)).toHaveLength(2);
    expect(accountChipOptions(mix, "instagram")).toEqual([]);
    expect(accountChipOptions(mix, "whatsapp")).toHaveLength(2);
    expect(accountChipOptions(mix, null)).toHaveLength(3);
  });

  it("sanitizes stored filters", () => {
    const mix = [acc("1", "whatsapp", "A"), acc("2", "whatsapp", "B"), acc("3", "instagram", "C")];
    expect(sanitizeInboxFilter(mix, { channel: "telegram", configId: "9" })).toEqual({ channel: null, configId: null });
    expect(sanitizeInboxFilter(mix, { channel: "whatsapp", configId: "3" })).toEqual({ channel: "whatsapp", configId: null });
    expect(sanitizeInboxFilter(mix, { channel: null, configId: "2" })).toEqual({ channel: null, configId: "2" });
  });

  it("parses stored filters defensively", () => {
    expect(parseStoredInboxFilter(null)).toEqual({ channel: null, configId: null });
    expect(parseStoredInboxFilter("{bad")).toEqual({ channel: null, configId: null });
    expect(parseStoredInboxFilter('{"channel":"instagram","configId":"x"}')).toEqual({ channel: "instagram", configId: "x" });
  });

  it("full label adds the handle on Instagram", () => {
    expect(accountFullLabel(acc("1", "instagram", "Casa Lumiar", "casalumiar"))).toBe("Casa Lumiar (@casalumiar)");
    expect(accountFullLabel(acc("2", "messenger", "Casa Lumiar"))).toBe("Casa Lumiar");
    expect(accountFullLabel(null)).toBe("");
  });

  it("via label", () => {
    expect(viaLabel("instagram")).toBe("via Instagram");
  });
});
