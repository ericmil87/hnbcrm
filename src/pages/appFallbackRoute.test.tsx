import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, Navigate, Outlet, RouterProvider } from "react-router";
import { TAB_ROUTES } from "@/lib/routes";

// Mesmo desenho do `/app` em main.tsx: o curinga precisa de destino absoluto,
// senão `to="painel"` resolve a partir da URL inteira e entra em loop.
function makeRouter(initial: string) {
  return createMemoryRouter(
    [
      {
        path: "/app",
        element: <Outlet />,
        children: [
          { path: "painel", element: <p>Painel</p> },
          { path: "*", element: <Navigate to={TAB_ROUTES.dashboard} replace /> },
        ],
      },
    ],
    { initialEntries: [initial] }
  );
}

describe("curinga dentro de /app", () => {
  it.each(["/app/foo", "/app/foo/bar", "/app/painel/x"])("%s termina em /app/painel", (path) => {
    const router = makeRouter(path);
    render(<RouterProvider router={router} />);
    expect(router.state.location.pathname).toBe("/app/painel");
    expect(screen.getByText("Painel")).toBeInTheDocument();
  });
});
