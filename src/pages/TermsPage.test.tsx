import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router";
import { TermsPage } from "./TermsPage";
import { PrivacyPage } from "./PrivacyPage";

function text(ui: React.ReactElement): string {
  const { container } = render(
    <HelmetProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </HelmetProvider>,
  );
  return container.textContent ?? "";
}

describe("TermsPage", () => {
  const t = text(<TermsPage />);

  it("sem beta gratuito nem licença MIT", () => {
    expect(t).not.toContain("Beta Aberto");
    expect(t).not.toContain("Beta");
    expect(t).not.toContain("licença MIT");
    expect(t).not.toContain("código aberto");
  });

  it("traz as cláusulas obrigatórias", () => {
    for (const needle of [
      "Eric Milfont de Oliveira",
      "contato@hnbcrm.com",
      "10 de novembro de 2026",
      "Atendimento IA",
      "O excedente só é cobrado se você o ligar",
      "30 dias do plano Profissional",
      "um teste por pessoa",
      "20 primeiros novos pagantes",
      "IPCA",
      "aviso de 30 dias",
      "modo só leitura",
      "Nunca apagamos dados",
      "continuam sendo gravadas",
      "sem multa",
      "fim do período já pago",
      "Reembolso de 7 dias",
      "suboperadores",
      "Canal WhatsApp não oficial",
      "aceite ativo",
      "foro",
    ]) {
      expect(t, needle).toContain(needle);
    }
  });

  it("franquias vêm do catálogo", () => {
    expect(t).toMatch(/Essencial: R\$\s*197 por mês, 1 canal, 300 atendimentos IA/);
    expect(t).toMatch(/Empresa: a partir de R\$\s*1\.490 mais R\$\s*390 por unidade/);
  });

  it("identificação incompleta aparece como em atualização", () => {
    expect(t).toContain("CPF/CNPJ e endereço: em atualização");
  });
});

describe("PrivacyPage", () => {
  const t = text(<PrivacyPage />);
  it("pagamento, contato comercial, retenção e encarregado", () => {
    for (const needle of ["Asaas", "legítimo interesse", "90 dias", "Encarregado", "privacidade@hnbcrm.com"]) {
      expect(t, needle).toContain(needle);
    }
  });
});
