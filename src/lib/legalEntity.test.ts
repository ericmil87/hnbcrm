import { describe, expect, it } from "vitest";
import { LEGAL_ENTITY, LEGAL_ENTITY_COMPLETE, legalIdentification } from "./legalEntity";

describe("legalEntity", () => {
  it("a flag de completo acompanha o preenchimento (falha em CI se divergirem)", () => {
    const filled = LEGAL_ENTITY.document.trim() !== "" && LEGAL_ENTITY.address.trim() !== "";
    // Com a flag true, CPF/CNPJ e endereço precisam estar preenchidos; com false, ainda vazios.
    expect(LEGAL_ENTITY_COMPLETE).toBe(filled);
  });

  it("contatos oficiais", () => {
    expect(LEGAL_ENTITY.email).toBe("contato@hnbcrm.com");
    expect(LEGAL_ENTITY.dpoEmail).toMatch(/^privacidade@/);
    expect(LEGAL_ENTITY.name).not.toBe("");
  });

  it("vazio vira incompleto; preenchido não", () => {
    expect(legalIdentification({ ...LEGAL_ENTITY, document: "", address: "Rua X, 1" }).incomplete).toBe(true);
    expect(legalIdentification({ ...LEGAL_ENTITY, document: "000", address: "" }).incomplete).toBe(true);
    expect(legalIdentification({ ...LEGAL_ENTITY, document: "000", address: "Rua X, 1" }).incomplete).toBe(false);
  });
});
