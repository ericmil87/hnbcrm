import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SubscriptionManagementView, type SubscriptionManagementViewProps } from "./SubscriptionManagementView";
import { BillingDetailsCardView, type BillingDetailsCardViewProps } from "./BillingDetailsCardView";
import { CheckoutModalView, type CheckoutModalViewProps } from "./CheckoutModalView";
import { InvoicesCardView } from "./InvoicesCard";
import { EMPTY_CHECKOUT_FORM, checkoutSummary } from "@/lib/checkoutForm";
import type { SubscriptionInfo } from "@/lib/subscriptionManagement";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const noop = () => {};

const sub = (o: Partial<SubscriptionInfo> = {}): SubscriptionInfo => ({
  billingCycle: "monthly",
  paymentStatus: "ok",
  hasSubscription: true,
  ...o,
});

function mgmt(over: Partial<SubscriptionManagementViewProps> = {}): SubscriptionManagementViewProps {
  return {
    sub: sub({ nextChargeBrl: 497, nextChargeAt: NOW + 20 * DAY }),
    mode: "active",
    canManage: true,
    now: NOW,
    refundAmountBrl: 497,
    busy: false,
    confirm: null,
    onAsk: noop,
    onCloseConfirm: noop,
    onConfirm: noop,
    onReactivate: noop,
    onUndoChange: noop,
    ...over,
  };
}

describe("SubscriptionManagementView", () => {
  it("próxima cobrança e link discreto de cancelar", () => {
    const onAsk = vi.fn();
    render(<SubscriptionManagementView {...mgmt({ onAsk })} />);
    expect(screen.getByText(/Próxima cobrança: R\$\s*497,00 em/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar assinatura" }));
    expect(onAsk).toHaveBeenCalledWith("cancel");
    expect(screen.queryByRole("button", { name: "Pedir reembolso" })).toBeNull();
  });

  it("cancelamento agendado: texto, Reativar e sem próxima cobrança", () => {
    const onReactivate = vi.fn();
    render(<SubscriptionManagementView {...mgmt({ sub: sub({ cancelAt: NOW + 5 * DAY, nextChargeBrl: 497, nextChargeAt: NOW + 5 * DAY }), onReactivate })} />);
    expect(screen.getByText(/Cancelamento agendado para .*Você usa o plano até lá/)).toBeTruthy();
    expect(screen.queryByText(/Próxima cobrança/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancelar assinatura" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reativar" }));
    expect(onReactivate).toHaveBeenCalled();
  });

  it("mudança agendada com Desfazer", () => {
    const onUndoChange = vi.fn();
    render(
      <SubscriptionManagementView
        {...mgmt({ sub: sub({ scheduledChange: { plan: "essencial", cycle: "monthly", effectiveAt: NOW + 9 * DAY } }), onUndoChange })}
      />,
    );
    expect(screen.getByText(/Muda para Essencial em/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Desfazer" }));
    expect(onUndoChange).toHaveBeenCalled();
  });

  it("reembolso só enquanto a janela está aberta", () => {
    const onAsk = vi.fn();
    const { rerender } = render(<SubscriptionManagementView {...mgmt({ sub: sub({ refundEligibleUntil: NOW + 3 * DAY }), onAsk })} />);
    fireEvent.click(screen.getByRole("button", { name: "Pedir reembolso" }));
    expect(onAsk).toHaveBeenCalledWith("refund");
    rerender(<SubscriptionManagementView {...mgmt({ sub: sub({ refundEligibleUntil: NOW - DAY }) })} />);
    expect(screen.queryByRole("button", { name: "Pedir reembolso" })).toBeNull();
  });

  it("com cancelamento agendado o reembolso continua disponível dentro da janela", () => {
    const onAsk = vi.fn();
    render(<SubscriptionManagementView {...mgmt({ sub: sub({ cancelAt: NOW + 5 * DAY, refundEligibleUntil: NOW + 2 * DAY }), onAsk })} />);
    expect(screen.getByRole("button", { name: "Reativar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancelar assinatura" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pedir reembolso" }));
    expect(onAsk).toHaveBeenCalledWith("refund");
  });

  it("sem settings:manage não há ações, só o texto", () => {
    render(<SubscriptionManagementView {...mgmt({ canManage: false, sub: sub({ nextChargeBrl: 497, nextChargeAt: NOW + DAY, refundEligibleUntil: NOW + DAY }) })} />);
    expect(screen.getByText(/Próxima cobrança/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("confirmação do cancelamento e do reembolso (ConfirmDialog)", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(<SubscriptionManagementView {...mgmt({ confirm: "cancel", onConfirm, sub: sub({ currentPeriodEnd: NOW + 9 * DAY }) })} />);
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/A assinatura não será renovada\. Você usa até .*; depois a conta fica em modo leitura e você pode exportar tudo\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar assinatura" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    rerender(<SubscriptionManagementView {...mgmt({ confirm: "refund", onConfirm, sub: sub({ refundEligibleUntil: NOW + DAY }) })} />);
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Reembolso integral de R\$\s*497,00 em até alguns dias, no mesmo meio de pagamento\. A conta passa para modo leitura agora\./)).toBeTruthy();
  });
});

describe("BillingDetailsCardView", () => {
  const base: BillingDetailsCardViewProps = {
    details: { billingName: "Acme Ltda", billingEmail: "fin@acme.com.br", document: "11222333000181" },
    canManage: true,
    editing: false,
    form: { billingName: "Acme Ltda", document: "11.222.333/0001-81", billingEmail: "fin@acme.com.br" },
    errors: {},
    showErrors: false,
    saving: false,
    serverError: null,
    onEdit: noop,
    onClose: noop,
    onChange: noop,
    onSave: noop,
  };

  it("mostra nome, e-mail e documento mascarado", () => {
    render(<BillingDetailsCardView {...base} />);
    expect(screen.getByText("Acme Ltda")).toBeTruthy();
    expect(screen.getByText("fin@acme.com.br")).toBeTruthy();
    expect(screen.getByText("••.•••.•••/••••-81")).toBeTruthy();
    expect(screen.queryByText(/11\.222\.333/)).toBeNull();
  });

  it("Editar só para quem gerencia; modal vem com os dados e salva", () => {
    const onEdit = vi.fn();
    const onSave = vi.fn();
    const { rerender } = render(<BillingDetailsCardView {...base} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(onEdit).toHaveBeenCalled();
    rerender(<BillingDetailsCardView {...base} editing onSave={onSave} />);
    expect((screen.getByLabelText("CPF ou CNPJ") as HTMLInputElement).value).toBe("11.222.333/0001-81");
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(onSave).toHaveBeenCalled();
    rerender(<BillingDetailsCardView {...base} canManage={false} />);
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
  });

  it("erro do servidor em alerta; campos faltando aparecem como não informado", () => {
    render(
      <BillingDetailsCardView
        {...base}
        details={{ billingName: null, billingEmail: null, document: null }}
        editing
        serverError="CPF ou CNPJ inválido. Confira os números e tente de novo."
      />,
    );
    expect(screen.getAllByText("Não informado").length).toBe(3);
    expect(screen.getByRole("alert").textContent).toContain("CPF ou CNPJ inválido");
  });
});

describe("CheckoutModalView em modo troca", () => {
  const form = { ...EMPTY_CHECKOUT_FORM, plan: "escala" as const };
  const props = (over: Partial<CheckoutModalViewProps> = {}): CheckoutModalViewProps => ({
    open: true,
    onClose: noop,
    form,
    onChange: noop,
    errors: {},
    showErrors: false,
    summary: checkoutSummary({ plan: "escala", cycle: "monthly", groupsAddon: false, now: 1 }),
    summaryLines: [],
    refusal: null,
    summaryFromServer: true,
    summaryLoading: false,
    submitting: false,
    serverError: null,
    notice: null,
    priceNote: null,
    invoiceUrl: null,
    created: false,
    onSubmit: noop,
    change: { currentPlan: "profissional", currentCycle: "monthly", effectiveAt: NOW + 9 * DAY },
    ...over,
  });

  it("sem campos de cobrança, plano atual desabilitado e upgrade/downgrade por plano", () => {
    render(<CheckoutModalView {...props()} />);
    expect(screen.getByRole("dialog").textContent).toContain("Trocar plano");
    expect(screen.queryByLabelText("CPF ou CNPJ")).toBeNull();
    expect((screen.getByLabelText(/Profissional/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByLabelText(/Escala/).closest("label")?.textContent).toContain("Upgrade");
    expect(screen.getByLabelText(/Essencial/).closest("label")?.textContent).toContain("Downgrade");
  });

  it("upgrade: paga hoje o valor cheio e o ciclo recomeça", () => {
    render(<CheckoutModalView {...props()} />);
    expect(screen.getByText(/Você paga R\$\s*997,00 hoje e o novo ciclo começa hoje\. Os dias restantes do plano atual não são devolvidos\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirmar e ir para o pagamento" })).toBeTruthy();
  });

  it("downgrade: vale na data e confirma a troca", () => {
    const onSubmit = vi.fn();
    render(<CheckoutModalView {...props({ form: { ...form, plan: "essencial" }, summary: checkoutSummary({ plan: "essencial", cycle: "monthly", groupsAddon: false, now: 1 }), onSubmit })} />);
    expect(screen.getByText(/Vale a partir de .*; até lá você continua no plano atual\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar troca" }));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("mesmo plano e ciclo não deixa confirmar", () => {
    render(<CheckoutModalView {...props({ form: { ...form, plan: "profissional" } })} />);
    expect(screen.getByRole("button", { name: /Confirmar/ }).hasAttribute("disabled")).toBe(true);
  });
});

describe("InvoicesCardView: cancelada e reembolsada", () => {
  it("status traduzido e nunca 'Ver fatura' para cancelada", () => {
    render(
      <InvoicesCardView
        invoices={[
          { id: "1", description: "Plano", amountCents: 49700, dueDate: NOW, status: "canceled", invoiceUrl: "https://www.asaas.com/i/1", nfseNumber: null, nfseUrl: null },
          { id: "2", description: "Plano", amountCents: 49700, dueDate: NOW - DAY, status: "refunded", invoiceUrl: "https://www.asaas.com/i/2", nfseNumber: null, nfseUrl: null },
        ]}
      />,
    );
    expect(screen.getByText("Cancelada")).toBeTruthy();
    expect(screen.getByText("Reembolsada")).toBeTruthy();
    const links = screen.getAllByRole("link", { name: "Ver fatura" });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://www.asaas.com/i/2");
  });
});
