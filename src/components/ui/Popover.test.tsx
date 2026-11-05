import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Popover } from "./Popover";

function Harness({ sheet = false }: { sheet?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={ref} onClick={() => setOpen((v) => !v)}>
        gatilho
      </button>
      <p>fora</p>
      <Popover open={open} onOpenChange={setOpen} anchor={ref} sheet={sheet} role="dialog" aria-label="Conteúdo">
        <button>dentro</button>
      </Popover>
    </div>
  );
}

describe("Popover", () => {
  it("renderiza em portal no body só quando aberto", async () => {
    const { container } = render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByText("gatilho"));
    const dialog = screen.getByRole("dialog");
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it("Esc fecha e devolve o foco ao gatilho", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText("gatilho"));
    screen.getByText("dentro").focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("gatilho")).toHaveFocus();
  });

  it("clique fora fecha; clique dentro não", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText("gatilho"));
    await userEvent.click(screen.getByText("dentro"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(screen.getByText("fora"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("modo folha também renderiza e fecha com Esc", async () => {
    render(<Harness sheet />);
    await userEvent.click(screen.getByText("gatilho"));
    expect(screen.getByRole("dialog")).toHaveClass("pb-safe");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
