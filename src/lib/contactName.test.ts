import { describe, expect, it } from "vitest";
import {
  contactNameUpdate,
  joinContactName,
  shouldSyncLeadTitle,
  splitFullName,
} from "./contactName";

describe("splitFullName", () => {
  it("separa a primeira palavra do resto", () => {
    expect(splitFullName("Ana Paula Souza")).toEqual({ firstName: "Ana", lastName: "Paula Souza" });
  });
  it("uma palavra só = sobrenome vazio", () => {
    expect(splitFullName("Rejane")).toEqual({ firstName: "Rejane", lastName: "" });
  });
  it("normaliza espaços", () => {
    expect(splitFullName("  Ana   Souza  ")).toEqual({ firstName: "Ana", lastName: "Souza" });
  });
  it("vazio = vazio", () => {
    expect(splitFullName("   ")).toEqual({ firstName: "", lastName: "" });
  });
});

describe("joinContactName", () => {
  it("junta e apara", () => {
    expect(joinContactName("Ana", undefined)).toBe("Ana");
    expect(joinContactName(undefined, undefined)).toBe("");
    expect(joinContactName("Ana", "Souza")).toBe("Ana Souza");
  });
});

describe("shouldSyncLeadTitle", () => {
  it("título = telefone cru", () => {
    expect(shouldSyncLeadTitle("15517868409", "15517868409", "")).toBe(true);
    expect(shouldSyncLeadTitle("+55 11 99999-0000", undefined, "")).toBe(true);
  });
  it("título vazio ou 'Sem nome'", () => {
    expect(shouldSyncLeadTitle("", "1", "")).toBe(true);
    expect(shouldSyncLeadTitle(undefined, null, null)).toBe(true);
    expect(shouldSyncLeadTitle("Sem nome", null, null)).toBe(true);
  });
  it("título igual ao nome antigo (sem diferenciar caixa)", () => {
    expect(shouldSyncLeadTitle("ana souza", null, "Ana Souza")).toBe(true);
  });
  it("título escrito pela equipe não é tocado", () => {
    expect(shouldSyncLeadTitle("Retiro de março", "15517868409", "Ana")).toBe(false);
    expect(shouldSyncLeadTitle("Ana - pacote 2", "15517868409", "Ana")).toBe(false);
  });
  it("número curto não conta como telefone", () => {
    expect(shouldSyncLeadTitle("2026", null, "")).toBe(false);
  });
  it("título com texto em volta do telefone do contato", () => {
    expect(shouldSyncLeadTitle("WhatsApp 5585999999999", "5585999999999", "")).toBe(true);
    expect(shouldSyncLeadTitle("+55 85 9999-9999 (cliente)", "558599999999", "")).toBe(true);
  });
  it("título com letras que não contém o telefone continua protegido", () => {
    expect(shouldSyncLeadTitle("Retiro de março — Ana", "5585999999999", "")).toBe(false);
    expect(shouldSyncLeadTitle("WhatsApp 5511888887777", "5585999999999", "")).toBe(false);
  });
  it("aceita lista de telefones", () => {
    expect(shouldSyncLeadTitle("5511999990000", [undefined, "5511999990000"], "")).toBe(true);
  });
});

describe("contactNameUpdate", () => {
  it("nome completo", () => {
    expect(contactNameUpdate("Ana Souza", {})).toEqual({ firstName: "Ana", lastName: "Souza" });
  });
  it("uma palavra sem sobrenome antes não manda lastName", () => {
    expect(contactNameUpdate("Ana", {})).toEqual({ firstName: "Ana" });
  });
  it("uma palavra com sobrenome antes limpa o sobrenome", () => {
    expect(contactNameUpdate("Ana", { lastName: "Souza" })).toEqual({ firstName: "Ana", lastName: "" });
  });
  it("vazio = null (nunca salva vazio)", () => {
    expect(contactNameUpdate("  ", { firstName: "Ana" })).toBeNull();
  });
});
