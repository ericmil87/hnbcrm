import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { readOnboardingDraft } from "@/lib/onboardingEntry";
import { FinalCta } from "./FinalCta";

vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

function setup() {
  const router = createMemoryRouter(
    [
      { path: "/", element: <FinalCta /> },
      { path: "*", element: <p>destino</p> },
    ],
    { initialEntries: ["/"] }
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FinalCta", () => {
  it("usa o composer do hero e envia como o hero: guarda a mensagem e vai para /comecar", async () => {
    const router = setup();
    expect(screen.getByRole("heading", { level: 2, name: "Conte como é o seu negócio. A sua IA começa daí." })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem para o Copiloto" }), {
      target: { value: "Tenho uma loja de roupas" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(readOnboardingDraft()).toEqual({ message: "Tenho uma loja de roupas", niche: null });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/comecar"));
  });

  it("chip guarda o nicho e a mensagem", async () => {
    const router = setup();
    fireEvent.click(screen.getByRole("button", { name: "Corretor" }));
    expect(readOnboardingDraft()).toEqual({ message: "Sou corretor e perco lead fora do horário", niche: "corretor" });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/comecar"));
  });
});
