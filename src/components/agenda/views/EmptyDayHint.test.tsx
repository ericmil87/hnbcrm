import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyDayHint } from "./EmptyDayHint";

describe("EmptyDayHint", () => {
  it("é um aviso de status sobreposto: absoluto e sem capturar o toque (não ocupa espaço no fluxo)", () => {
    render(<EmptyDayHint />);
    const hint = screen.getByRole("status");
    expect(hint).toHaveTextContent("Toque em um horário livre");
    expect(hint.className).toContain("absolute");
    expect(hint.className).toContain("pointer-events-none");
    expect(hint.className).not.toMatch(/(^| )(relative|static|block)( |$)/);
  });
});
