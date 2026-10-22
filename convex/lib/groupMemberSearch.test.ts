import { describe, expect, test } from "vitest";
import {
  memberMatchesSearch,
  normalizeSearchText,
  participantSearchName,
  phonePrefixVariants,
  phoneSearchDigits,
} from "./groupMemberSearch";

describe("groupMemberSearch", () => {
  test("normaliza acento e caixa", () => {
    expect(normalizeSearchText("  João ÁVILA ")).toBe("joao avila");
    expect(participantSearchName(undefined)).toBeUndefined();
    expect(participantSearchName("   ")).toBeUndefined();
    expect(participantSearchName("Conceição")).toBe("conceicao");
  });

  test("termo com cara de telefone", () => {
    expect(phoneSearchDigits("(85) 9 8139-2929")).toBe("85981392929");
    expect(phoneSearchDigits("Ana 85")).toBeNull();
    expect(phoneSearchDigits("--")).toBeNull();
  });

  test("variantes de prefixo: DDI e 9º dígito BR", () => {
    expect(phonePrefixVariants("859813")).toEqual(["859813", "55859813", "5585813"]);
    expect(phonePrefixVariants("558581")).toEqual(["558581", "5585981", "55558581"]);
    // Antes de chegar ao dígito depois do DDD, sem variante do 9.
    expect(phonePrefixVariants("85")).toEqual(["85", "5585"]);
  });

  test("casamento no cliente: nome contém, telefone por prefixo com variantes", () => {
    const joao = { name: "João Silva", phone: "558181392929" };
    expect(memberMatchesSearch(joao, "joao")).toBe(true);
    expect(memberMatchesSearch(joao, "silv")).toBe(true);
    expect(memberMatchesSearch(joao, "81 98139")).toBe(true);
    expect(memberMatchesSearch(joao, "maria")).toBe(false);
    expect(memberMatchesSearch(joao, "")).toBe(true);
  });
});
