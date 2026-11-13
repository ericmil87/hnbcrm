import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovableCard } from "./ApprovableCard";

describe("ApprovableCard: o que abre fica à vista", () => {
  it("'Ajustar' abre o editor: o cartão rola para a vista e o primeiro campo recebe o foco", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { rerender } = render(
      <ApprovableCard title="Jeito de atender" approval={{ approved: false, onApprove: vi.fn() }} onAdjust={vi.fn()}>
        <p>Conteúdo</p>
      </ApprovableCard>
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(
      <ApprovableCard title="Jeito de atender" approval={{ approved: false, onApprove: vi.fn() }} onAdjust={vi.fn()} formOpen>
        <label>
          Nome da IA
          <input />
        </label>
      </ApprovableCard>
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText("Nome da IA")).toHaveFocus());
  });

  it("'Ver' num cartão aprovado também traz o cartão à vista (sem roubar o foco)", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(
      <ApprovableCard title="Funil" approval={{ approved: true }} onAdjust={vi.fn()}>
        <input aria-label="campo" />
      </ApprovableCard>
    );
    await userEvent.click(screen.getByRole("button", { name: "Ver" }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(screen.getByLabelText("campo")).not.toHaveFocus();
  });
});
