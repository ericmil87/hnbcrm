import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./Button";

describe("Button", () => {
  it("garante alvo de 44 px em pointer grosso para sm e md", () => {
    const { rerender } = render(<Button size="sm">Salvar</Button>);
    expect(screen.getByRole("button")).toHaveClass("h-8", "coarse:min-h-11");
    rerender(<Button size="md">Salvar</Button>);
    expect(screen.getByRole("button")).toHaveClass("h-10", "coarse:min-h-11");
  });

  it("iconOnly usa quadrado e alvo de 44 px", () => {
    render(
      <Button iconOnly aria-label="Fechar">
        x
      </Button>
    );
    expect(screen.getByRole("button", { name: "Fechar" })).toHaveClass("w-10", "h-10", "coarse:min-w-11", "coarse:min-h-11");
  });

  it("exige aria-label em iconOnly", () => {
    // @ts-expect-error iconOnly sem aria-label
    const bad = <Button iconOnly>x</Button>;
    expect(bad).toBeTruthy();
  });

  it("loading desabilita, marca aria-busy e não dispara clique", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Enviar
      </Button>
    );
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    await userEvent.click(btn).catch(() => undefined);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("usa focus-visible em vez de focus", () => {
    render(<Button>Ok</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("focus-visible:ring-2");
    expect(cls).not.toMatch(/(^|\s)focus:ring/);
  });

  it("mantém variantes e dispara onClick", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="danger" onClick={onClick}>
        Apagar
      </Button>
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button")).toHaveClass("bg-semantic-error");
  });
});
