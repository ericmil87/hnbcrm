import { describe, expect, test } from "vitest";
import { addMonthsUtc, lastPaidSubscriptionInvoice, periodEndAfter, resolvePeriod } from "./billingPeriod";

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

describe("resolvePeriod", () => {
  const inv = (dueDate: number, extra: Partial<{ status: string; kind: string; providerSubscriptionId: string; amountCents: number }> = {}) => ({
    kind: "subscription", status: "paid", dueDate, amountCents: 49700, ...extra,
  });
  test("fim gravado vale; ausente, calcula da última fatura paga + 1 ciclo (e o início é o vencimento)", () => {
    const invoices = [inv(d(2026, 11, 10)), inv(d(2026, 12, 10), { amountCents: 59700 }), inv(d(2027, 1, 10), { status: "pending" })];
    expect(resolvePeriod({ cycle: "monthly", invoices, subscriptionIds: ["sub_1"] })).toMatchObject({ periodStart: d(2026, 12, 10), periodEnd: d(2027, 1, 10) });
    expect(resolvePeriod({ currentPeriodEnd: d(2027, 3, 1), cycle: "monthly", invoices, subscriptionIds: ["sub_1"] }).periodEnd).toBe(d(2027, 3, 1));
    expect(resolvePeriod({ cycle: "monthly", invoices: [], subscriptionIds: ["sub_1"] })).toEqual({ periodStart: null, periodEnd: null, lastPaid: null });
  });
  test("ignora fatura de outra assinatura e de outro tipo; aceita a sem id", () => {
    const invoices = [inv(d(2026, 12, 10), { providerSubscriptionId: "sub_old" }), inv(d(2026, 11, 10)), inv(d(2027, 1, 10), { kind: "overage" })];
    expect(lastPaidSubscriptionInvoice(invoices, ["sub_new"])?.dueDate).toBe(d(2026, 11, 10));
    expect(lastPaidSubscriptionInvoice(invoices, ["sub_old", "sub_new"])?.dueDate).toBe(d(2026, 12, 10));
  });
});
