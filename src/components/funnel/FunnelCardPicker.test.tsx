import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FunnelCardPicker } from "./FunnelCardPicker";
import { defaultFunnelCardPrefs } from "@/lib/funnelCardPrefs";

function open(onChange = vi.fn(), prefs = defaultFunnelCardPrefs()) {
  render(<FunnelCardPicker prefs={prefs} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Exibição dos cards" }));
  return onChange;
}

describe("FunnelCardPicker", () => {
  it("começa fechado e abre pelo botão", () => {
    render(<FunnelCardPicker prefs={defaultFunnelCardPrefs()} onChange={vi.fn()} />);
    expect(screen.queryByText("Campos no card")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Exibição dos cards" }));
    expect(screen.getByText("Campos no card")).toBeInTheDocument();
  });

  it("lista os campos com o estado atual", () => {
    open();
    expect(screen.getByRole("checkbox", { name: "Valor" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Etiquetas" })).not.toBeChecked();
    expect(screen.getAllByRole("checkbox")).toHaveLength(8);
  });

  it("marcar um campo emite as preferências novas na hora", () => {
    const onChange = open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Etiquetas" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fields: expect.arrayContaining(["tags", "value"]) }));
  });

  it("desmarcar remove o campo", () => {
    const onChange = open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Valor" }));
    expect(onChange.mock.calls[0][0].fields).not.toContain("value");
  });

  it("troca a densidade", () => {
    const onChange = open();
    fireEvent.click(screen.getByRole("radio", { name: "Confortável" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ density: "comfortable" }));
  });
});
