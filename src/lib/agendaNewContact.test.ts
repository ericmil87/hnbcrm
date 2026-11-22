import { describe, expect, it } from "vitest";
import { newContactArgs, newContactErrors, NEW_CONTACT_COPY, prefillNewContact } from "./agendaNewContact";

describe("agendaNewContact", () => {
  it("nome é obrigatório; telefone é opcional", () => {
    expect(newContactErrors({ name: "  ", phone: "" })).toEqual({ name: NEW_CONTACT_COPY.errors.name });
    expect(newContactErrors({ name: "Maria", phone: "" })).toEqual({});
    expect(newContactErrors({ name: "x".repeat(81), phone: "" }).name).toBe(NEW_CONTACT_COPY.errors.nameLong);
  });
  it("telefone preenchido passa pela validação do servidor", () => {
    expect(newContactErrors({ name: "Maria", phone: "(11) 99999-1234" })).toEqual({});
    expect(newContactErrors({ name: "Maria", phone: "123" }).phone).toBe(NEW_CONTACT_COPY.errors.phone);
    expect(newContactErrors({ name: "Maria", phone: "abc" }).phone).toBe(NEW_CONTACT_COPY.errors.phone);
  });
  it("grava como o WhatsApp: E.164 sem '+', DDI padrão da organização", () => {
    expect(newContactArgs({ name: "Maria", phone: "(11) 99999-1234" })).toEqual({ firstName: "Maria", phone: "5511999991234" });
    expect(newContactArgs({ name: "Maria", phone: "+1 212 555 1234" }, "55").phone).toBe("12125551234");
    expect(newContactArgs({ name: "Maria", phone: "212 555 1234" }, "1").phone).toBe("12125551234");
  });
  it("separa nome e sobrenome e não manda telefone vazio", () => {
    expect(newContactArgs({ name: "  Maria   de  Souza ", phone: " " })).toEqual({ firstName: "Maria", lastName: "de Souza" });
  });
  it("preenche a partir da busca", () => {
    expect(prefillNewContact(" Maria ")).toEqual({ name: "Maria", phone: "" });
    expect(prefillNewContact("(11) 99999-1234")).toEqual({ name: "", phone: "(11) 99999-1234" });
    expect(prefillNewContact("")).toEqual({ name: "", phone: "" });
  });
});
