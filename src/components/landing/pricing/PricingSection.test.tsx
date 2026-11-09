import { describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { PricingSection } from "./PricingSection";

const plan = (name: string) => screen.getByRole("article", { name });

describe("PricingSection", () => {
  it("mostra os 4 planos com os precos do catalogo", () => {
    renderWithRouter(<PricingSection />);
    expect(within(plan("Essencial")).getByText(/R\$\s*197/)).toBeTruthy();
    expect(within(plan("Profissional")).getByText(/R\$\s*497/)).toBeTruthy();
    expect(within(plan("Escala")).getByText(/R\$\s*997/)).toBeTruthy();
    expect(within(plan("Empresa")).getByText(/R\$\s*1\.490/)).toBeTruthy();
    expect(within(plan("Empresa")).getByText(/R\$\s*390 por unidade/)).toBeTruthy();
  });

  it("Mais escolhido so no Profissional", () => {
    renderWithRouter(<PricingSection />);
    expect(screen.getAllByText("Mais escolhido")).toHaveLength(1);
    expect(within(plan("Profissional")).getByText("Mais escolhido")).toBeTruthy();
  });

  it("toggle anual mostra 164 / 414 / 831 e Empresa por contrato", () => {
    renderWithRouter(<PricingSection />);
    fireEvent.click(screen.getByRole("radio", { name: /Anual/ }));
    expect(within(plan("Essencial")).getByText(/R\$\s*164/)).toBeTruthy();
    expect(within(plan("Profissional")).getByText(/R\$\s*414/)).toBeTruthy();
    expect(within(plan("Escala")).getByText(/R\$\s*831/)).toBeTruthy();
    expect(within(plan("Empresa")).getByText("Contrato anual ou trimestral")).toBeTruthy();
  });

  it("CTA de teste sem cartao e sem texto do beta antigo", () => {
    const { container } = renderWithRouter(<PricingSection />);
    expect(screen.getAllByRole("button", { name: "Testar 30 dias grátis" }).length).toBeGreaterThanOrEqual(3);
    expect(within(plan("Empresa")).getByRole("button", { name: "Falar com a gente" })).toBeTruthy();
    const text = container.textContent ?? "";
    for (const banned of ["Beta", "Grátis no Beta", "R$ 97", "R$ 297", "Starter", "Enterprise", "Começar Grátis"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("tem os blocos de transparencia, avulsos e FAQ", () => {
    renderWithRouter(<PricingSection />);
    expect(screen.getByText("O que não cobramos")).toBeTruthy();
    expect(screen.getByText("Terceiros sem margem")).toBeTruthy();
    expect(screen.getByText(/Add-on Grupos/)).toBeTruthy();
    expect(screen.getByText("O que é um atendimento IA?")).toBeTruthy();
  });
});
