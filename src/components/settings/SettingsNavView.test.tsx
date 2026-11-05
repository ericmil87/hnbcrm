import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Bell, Building2 } from "lucide-react";
import { SettingsNavView, type SettingsNavGroup } from "./SettingsNavView";

const GROUPS: SettingsNavGroup[] = [
  {
    id: "conta",
    label: "Conta",
    panels: [
      { id: "general", label: "Dados da empresa", description: "Nome e fuso", icon: Building2 },
      { id: "notifications", label: "Notificações", description: "Avisos", icon: Bell },
    ],
  },
];

describe("SettingsNavView", () => {
  it("clicar chama onSelect com o id do painel", async () => {
    const onSelect = vi.fn();
    render(<SettingsNavView groups={GROUPS} active={null} onSelect={onSelect} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Notificações/ }));
    expect(onSelect).toHaveBeenCalledWith("notifications");
  });

  it("marca só o painel ativo com aria-current", () => {
    render(<SettingsNavView groups={GROUPS} active="general" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Dados da empresa/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /Notificações/ })).not.toHaveAttribute("aria-current");
  });

  it("mostra o rótulo do grupo; na lista, também a descrição", () => {
    const { rerender } = render(<SettingsNavView groups={GROUPS} active={null} onSelect={() => {}} />);
    expect(screen.getByText("Conta")).toBeInTheDocument();
    expect(screen.queryByText("Nome e fuso")).not.toBeInTheDocument();
    rerender(<SettingsNavView groups={GROUPS} active={null} onSelect={() => {}} variant="list" />);
    expect(screen.getByText("Nome e fuso")).toBeInTheDocument();
  });
});
