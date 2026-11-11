import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { applyTheme } from "@/lib/themeDom";
import { rawColorHits } from "@/test/rawColorDom";
import { UI_THEMES } from "../../../../convex/lib/uiTheme";
import { S3Team } from "./S3Team";
import { S4Profiles } from "./S4Profiles";
import { S5HowItStarts } from "./S5HowItStarts";

afterEach(() => applyTheme("whatsapp"));

function all() {
  return (
    <MemoryRouter>
      <S3Team />
      <S4Profiles />
      <S5HowItStarts />
    </MemoryRouter>
  );
}

describe("S3, S4 e S5 nos 4 temas", () => {
  for (const theme of UI_THEMES) {
    it(`${theme}: renderiza sem cor crua`, () => {
      applyTheme(theme);
      const { container } = render(all());
      expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
      expect(rawColorHits(container)).toEqual([]);
      expect(container.querySelector(".chat-wallpaper")).not.toBeNull();
    });
  }
});

describe("S3", () => {
  it("tem os três cartões e a faixa de canais com o selo Em liberação", () => {
    render(all());
    for (const name of ["Atendente", "Copiloto", "Sua equipe"]) {
      expect(screen.getByRole("heading", { level: 3, name })).toBeInTheDocument();
    }
    expect(screen.getAllByText("Em liberação")).toHaveLength(2);
    expect(screen.getAllByText("Pronto")).toHaveLength(2);
    expect(screen.getByText(/Instagram e Messenger estão sendo liberados/)).toBeInTheDocument();
  });
});

describe("S4", () => {
  it("abas acessíveis: setas, Home/End e troca de conteúdo", () => {
    render(all());
    const list = screen.getByRole("tablist", { name: "Perfis" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tabs[0].id);
    expect(screen.getByText("Paciente chama às 22h e só tem resposta no dia seguinte.")).toBeInTheDocument();

    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Paciente chama às 22h e só tem resposta no dia seguinte.")).toBeNull();
    expect(screen.getByText("O comprovante do Pix se perde no meio da conversa.")).toBeInTheDocument();

    fireEvent.keyDown(list, { key: "End" });
    expect(tabs[4]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("O hóspede escreve em outro idioma.")).toBeInTheDocument();
    fireEvent.keyDown(list, { key: "Home" });
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("cada aba tem três dores e cenas rotuladas como exemplo; a aba Corretor traz a nota fixa", () => {
    render(all());
    const tabs = screen.getAllByRole("tab");
    for (const tab of tabs) {
      fireEvent.click(tab);
      expect(screen.getAllByText("Hoje")).toHaveLength(3);
      expect(screen.getAllByText("Com o HNBCRM")).toHaveLength(3);
      expect(screen.getAllByText("Exemplo ilustrativo")).toHaveLength(3);
    }
    fireEvent.click(screen.getByRole("tab", { name: "Corretor e imobiliária" }));
    expect(within(screen.getByRole("tabpanel")).getByRole("note")).toHaveTextContent(/Distribuição automática de leads/);
    fireEvent.click(screen.getByRole("tab", { name: "Rede com várias unidades" }));
    expect(screen.getAllByText("números ilustrativos").length).toBeGreaterThan(0);
  });
});

describe("S5", () => {
  it("três passos e aviso de QR code sem prometer ausência de risco", () => {
    const { container } = render(all());
    const steps = screen.getByRole("heading", { name: "Como começa" }).closest("section")!.querySelectorAll("ol > li");
    expect(steps).toHaveLength(3);
    const note = screen.getByText(/não é oficial do WhatsApp e existe risco de o número ser banido/);
    expect(note).toHaveTextContent(/API oficial da Meta/);
    expect(container.textContent?.toLowerCase()).not.toContain("sem risco");
    expect(screen.getByRole("link", { name: "Testar grátis" })).toBeInTheDocument();
  });
});
