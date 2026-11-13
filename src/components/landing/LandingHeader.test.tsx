import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { SESSION_HINT_KEY } from "@/lib/sessionHint";
import { LandingHeader } from "./LandingHeader";

function storageWith(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
}

describe("LandingHeader e sessão", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sem sessão: Entrar e Testar grátis", () => {
    vi.stubGlobal("localStorage", storageWith({}));
    renderWithRouter(<LandingHeader />);
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/entrar");
    expect(screen.queryByRole("link", { name: "Abrir o meu CRM" })).not.toBeInTheDocument();
  });

  it("com a marca de sessão: Abrir o meu CRM (lida depois de montar)", async () => {
    vi.stubGlobal("localStorage", storageWith({ [SESSION_HINT_KEY]: "1" }));
    renderWithRouter(<LandingHeader />);
    expect(await screen.findByRole("link", { name: "Abrir o meu CRM" })).toHaveAttribute("href", "/app");
    expect(screen.queryByRole("link", { name: "Entrar" })).not.toBeInTheDocument();
  });
});
