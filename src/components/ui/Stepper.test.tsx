import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Stepper } from "./Stepper";

const STEPS = [
  { id: "a", label: "Arquivo" },
  { id: "b", label: "Colunas" },
  { id: "c", label: "Prévia" },
];

describe("Stepper", () => {
  it("marca o passo atual com aria-current e mostra o resumo mobile", () => {
    render(<Stepper steps={STEPS} current="b" completed={["a"]} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[0]).not.toHaveAttribute("aria-current");
    expect(screen.getByTestId("stepper-summary")).toHaveTextContent("Passo 2 de 3 · Colunas");
  });

  it("só passos concluídos são clicáveis", async () => {
    const onStepClick = vi.fn();
    render(<Stepper steps={STEPS} current="b" completed={["a"]} onStepClick={onStepClick} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /Arquivo/ }));
    expect(onStepClick).toHaveBeenCalledWith("a");
  });

  it("sem onStepClick não há botões", () => {
    render(<Stepper steps={STEPS} current="a" completed={["a"]} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("vertical não mostra resumo", () => {
    render(<Stepper steps={STEPS} current="a" orientation="vertical" />);
    expect(screen.queryByTestId("stepper-summary")).toBeNull();
  });
});
