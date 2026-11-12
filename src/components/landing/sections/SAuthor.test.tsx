import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { SAuthor } from "./SAuthor";
import { AUTHOR, MANIFESTO_TEASER } from "../manifestoCopy";

describe("SAuthor", () => {
  it("mostra o autor, a foto e o trecho do manifesto com link", () => {
    const { container } = renderWithRouter(<SAuthor />);
    expect(container.querySelector("#quem-faz")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: AUTHOR.sectionTitle })).toBeTruthy();
    expect(screen.getByText(AUTHOR.name)).toBeTruthy();
    const img = screen.getByAltText(AUTHOR.photoAlt);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(container.querySelector("blockquote")).toHaveTextContent(MANIFESTO_TEASER.quote);
    expect(screen.getByRole("link", { name: MANIFESTO_TEASER.cta }).getAttribute("href")).toBe("/manifesto");
  });

  it("links externos abrem fora com noopener", () => {
    renderWithRouter(<SAuthor />);
    for (const l of AUTHOR.links) {
      const a = screen.getByRole("link", { name: l.label });
      expect(a.getAttribute("href")).toBe(l.href);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
  });
});
