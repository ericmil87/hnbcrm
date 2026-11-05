import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

interface RenderWithRouterOptions {
  /** Rota inicial (pathname + search). */
  route?: string;
  /** Caminho em que o elemento é montado; por padrão, qualquer rota. */
  path?: string;
}

/** Renderiza `ui` dentro de um roteador em memória. */
export function renderWithRouter(ui: ReactElement, { route = "/", path = "*" }: RenderWithRouterOptions = {}) {
  const router = createMemoryRouter([{ path, element: ui }], { initialEntries: [route] });
  return { router, ...render(<RouterProvider router={router} />) };
}
