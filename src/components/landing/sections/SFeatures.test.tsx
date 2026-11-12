import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { FEATURE_HIGHLIGHTS } from "../featuresCatalog";
import { SFeatures } from "./SFeatures";

describe("SFeatures", () => {
  it("mostra os oito destaques, sem 'Em breve', e leva a /funcionalidades", () => {
    const { container } = renderWithRouter(<SFeatures />);
    expect(container.querySelector("#funcionalidades")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Tudo num lugar só" })).toBeInTheDocument();
    for (const h of FEATURE_HIGHLIGHTS) expect(screen.getByRole("heading", { level: 3, name: h.title })).toBeInTheDocument();
    expect(screen.queryByText(/Em breve/)).toBeNull();
    expect(screen.getByRole("link", { name: "Ver todas as funcionalidades" })).toHaveAttribute("href", "/funcionalidades");
  });
});
