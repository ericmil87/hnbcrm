import { describe, expect, test } from "vitest";
import { checkRefund, firstPaidInvoice, REFUND_WINDOW_MS, type RefundInvoiceLite } from "./refund";

const T0 = Date.UTC(2026, 10, 1, 12);
const inv = (id: string, extra: Partial<RefundInvoiceLite> = {}): RefundInvoiceLite => ({
  _id: id,
  status: "paid",
  paidAt: T0,
  providerPaymentId: `pay_${id}`,
  kind: "subscription",
  ...extra,
});
const base = { orgStatus: "active", hasProviderSubscription: true };

describe("firstPaidInvoice", () => {
  test("a mais antiga por paidAt; ignora abertas, canceladas e outros tipos", () => {
    const first = firstPaidInvoice([
      inv("b", { paidAt: T0 + 5 }),
      inv("a"),
      inv("c", { status: "pending" }),
      inv("d", { paidAt: T0 - 10, kind: "overage" }),
      inv("e", { paidAt: T0 - 20, status: "canceled" }),
    ]);
    expect(first?._id).toBe("a");
  });
  test("sem pagamento: null", () => {
    expect(firstPaidInvoice([inv("c", { status: "pending", paidAt: undefined })])).toBeNull();
  });
});

describe("checkRefund", () => {
  test("dentro de 168 h: elegível, com prazo", () => {
    const r = checkRefund({ ...base, invoices: [inv("a")], now: T0 + REFUND_WINDOW_MS });
    expect(r).toMatchObject({ eligible: true, until: T0 + REFUND_WINDOW_MS });
  });
  test("1 ms depois: expirado", () => {
    expect(checkRefund({ ...base, invoices: [inv("a")], now: T0 + REFUND_WINDOW_MS + 1 })).toEqual({ eligible: false, reason: "expired" });
  });
  test("segundo pagamento não é elegível (só o primeiro)", () => {
    const invoices = [inv("a", { paidAt: T0 - 40 * 86_400_000 }), inv("b")];
    expect(checkRefund({ ...base, invoices, candidateId: "b", now: T0 + 1 })).toEqual({ eligible: false, reason: "not_first" });
    expect(checkRefund({ ...base, invoices, now: T0 + 1 })).toEqual({ eligible: false, reason: "expired" });
  });
  test("já reembolsada, sem pagamento ou org fora de active/past_due", () => {
    expect(checkRefund({ ...base, invoices: [inv("a")], refundedAt: T0, now: T0 })).toEqual({ eligible: false, reason: "already_refunded" });
    expect(checkRefund({ ...base, invoices: [], now: T0 })).toEqual({ eligible: false, reason: "no_payment" });
    expect(checkRefund({ ...base, orgStatus: "canceled", invoices: [inv("a")], now: T0 })).toEqual({ eligible: false, reason: "not_active" });
    expect(checkRefund({ ...base, hasProviderSubscription: false, invoices: [inv("a")], now: T0 })).toEqual({ eligible: false, reason: "not_active" });
  });
});
