import { describe, expect, test } from "vitest";
import { addMonthsUtc, periodEndAfter } from "./billingPeriod";

const d = (y: number, m: number, day: number) => Date.UTC(y, m - 1, day);

describe("periodEndAfter", () => {
  test("mensal, anual e trimestral somam 1, 12 e 3 meses; ciclo ausente = mensal", () => {
    expect(periodEndAfter(d(2026, 11, 5), "monthly")).toBe(d(2026, 12, 5));
    expect(periodEndAfter(d(2026, 11, 5), "yearly")).toBe(d(2027, 11, 5));
    expect(periodEndAfter(d(2026, 11, 5), "quarterly")).toBe(d(2027, 2, 5));
    expect(periodEndAfter(d(2026, 11, 5), null)).toBe(d(2026, 12, 5));
  });
  test("dia 31 cai no último dia do mês curto e vira o ano", () => {
    expect(addMonthsUtc(d(2026, 1, 31), 1)).toBe(d(2026, 2, 28));
    expect(addMonthsUtc(d(2028, 1, 31), 1)).toBe(d(2028, 2, 29));
    expect(addMonthsUtc(d(2026, 12, 15), 1)).toBe(d(2027, 1, 15));
  });
});
