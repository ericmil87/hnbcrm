import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScrollToBottomButton } from "./ScrollToBottomButton";

describe("ScrollToBottomButton", () => {
  it("sem novas: rótulo simples e sem badge", () => {
    render(<ScrollToBottomButton count={0} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Ir para as mensagens mais recentes" })).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("com novas: mostra o contador e o inclui no rótulo", () => {
    render(<ScrollToBottomButton count={3} onClick={() => {}} />);
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ir para as mensagens mais recentes, 3 novas" })).toBeTruthy();
  });

  it("chama onClick", () => {
    const onClick = vi.fn();
    render(<ScrollToBottomButton count={0} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
