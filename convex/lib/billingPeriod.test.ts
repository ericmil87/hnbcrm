import { describe, expect, test } from "vitest";
import { addMonthsUtc, formatDueDay, lastPaidSubscriptionInvoice, nextPaidPeriod, periodEndAfter, resolvePeriod } from "./billingPeriod";

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

describe("nextPaidPeriod", () => {
  const now = d(2026, 11, 10);
  const start = d(2026, 11, 1);
  test("sem fim gravado: início agora e fim = nextDue (comportamento antigo)", () => {
    expect(nextPaidPeriod({ nextDue: d(2026, 12, 5), now })).toEqual({ currentPeriodStart: now, currentPeriodEnd: d(2026, 12, 5) });
    expect(nextPaidPeriod({ now })).toEqual({ currentPeriodStart: now });
  });
  test("fim anda para frente: início vira agora", () => {
    expect(nextPaidPeriod({ currentStart: start, currentEnd: d(2026, 12, 5), nextDue: d(2027, 1, 5), now })).toEqual({
      currentPeriodStart: now,
      currentPeriodEnd: d(2027, 1, 5),
    });
  });
  test("fim anterior ao atual não recua e mantém o início", () => {
    expect(nextPaidPeriod({ currentStart: start, currentEnd: d(2027, 1, 5), nextDue: d(2026, 12, 5), now })).toEqual({
      currentPeriodStart: start,
      currentPeriodEnd: d(2027, 1, 5),
    });
  });
  test("fim igual ao atual não mexe no início (não é estritamente maior)", () => {
    expect(nextPaidPeriod({ currentStart: start, currentEnd: d(2026, 12, 5), nextDue: d(2026, 12, 5), now })).toEqual({
      currentPeriodStart: start,
      currentPeriodEnd: d(2026, 12, 5),
    });
  });
  test("sem nextDue com fim gravado: nada anda", () => {
    expect(nextPaidPeriod({ currentStart: start, currentEnd: d(2026, 12, 5), now })).toEqual({ currentPeriodStart: start, currentPeriodEnd: d(2026, 12, 5) });
    expect(nextPaidPeriod({ currentEnd: d(2026, 12, 5), now })).toEqual({ currentPeriodEnd: d(2026, 12, 5) });
  });
});

describe("formatDueDay", () => {
  test("meia-noite UTC mostra o mesmo dia (não o anterior, como em Brasília)", () => {
    expect(formatDueDay(d(2026, 12, 14))).toBe("14/12/2026");
    expect(formatDueDay(d(2027, 1, 1))).toBe("01/01/2027");
  });
});
