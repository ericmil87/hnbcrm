import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { TermsAcceptanceBannerView } from "./TermsAcceptanceBanner";

describe("TermsAcceptanceBannerView", () => {
  it("mostra a versão, o link para revisar e o botão de aceite", () => {
    const onAccept = vi.fn();
    render(
      <MemoryRouter>
        <TermsAcceptanceBannerView version="2026-11-10" accepting={false} onAccept={onAccept} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status").textContent).toContain("2026-11-10");
    expect(screen.getByRole("link", { name: "Revisar e aceitar" }).getAttribute("href")).toBe("/termos");
    fireEvent.click(screen.getByRole("button", { name: "Aceito os Termos" }));
    expect(onAccept).toHaveBeenCalled();
  });
});
