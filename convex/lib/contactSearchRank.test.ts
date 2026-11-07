import { describe, expect, it } from "vitest";
import { contactFallbackName, matchesIdentity, phoneLikeDigits, rankContacts } from "./contactSearchRank";

describe("phoneLikeDigits", () => {
  it("aceita telefone com pontuação e 8+ dígitos", () => {
    expect(phoneLikeDigits("11 99999-8888")).toBe("11999998888");
    expect(phoneLikeDigits("+55 (81) 99988-7766")).toBe("5581999887766");
  });
  it("recusa texto e números curtos", () => {
    expect(phoneLikeDigits("Maura 1199")).toBeNull();
    expect(phoneLikeDigits("1234-567")).toBeNull();
  });
});

describe("matchesIdentity", () => {
  it("nome por prefixo, sem acento nem caixa", () => {
    expect(matchesIdentity({ firstName: "Joana", lastName: "Simões" }, "simo")).toBe(true);
    expect(matchesIdentity({ firstName: "Joana" }, "jo si")).toBe(false);
  });
  it("telefone por dígitos contidos", () => {
    expect(matchesIdentity({ phone: "5511987651234" }, "8765")).toBe(true);
  });
  it("cidade/bio não contam", () => {
    expect(matchesIdentity({ firstName: "Pedro", company: "Acme" }, "recife")).toBe(false);
  });
});

describe("rankContacts", () => {
  it("telefone exato, depois identidade, depois o resto, sem repetir", () => {
    const a = { _id: "a" };
    const b = { _id: "b" };
    const c = { _id: "c" };
    const out = rankContacts([c], [a, b, c], (x) => x._id === "b");
    expect(out.map((x) => x._id)).toEqual(["c", "b", "a"]);
  });
});

describe("contactFallbackName", () => {
  it("@ do Instagram, senão título do lead", () => {
    expect(contactFallbackName({ instagramUsername: "@maura.s" }, "Lead X")).toBe("@maura.s");
    expect(contactFallbackName({}, " Lead X ")).toBe("Lead X");
    expect(contactFallbackName({}, undefined)).toBeNull();
  });
});
