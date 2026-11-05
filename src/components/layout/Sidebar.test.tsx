import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarView } from "./Sidebar";
import { groupNavItems, visibleNavItems } from "@/lib/nav";

const items = visibleNavItems(() => true, { central: true });
const zero = { inboxUnread: 0, pendingAttention: 0, pausedCampaigns: 0 };

function setup(over: Partial<React.ComponentProps<typeof SidebarView>> = {}) {
  const onNavigate = vi.fn();
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
      {...over}
    />
  );
  return { onNavigate };
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
});
