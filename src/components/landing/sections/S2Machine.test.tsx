import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { applyTheme } from "@/lib/themeDom";
import { totalSceneDuration } from "@/lib/sceneTimeline";
import { UI_THEMES } from "../../../../convex/lib/uiTheme";
import { rawColorHits } from "@/test/rawColorDom";
import { mockReducedMotion } from "@/test/reducedMotion";
import { S2Machine } from "./S2Machine";
import { MACHINE_CHAPTERS, MACHINE_STEPS } from "./S2MachineCopy";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  applyTheme("whatsapp");
});

/** Esqueleto que define a altura da cena: painéis, caixas reservadas e suas classes. */
function skeleton(container: HTMLElement) {
  return [...container.querySelectorAll("[data-panel]")].map((panel) => ({
    id: panel.getAttribute("data-panel"),
    box: panel.querySelector("[data-stage-box]")!.className,
  }));
}

describe("S2Machine", () => {
  for (const theme of UI_THEMES) {
    it(`${theme}: renderiza com tokens, sem cor crua`, () => {
      applyTheme(theme);
      restore = mockReducedMotion(true);
      const { container } = render(<S2Machine />);
      expect(rawColorHits(container)).toEqual([]);
      expect(container.querySelector(".chat-wallpaper")).not.toBeNull();
    });
  }

  it("os painéis têm altura reservada, igual no primeiro quadro e no estado final", () => {
    restore = mockReducedMotion(false);
    const first = render(<S2Machine />);
    const initial = skeleton(first.container);
    first.unmount();
    restore();
    restore = mockReducedMotion(true);
    const final = skeleton(render(<S2Machine />).container);

    expect(initial).toEqual(final);
    expect(initial.map((p) => p.id)).toEqual(["conversa", "funil", "voce"]);
    const byId = Object.fromEntries(initial.map((p) => [p.id, p.box]));
    // Conversa e Você: altura fixa no celular e no computador. Funil: faixa de altura própria no celular, fixa a partir de md.
    for (const id of ["conversa", "voce"]) {
      expect(byId[id]).toContain("h-[23rem]");
      expect(byId[id]).toContain("md:h-[28rem]");
    }
    expect(byId.funil).toContain("md:h-[28rem]");
  });

  it("as bolhas entram numa área ancorada embaixo e o que entra depois é camada absoluta", () => {
    restore = mockReducedMotion(true);
    const { container } = render(<S2Machine />);
    const feed = container.querySelector('[data-panel="conversa"] [data-chat-feed]')!;
    expect(feed).toHaveClass("overflow-hidden");
    expect(feed.firstElementChild).toHaveClass("absolute", "bottom-0");
    for (const layer of ["repouso", "conversa-assumida", "resumo", "aviso"]) {
      expect(container.querySelector(`[data-panel="voce"] [data-layer="${layer}"]`)).toHaveClass("absolute");
    }
    expect(container.querySelector("[data-rail-card]")).toHaveClass("absolute");
  });

  it("primeiro quadro: Você mostra o repouso (não fica vazio) e o Funil ainda sem a Marina", () => {
    restore = mockReducedMotion(false);
    const { container } = render(<S2Machine />);
    const rest = container.querySelector('[data-layer="repouso"]')!;
    expect(rest).toHaveClass("opacity-100");
    expect(within(rest as HTMLElement).getByText("Tudo em dia")).toBeInTheDocument();
    expect(within(rest as HTMLElement).getByText("A IA está atendendo")).toBeInTheDocument();
    expect(container.querySelector('[data-layer="aviso"]')).toHaveClass("opacity-0");
    expect(container.querySelector('[data-layer="resumo"]')).toHaveClass("opacity-0");
    expect(container.querySelector("[data-funnel-rail]")).not.toHaveAttribute("data-stage");
    expect(container.querySelectorAll("[data-rail-stage]")).toHaveLength(3);
    expect(screen.queryByText("Fechado, 10h30!")).toBeNull();
    expect([...container.querySelectorAll("[data-scene-steps] li")].map((li) => li.getAttribute("data-state"))).toEqual(
      MACHINE_CHAPTERS.map(() => "pending")
    );
  });

  it("movimento reduzido: estado final estático, sem botão de pausa", () => {
    restore = mockReducedMotion(true);
    const { container } = render(<S2Machine />);
    expect(screen.getByText("Anotei 10h30. A equipe confirma com você amanhã cedo.")).toBeInTheDocument();
    expect(screen.getByText(/Transcrição/)).toBeInTheDocument();
    expect(container.querySelector("[data-funnel-rail]")).toHaveAttribute("data-stage", "agendado");
    expect(container.querySelector('[data-layer="conversa-assumida"]')).toHaveClass("opacity-100");
    expect(screen.getByText("Você assumiu a conversa. A IA pausou.")).toBeInTheDocument();
    expect(container.querySelector('[data-layer="resumo"]')).toHaveClass("opacity-100");
    expect(screen.getByText("3 leads quentes hoje")).toBeInTheDocument();
    expect(container.querySelector('[data-layer="repouso"]')).toHaveClass("opacity-0");
    // Nada apagado pela saída do loop nem "digitando".
    expect(container.querySelector("[data-chat-feed]")!.firstElementChild).toHaveClass("opacity-100");
    expect(screen.queryByText("digitando…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pausar cena" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retomar cena" })).toBeNull();
    // O lugar do botão continua reservado.
    expect(container.querySelector("[data-scene-header] .h-11")).not.toBeNull();
  });

  it("com movimento: botão de pausa rotulado no cabeçalho da cena, fora do conteúdo aria-hidden", () => {
    restore = mockReducedMotion(false);
    const { container } = render(<S2Machine />);
    const header = container.querySelector("[data-scene-header]") as HTMLElement;
    const pause = within(header).getByRole("button", { name: "Pausar cena" });
    expect(pause.closest("[aria-hidden]")).toBeNull();
    fireEvent.click(pause);
    expect(within(header).getByRole("button", { name: "Retomar cena" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Cena ilustrativa: a máquina funcionando" })).toHaveAttribute("data-scene-paused", "true");
  });

  it("a cena tem nome acessível, descrição para leitor de tela e a legenda honesta fora da animação", () => {
    restore = mockReducedMotion(false);
    const { container } = render(<S2Machine />);
    const group = screen.getByRole("group", { name: "Cena ilustrativa: a máquina funcionando" });
    expect(screen.getByText(/Cena ilustrativa: às 23h14/)).toHaveClass("sr-only");
    expect(container.querySelector('[data-panel="conversa"]')!.closest("[aria-hidden]")).not.toBeNull();
    const caption = screen.getByText(
      "Cena ilustrativa, com o Atendente no modo automático. Ele começa em modo sugestão, e você libera o automático quando quiser."
    );
    expect(group).not.toContainElement(caption);
    expect(caption.closest("[aria-hidden]")).toBeNull();
  });

  it("roteiro: uma volta dura entre 20 e 26 s e termina no passo de saída", () => {
    const total = totalSceneDuration(MACHINE_STEPS);
    expect(total).toBeGreaterThanOrEqual(20_000);
    expect(total).toBeLessThanOrEqual(26_000);
    expect(MACHINE_STEPS.at(-1)?.id).toBe("saida");
    const ids = MACHINE_STEPS.map((s) => s.id);
    for (const chapter of MACHINE_CHAPTERS) expect(ids).toContain(chapter.from);
  });
});
