import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BottomTabBarView } from "./BottomTabBar";
import { HelpModal } from "./HelpModal";
import { visibleNavItems } from "@/lib/nav";

const items = visibleNavItems(() => true, { central: true });
const zero = { inboxUnread: 0, pendingAttention: 0, pausedCampaigns: 0 };

function setup(over: Partial<React.ComponentProps<typeof BottomTabBarView>> = {}) {
  const onNavigate = vi.fn();
  const onToggleMore = vi.fn();
  const onOpenAppearance = vi.fn();
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
      theme="whatsapp"
      onOpenAppearance={onOpenAppearance}
      {...over}
    />
  );
  return { onNavigate, onToggleMore, onOpenAppearance };
}

function WithHelp() {
  const [more, setMore] = useState(true);
  const [help, setHelp] = useState(false);
  return (
    <>
      <BottomTabBarView
        items={items}
        activeTab="dashboard"
        badges={zero}
        showMore={more}
        orgName="Acme"
        onNavigate={vi.fn()}
        onToggleMore={() => setMore((m) => !m)}
        onOpenOrgSwitcher={vi.fn()}
        onSignOut={vi.fn()}
        theme="whatsapp"
        onOpenAppearance={vi.fn()}
        onOpenHelp={() => setHelp(true)}
      />
      <HelpModal open={help} onClose={() => setHelp(false)} />
    </>
  );
}

describe("BottomTabBarView", () => {
  it("folha aberta: Ajuda fecha a folha e abre o modal de ajuda", async () => {
    render(<WithHelp />);
    await userEvent.click(within(screen.getByRole("dialog", { name: "Mais opções" })).getByRole("button", { name: "Ajuda" }));
    expect(screen.queryByRole("dialog", { name: "Mais opções" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Ajuda" })).toBeInTheDocument();
  });

  it("sem onOpenHelp a folha não mostra Ajuda", () => {
    setup({ showMore: true });
    expect(screen.queryByRole("button", { name: "Ajuda" })).toBeNull();
  });

  it("folha aberta: linha Aparência com o tema, entre Organização e Sair", async () => {
    const { onToggleMore, onOpenAppearance } = setup({ showMore: true });
    const dialog = screen.getByRole("dialog", { name: "Mais opções" });
    const btns = within(dialog).getAllByRole("button");
    const org = btns.findIndex((b) => /Organização atual/.test(b.getAttribute("aria-label") ?? ""));
    const row = btns.findIndex((b) => b.textContent === "Aparência · Estilo WhatsApp");
    const out = btns.findIndex((b) => b.textContent === "Sair");
    expect(org).toBeLessThan(row);
    expect(row).toBeLessThan(out);
    await userEvent.click(btns[row]);
    expect(onToggleMore).toHaveBeenCalled();
    expect(onOpenAppearance).toHaveBeenCalled();
  });

  it("mostra 4 primários e Mais", () => {
    setup();
    const nav = screen.getByRole("navigation");
    const names = within(nav).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Painel", "Conversas", "Requer atenção", "Funil", "Mais opções"]);
    expect(within(nav).getByRole("button", { name: "Painel" })).toHaveAttribute("aria-current", "page");
  });

  it("modo conversa: a barra some, mas continua montada", () => {
    setup({ hidden: true });
    expect(screen.getByRole("navigation", { hidden: true })).toHaveClass("hidden");
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
