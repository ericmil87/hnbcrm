import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppearancePicker } from "./AppearancePicker";
import type { UiTheme } from "@/lib/theme";

function Controlled({ spy }: { spy: (t: UiTheme) => void }) {
  const [v, setV] = useState<UiTheme>("dark");
  return <AppearancePicker value={v} onValueChange={(t) => { spy(t); setV(t); }} />;
}

describe("AppearancePicker", () => {
  it("mostra 3 opções e marca só a selecionada", () => {
    render(<AppearancePicker value="light" onValueChange={vi.fn()} />);
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /Claro/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Escuro/ })).toHaveAttribute("aria-checked", "false");
  });

  it("seleciona por clique", async () => {
    const onValueChange = vi.fn();
    render(<AppearancePicker value="dark" onValueChange={onValueChange} />);
    await userEvent.click(screen.getByRole("radio", { name: /Estilo WhatsApp/ }));
    expect(onValueChange).toHaveBeenCalledWith("whatsapp");
  });

  it("navega por setas, Home e End", async () => {
    const onValueChange = vi.fn();
    render(<Controlled spy={onValueChange} />);
    screen.getByRole("radio", { name: /Escuro/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onValueChange).toHaveBeenLastCalledWith("light");
    await userEvent.keyboard("{ArrowLeft}");
    expect(onValueChange).toHaveBeenLastCalledWith("dark");
    await userEvent.keyboard("{ArrowLeft}");
    expect(onValueChange).toHaveBeenLastCalledWith("whatsapp");
    await userEvent.keyboard("{End}");
    expect(onValueChange).toHaveBeenLastCalledWith("whatsapp");
    await userEvent.keyboard("{Home}");
    expect(onValueChange).toHaveBeenLastCalledWith("dark");
  });

  it("desabilitado não muda", async () => {
    const onValueChange = vi.fn();
    render(<AppearancePicker value="dark" onValueChange={onValueChange} disabled />);
    await userEvent.click(screen.getByRole("radio", { name: /Claro/ }));
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
