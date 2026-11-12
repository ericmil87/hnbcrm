import { afterEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { renderWithRouter } from "@/test/render";
import { applyTheme } from "@/lib/themeDom";
import { rawColorHits } from "@/test/rawColorDom";
import { UI_THEMES } from "../../convex/lib/uiTheme";
import { LandingPage } from "./LandingPage";

afterEach(() => applyTheme("whatsapp"));

function renderLanding() {
  return renderWithRouter(
    <HelmetProvider>
      <LandingPage />
    </HelmetProvider>
  );
}

describe("LandingPage (esqueleto)", () => {
  it("tem um único h1, com o título A da copy aprovada", () => {
    renderLanding();
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Seu WhatsApp atende na hora. Até quando você não pode.");
  });

  it("navegação aponta para as âncoras das seções que existem", () => {
    const { container } = renderLanding();
    const nav = screen.getByRole("navigation", { name: "Seções da página" });
    const hrefs = Array.from(nav.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["#como-funciona", "#funcionalidades", "#precos", "#feito-com-voce", "#comunidade"]);
    // A seção de comunidade agora aparece sempre (sem a env só some o cartão do grupo).
    for (const href of hrefs) expect(container.querySelector(href!)).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Entrar no grupo do WhatsApp" })).toBeNull();
  });

  it("o link Comunidade da navegação aparece sempre, mesmo sem VITE_COMMUNITY_URL", () => {
    renderLanding();
    const nav = within(screen.getByRole("navigation", { name: "Seções da página" }));
    expect(nav.getByRole("link", { name: "Comunidade" })).toHaveAttribute("href", "#comunidade");
  });

  it("a seção Funcionalidades fica depois do time e leva a /funcionalidades", () => {
    const { container } = renderLanding();
    const features = container.querySelector("#funcionalidades");
    expect(features).not.toBeNull();
    expect(container.querySelector("#time")!.compareDocumentPosition(features!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ver todas as funcionalidades" })).toHaveAttribute("href", "/funcionalidades");
  });

  it("Testar grátis leva ao /comecar e Entrar ao login", () => {
    renderLanding();
    const ctas = screen.getAllByRole("link", { name: "Testar grátis" });
    expect(ctas.length).toBeGreaterThanOrEqual(1);
    for (const a of ctas) expect(a).toHaveAttribute("href", "/comecar");
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/entrar");
    expect(header.getByRole("link", { name: "Testar grátis" })).toHaveAttribute("href", "/comecar");
    expect(header.getByRole("button", { name: "Escolher tema" })).toBeInTheDocument();
  });

  it("a tabela de preços e os cards antigos saíram da landing (só o resumo do S6)", () => {
    renderLanding();
    expect(screen.getAllByText("Mais escolhido")).toHaveLength(1);
    expect(screen.queryByText("Compare os planos")).toBeNull();
    expect(screen.queryByText(/Em breve/)).toBeNull();
    expect(screen.getByRole("link", { name: /Ver tabela completa/ })).toHaveAttribute("href", "/precos");
  });

  it("tem os títulos de todas as seções do esqueleto", () => {
    renderLanding();
    for (const title of [
      "A máquina funcionando, às 23h14",
      "Três no mesmo time",
      "O que muda no seu dia",
      "Como começa",
      "Preço em 20 segundos",
      "Quer que a gente monte junto?",
      "Como é usar no dia a dia",
      "Perguntas rápidas",
      "Conte como é o seu negócio. A sua IA começa daí.",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeInTheDocument();
    }
  });

  for (const theme of UI_THEMES) {
    it(`${theme}: sem cor crua no que chega à tela`, () => {
      applyTheme(theme);
      const { container } = renderLanding();
      expect(rawColorHits(container)).toEqual([]);
    });
  }
});
