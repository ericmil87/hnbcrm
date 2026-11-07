import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PageHeaderProvider, PageHeaderSlot, usePageHeader, usePageHeaderRegistry, type PageMenuItem } from "./pageHeader";

function Shell({ children, globalMenuItems }: { children: ReactNode; globalMenuItems?: PageMenuItem[] }) {
  const registry = usePageHeaderRegistry();
  return (
    <PageHeaderProvider registry={registry.registry}>
      <header>
        <PageHeaderSlot registration={registry.registration} globalMenuItems={globalMenuItems} />
      </header>
      {children}
    </PageHeaderProvider>
  );
}

function Page({ onNew, onSelectCount }: { onNew: () => void; onSelectCount: (n: number) => void }) {
  const [count, setCount] = useState(0);
  usePageHeader({
    menuItems: [{ id: "select", label: `Selecionar (${count > 0 ? "de novo" : "1ª vez"})`, onSelect: () => onSelectCount(count) }],
    actions: [{ id: "new", label: "Nova conversa", icon: <span>+</span>, onSelect: onNew }],
  });
  return (
    <button type="button" onClick={() => setCount((c) => c + 1)}>
      Incrementar
    </button>
  );
}

describe("usePageHeader + PageHeaderSlot", () => {
  it("a página põe ⋯ e ação no cabeçalho e o AppShell chama o onSelect mais recente", async () => {
    const onNew = vi.fn();
    const onSelectCount = vi.fn();
    render(
      <Shell>
        <Page onNew={onNew} onSelectCount={onSelectCount} />
      </Shell>
    );
    await userEvent.click(await screen.findByRole("button", { name: "Nova conversa" }));
    expect(onNew).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Incrementar" }));
    await userEvent.click(screen.getByRole("button", { name: "Mais ações" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Selecionar (de novo)" }));
    expect(onSelectCount).toHaveBeenCalledWith(1);
  });

  it("itens globais vêm antes dos da página; sem página, só os globais", async () => {
    const copilot = vi.fn();
    const { rerender } = render(
      <Shell globalMenuItems={[{ id: "copilot", label: "Copiloto", onSelect: copilot }]}>
        <Page onNew={() => {}} onSelectCount={() => {}} />
      </Shell>
    );
    await userEvent.click(await screen.findByRole("button", { name: "Mais ações" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Copiloto", "Selecionar (1ª vez)"]);
    await userEvent.keyboard("{Escape}");

    rerender(<Shell globalMenuItems={[{ id: "copilot", label: "Copiloto", onSelect: copilot }]}>{null}</Shell>);
    expect(screen.queryByRole("button", { name: "Nova conversa" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mais ações" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Copiloto"]);
  });

  it("fora do AppShell não quebra", () => {
    render(<Page onNew={() => {}} onSelectCount={() => {}} />);
    expect(screen.getByRole("button", { name: "Incrementar" })).toBeInTheDocument();
  });
});
