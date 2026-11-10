import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PUBLIC_THEME_STORAGE_KEY, THEME_STORAGE_KEY } from "@/lib/theme";
import { applyTheme } from "@/lib/themeDom";
import { PublicThemeButton } from "./PublicThemeButton";

afterEach(() => {
  localStorage.clear();
  applyTheme("whatsapp");
});

describe("PublicThemeButton", () => {
  it("lista os 4 temas como menuitemradio com o atual marcado", async () => {
    applyTheme("whatsapp");
    render(<PublicThemeButton />);
    await userEvent.click(screen.getByRole("button", { name: "Escolher tema" }));
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["Estilo WhatsApp", "WhatsApp escuro", "Escuro", "Claro"]);
    expect(screen.getByRole("menuitemradio", { name: "Estilo WhatsApp" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Escuro" })).toHaveAttribute("aria-checked", "false");
  });

  it("aplica na hora e grava só a chave pública do aparelho", async () => {
    render(<PublicThemeButton />);
    await userEvent.click(screen.getByRole("button", { name: "Escolher tema" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "WhatsApp escuro" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("whatsapp-dark");
    expect(localStorage.getItem(PUBLIC_THEME_STORAGE_KEY)).toBe("whatsapp-dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Escolher tema" }));
    expect(await screen.findByRole("menuitemradio", { name: "WhatsApp escuro" })).toHaveAttribute("aria-checked", "true");
  });
});
