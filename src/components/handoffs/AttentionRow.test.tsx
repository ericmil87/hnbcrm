import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttentionRow, type AttentionItem } from "./AttentionRow";

const NOW = new Date("2026-01-01T12:00:00Z").getTime();
const handoff: AttentionItem = {
  _id: "h1",
  reason: "Objeto perdido na clínica",
  summary: "Cliente perdeu um guarda-chuva na recepção e pede ajuda para localizar.",
  suggestedActions: ["Verificar achados e perdidos", "Ligar para o cliente"],
  createdAt: NOW - 2 * 3600_000,
  title: "Maria Souza",
  fromMember: { name: "Atendente IA", role: "ai", type: "ai" },
};

function setup(over: Partial<React.ComponentProps<typeof AttentionRow>> = {}) {
  const props = {
    handoff,
    density: "compact" as const,
    now: NOW,
    expanded: false,
    onToggleExpanded: vi.fn(),
    onView: vi.fn(),
    onAccept: vi.fn(),
    onToggleGiveBack: vi.fn(),
    ...over,
  };
  render(<AttentionRow {...props} />);
  return props;
}

describe("AttentionRow", () => {
  it("compacto mostra nome, motivo, tempo relativo e resumo em uma linha", () => {
    setup();
    expect(screen.getByText("Maria Souza")).toBeInTheDocument();
    expect(screen.getByText("Objeto perdido na clínica")).toBeInTheDocument();
    expect(screen.getByText("há 2h")).toBeInTheDocument();
    expect(screen.getByText(/guarda-chuva/)).toHaveClass("line-clamp-1");
    expect(screen.queryByText("Ações sugeridas")).not.toBeInTheDocument();
  });

  it("tem as três ações e dispara os callbacks", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("button", { name: "Assumir conversa" }));
    await userEvent.click(screen.getByRole("button", { name: "Devolver à IA" }));
    await userEvent.click(screen.getByRole("button", { name: /Ver conversa/ }));
    expect(p.onAccept).toHaveBeenCalled();
    expect(p.onToggleGiveBack).toHaveBeenCalled();
    expect(p.onView).toHaveBeenCalled();
  });

  it("o botão de detalhes expõe aria-expanded e alterna", async () => {
    const p = setup();
    const btn = screen.getByRole("button", { name: /Mostrar detalhes/ });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(btn);
    expect(p.onToggleExpanded).toHaveBeenCalled();
  });

  it("expandido mostra as ações sugeridas e libera o resumo inteiro", () => {
    setup({ expanded: true });
    expect(screen.getByText("Ações sugeridas")).toBeInTheDocument();
    expect(screen.getByText("Ligar para o cliente")).toBeInTheDocument();
    // O motivo completo fica legível nos detalhes (o selo da linha pode truncar).
    expect(screen.getAllByText(/Objeto perdido na clínica/).length).toBeGreaterThan(1);
    expect(screen.getByText(/guarda-chuva/)).not.toHaveClass("line-clamp-1");
    expect(screen.getByRole("button", { name: /Ocultar detalhes/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("completo renderiza o cartão com Resumo e Ações sugeridas", () => {
    setup({ density: "comfortable" });
    expect(screen.getByText("Resumo")).toBeInTheDocument();
    expect(screen.getByText("Ações sugeridas")).toBeInTheDocument();
    expect(screen.getByText("De")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assumir conversa" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver conversa" })).toHaveTextContent("Ver conversa");
  });

  it("repasse de grupo mostra o subtítulo de grupo quando não há resumo", () => {
    setup({ handoff: { ...handoff, summary: null, isGroup: true, suggestedActions: [] } });
    expect(screen.getByText("Grupo de WhatsApp")).toBeInTheDocument();
  });

  it("compacto deixa todo contêiner de texto encolher (sem estourar o cartão no celular)", () => {
    const { container } = render(
      <AttentionRow
        handoff={{ ...handoff, title: "Nome muito comprido ".repeat(8), reason: "Motivo ".repeat(20) }}
        density="compact"
        now={NOW}
        expanded={false}
        onToggleExpanded={vi.fn()}
        onView={vi.fn()}
        onAccept={vi.fn()}
        onToggleGiveBack={vi.fn()}
      />
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card).toHaveClass("w-full", "max-w-full", "min-w-0", "overflow-hidden");
    expect(screen.getByRole("heading", { level: 3 })).toHaveClass("min-w-0", "truncate");
    expect(screen.getByText(/^Motivo/)).toHaveClass("min-w-0", "max-w-full", "truncate");
    expect(screen.getByText(/guarda-chuva/)).toHaveClass("min-w-0", "break-words");
    // O solicitante só aparece de md para cima; abaixo disso vai nos detalhes.
    expect(screen.getByText("Atendente IA").parentElement).toHaveClass("hidden", "md:inline-flex");
    // Linha de ações quebra em vez de rolar na horizontal.
    expect(screen.getByRole("button", { name: "Assumir conversa" }).parentElement).toHaveClass("flex-wrap");
  });

  it("entrega o botão Devolver à IA como âncora do popover", () => {
    const seen: Array<HTMLElement | null> = [];
    setup({
      renderGiveBackPopover: (anchor) => {
        seen.push(anchor.current);
        return null;
      },
    });
    expect(screen.getByRole("button", { name: "Devolver à IA" })).toBeInTheDocument();
  });
});
