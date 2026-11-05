import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { AttentionBanner } from "./AttentionBanner";

describe("AttentionBanner", () => {
  it("some com zero", () => {
    const { container } = renderWithRouter(<AttentionBanner count={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("singular com um pedido", () => {
    renderWithRouter(<AttentionBanner count={1} />);
    expect(screen.getByRole("status")).toHaveTextContent("1 conversa precisa de você");
  });

  it("plural com vários pedidos", () => {
    renderWithRouter(<AttentionBanner count={3} />);
    expect(screen.getByRole("status")).toHaveTextContent("3 conversas precisam de você");
  });

  it("'Ver' leva para Requer atenção", () => {
    renderWithRouter(<AttentionBanner count={2} />);
    expect(screen.getByRole("link", { name: "Ver" })).toHaveAttribute("href", "/app/repasses");
  });
});
