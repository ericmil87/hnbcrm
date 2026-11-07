import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttentionListItem } from "./AttentionListItem";
import type { AttentionItem } from "./AttentionRow";

const NOW = new Date("2026-11-07T12:00:00Z").getTime();
const handoff: AttentionItem = {
  _id: "h1",
  reason: "Pediu desconto",
  summary: "Cliente quer 10% no plano anual.",
  suggestedActions: ["Oferecer 5%"],
  createdAt: NOW - 10 * 60_000,
  title: "Maria Souza",
  fromMember: { name: "Atendente IA", type: "ai" },
};

function renderItem(over: Partial<React.ComponentProps<typeof AttentionListItem>> = {}) {
  const onOpen = vi.fn();
  render(
    <ul>
      <AttentionListItem handoff={handoff} now={NOW} onOpen={onOpen} {...over} />
    </ul>
  );
  return { onOpen };
}

describe("AttentionListItem", () => {
  it("mostra nome, hora relativa, motivo e resumo em duas linhas truncadas", () => {
    renderItem();
    expect(screen.getByText("Maria Souza")).toHaveClass("truncate", "font-semibold");
    expect(screen.getByText("há 10 min")).toHaveClass("tabular-nums");
    const reason = screen.getByText("Pediu desconto");
    expect(reason.parentElement).toHaveClass("truncate", "min-w-0");
    expect(screen.getByText(/· Cliente quer 10%/)).toBeInTheDocument();
  });

  it("é um único botão de toque (sem ações na linha) e abre a espiada", async () => {
    const { onOpen } = renderItem();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveClass("min-h-[72px]", "w-full");
    expect(buttons[0]).toHaveAccessibleName(/Maria Souza.*Pediu desconto/);
    await userEvent.click(buttons[0]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("espera de uma hora ou mais fica em vermelho", () => {
    const { container } = render(
      <ul>
        <AttentionListItem handoff={{ ...handoff, createdAt: NOW - 2 * 3600_000 }} now={NOW} onOpen={vi.fn()} />
      </ul>
    );
    expect(screen.getByText("há 2h")).toHaveClass("text-semantic-error");
    expect(container.querySelector("[data-urgency]")).toHaveAttribute("data-urgency", "late");
  });

  it("recente usa o ponto de aviso e hora discreta", () => {
    const { container } = render(
      <ul>
        <AttentionListItem handoff={handoff} now={NOW} onOpen={vi.fn()} />
      </ul>
    );
    expect(container.querySelector("[data-urgency]")).toHaveClass("bg-semantic-warning");
    expect(screen.getByText("há 10 min")).toHaveClass("text-text-muted");
  });

  it("grupo sem resumo mostra o ícone de grupo e o subtítulo", () => {
    renderItem({ handoff: { ...handoff, isGroup: true, summary: null, title: "Sala Vendas" } });
    expect(screen.getByText(/· Grupo de WhatsApp/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Humano/)).not.toBeInTheDocument();
  });

  it("marca o pedido aberto com aria-current", () => {
    renderItem({ selected: true });
    expect(screen.getByRole("button")).toHaveAttribute("aria-current", "true");
  });
});
