import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfigPreview } from "./ConfigPreview";

describe("ConfigPreview", () => {
  it("destaca Antes/Depois em negrito", () => {
    render(<ConfigPreview preview={"Persona\nAntes: 10 caracteres\nDepois: 20 caracteres"} />);
    expect(screen.getByText("Antes: 10 caracteres")).toHaveClass("font-semibold", "text-text-primary");
    expect(screen.getByText("Depois: 20 caracteres")).toHaveClass("font-semibold", "text-text-primary");
  });

  it("colore linhas de diff por prefixo", () => {
    render(<ConfigPreview preview={"- velho\n+ novo"} />);
    expect(screen.getByText("- velho")).toHaveClass("text-semantic-error");
    expect(screen.getByText("+ novo")).toHaveClass("text-semantic-success");
  });

  it("texto comum fica secundário e preserva quebras", () => {
    const { container } = render(<ConfigPreview preview={"Alterar persona\n\nfim"} />);
    expect(screen.getByText("Alterar persona")).toHaveClass("text-text-secondary");
    expect(container.firstChild).toHaveClass("whitespace-pre-wrap");
    expect(container.querySelectorAll("[data-kind]")).toHaveLength(3);
  });

  it("não interpreta HTML", () => {
    render(<ConfigPreview preview={"<b>x</b>"} />);
    expect(screen.getByText("<b>x</b>")).toBeInTheDocument();
  });
});
