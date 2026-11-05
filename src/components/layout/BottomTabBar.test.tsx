import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BottomTabBarView } from "./BottomTabBar";
import { visibleNavItems } from "@/lib/nav";

const items = visibleNavItems(() => true, { central: true });
const zero = { inboxUnread: 0, pendingAttention: 0, pausedCampaigns: 0 };

function setup(over: Partial<React.ComponentProps<typeof BottomTabBarView>> = {}) {
  const onNavigate = vi.fn();
  const onToggleMore = vi.fn();
  render(
    <BottomTabBarView
      items={items}
      activeTab="dashboard"
      badges={zero}
      showMore={false}
      orgName="Acme"
      onNavigate={onNavigate}
      onToggleMore={onToggleMore}
      onOpenOrgSwitcher={vi.fn()}
      onSignOut={vi.fn()}
      {...over}
    />
  );
  return { onNavigate, onToggleMore };
}

describe("BottomTabBarView", () => {
  it("mostra 4 primários e Mais", () => {
    setup();
    const nav = screen.getByRole("navigation");
    const names = within(nav).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Painel", "Conversas", "Requer atenção", "Funil", "Mais opções"]);
    expect(within(nav).getByRole("button", { name: "Painel" })).toHaveAttribute("aria-current", "page");
  });

  it("ponto no Mais quando item escondido tem badge", () => {
    setup({ badges: { ...zero, pausedCampaigns: 2 } });
    expect(screen.getByRole("button", { name: /Mais opções, há itens/ })).toBeInTheDocument();
  });

  it("folha aberta: Contatos, Tarefas e Agenda primeiro, org e Sair no rodapé", async () => {
    const { onNavigate, onToggleMore } = setup({ showMore: true });
    const dialog = screen.getByRole("dialog", { name: "Mais opções" });
    const names = within(dialog).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names.slice(1, 4)).toEqual(["Contatos", "Tarefas", "Agenda"]);
    expect(within(dialog).getByRole("button", { name: /Organização atual: Acme/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Sair" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Tarefas" }));
    expect(onNavigate).toHaveBeenCalledWith("tasks");
    expect(onToggleMore).toHaveBeenCalled();
  });
});
