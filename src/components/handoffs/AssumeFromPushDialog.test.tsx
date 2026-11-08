import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { renderWithRouter } from "@/test/render";
import { AssumeFromPushDialog } from "./AssumeFromPushDialog";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

describe("AssumeFromPushDialog", () => {
  it("acao=assumir pede confirmação e só assume ao confirmar", async () => {
    const onAccept = vi.fn();
    const { router } = renderWithRouter(<AssumeFromPushDialog handoffId="h1" handoffs={[{ _id: "h1" }]} onAccept={onAccept} />, {
      route: "/app/repasses?handoff=h1&acao=assumir",
    });
    expect(screen.getByText("Assumir este pedido de ajuda?")).toBeTruthy();
    expect(onAccept).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Assumir" }));
    expect(onAccept).toHaveBeenCalledWith("h1");
    await waitFor(() => expect(router.state.location.search).toBe("?handoff=h1"));
  });

  it("cancelar limpa a acao sem assumir", async () => {
    const onAccept = vi.fn();
    const { router } = renderWithRouter(<AssumeFromPushDialog handoffId="h1" handoffs={[{ _id: "h1" }]} onAccept={onAccept} />, {
      route: "/app/repasses?handoff=h1&acao=assumir",
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onAccept).not.toHaveBeenCalled();
    await waitFor(() => expect(router.state.location.search).toBe("?handoff=h1"));
  });

  it("sem acao na URL não pergunta nada", () => {
    renderWithRouter(<AssumeFromPushDialog handoffId="h1" handoffs={[{ _id: "h1" }]} onAccept={vi.fn()} />, { route: "/app/repasses?handoff=h1" });
    expect(screen.queryByText("Assumir este pedido de ajuda?")).toBeNull();
  });

  it("pedido que já saiu da fila avisa e não pergunta", async () => {
    renderWithRouter(<AssumeFromPushDialog handoffId="h1" handoffs={[]} onAccept={vi.fn()} />, { route: "/app/repasses?handoff=h1&acao=assumir" });
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(screen.queryByText("Assumir este pedido de ajuda?")).toBeNull();
  });
});
