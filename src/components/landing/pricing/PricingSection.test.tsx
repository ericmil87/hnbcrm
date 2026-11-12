import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePlanKey } from "@/lib/authEntry";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { PricingSection } from "./PricingSection";

const page = <PricingSection variant="page" />;
const plan = (name: string) => screen.getByRole("article", { name });
const planWrapper = (key: string) => document.querySelector(`[data-plan="${key}"]`) as HTMLElement;

function stubMedia(matches: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((q: string) => ({
    matches,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

describe("PricingSection", () => {
  it("variant section nao traz servicos, definicoes nem FAQ (ids unicos na landing)", () => {
    renderWithRouter(<PricingSection />);
    expect(screen.queryByRole("region", { name: "Quer que a gente monte junto?" })).toBeNull();
    expect(screen.queryByText("Perguntas sobre preço")).toBeNull();
    expect(screen.queryByText("O que conta e o que não conta")).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(4);
  });

  it("Falar com a gente (Empresa e servicos) abre o formulario, nunca o cadastro", () => {
    renderWithRouter(page);
    const emp = within(plan("Empresa")).getByRole("button", { name: "Falar com a gente" });
    expect(emp.closest("a")).toBeNull();
    const block = screen.getByRole("region", { name: "Quer que a gente monte junto?" });
    for (const name of ["Falar com a gente", "Pedir orçamento"]) {
      expect(within(block).getByRole("button", { name }).closest("a")).toBeNull();
    }
  });

  it("mostra os 4 planos com os precos do catalogo", () => {
    renderWithRouter(page);
    expect(within(plan("Essencial")).getByText(/R\$\s*197/)).toBeTruthy();
    expect(within(plan("Profissional")).getByText(/R\$\s*497/)).toBeTruthy();
    expect(within(plan("Escala")).getByText(/R\$\s*997/)).toBeTruthy();
    expect(within(plan("Empresa")).getByText(/R\$\s*1\.490/)).toBeTruthy();
    expect(within(plan("Empresa")).getByText(/R\$\s*390 por unidade/)).toBeTruthy();
  });

  it("cartoes falam em pessoas atendidas pela IA", () => {
    renderWithRouter(page);
    expect(within(plan("Essencial")).getByText("300 pessoas atendidas pela IA por mês")).toBeTruthy();
    expect(within(plan("Profissional")).getByText("1.000 pessoas atendidas pela IA por mês")).toBeTruthy();
    expect(within(plan("Escala")).getByText("2.500 pessoas atendidas pela IA por mês")).toBeTruthy();
  });

  it("Mais escolhido so no Profissional, dentro do cartao", () => {
    renderWithRouter(page);
    expect(screen.getAllByText("Mais escolhido")).toHaveLength(1);
    expect(within(plan("Profissional")).getByText("Mais escolhido")).toBeTruthy();
  });

  it("toggle anual mostra 164 / 414 / 831 e Empresa por contrato", () => {
    renderWithRouter(page);
    fireEvent.click(screen.getByRole("radio", { name: "Anual · 2 meses grátis" }));
    expect(within(plan("Essencial")).getByText(/R\$\s*164/)).toBeTruthy();
    expect(within(plan("Profissional")).getByText(/R\$\s*414/)).toBeTruthy();
    expect(within(plan("Escala")).getByText(/R\$\s*831/)).toBeTruthy();
    expect(within(plan("Empresa")).getByText("Contrato anual ou trimestral")).toBeTruthy();
    expect(screen.getByText(/No anual você paga 10 meses e usa 12/)).toBeTruthy();
  });

  it("CTA de teste sem cartao leva o plano e nao ha texto do beta antigo", () => {
    const { container } = renderWithRouter(page);
    expect(screen.getAllByRole("button", { name: "Testar 30 dias grátis" }).length).toBeGreaterThanOrEqual(3);
    expect(within(plan("Empresa")).getByRole("button", { name: "Falar com a gente" })).toBeTruthy();
    const hrefs = within(plan("Escala")).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/comecar?plano=escala");
    const text = container.textContent ?? "";
    for (const banned of ["Beta", "Grátis no Beta", "R$ 97", "R$ 297", "Starter", "Enterprise", "Começar Grátis"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("clicar no botão de um plano chega a /comecar com ?plano= que a rota consegue ler", () => {
    const { router } = renderWithRouter(page);
    fireEvent.click(within(plan("Escala")).getAllByRole("link")[0]);
    expect(router.state.location.pathname).toBe("/comecar");
    expect(parsePlanKey(new URLSearchParams(router.state.location.search).get("plano"))).toBe("escala");
  });

  it("faixa da unidade com o exemplo de 20 vezes", () => {
    renderWithRouter(page);
    expect(screen.getAllByText("O mesmo cliente falando 20 vezes conta 1.").length).toBeGreaterThan(0);
  });

  it("avulsos citam o teto de canais extras por plano", () => {
    renderWithRouter(page);
    expect(screen.getAllByText(/Essencial: até 2 extras\. Profissional: até 3\./).length).toBeGreaterThan(0);
  });

  it("tem os blocos de transparencia, avulsos e FAQ", () => {
    renderWithRouter(page);
    expect(screen.getByText("O que não cobramos")).toBeTruthy();
    expect(screen.getByText("Terceiros, sem margem nossa")).toBeTruthy();
    expect(screen.getByText("Quando a franquia acaba")).toBeTruthy();
    expect(screen.getByText(/Add-on Grupos/)).toBeTruthy();
    expect(screen.getByText("O que é uma pessoa atendida pela IA?")).toBeTruthy();
    expect(screen.getByText("Perguntas sobre preço")).toBeTruthy();
  });

  describe("seletor de plano no celular", () => {
    let restore: () => void = () => {};
    beforeEach(() => {
      restore = stubMedia(true);
    });
    afterEach(() => restore());

    it("abas com role tablist, Profissional abre selecionada e um cartao visivel por vez", () => {
      renderWithRouter(page);
      const tablist = screen.getByRole("tablist", { name: "Escolha um plano para ver os detalhes" });
      const tabs = within(tablist).getAllByRole("tab");
      expect(tabs.map((t) => t.textContent)).toEqual(["Essencial", "Profissional", "Escala", "Empresa"]);
      expect(screen.getByRole("tab", { name: "Profissional" }).getAttribute("aria-selected")).toBe("true");
      expect(planWrapper("profissional").className).not.toContain("hidden");
      expect(planWrapper("essencial").className).toContain("hidden md:block");
      expect(within(screen.getByRole("tabpanel")).getByRole("article", { name: "Profissional" })).toBeTruthy();
    });

    it("clicar numa aba troca o cartao mostrado", () => {
      renderWithRouter(page);
      fireEvent.click(screen.getByRole("tab", { name: "Escala" }));
      expect(screen.getByRole("tab", { name: "Escala" }).getAttribute("aria-selected")).toBe("true");
      expect(planWrapper("escala").className).not.toContain("hidden");
      expect(planWrapper("profissional").className).toContain("hidden md:block");
      expect(within(screen.getByRole("tabpanel")).getByRole("article", { name: "Escala" })).toBeTruthy();
    });
  });

  describe("compare os planos", () => {
    it("sem tabpanel focavel no desktop", () => {
      renderWithRouter(page);
      expect(screen.queryByRole("tabpanel")).toBeNull();
    });

    it("dica de rolagem aparece quando a tabela rola", () => {
      const sw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 700 });
      try {
        renderWithRouter(page);
        fireEvent.click(screen.getByRole("button", { name: "Compare os planos" }));
        expect(screen.getByText("Deslize para ver todos os planos")).toBeTruthy();
      } finally {
        if (sw) Object.defineProperty(HTMLElement.prototype, "scrollWidth", sw);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
      }
    });

    it("vem recolhida e abre e fecha pelo botao", () => {
      renderWithRouter(page);
      expect(screen.queryByRole("table")).toBeNull();
      const open = screen.getByRole("button", { name: "Compare os planos" });
      expect(open.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(open);
      const table = screen.getByRole("table");
      expect(within(table).getByRole("columnheader", { name: "Escala" })).toBeTruthy();
      expect(within(table).getByRole("rowheader", { name: "Pessoas atendidas pela IA por mês" })).toBeTruthy();
      expect(screen.queryByText("Deslize para ver todos os planos")).toBeNull();
      const close = screen.getByRole("button", { name: "Fechar comparação" });
      expect(close.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(close);
      expect(screen.queryByRole("table")).toBeNull();
    });
  });

  describe("implantacao e consultoria", () => {
    it("mostra os pacotes com os valores do catalogo, parcelas e acompanhamento", () => {
      renderWithRouter(page);
      const block = screen.getByRole("region", { name: "Quer que a gente monte junto?" });
      expect(within(block).getByText("Opcional")).toBeTruthy();
      expect(within(block).getByText(/R\$\s*1\.490/)).toBeTruthy();
      expect(within(block).getByText(/R\$\s*3\.900/)).toBeTruthy();
      expect(within(block).getByText(/R\$\s*6\.900/)).toBeTruthy();
      expect(within(block).getByText(/R\$\s*2\.400 por unidade adicional/)).toBeTruthy();
      expect(within(block).getByText("Sob orçamento")).toBeTruthy();
      expect(within(block).getByText(/parcelada em até 3 vezes/)).toBeTruthy();
      expect(within(block).getByText(/R\$\s*390\/mês, com 2 horas de ajustes/)).toBeTruthy();
      expect(within(block).getByRole("button", { name: "Falar com a gente" })).toBeTruthy();
      expect(within(block).getByRole("button", { name: "Pedir orçamento" })).toBeTruthy();
    });
  });
});
