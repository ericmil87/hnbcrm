import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  afterEach(() => vi.useRealTimers());

  it("abre em hover e fecha ao sair, com aria-describedby", async () => {
    render(
      <Tooltip content="Ajuda">
        <button>alvo</button>
      </Tooltip>
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.hover(screen.getByText("alvo"));
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Ajuda");
    expect(screen.getByText("alvo")).toHaveAttribute("aria-describedby", tip.id);
    await userEvent.unhover(screen.getByText("alvo"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("abre em foco por teclado e fecha com Esc", async () => {
    render(
      <Tooltip content="Ajuda">
        <button>alvo</button>
      </Tooltip>
    );
    await userEvent.tab();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("no toque abre só com pressão longa de 500 ms", () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Ajuda">
        <button>alvo</button>
      </Tooltip>
    );
    const el = screen.getByText("alvo");
    fireEvent.touchStart(el);
    act(() => void vi.advanceTimersByTime(300));
    fireEvent.touchEnd(el);
    act(() => void vi.advanceTimersByTime(500));
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.touchStart(el);
    act(() => void vi.advanceTimersByTime(500));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("asInfo abre com toque simples e alterna", () => {
    render(
      <Tooltip content="Info" asInfo>
        <button>alvo</button>
      </Tooltip>
    );
    const el = screen.getByText("alvo");
    fireEvent.touchStart(el);
    fireEvent.touchEnd(el);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.touchStart(el);
    fireEvent.touchEnd(el);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("gatilho desabilitado abre em toque simples", () => {
    render(
      <Tooltip content="Sem permissão">
        <button disabled>alvo</button>
      </Tooltip>
    );
    const wrapper = screen.getByText("alvo").parentElement!;
    expect(wrapper).toHaveAttribute("tabindex", "0");
    fireEvent.touchStart(wrapper);
    fireEvent.touchEnd(wrapper);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Sem permissão");
  });

  it("toque fora fecha", () => {
    render(
      <>
        <Tooltip content="Info" asInfo>
          <button>alvo</button>
        </Tooltip>
        <p>fora</p>
      </>
    );
    const el = screen.getByText("alvo");
    fireEvent.touchStart(el);
    fireEvent.touchEnd(el);
    fireEvent.touchStart(screen.getByText("fora"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
