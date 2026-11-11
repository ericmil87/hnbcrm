import { describe, expect, it } from "vitest";
import { parseCommunityUrl } from "./communityLink";

describe("parseCommunityUrl", () => {
  it("aceita só https", () => {
    expect(parseCommunityUrl("https://chat.whatsapp.com/abc123")).toBe("https://chat.whatsapp.com/abc123");
    expect(parseCommunityUrl("  https://exemplo.com/grupo  ")).toBe("https://exemplo.com/grupo");
  });

  it("recusa vazio, ausente, http e esquemas perigosos", () => {
    expect(parseCommunityUrl(undefined)).toBeNull();
    expect(parseCommunityUrl("")).toBeNull();
    expect(parseCommunityUrl("   ")).toBeNull();
    expect(parseCommunityUrl("http://exemplo.com")).toBeNull();
    expect(parseCommunityUrl("javascript:alert(1)")).toBeNull();
    expect(parseCommunityUrl("não é link")).toBeNull();
  });
});
