import { describe, expect, it } from "vitest";
import { contactHref } from "./contactHref";
import { LEGAL_ENTITY } from "./legalEntity";

describe("contactHref", () => {
  it("usa o e-mail de contato do projeto com assunto pré-preenchido", () => {
    expect(contactHref("implantacao")).toBe(`mailto:${LEGAL_ENTITY.email}?subject=Implanta%C3%A7%C3%A3o%20HNBCRM`);
    expect(contactHref("empresa")).toBe(`mailto:${LEGAL_ENTITY.email}?subject=Plano%20Empresa`);
  });
  it("nunca leva ao cadastro", () => {
    expect(contactHref("empresa")).not.toContain("/entrar");
  });
});
