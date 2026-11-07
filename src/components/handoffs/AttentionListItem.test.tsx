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

  it("grupo sem resumo mostra o ícone de grupo (sem iniciais) e o subtítulo", () => {
    const { container } = render(
      <ul>
        <AttentionListItem
          handoff={{ ...handoff, isGroup: true, summary: null, title: "Sala Vendas" }}
          now={NOW}
          onOpen={vi.fn()}
        />
      </ul>
    );
    expect(screen.getByText(/· Grupo de WhatsApp/)).toBeInTheDocument();
    const avatar = container.querySelector("[data-avatar]");
    expect(avatar).toHaveAttribute("data-avatar", "group");
    expect(avatar?.querySelector("svg")).not.toBeNull();
    expect(avatar).not.toHaveTextContent("SV");
  });

  it("pessoa mostra as iniciais do nome no avatar", () => {
    const { container } = render(
      <ul>
        <AttentionListItem handoff={handoff} now={NOW} onOpen={vi.fn()} />
      </ul>
    );
    const avatar = container.querySelector("[data-avatar]");
    expect(avatar).toHaveAttribute("data-avatar", "person");
    expect(avatar).toHaveTextContent("MS");
  });

  it("motivo vazio vira Pedido de ajuda", () => {
    renderItem({ handoff: { ...handoff, reason: "  " } });
    expect(screen.getByText("Pedido de ajuda")).toBeInTheDocument();
  });

  it("hover só para ponteiro fino (sem linha presa no toque)", () => {
    renderItem();
    const btn = screen.getByRole("button");
    expect(btn).toHaveClass("[@media(hover:hover)]:hover:bg-surface-overlay", "active:bg-surface-overlay");
    expect(btn).not.toHaveClass("hover:bg-surface-overlay");
  });

  it("marca o pedido aberto com aria-current", () => {
    renderItem({ selected: true });
    expect(screen.getByRole("button")).toHaveAttribute("aria-current", "true");
  });
});
