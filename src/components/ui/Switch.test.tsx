import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "./Switch";

function Controlled({ disabled }: { disabled?: boolean }) {
  const [on, setOn] = useState(false);
  return <Switch checked={on} onCheckedChange={setOn} label="Notificações" disabled={disabled} />;
}

describe("Switch", () => {
  it("alterna por clique e por Espaço", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const sw = screen.getByRole("switch", { name: "Notificações" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await user.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    sw.focus();
    await user.keyboard(" ");
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("clicar no rótulo alterna", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.click(screen.getByText("Notificações"));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("disabled não alterna", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} label="X" disabled />);
    await user.click(screen.getByRole("switch"));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("aria-checked reflete a prop e onCheckedChange recebe o novo valor", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked onCheckedChange={onCheckedChange} label="X" />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "true");
    await user.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("hideLabel usa aria-label e aplica className no botão; sm mantém área de toque ampliada", () => {
    render(<Switch checked={false} onCheckedChange={() => {}} label="Ativar" hideLabel size="sm" className="minha-classe" />);
    const sw = screen.getByRole("switch", { name: "Ativar" });
    expect(sw).toHaveClass("minha-classe");
    expect(sw.className).toContain("before:-inset-y-3");
  });

  it("liga a descrição por aria-describedby", () => {
    render(<Switch checked={false} onCheckedChange={() => {}} label="A" description="Explica A" />);
    expect(screen.getByRole("switch")).toHaveAccessibleDescription("Explica A");
  });
});
