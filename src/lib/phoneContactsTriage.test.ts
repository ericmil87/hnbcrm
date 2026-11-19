import { describe, expect, it } from "vitest";
import {
  buildImportPayload,
  buildTriageRows,
  chunk,
  countChoices,
  filterTriageRows,
  initialChoices,
  suggestsFamily,
} from "./phoneContactsTriage";
import type { VCardContact } from "./vcard";

const c = (partial: Partial<VCardContact>): VCardContact => ({ phones: [], emails: [], ...partial });
const tel = (value: string, types: string[] = []) => ({ value, types });

describe("suggestsFamily", () => {
  it("parentesco como palavra inteira, com ou sem acento", () => {
    expect(suggestsFamily("Mãe")).toBe(true);
    expect(suggestsFamily("Vó Maria")).toBe(true);
    expect(suggestsFamily("Irmã Carol")).toBe(true);
    expect(suggestsFamily("Amor da minha vida")).toBe(true);
    expect(suggestsFamily("Tia Neide (vizinha)")).toBe(true);
  });
  it("negócio e palavras parecidas não contam", () => {
    expect(suggestsFamily("Mãe Terra Restaurante")).toBe(false);
    expect(suggestsFamily("Pai Inácio Pousada")).toBe(false);
    expect(suggestsFamily("Paiva Contabilidade")).toBe(false);
    expect(suggestsFamily("Tiago")).toBe(false);
    expect(suggestsFamily(undefined)).toBe(false);
  });
  it("sobrenome do dono depois do primeiro nome", () => {
    expect(suggestsFamily("Carla Milfont", ["Milfont"])).toBe(true);
    expect(suggestsFamily("Milfont Seguros", ["Milfont"])).toBe(false); // sobrenome como 1º nome não conta
    expect(suggestsFamily("Ana Sá", ["Sá"])).toBe(false); // sobrenome curto demais é ignorado
  });
});

describe("buildTriageRows", () => {
  it("normaliza com o DDI da org, celular primeiro, e descarta quem não tem contato", () => {
    const result = buildTriageRows(
      [
        c({ fullName: "João da Silva", firstName: "João", lastName: "da Silva", phones: [tel("(81) 3222-1111", ["work"]), tel("81 98888-7777", ["cell"])] }),
        c({ fullName: "Sem número" }),
        c({ fullName: "Número quebrado", phones: [tel("123")] }),
      ],
      "55",
    );
    expect(result.total).toBe(3);
    expect(result.withoutContact).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      displayName: "João da Silva",
      firstName: "João",
      lastName: "da Silva",
      phones: ["5581988887777", "558132221111"],
      familyHint: false,
    });
  });

  it("junta repetidos do arquivo pelo 9º dígito e pelo e-mail", () => {
    const result = buildTriageRows(
      [
        c({ fullName: "Bia", phones: [tel("81 97777-6666")] }),
        c({ fullName: "Beatriz Trabalho", phones: [tel("+55 81 7777-6666")], emails: [tel("bia@ex.com")] }),
        c({ emails: [tel("BIA@ex.com")], org: "Empresa da Bia" }),
        c({ fullName: "Outra", phones: [tel("81 95555-4444")] }),
      ],
      "55",
    );
    expect(result.merged).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      displayName: "Bia",
      phones: ["5581977776666"],
      emails: ["bia@ex.com"],
      company: "Empresa da Bia",
    });
  });

  it("nome a partir do FN, da empresa ou do telefone", () => {
    const { rows } = buildTriageRows(
      [
        c({ fullName: "Ana Paula Moreira", phones: [tel("11912345678")] }),
        c({ org: "Distribuidora X", phones: [tel("11923456789")] }),
        c({ phones: [tel("11934567890")] }),
      ],
      "55",
    );
    expect(rows[0]).toMatchObject({ firstName: "Ana", lastName: "Paula Moreira" });
    expect(rows[1]).toMatchObject({ displayName: "Distribuidora X", firstName: "Distribuidora X" });
    expect(rows[2].displayName).toBe("+55 (11) 93456-7890");
  });

  it("DDI padrão de outro país", () => {
    const { rows } = buildTriageRows([c({ fullName: "John", phones: [tel("(212) 555-1234")] })], "1");
    expect(rows[0].phones).toEqual(["12125551234"]);
  });

  it("sugere Pessoal para parentes e o sobrenome do dono", () => {
    const { rows } = buildTriageRows(
      [
        c({ fullName: "Mãe", phones: [tel("81999990001")] }),
        c({ fullName: "Kenji Kawano Filho", phones: [tel("81999990002")] }),
        c({ fullName: "Cliente Novo", phones: [tel("81999990003")] }),
      ],
      "55",
      ["Kawano"],
    );
    expect(rows.map((r) => r.familyHint)).toEqual([true, true, false]);
    expect(initialChoices(rows)).toEqual({ [rows[0].key]: "personal", [rows[1].key]: "personal" });
  });

  it("aguenta milhares de contatos", () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      c({ fullName: `Contato ${i}`, phones: [tel(`8198${String(i).padStart(7, "0")}`)] }),
    );
    const { rows } = buildTriageRows(many, "55");
    expect(rows).toHaveLength(5000);
  });
});

describe("busca, escolhas e envio", () => {
  const { rows } = buildTriageRows(
    [
      c({ fullName: "Maria Souza", phones: [tel("81988881111")], org: "Loja da Maria" }),
      c({ fullName: "Pedro", emails: [tel("pedro@ex.com")] }),
      c({ fullName: "Mãe", phones: [tel("81988883333")] }),
    ],
    "55",
  );

  it("filtra por nome sem acento, empresa, e-mail e dígitos", () => {
    expect(filterTriageRows(rows, "mae").map((r) => r.displayName)).toEqual(["Mãe"]);
    expect(filterTriageRows(rows, "loja").map((r) => r.displayName)).toEqual(["Maria Souza"]);
    expect(filterTriageRows(rows, "pedro@").map((r) => r.displayName)).toEqual(["Pedro"]);
    expect(filterTriageRows(rows, "8888-1111").map((r) => r.displayName)).toEqual(["Maria Souza"]);
    expect(filterTriageRows(rows, "")).toHaveLength(3);
  });

  it("envio só com as linhas escolhidas (minimização)", () => {
    const choices = { [rows[0].key]: "lead" as const, [rows[1].key]: "skip" as const };
    const payload = buildImportPayload(rows, choices);
    expect(payload).toEqual([
      { firstName: "Maria", lastName: "Souza", phones: ["5581988881111"], emails: [], company: "Loja da Maria", choice: "lead" },
    ]);
    expect(countChoices(rows, choices)).toMatchObject({ lead: 1, skip: 1, pending: 1 });
  });

  it("chunk", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
