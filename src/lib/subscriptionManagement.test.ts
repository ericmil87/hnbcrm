import { describe, expect, it } from "vitest";
import {
  canCancelSubscription,
  canReactivateSubscription,
  canRequestRefund,
  firstPaidAmountBrl,
  cancelConfirmText,
  cancelScheduledText,
  changeKindLabel,
  changeNotice,
  maskDocument,
  nextChargeText,
  planChangeKind,
  planMonthlyForCycle,
  refundConfirmText,
  scheduledChangeText,
  type SubscriptionInfo,
} from "./subscriptionManagement";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const sub = (o: Partial<SubscriptionInfo> = {}): SubscriptionInfo => ({
  billingCycle: "monthly",
  paymentStatus: "ok",
  hasSubscription: true,
  ...o,
});

describe("textos da assinatura", () => {
  it("próxima cobrança", () => {
    const t = nextChargeText(sub({ nextChargeBrl: 497, nextChargeAt: NOW + 20 * DAY }));
    expect(t).toMatch(/^Próxima cobrança: R\$\s*497,00 em \d{2}\/\d{2}\/\d{4}$/);
    expect(nextChargeText(sub())).toBeNull();
    expect(nextChargeText(null)).toBeNull();
    expect(nextChargeText(sub({ nextChargeBrl: 1, nextChargeAt: NOW, cancelAt: NOW + DAY }))).toBeNull();
    expect(nextChargeText(sub({ hasSubscription: false, nextChargeBrl: 1, nextChargeAt: NOW }))).toBeNull();
  });
  it("cancelamento agendado e mudança agendada", () => {
    expect(cancelScheduledText(sub({ cancelAt: NOW + DAY }))).toMatch(/^Cancelamento agendado para .*Você usa o plano até lá\.$/);
    expect(cancelScheduledText(sub())).toBeNull();
    expect(scheduledChangeText(sub({ scheduledChange: { plan: "essencial", cycle: "monthly", effectiveAt: NOW + DAY } }))).toMatch(
      /^Muda para Essencial em \d{2}\/\d{2}\/\d{4}\.$/,
    );
    expect(scheduledChangeText(sub())).toBeNull();
  });
  it("confirmações", () => {
    expect(cancelConfirmText(NOW + DAY, null)).toMatch(/não será renovada\. Você usa até \d{2}\/\d{2}\/\d{4}; depois a conta fica em modo leitura e você pode exportar tudo\./);
    expect(cancelConfirmText(null, null)).toContain("até o fim do período pago");
    expect(refundConfirmText(497)).toMatch(/Reembolso integral de R\$\s*497,00 em até alguns dias, no mesmo meio de pagamento\. A conta passa para modo leitura agora\./);
    expect(refundConfirmText(null)).toContain("Reembolso integral em até");
  });
});

describe("quando mostrar cada ação", () => {
  it("cancelar: ativo ou em atraso, sem cancelamento, e quem gerencia", () => {
    expect(canCancelSubscription({ mode: "active", sub: sub(), canManage: true })).toBe(true);
    expect(canCancelSubscription({ mode: "past_due", sub: sub(), canManage: true })).toBe(true);
    expect(canCancelSubscription({ mode: "active", sub: sub(), canManage: false })).toBe(false);
    expect(canCancelSubscription({ mode: "trial", sub: sub(), canManage: true })).toBe(false);
    expect(canCancelSubscription({ mode: "active", sub: sub({ cancelAt: NOW + DAY }), canManage: true })).toBe(false);
    expect(canCancelSubscription({ mode: "active", sub: sub({ hasSubscription: false }), canManage: true })).toBe(false);
  });
  it("reativar: só com cancelamento agendado no futuro", () => {
    expect(canReactivateSubscription({ sub: sub({ cancelAt: NOW + DAY }), canManage: true, now: NOW })).toBe(true);
    expect(canReactivateSubscription({ sub: sub({ cancelAt: NOW - DAY }), canManage: true, now: NOW })).toBe(false);
    expect(canReactivateSubscription({ sub: sub(), canManage: true, now: NOW })).toBe(false);
    expect(canReactivateSubscription({ sub: sub({ cancelAt: NOW + DAY }), canManage: false, now: NOW })).toBe(false);
    expect(canReactivateSubscription({ sub: sub({ cancelAt: NOW + DAY, hasSubscription: false }), canManage: true, now: NOW })).toBe(false);
  });
  it("reembolso: só enquanto a janela está aberta", () => {
    expect(canRequestRefund({ sub: sub({ refundEligibleUntil: NOW + DAY }), canManage: true, now: NOW })).toBe(true);
    expect(canRequestRefund({ sub: sub({ refundEligibleUntil: NOW }), canManage: true, now: NOW })).toBe(false);
    expect(canRequestRefund({ sub: sub(), canManage: true, now: NOW })).toBe(false);
    expect(canRequestRefund({ sub: sub({ refundEligibleUntil: NOW + DAY }), canManage: false, now: NOW })).toBe(false);
  });
});

describe("troca de plano", () => {
  const cur = { plan: "profissional" as const, cycle: "monthly" as const };
  it("plano mais caro é upgrade, mais barato é downgrade", () => {
    expect(planChangeKind(cur, { plan: "escala", cycle: "monthly" })).toBe("upgrade");
    expect(planChangeKind(cur, { plan: "essencial", cycle: "monthly" })).toBe("downgrade");
  });
  it("mesmo plano: ciclo mais longo é upgrade, mais curto é downgrade, igual é o atual", () => {
    expect(planChangeKind(cur, { plan: "profissional", cycle: "yearly" })).toBe("upgrade");
    expect(planChangeKind({ plan: "profissional", cycle: "yearly" }, { plan: "profissional", cycle: "monthly" })).toBe("downgrade");
    expect(planChangeKind(cur, cur)).toBe("same");
    expect(changeKindLabel("same")).toBe("Plano atual");
  });
  it("texto do upgrade e do downgrade", () => {
    expect(changeNotice("upgrade", { chargeBrl: 997, effectiveAt: null })).toMatch(
      /Você paga R\$\s*997,00 hoje e o novo ciclo começa hoje\. Os dias restantes do plano atual não são devolvidos\./,
    );
    expect(changeNotice("downgrade", { chargeBrl: null, effectiveAt: NOW + DAY })).toMatch(
      /Vale a partir de \d{2}\/\d{2}\/\d{4}; até lá você continua no plano atual\./,
    );
    expect(changeNotice("downgrade", { chargeBrl: null, effectiveAt: null })).toContain("na próxima renovação");
    expect(changeNotice("same", { chargeBrl: 1, effectiveAt: 1 })).toBeNull();
  });
  it("mensalidade por ciclo vem do catálogo", () => {
    expect(planMonthlyForCycle("essencial", "monthly")).toBe(197);
    expect(planMonthlyForCycle("essencial", "yearly")).toBe(164);
  });
});

describe("documento mascarado", () => {
  it("CPF, CNPJ e entradas estranhas", () => {
    expect(maskDocument("529.982.247-25")).toBe("•••.•••.•••-25");
    expect(maskDocument("11222333000181")).toBe("••.•••.•••/••••-81");
    expect(maskDocument("1234")).toBe("•••34");
    expect(maskDocument("")).toBeNull();
    expect(maskDocument(null)).toBeNull();
  });
});

describe("valor do reembolso", () => {
  it("1ª fatura paga (menor paidAt), ignorando pendentes", () => {
    const inv = (status: string, paidAt: number | null, amountCents: number) => ({ status, paidAt, amountCents });
    expect(firstPaidAmountBrl([inv("paid", 20, 29600), inv("paid", 10, 19700), inv("pending", null, 1)])).toBe(197);
    expect(firstPaidAmountBrl([inv("pending", null, 1)])).toBeNull();
    expect(firstPaidAmountBrl(undefined)).toBeNull();
  });
});
