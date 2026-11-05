import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "@/components/ui/Badge";

describe("infra de teste de componente", () => {
  it("renderiza um primitivo no jsdom", () => {
    render(<Badge variant="success">Ativo</Badge>);
    expect(screen.getByText("Ativo")).toBeInTheDocument();
  });
});
