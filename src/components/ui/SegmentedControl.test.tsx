import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SegmentedControl } from "./SegmentedControl";

const OPTIONS = [
  { value: "all", label: "Todas" },
  { value: "direct", label: "Diretas" },
  { value: "groups", label: "Grupos" },
];

function Harness() {
  const [v, setV] = useState("all");
  return <SegmentedControl value={v} onValueChange={setV} options={OPTIONS} ariaLabel="Tipo de conversa" />;
}

describe("SegmentedControl", () => {
  it("expõe radiogroup e aria-checked", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup", { name: "Tipo de conversa" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Todas" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Grupos" })).toHaveAttribute("aria-checked", "false");
  });

  it("seleciona por clique", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("radio", { name: "Diretas" }));
    expect(screen.getByRole("radio", { name: "Diretas" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Todas" })).toHaveAttribute("aria-checked", "false");
  });

  it("seleciona por setas com foco itinerante", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("radio", { name: "Todas" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Diretas" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Diretas" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Todas" })).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Grupos" })).toHaveAttribute("aria-checked", "true");
  });

  it("iconOnly mostra só o ícone e usa o rótulo como nome acessível", async () => {
    const user = userEvent.setup();
    let value = "board";
    const { rerender } = render(
      <SegmentedControl
        iconOnly
        ariaLabel="Modo de exibição"
        value={value}
        onValueChange={(v) => (value = v)}
        options={[
          { value: "board", label: "Modo quadro", icon: <svg data-testid="i-board" /> },
          { value: "list", label: "Modo lista", icon: <svg data-testid="i-list" /> },
        ]}
      />
    );
    const list = screen.getByRole("radio", { name: "Modo lista" });
    expect(list).not.toHaveTextContent("Modo lista");
    expect(screen.getByTestId("i-list")).toBeInTheDocument();
    await user.click(list);
    expect(value).toBe("list");
    rerender(<></>);
  });
});
