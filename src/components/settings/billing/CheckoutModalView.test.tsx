import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CheckoutModalView, type CheckoutModalViewProps } from "./CheckoutModalView";
import { InvoicesCardView } from "./InvoicesCard";
import { EMPTY_CHECKOUT_FORM, checkoutSummary, validateCheckoutForm } from "@/lib/checkoutForm";

const form = { ...EMPTY_CHECKOUT_FORM };

function props(over: Partial<CheckoutModalViewProps> = {}): CheckoutModalViewProps {
  return {
    open: true,
    onClose: () => {},
    form,
    onChange: () => {},
    errors: validateCheckoutForm(form),
    showErrors: false,
    summary: checkoutSummary({ plan: form.plan, cycle: form.cycle, groupsAddon: false, now: 1 }),
    summaryLines: [],
    refusal: null,
    summaryFromServer: false,
    summaryLoading: false,
    submitting: false,
    serverError: null,
    notice: null,
    priceNote: null,
    invoiceUrl: null,
    created: false,
    onSubmit: () => {},
    ...over,
  };
}

describe("CheckoutModalView", () => {
  it("planos do catálogo, Empresa com contato e nota do Asaas", () => {
    render(<CheckoutModalView {...props()} />);
    expect(screen.getByLabelText(/Essencial/).closest("label")?.textContent).toMatch(/R\$\s*197\/mês/);
    expect(screen.getByLabelText(/Profissional/).closest("label")?.textContent).toMatch(/R\$\s*497\/mês/);
    expect(screen.getByLabelText(/Escala/).closest("label")?.textContent).toMatch(/R\$\s*997\/mês/);
    expect(screen.queryByLabelText(/Empresa/)).toBeNull();
    expect(screen.getByText("fale com a gente").getAttribute("href")).toBe("mailto:contato@hnbcrm.com");
    expect(screen.getByText(/Pix, boleto ou cartão na página segura do Asaas/)).toBeTruthy();
    expect(screen.getByText(/INOVAWAY LTDA/)).toBeTruthy();
  });

  it("add-on Grupos só aparece no Essencial", () => {
    const { rerender } = render(<CheckoutModalView {...props()} />);
    expect(screen.queryByText(/Add-on Grupos/)).toBeNull();
    rerender(<CheckoutModalView {...props({ form: { ...form, plan: "essencial" } })} />);
    expect(screen.getByText(/Add-on Grupos/)).toBeTruthy();
  });

  it("escolher plano e ciclo dispara onChange", () => {
    const onChange = vi.fn();
    render(<CheckoutModalView {...props({ onChange })} />);
    fireEvent.click(screen.getByLabelText(/Escala/));
    expect(onChange).toHaveBeenCalledWith({ plan: "escala" });
    fireEvent.click(screen.getByRole("radio", { name: /Anual/ }));
    expect(onChange).toHaveBeenCalledWith({ cycle: "yearly" });
  });

  it("CPF/CNPJ chega com máscara no onChange", () => {
    const onChange = vi.fn();
    render(<CheckoutModalView {...props({ onChange })} />);
    fireEvent.change(screen.getByLabelText("CPF ou CNPJ"), { target: { value: "52998224725" } });
    expect(onChange).toHaveBeenCalledWith({ document: "529.982.247-25" });
  });

  it("erros só depois da primeira tentativa; erro do servidor em alerta", () => {
    const { rerender } = render(<CheckoutModalView {...props()} />);
    expect(screen.queryByText(/CPF ou CNPJ inválido/)).toBeNull();
    rerender(<CheckoutModalView {...props({ showErrors: true, serverError: "A assinatura online ainda não está disponível." })} />);
    expect(screen.getByText(/CPF ou CNPJ inválido/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("ainda não está disponível");
  });

  it("o valor do resumo vem da prop (servidor), não do catálogo local", () => {
    const fromServer = { monthlyBrl: 345, listMonthlyBrl: 497, chargeBrl: 345, yearly: null, lockApplied: true };
    render(<CheckoutModalView {...props({ summary: fromServer, summaryFromServer: true })} />);
    expect(screen.getByText(/R\$\s*345/)).toBeTruthy();
    expect(screen.getByText("Valor calculado pelo servidor.")).toBeTruthy();
    expect(screen.getByText(/Preço combinado aplicado \(tabela: R\$\s*497/)).toBeTruthy();
  });

  it("linhas do servidor no resumo e recusa trava o envio", () => {
    const { rerender } = render(
      <CheckoutModalView
        {...props({
          summaryFromServer: true,
          summaryLines: [
            { id: "plan", label: "Plano Essencial", amountBrl: 197 },
            { id: "extra_channels", label: "Canais extras", amountBrl: 158 },
          ],
        })}
      />,
    );
    expect(screen.getByText("Canais extras")).toBeTruthy();
    expect(screen.getByText(/R\$\s*158\/mês/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ir para o pagamento" }).hasAttribute("disabled")).toBe(false);
    rerender(<CheckoutModalView {...props({ summary: null, refusal: "Sua conta já tem um plano ativo." })} />);
    expect(screen.getByText("Sua conta já tem um plano ativo.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ir para o pagamento" }).hasAttribute("disabled")).toBe(true);
  });

  it("enquanto consulta o servidor mostra Calculando…", () => {
    render(<CheckoutModalView {...props({ summaryLoading: true })} />);
    expect(screen.getByText("Calculando…")).toBeTruthy();
  });

  it("anual mostra o resumo com 2 meses grátis; enviar chama onSubmit", () => {
    const onSubmit = vi.fn();
    render(
      <CheckoutModalView
        {...props({
          form: { ...form, cycle: "yearly" },
          summary: checkoutSummary({ plan: "profissional", cycle: "yearly", groupsAddon: false, now: 1 }),
          onSubmit,
        })}
      />,
    );
    expect(screen.getByText(/paga 10 meses e usa 12 \(2 grátis\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ir para o pagamento" }));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("pagamento em processamento aparece como aviso (status), não como erro", () => {
    render(<CheckoutModalView {...props({ notice: "Recebemos um pagamento e ele está sendo processado; aguarde alguns minutos." })} />);
    expect(screen.getByRole("status").textContent).toContain("está sendo processado");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("fatura criada com preço especial mostra a nota", () => {
    render(<CheckoutModalView {...props({ created: true, invoiceUrl: null, priceNote: "Preço especial da sua conta aplicado nesta fatura." })} />);
    expect(screen.getByText(/Preço especial da sua conta/)).toBeTruthy();
  });

  it("nota fiscal em nome do fornecedor do cadastro", () => {
    render(<CheckoutModalView {...props()} />);
    expect(screen.getByText(/nota fiscal sai em nome da INOVAWAY LTDA/)).toBeTruthy();
  });

  it("depois de criada: link clicável da fatura", () => {
    render(<CheckoutModalView {...props({ created: true, invoiceUrl: "https://www.asaas.com/i/abc" })} />);
    const a = screen.getByRole("link", { name: /Abrir fatura/ });
    expect(a.getAttribute("href")).toBe("https://www.asaas.com/i/abc");
    expect(a.getAttribute("target")).toBe("_blank");
  });
});

describe("InvoicesCardView", () => {
  it("vazio e carregando", () => {
    const { rerender } = render(<InvoicesCardView invoices={[]} />);
    expect(screen.getByText("Nenhuma fatura ainda.")).toBeTruthy();
    rerender(<InvoicesCardView invoices={undefined} />);
    expect(screen.getByText("Carregando…")).toBeTruthy();
  });

  it("lista com status traduzido e links", () => {
    render(
      <InvoicesCardView
        invoices={[
          { id: "1", description: "Plano Profissional", amountCents: 49700, dueDate: Date.UTC(2026, 10, 20, 12), status: "paid", invoiceUrl: "https://a/1", nfseNumber: "123", nfseUrl: "https://a/n" },
          { id: "2", description: "Plano Profissional", amountCents: 49700, dueDate: Date.UTC(2026, 11, 20, 12), status: "overdue", invoiceUrl: null, nfseNumber: null, nfseUrl: null },
        ]}
      />,
    );
    expect(screen.getByText("Paga")).toBeTruthy();
    expect(screen.getByText("Em atraso")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ver fatura" }).getAttribute("href")).toBe("https://a/1");
    expect(screen.getByRole("link", { name: /Nota fiscal 123/ }).getAttribute("href")).toBe("https://a/n");
    expect(screen.getAllByText(/R\$\s*497,00/).length).toBe(2);
  });
});
