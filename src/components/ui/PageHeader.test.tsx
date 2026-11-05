import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "@/test/render";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("renderiza um único h1 com subtítulo, selo e ações", () => {
    renderWithRouter(
      <PageHeader title="Leads" subtitle="Seu funil" badge={<span>3 novos</span>} actions={<button>Novo</button>} />
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Leads" })).toBeInTheDocument();
    expect(screen.getByText("Seu funil")).toBeInTheDocument();
    expect(screen.getByText("3 novos")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Novo" })).toBeInTheDocument();
  });

  it("voltar por link", () => {
    renderWithRouter(<PageHeader title="Detalhe" back={{ to: "/leads" }} />);
    expect(screen.getByRole("link", { name: "Voltar" })).toHaveAttribute("href", "/leads");
  });

  it("voltar por clique", async () => {
    const onClick = vi.fn();
    renderWithRouter(<PageHeader title="Detalhe" back={{ onClick }} />);
    await userEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(onClick).toHaveBeenCalled();
  });

  it("sem back não mostra voltar", () => {
    renderWithRouter(<PageHeader title="Início" />);
    expect(screen.queryByLabelText("Voltar")).toBeNull();
  });
});
