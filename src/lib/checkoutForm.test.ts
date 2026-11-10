import { describe, expect, it } from "vitest";
import {
  EMPTY_CHECKOUT_FORM,
  canStartCheckout,
  checkoutButtonLabel,
  checkoutSummary,
  formatCpfCnpj,
  invoiceStatusLabel,
  isCheckoutReady,
  isPaymentProcessingMessage,
  priceSourceNote,
  summaryFromPreview,
  paymentNotice,
  toCheckoutArgs,
  validateCheckoutForm,
  type CheckoutForm,
} from "./checkoutForm";

const CPF = "529.982.247-25";
const CNPJ = "11.222.333/0001-81";
const ok: CheckoutForm = {
  ...EMPTY_CHECKOUT_FORM,
  billingName: "Acme Ltda",
  document: CPF,
  billingEmail: "financeiro@acme.com.br",
};

describe("máscara de CPF/CNPJ", () => {
  it("CPF até 11 dígitos", () => {
    expect(formatCpfCnpj("52998224725")).toBe("529.982.247-25");
    expect(formatCpfCnpj("5299")).toBe("529.9");
    expect(formatCpfCnpj("529.982")).toBe("529.982");
  });
  it("CNPJ com 12 a 14 dígitos, sem passar de 14", () => {
    expect(formatCpfCnpj("11222333000181")).toBe(CNPJ);
    expect(formatCpfCnpj("11222333000181999")).toBe(CNPJ);
    expect(formatCpfCnpj("112223330001")).toBe("11.222.333/0001");
  });
  it("ignora letras", () => {
    expect(formatCpfCnpj("abc")).toBe("");
  });
});

describe("validação do formulário", () => {
  it("completo é válido; vazio acusa nome, documento e e-mail", () => {
    expect(validateCheckoutForm(ok)).toEqual({});
    expect(isCheckoutReady(ok)).toBe(true);
    expect(Object.keys(validateCheckoutForm(EMPTY_CHECKOUT_FORM)).sort()).toEqual(["billingEmail", "billingName", "document"]);
  });
  it("CPF e CNPJ por dígitos verificadores", () => {
    expect(validateCheckoutForm({ ...ok, document: CNPJ }).document).toBeUndefined();
    expect(validateCheckoutForm({ ...ok, document: "529.982.247-26" }).document).toContain("inválido");
    expect(validateCheckoutForm({ ...ok, document: "111.111.111-11" }).document).toContain("inválido");
    expect(validateCheckoutForm({ ...ok, document: "123" }).document).toContain("inválido");
  });
  it("e-mail e nome", () => {
    expect(validateCheckoutForm({ ...ok, billingEmail: "toni" }).billingEmail).toBeTruthy();
    expect(validateCheckoutForm({ ...ok, billingName: " a " }).billingName).toBeTruthy();
  });
  it("add-on Grupos só no Essencial", () => {
    expect(validateCheckoutForm({ ...ok, plan: "profissional", groupsAddon: true }).groupsAddon).toBeTruthy();
    expect(validateCheckoutForm({ ...ok, plan: "essencial", groupsAddon: true }).groupsAddon).toBeUndefined();
  });
});

describe("argumentos do startCheckout", () => {
  it("documento só com dígitos, e-mail em minúsculas, add-on só no Essencial", () => {
    const a = toCheckoutArgs({ ...ok, billingEmail: " Fin@Acme.com.br ", plan: "essencial", groupsAddon: true });
    expect(a).toEqual({
      plan: "essencial",
      cycle: "monthly",
      groupsAddon: true,
      billingName: "Acme Ltda",
      document: "52998224725",
      billingEmail: "fin@acme.com.br",
    });
    expect(toCheckoutArgs({ ...ok, plan: "profissional", groupsAddon: true }).groupsAddon).toBeUndefined();
  });
});

describe("resumo do valor pelo catálogo", () => {
  const now = 1_000;
  it("mensal e anual (2 meses grátis)", () => {
    const m = checkoutSummary({ plan: "profissional", cycle: "monthly", groupsAddon: false, now });
    expect(m).toMatchObject({ monthlyBrl: 497, chargeBrl: 497, yearly: null });
    const y = checkoutSummary({ plan: "profissional", cycle: "yearly", groupsAddon: false, now });
    expect(y).toMatchObject({ monthlyBrl: 497, chargeBrl: 4970, yearly: { paidMonths: 10, freeMonths: 2 } });
  });
  it("add-on Grupos soma 99 no Essencial e é ignorado nos outros", () => {
    expect(checkoutSummary({ plan: "essencial", cycle: "monthly", groupsAddon: true, now })?.monthlyBrl).toBe(296);
    expect(checkoutSummary({ plan: "escala", cycle: "monthly", groupsAddon: true, now })?.monthlyBrl).toBe(997);
  });
  it("preço combinado vence a tabela", () => {
    const s = checkoutSummary({ plan: "essencial", cycle: "monthly", groupsAddon: false, priceLock: { kind: "founder", discountPct: 30 }, now });
    expect(s?.monthlyBrl).toBeCloseTo(137.9, 5);
    expect(s?.listMonthlyBrl).toBe(197);
    expect(s?.lockApplied).toBe(true);
  });
});

describe("recusa em processamento e origem do preço", () => {
  it("pagamento em processamento é aviso", () => {
    expect(isPaymentProcessingMessage("Recebemos um pagamento e ele está sendo processado; aguarde alguns minutos.")).toBe(true);
    expect(isPaymentProcessingMessage("CPF ou CNPJ inválido.")).toBe(false);
  });
  it("preço especial só quando veio da trava", () => {
    expect(priceSourceNote("price_lock")).toBe("Preço especial da sua conta aplicado nesta fatura.");
    expect(priceSourceNote("table")).toBeNull();
    expect(priceSourceNote(undefined)).toBeNull();
  });
});

describe("prévia do servidor", () => {
  const lines = [{ id: "plan", label: "Plano Profissional", amountBrl: 497 }];
  it("mensal", () => {
    const r = summaryFromPreview({ chargeBrl: 497, listBrl: 497, monthlyBrl: 497, priceSource: "table", lines, cycleMonths: 1 });
    expect(r.summary).toEqual({ monthlyBrl: 497, listMonthlyBrl: 497, chargeBrl: 497, yearly: null, lockApplied: false });
    expect(r.lines).toEqual(lines);
    expect(r.refusal).toBeNull();
  });
  it("anual com preço combinado: lista do ciclo vira lista mensal", () => {
    const r = summaryFromPreview({ chargeBrl: 3479, listBrl: 4970, monthlyBrl: 347.9, priceSource: "price_lock", lines, cycleMonths: 10 });
    expect(r.summary?.listMonthlyBrl).toBe(497);
    expect(r.summary?.yearly).toEqual({ paidMonths: 10, freeMonths: 2 });
    expect(r.summary?.lockApplied).toBe(true);
  });
  it("recusa vira aviso e some o valor", () => {
    const r = summaryFromPreview({ chargeBrl: null, listBrl: null, monthlyBrl: null, priceSource: null, lines: [], cycleMonths: 1, refusal: "Sua conta já tem um plano ativo." });
    expect(r).toEqual({ summary: null, lines: [], refusal: "Sua conta já tem um plano ativo." });
  });
});

describe("estados e rótulos", () => {
  it("quem abre o checkout", () => {
    expect(canStartCheckout("trial")).toBe(true);
    expect(canStartCheckout("read_only")).toBe(true);
    expect(canStartCheckout("canceled")).toBe(true);
    expect(canStartCheckout("active")).toBe(false);
    expect(canStartCheckout("past_due")).toBe(false);
  });
  it("botão", () => {
    expect(checkoutButtonLabel(false)).toBe("Assinar plano");
    expect(checkoutButtonLabel(true)).toBe("Trocar plano");
  });
  it("status de fatura traduzido", () => {
    expect(invoiceStatusLabel("paid")).toBe("Paga");
    expect(invoiceStatusLabel("pending")).toBe("Aguardando pagamento");
    expect(invoiceStatusLabel("overdue")).toBe("Em atraso");
  });
  it("aviso do pagamento da assinatura", () => {
    expect(paymentNotice({ paymentStatus: "pending", hasSubscription: true })?.text).toContain("Aguardando o pagamento da 1ª fatura");
    expect(paymentNotice({ paymentStatus: "overdue", hasSubscription: true })?.tone).toBe("error");
    expect(paymentNotice({ paymentStatus: "ok", hasSubscription: true })).toBeNull();
    expect(paymentNotice(undefined)).toBeNull();
  });
});
