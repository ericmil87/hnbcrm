import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { toast } from "sonner";
import { readOnboardingDraft } from "@/lib/onboardingEntry";
import { startHref } from "@/lib/onboardingEntry";
import { S1Hero } from "./S1Hero";

vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

function setup() {
  const router = createMemoryRouter(
    [
      { path: "/", element: <S1Hero /> },
      { path: "*", element: <p>destino</p> },
    ],
    { initialEntries: ["/"] }
  );
  render(<RouterProvider router={router} />);
  return router;
}

const field = () => screen.getByRole("textbox", { name: "Mensagem para o Copiloto" });

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("S1Hero", () => {
  it("tem um h1 sem classe de animação", () => {
    setup();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("Conte como é o seu negócio. Em minutos, sua IA já atende no WhatsApp.");
    expect(h1.className).not.toMatch(/animate|transition/);
  });

  it("enviar guarda a mensagem e navega", async () => {
    const router = setup();
    fireEvent.change(field(), { target: { value: "Tenho uma clínica em Recife" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(readOnboardingDraft()).toEqual({ message: "Tenho uma clínica em Recife", niche: null });
    await vi.waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(startHref()));
  });

  it("chip guarda o nicho e a mensagem", async () => {
    const router = setup();
    fireEvent.click(screen.getByRole("button", { name: "Corretor" }));
    expect(readOnboardingDraft()).toEqual({ message: "Sou corretor e perco lead fora do horário", niche: "corretor" });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/comecar"));
  });

  it("chip Outro só foca o campo", () => {
    const router = setup();
    fireEvent.click(screen.getByRole("button", { name: "Outro" }));
    expect(field()).toHaveFocus();
    expect(readOnboardingDraft()).toBeNull();
    expect(router.state.location.pathname).toBe("/");
  });

  it.each(["Anexar arquivo (site, PDF ou imagem)", "Gravar áudio"])("%s avisa e leva ao destino", async (name) => {
    const router = setup();
    fireEvent.click(screen.getByRole("button", { name }));
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("depois de criar a conta"));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/comecar"));
  });

  it("tem controle de pausa, rolagem para a cena e linha de confiança do catálogo", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Pausar animação" }));
    expect(screen.getByRole("button", { name: "Retomar animação" })).toBeInTheDocument();
    expect(screen.getByText(/dias grátis · sem cartão · reembolso em \d+ dias/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ver como funciona/ })).toHaveAttribute("href", "#como-funciona");
  });
});
