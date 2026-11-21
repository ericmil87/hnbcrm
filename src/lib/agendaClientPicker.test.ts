import { describe, expect, it } from "vitest";
import { formatPhone } from "@/components/campaigns/campaignUtils";
import { formatClientPhone } from "./agendaClientPicker";

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
