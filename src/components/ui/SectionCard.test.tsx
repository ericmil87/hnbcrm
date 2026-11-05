import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionCard } from "./SectionCard";

describe("SectionCard", () => {
  it("é uma região nomeada pelo h2", () => {
    render(
      <SectionCard title="Equipe" description="Quem participa" actions={<button>Convidar</button>}>
        corpo
      </SectionCard>
    );
    const region = screen.getByRole("region", { name: "Equipe" });
    expect(region.tagName).toBe("SECTION");
    expect(screen.getByRole("heading", { level: 2, name: "Equipe" })).toBeInTheDocument();
    expect(screen.getByText("Quem participa")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Convidar" })).toBeInTheDocument();
    expect(screen.getByText("corpo")).toBeInTheDocument();
  });

  it("aceita outro elemento raiz e ícone", () => {
    const { container } = render(
      <SectionCard title="X" as="div" icon={<svg data-testid="ic" />}>
        a
      </SectionCard>
    );
    expect(container.firstElementChild?.tagName).toBe("DIV");
    expect(screen.getByTestId("ic")).toBeInTheDocument();
  });
});
