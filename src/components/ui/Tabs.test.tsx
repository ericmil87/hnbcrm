import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tabs, TabPanel } from "./Tabs";

const ITEMS = [
  { id: "a", label: "Leads" },
  { id: "b", label: "Contatos", disabled: true },
  { id: "c", label: "Times", badge: 3 },
];

function Harness() {
  const [v, setV] = useState("a");
  return (
    <>
      <Tabs value={v} onValueChange={setV} items={ITEMS} ariaLabel="Entidades" />
      <TabPanel id={v}>conteúdo {v}</TabPanel>
    </>
  );
}

describe("Tabs", () => {
  it("expõe roles e aria-selected único", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Entidades" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[2]).toHaveAttribute("tabindex", "-1");
    const panel = screen.getByRole("tabpanel");
    expect(tabs[0]).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", tabs[0].id);
  });

  it("setas movem foco e selecionam, pulando desabilitado", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("tab", { name: "Leads" }).focus();
    await user.keyboard("{ArrowRight}");
    const times = screen.getByRole("tab", { name: /Times/ });
    expect(times).toHaveFocus();
    expect(times).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(1);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Leads" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(times).toHaveFocus();
  });

  it("Home e End", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("tab", { name: "Leads" }).focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: /Times/ })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Leads" })).toHaveAttribute("aria-selected", "true");
  });

  it("clique seleciona e desabilitado não", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("tab", { name: "Contatos" }));
    expect(screen.getByRole("tab", { name: "Leads" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: /Times/ }));
    expect(screen.getByText("conteúdo c")).toBeInTheDocument();
  });
});
