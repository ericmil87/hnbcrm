import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazy, Suspense } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { RouteErrorPage } from "./RouteErrorPage";

function Boom(): never {
  throw new TypeError("Failed to fetch dynamically imported module: /assets/Chunk-abc.js");
}

describe("RouteErrorPage", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mostra a mensagem e o botão Recarregar quando a rota falha", () => {
    const router = createMemoryRouter(
      [{ path: "/", element: <Boom />, errorElement: <RouteErrorPage /> }],
      { initialEntries: ["/"] }
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByText("Algo deu errado.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recarregar" })).toBeInTheDocument();
  });

  it("Recarregar chama window.location.reload", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const router = createMemoryRouter(
      [{ path: "/", element: <Boom />, errorElement: <RouteErrorPage /> }],
      { initialEntries: ["/"] }
    );
    render(<RouterProvider router={router} />);

    await userEvent.click(screen.getByRole("button", { name: "Recarregar" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("mostra Recarregar quando o chunk lazy falha ao carregar", async () => {
    const Broken = lazy(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module"))
    );
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <Suspense fallback={null}>
              <Broken />
            </Suspense>
          ),
          errorElement: <RouteErrorPage />,
        },
      ],
      { initialEntries: ["/"] }
    );
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("button", { name: "Recarregar" })).toBeInTheDocument();
  });
});
