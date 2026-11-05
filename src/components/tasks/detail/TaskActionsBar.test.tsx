import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskActionsBar } from "./TaskActionsBar";

function mockDesktop() {
  (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function setup(overrides: Partial<React.ComponentProps<typeof TaskActionsBar>> = {}) {
  const props = {
    isCompleted: false,
    priority: "medium" as const,
    assignees: [{ _id: "m1", name: "Ana", type: "human" as const }],
    onComplete: vi.fn(),
    onCancel: vi.fn(),
    onRequestDelete: vi.fn(),
    onPriorityChange: vi.fn(),
    onSnooze: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  render(<TaskActionsBar {...props} />);
  return props;
}

describe("TaskActionsBar", () => {
  beforeEach(mockDesktop);

  it("tarefa aberta mostra Concluir e Lembrete", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: "Concluir" }));
    expect(props.onComplete).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Lembrete" })).toBeInTheDocument();
  });

  it("tarefa concluída esconde Concluir, Lembrete e Cancelar tarefa", async () => {
    setup({ isCompleted: true });
    expect(screen.queryByRole("button", { name: "Concluir" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lembrete" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Mais ações" }));
    expect(screen.queryByRole("menuitem", { name: "Cancelar tarefa" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Excluir" })).toBeInTheDocument();
  });

  it("o menu troca a prioridade, cancela e pede a exclusão", async () => {
    const props = setup();
    const open = () => userEvent.click(screen.getByRole("button", { name: "Mais ações" }));

    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "Prioridade: Alta" }));
    expect(props.onPriorityChange).toHaveBeenCalledWith("high");

    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "Cancelar tarefa" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);

    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "Excluir" }));
    expect(props.onRequestDelete).toHaveBeenCalledTimes(1);
  });

  it("lembrete só salva com data e usa 09:00 quando a hora falta", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: "Lembrete" }));
    const save = screen.getByRole("button", { name: "Salvar" });
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Data do lembrete"), "2026-12-01");
    await userEvent.click(save);

    expect(props.onSnooze).toHaveBeenCalledWith(new Date("2026-12-01T09:00").getTime());
    // salvou: o seletor recolhe
    expect(screen.queryByLabelText("Data do lembrete")).toBeNull();
  });

  it("se o salvamento falha, o seletor continua aberto", async () => {
    const props = setup({ onSnooze: vi.fn().mockResolvedValue(false) });
    await userEvent.click(screen.getByRole("button", { name: "Lembrete" }));
    await userEvent.type(screen.getByLabelText("Data do lembrete"), "2026-12-01");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(props.onSnooze).toHaveBeenCalled();
    expect(screen.getByLabelText("Data do lembrete")).toBeInTheDocument();
  });
});
