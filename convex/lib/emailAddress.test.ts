import { describe, expect, it } from "vitest";
import { maskEmailForDisplay } from "./emailAddress";

describe("maskEmailForDisplay", () => {
  it("mostra duas letras de cada ponta da parte local", () => {
    expect(maskEmailForDisplay("bugueiroteste@milfont.net")).toBe("bu…te@milfont.net");
  });
  it("local curta mostra só a primeira letra", () => {
    expect(maskEmailForDisplay("ana@exemplo.com.br")).toBe("a…@exemplo.com.br");
    expect(maskEmailForDisplay("joao@exemplo.com.br")).toBe("j…@exemplo.com.br");
  });
  it("normaliza caixa e espaços; inválido vira vazio", () => {
    expect(maskEmailForDisplay("  MariaSilva@Loja.com ")).toBe("ma…va@loja.com");
    expect(maskEmailForDisplay("sem-arroba")).toBe("");
    expect(maskEmailForDisplay(undefined)).toBe("");
    expect(maskEmailForDisplay("")).toBe("");
  });
  it("nunca devolve o endereço inteiro", () => {
    expect(maskEmailForDisplay("fulano.silva@dominio.com")).not.toContain("fulano.silva");
  });
});
