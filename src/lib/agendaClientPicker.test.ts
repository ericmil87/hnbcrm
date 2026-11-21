import { describe, expect, it } from "vitest";
import { formatClientPhone } from "./agendaClientPicker";

describe("formatClientPhone", () => {
  it("celular e fixo brasileiros", () => {
    expect(formatClientPhone("5511999991234")).toBe("+55 11 99999-1234");
    expect(formatClientPhone("551133334444")).toBe("+55 11 3333-4444");
  });
  it("aceita o + na frente e não mexe em número de fora", () => {
    expect(formatClientPhone("+5511999991234")).toBe("+55 11 99999-1234");
    expect(formatClientPhone("14155550123")).toBe("+14155550123");
  });
});
