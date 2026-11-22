import { describe, expect, it } from "vitest";
import { formatPhone } from "@/components/campaigns/campaignUtils";
import { clientCandidateName, clientCandidateSub, formatClientPhone } from "./agendaClientPicker";
import { joinContactName } from "./contactName";

describe("formatClientPhone", () => {
  it("celular e fixo brasileiros", () => {
    expect(formatClientPhone("5511999991234")).toBe("+55 11 99999-1234");
    expect(formatClientPhone("551133334444")).toBe("+55 11 3333-4444");
    expect(formatClientPhone("14155550123")).toBe("+14155550123");
  });
  it("é idêntica a formatPhone de campaignUtils (cópia só para não criar chunk compartilhado)", () => {
    for (const phone of ["5511999991234", "551133334444", "14155550123", "+5511999991234", "", "55", "5599"]) {
      expect(formatClientPhone(phone)).toBe(formatPhone(phone));
    }
  });
});

describe("nome e telefone do contato na busca de cliente", () => {
  it("nome = firstName + lastName, igual ao joinContactName do resto do app", () => {
    const cases: Array<{ firstName?: string | null; lastName?: string | null }> = [
      { firstName: "Teste", lastName: "Agenda Maria" },
      { firstName: "Tati" },
      { firstName: "  Ana  ", lastName: " Lima " },
      { firstName: null, lastName: "Souza" },
      {},
    ];
    for (const c of cases) expect(clientCandidateName(c)).toBe(joinContactName(c.firstName, c.lastName));
    expect(clientCandidateName(cases[0])).toBe("Teste Agenda Maria");
    expect(clientCandidateName({})).toBe("");
  });
  it("linha de baixo: telefone, senão WhatsApp, senão e-mail", () => {
    expect(clientCandidateSub({ phone: "5511999991234" })).toBe("+55 11 99999-1234");
    expect(clientCandidateSub({ phone: "+5511999991234" })).toBe("+55 11 99999-1234");
    expect(clientCandidateSub({ whatsappNumber: "551133334444", email: "a@example.com" })).toBe("+55 11 3333-4444");
    expect(clientCandidateSub({ email: "a@example.com" })).toBe("a@example.com");
    expect(clientCandidateSub({})).toBe("");
  });
});
