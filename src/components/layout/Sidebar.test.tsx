import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarView } from "./Sidebar";
import { groupNavItems, visibleNavItems } from "@/lib/nav";

const items = visibleNavItems(() => true, { central: true });
const zero = { inboxUnread: 0, pendingAttention: 0, pausedCampaigns: 0 };

function setup(over: Partial<React.ComponentProps<typeof SidebarView>> = {}) {
  const onNavigate = vi.fn();
  const onOpenAppearance = vi.fn();
  render(
    <SidebarView
      items={items}
      groups={groupNavItems(items)}
      activeTab="inbox"
      badges={zero}
      collapsed={false}
      orgName="Acme"
      onNavigate={onNavigate}
      onSignOut={vi.fn()}
      onOpenOrgSwitcher={vi.fn()}
      onOpenAppearance={onOpenAppearance}
      {...over}
    />
  );
  return { onNavigate, onOpenAppearance };
}

describe("SidebarView", () => {
  it("marca só o item ativo com aria-current=page", () => {
    setup();
    const current = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Conversas");
  });

  it("badge com texto acessível", () => {
    setup({ badges: { ...zero, inboxUnread: 3, pendingAttention: 1 } });
    expect(screen.getByRole("button", { name: "Conversas, 3 não lidas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Requer atenção, 1 pedido de ajuda" })).toBeInTheDocument();
  });

  it("renderiza os 4 grupos com rótulo e os itens em ordem", () => {
    setup();
    for (const label of ["Atendimento", "Organização", "Divulgação", "Gestão"]) {
      expect(screen.getByRole("group", { name: label })).toBeInTheDocument();
    }
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names.indexOf("Painel")).toBeLessThan(names.indexOf("Conversas"));
    expect(names.indexOf("Conversas")).toBeLessThan(names.indexOf("Requer atenção"));
  });

  it("Ajuda só aparece com onOpenHelp e abre o menu", async () => {
    setup();
    expect(screen.queryByRole("button", { name: "Ajuda" })).toBeNull();
    cleanup();
    const onOpenHelp = vi.fn();
    setup({ onOpenHelp });
    await userEvent.setup().click(screen.getByRole("button", { name: "Ajuda" }));
    expect(onOpenHelp).toHaveBeenCalledOnce();
  });

  it("botão Aparência fica acima de Sair, com 44 px, e abre o seletor", async () => {
    const { onOpenAppearance } = setup();
    const btn = screen.getByRole("button", { name: "Aparência" });
    expect(btn.className).toContain("min-h-[44px]");
    const all = screen.getAllByRole("button");
    expect(all.indexOf(btn)).toBe(all.indexOf(screen.getByRole("button", { name: "Sair" })) - 1);
    await userEvent.click(btn);
    expect(onOpenAppearance).toHaveBeenCalled();
  });

  it("navega ao clicar", async () => {
    const { onNavigate } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Agenda" }));
    expect(onNavigate).toHaveBeenCalledWith("calendar");
  });

  it("colapsada mostra Tooltip no hover e não usa title", async () => {
    setup({ collapsed: true });
    expect(document.querySelector("nav [title]")).toBeNull();
    await userEvent.hover(screen.getByRole("button", { name: "Funil" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Funil");
  });

  it("sem onOpenCopilot a barra lateral não mostra o Copiloto", async () => {
    setup();
    expect(screen.queryByRole("button", { name: "Copiloto" })).not.toBeInTheDocument();
  });

  it("Copiloto na barra lateral: 44 px, ícone com aria-label, chama onOpenCopilot", async () => {
    const onOpenCopilot = vi.fn();
    setup({ onOpenCopilot, collapsed: true });
    const btn = screen.getByRole("button", { name: "Copiloto" });
    expect(btn.className).toContain("min-h-[44px]");
    await userEvent.click(btn);
    expect(onOpenCopilot).toHaveBeenCalled();
  });
});
