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

  it("cada aba tem três dores e cenas sem rótulo repetido; a aba Corretor traz a nota fixa", () => {
    render(all());
    const tabs = screen.getAllByRole("tab");
    for (const tab of tabs) {
      fireEvent.click(tab);
      expect(screen.getAllByText("Hoje")).toHaveLength(3);
      expect(screen.getAllByText("Com o HNBCRM")).toHaveLength(3);
      expect(within(screen.getByRole("tabpanel")).queryByText("Exemplo ilustrativo")).toBeNull();
      expect(within(screen.getByRole("tabpanel")).getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
    }
    fireEvent.click(screen.getByRole("tab", { name: "Corretor e imobiliária" }));
    const note = within(screen.getByRole("tabpanel")).getByRole("note");
    expect(note).toHaveTextContent(/distribuição automática de leads/);
    expect(within(note).getByRole("link", { name: "Ver o que vem depois" })).toHaveAttribute("href", "/funcionalidades#o-que-vem");
    fireEvent.click(screen.getByRole("tab", { name: "Rede com várias unidades" }));
    const rede = within(screen.getByRole("tabpanel"));
    expect(rede.getAllByText("números ilustrativos")).toHaveLength(1);
    expect(rede.queryByText(/IA ×|IA 68%/)).toBeNull();
    expect(rede.getByText("Primeira resposta")).toBeInTheDocument();
    expect(rede.getByText("Conversas por unidade")).toBeInTheDocument();
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

describe("S3 a S5: vocabulário e movimento", () => {
  it("nenhum texto (todas as abas) contém repasse ou setor", () => {
    const { container } = render(all());
    const texts: string[] = [container.textContent ?? ""];
    for (const tab of screen.getAllByRole("tab")) {
      fireEvent.click(tab);
      texts.push(screen.getByRole("tabpanel").textContent ?? "");
    }
    const labels = Array.from(container.querySelectorAll("[aria-label]")).map((el) => el.getAttribute("aria-label") ?? "");
    for (const text of [...texts, ...labels]) expect(text).not.toMatch(/\b(repasse|setor)/i);
  });

  it("movimento reduzido: toda animação é motion-safe (estado final sem animar) e nada fica em loop", () => {
    const { container } = render(all());
    for (const tab of screen.getAllByRole("tab")) {
      fireEvent.click(tab);
      for (const el of Array.from(container.querySelectorAll("[class*='animate-']"))) {
        const animated = (el.getAttribute("class") ?? "").split(/\s+/).filter((c) => /(^|:)animate-/.test(c));
        for (const c of animated) {
          expect(c.startsWith("motion-safe:")).toBe(true);
          expect(c).not.toMatch(/pulse|spin|ping|bounce/);
        }
      }
    }
    expect(container.querySelector("[data-revealed]")).not.toBeNull();
  });

  it("a cena de cada dor tem nome acessível vindo de sceneLabel e a seção avisa uma vez que são exemplos", () => {
    render(all());
    expect(screen.getByRole("group", { name: "Exemplo: paciente pergunta o preço à noite" })).toBeInTheDocument();
    const section = screen.getByRole("heading", { name: "O que muda no seu dia" }).closest("section")!;
    expect(within(section).queryByText("Exemplo ilustrativo")).toBeNull();
    expect(within(section).getByText("As cenas são exemplos.")).toBeInTheDocument();
  });
});
