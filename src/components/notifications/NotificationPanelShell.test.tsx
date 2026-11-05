import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationPanelShell } from "./NotificationPanel";

function mockMobile(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function Harness({ open = true, hasUnread = true, onClose = vi.fn(), onMarkAllRead = vi.fn() }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <header className="backdrop-blur h-14">
      <button ref={ref} type="button">
        sino
      </button>
      <NotificationPanelShell
        open={open}
        onClose={onClose}
        anchor={ref}
        hasUnread={hasUnread}
        onMarkAllRead={onMarkAllRead}
      >
        <ul>
          <li>Pedido de ajuda</li>
        </ul>
      </NotificationPanelShell>
    </header>
  );
}

describe("NotificationPanelShell", () => {
  it("no mobile renderiza fora do header (portal no body) com título, ação e lista", async () => {
    mockMobile(true);
    const { container } = render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Notificações" });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(screen.getByRole("heading", { name: "Notificações" })).toBeInTheDocument();
    expect(screen.getByText("Pedido de ajuda")).toBeVisible();
    // Folha inferior com fundo próprio.
    expect(dialog).toHaveClass("bg-surface-overlay");
  });

  it("no desktop também usa portal e ancora com largura fixa", () => {
    mockMobile(false);
    const { container } = render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Notificações" });
    expect(container.contains(dialog)).toBe(false);
    expect(dialog).toHaveClass("w-96");
  });

  it("Marcar todas como lidas só aparece com não lidas e dispara o callback", async () => {
    mockMobile(false);
    const onMarkAllRead = vi.fn();
    const { rerender } = render(<Harness onMarkAllRead={onMarkAllRead} />);
    await userEvent.click(screen.getByRole("button", { name: "Marcar todas como lidas" }));
    expect(onMarkAllRead).toHaveBeenCalled();
    rerender(<Harness hasUnread={false} />);
    expect(screen.queryByRole("button", { name: "Marcar todas como lidas" })).toBeNull();
  });

  it("Esc chama onClose e fechado não renderiza nada", async () => {
    mockMobile(false);
    const onClose = vi.fn();
    const { rerender } = render(<Harness onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    rerender(<Harness open={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
