import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FunnelEditor } from "./FunnelEditor";
import type { FunnelValue } from "@/lib/funnelEditor";

const value = (): FunnelValue => ({
  boardName: "Funil de vendas",
  stages: [
    { key: "a", name: "Novo", color: "#3B82F6" },
    { key: "b", name: "Proposta", color: "#F59E0B" },
    { key: "w", name: "Ganho", color: "#10B981", isClosedWon: true },
  ],
});

describe("FunnelEditor", () => {
  it("renomear chama onChange com o nome novo", async () => {
    const onChange = vi.fn();
    render(<FunnelEditor value={value()} onChange={onChange} onRestore={() => {}} />);
    await userEvent.type(screen.getByLabelText("Nome da etapa 1"), "s");
    expect(onChange.mock.calls[0][0].stages[0].name).toBe("Novos");
  });

  it("descer a etapa troca a ordem; subir a primeira fica desabilitado", async () => {
    const onChange = vi.fn();
    render(<FunnelEditor value={value()} onChange={onChange} onRestore={() => {}} />);
    expect(screen.getByRole("button", { name: "Subir a etapa 1" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Descer a etapa 1" }));
    expect(onChange.mock.calls[0][0].stages.map((s: { key: string }) => s.key)).toEqual(["b", "a", "w"]);
  });

  it("não deixa remover a última etapa aberta", async () => {
    const onChange = vi.fn();
    const v: FunnelValue = { ...value(), stages: [value().stages[0], value().stages[2], { key: "l", name: "Perdido", color: "#6B7280", isClosedLost: true }] };
    render(<FunnelEditor value={v} onChange={onChange} onRestore={() => {}} />);
    const remove = screen.getByRole("button", { name: "Remover a etapa 1" });
    expect(remove).toBeDisabled();
    await userEvent.click(remove);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remover a etapa 3" })).toBeEnabled();
  });

  it("remove uma etapa permitida e adiciona antes da fechada", async () => {
    const onChange = vi.fn();
    render(<FunnelEditor value={value()} onChange={onChange} onRestore={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Remover a etapa 2" }));
    expect(onChange.mock.calls[0][0].stages).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Adicionar etapa" }));
    const added = onChange.mock.calls[1][0].stages;
    expect(added).toHaveLength(4);
    expect(added[3].key).toBe("w");
  });

  it("Restaurar sugestão chama onRestore", async () => {
    const onRestore = vi.fn();
    render(<FunnelEditor value={value()} onChange={() => {}} onRestore={onRestore} />);
    await userEvent.click(screen.getByRole("button", { name: "Restaurar sugestão" }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it("botões só com ícone têm nome acessível", () => {
    render(<FunnelEditor value={value()} onChange={() => {}} onRestore={() => {}} />);
    for (const btn of screen.getAllByRole("button")) {
      expect(btn).toHaveAccessibleName();
    }
  });

  it("disabled trava tudo e mostra erro de nome vazio", () => {
    render(<FunnelEditor value={{ ...value(), boardName: "" }} onChange={() => {}} onRestore={() => {}} disabled variant="panel" />);
    expect(screen.getByRole("button", { name: "Restaurar sugestão" })).toBeDisabled();
    expect(screen.getByText("Dê um nome ao funil")).toBeInTheDocument();
  });
});
