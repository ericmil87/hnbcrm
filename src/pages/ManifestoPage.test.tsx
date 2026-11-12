import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { renderWithRouter } from "@/test/render";
import { ManifestoPage } from "./ManifestoPage";
import {
  MANIFESTO_CHAPTERS,
  MANIFESTO_CLOSING,
  MANIFESTO_SIGNATURE,
  MANIFESTO_TITLE,
} from "@/components/landing/manifestoCopy";

function renderPage() {
  return renderWithRouter(
    <HelmetProvider>
      <ManifestoPage />
    </HelmetProvider>,
    { route: "/manifesto" },
  );
}

describe("ManifestoPage", () => {
  it("tem um único h1 e um h2 por capítulo, com a âncora", () => {
    const { container } = renderPage();
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(MANIFESTO_TITLE);
    for (const c of MANIFESTO_CHAPTERS) {
      expect(screen.getByRole("heading", { level: 2, name: c.title })).toBeTruthy();
      expect(container.querySelector(`h2#${c.id}`)).not.toBeNull();
    }
  });

  it("mostra o fecho, a assinatura, o autor e a inscrição", () => {
    renderPage();
    expect(screen.getByText(MANIFESTO_CLOSING)).toBeTruthy();
    expect(screen.getByText(MANIFESTO_SIGNATURE)).toBeTruthy();
    expect(screen.getByAltText("Retrato de Eric Milfont")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Receba as novidades" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quero receber" })).toBeTruthy();
  });

  it("CTA leva ao /comecar e há link para as funcionalidades", () => {
    renderPage();
    const cta = screen.getAllByRole("link", { name: "Testar grátis" });
    expect(cta.some((a) => a.getAttribute("href")?.startsWith("/comecar"))).toBe(true);
    expect(screen.getByRole("link", { name: "Ver todas as funcionalidades" }).getAttribute("href")).toBe("/funcionalidades");
  });
});
