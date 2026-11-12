import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "@/test/render";
import { HomeLogoLink } from "./HomeLogoLink";

afterEach(() => vi.restoreAllMocks());

describe("HomeLogoLink", () => {
  it("é um link acessível para a home", () => {
    renderWithRouter(<HomeLogoLink>logo</HomeLogoLink>, { route: "/precos" });
    expect(screen.getByRole("link", { name: "HNBCRM, início" })).toHaveAttribute("href", "/");
  });

  it("em outra página navega para / sem rolar à mão", async () => {
    const spy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { router } = renderWithRouter(<HomeLogoLink>logo</HomeLogoLink>, { route: "/precos" });
    await userEvent.click(screen.getByRole("link", { name: "HNBCRM, início" }));
    expect(router.state.location.pathname).toBe("/");
    expect(spy).not.toHaveBeenCalled();
  });

  it("já na home rola suave ao topo e limpa o hash", async () => {
    const spy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState(null, "", "/#precos");
    const { router } = renderWithRouter(<HomeLogoLink>logo</HomeLogoLink>, { route: "/#precos" });
    await userEvent.click(screen.getByRole("link", { name: "HNBCRM, início" }));
    expect(spy).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(router.state.location.hash).toBe("");
    window.history.replaceState(null, "", "/");
  });
});
