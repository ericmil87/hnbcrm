import { describe, expect, it } from "vitest";
import { CONTACT_TAB_PARAM, isContactTabInUrl } from "./contactTab";

describe("contactTab", () => {
  it("codec: padrão info sai da URL e valor inválido cai em info", () => {
    expect(CONTACT_TAB_PARAM.parse("leads")).toBe("leads");
    expect(CONTACT_TAB_PARAM.parse("x")).toBe("info");
    expect(CONTACT_TAB_PARAM.parse(null)).toBe("info");
    expect(CONTACT_TAB_PARAM.serialize("info")).toBeNull();
    expect(CONTACT_TAB_PARAM.serialize("groups")).toBe("groups");
  });

  it("a aba só vai para a URL quando ?contact= é este contato", () => {
    expect(isContactTabInUrl("c1", "c1")).toBe(true);
    expect(isContactTabInUrl(null, "c1")).toBe(false);
    expect(isContactTabInUrl("c2", "c1")).toBe(false);
  });
});
