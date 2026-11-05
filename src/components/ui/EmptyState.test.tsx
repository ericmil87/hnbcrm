import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inbox } from "lucide-react";
import { renderWithRouter } from "@/test/render";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("mantém h3 por padrão e aceita h2", () => {
    const { unmount } = renderWithRouter(<EmptyState icon={Inbox} title="Vazio" description="Nada aqui" />);
    expect(screen.getByRole("heading", { level: 3, name: "Vazio" })).toBeInTheDocument();
    expect(screen.getByText("Nada aqui")).toBeInTheDocument();
    unmount();
    renderWithRouter(<EmptyState icon={Inbox} title="Vazio" headingLevel="h2" />);
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
  });

  it("ação principal por clique", async () => {
    const onClick = vi.fn();
    renderWithRouter(<EmptyState icon={Inbox} title="T" action={{ label: "Criar", onClick }} />);
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    expect(onClick).toHaveBeenCalled();
  });

  it("action.href vira Link e secondaryAction aparece", () => {
    renderWithRouter(
      <EmptyState
        icon={Inbox}
        title="T"
        action={{ label: "Ir", href: "/leads" }}
        secondaryAction={{ label: "Depois", onClick: () => {} }}
      />
    );
    expect(screen.getByRole("link", { name: "Ir" })).toHaveAttribute("href", "/leads");
    expect(screen.getByRole("button", { name: "Depois" })).toBeInTheDocument();
  });

  it("renderiza children e tamanho sm", () => {
    const { container } = renderWithRouter(
      <EmptyState icon={Inbox} title="T" size="sm">
        <span>extra</span>
      </EmptyState>
    );
    expect(screen.getByText("extra")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("py-6");
  });
});
