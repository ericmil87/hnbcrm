import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { renderWithRouter } from "@/test/render";
import { FEATURE_AREAS } from "@/components/landing/featuresCatalog";
import { FeaturesPage } from "./FeaturesPage";

function renderPage() {
  return renderWithRouter(
    <HelmetProvider>
      <FeaturesPage />
    </HelmetProvider>
  );
}

describe("FeaturesPage", () => {
  it("tem um único h1", () => {
    renderPage();
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Tudo o que o HNBCRM faz hoje, e o que vem depois");
  });

  it("renderiza todas as áreas, cada uma com o seu h2, e a navegação aponta para elas", () => {
    const { container } = renderPage();
    const nav = within(screen.getByRole("navigation", { name: "Áreas" }));
    for (const area of FEATURE_AREAS) {
      expect(container.querySelector(`section#${area.id}`)).not.toBeNull();
      expect(screen.getByRole("heading", { level: 2, name: area.title })).toBeInTheDocument();
      expect(nav.getByRole("link", { name: area.title })).toHaveAttribute("href", `#${area.id}`);
    }
    expect(container.querySelector("section#o-que-vem")).not.toBeNull();
  });

  it("mostra os selos Em breve e No radar e a legenda", () => {
    renderPage();
    expect(screen.getAllByText("Em breve").length).toBeGreaterThan(1);
    expect(screen.getAllByText("No radar").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Em liberação").length).toBeGreaterThan(0);
    expect(screen.getByText("em estudo, sem data")).toBeInTheDocument();
  });

  it("Testar grátis aponta para /comecar; há links para preços e manifesto", () => {
    renderPage();
    const ctas = screen.getAllByRole("link", { name: "Testar grátis" });
    expect(ctas.length).toBeGreaterThanOrEqual(2);
    for (const a of ctas) expect(a).toHaveAttribute("href", "/comecar");
    expect(screen.getByRole("link", { name: "Ver preços" })).toHaveAttribute("href", "/precos");
    expect(screen.getByRole("link", { name: "Ler o manifesto" })).toHaveAttribute("href", "/manifesto");
  });
});
