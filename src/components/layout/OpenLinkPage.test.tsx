import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { OpenLinkRedirect } from "./OpenLinkPage";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function setup(search: string, activeOrgId: string, selectOrganization = vi.fn()) {
  const mount = (active: string) => (
    <OpenLinkRedirect
      search={search}
      activeOrgId={active}
      organizationIds={["o1", "o2"]}
      selectOrganization={selectOrganization}
    />
  );
  const router = createMemoryRouter(
    [
      { path: "/app/abrir", element: mount(activeOrgId) },
      { path: "*", element: <Where /> },
    ],
    { initialEntries: [`/app/abrir${search}`] },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, selectOrganization, view, mount };
}

const link = (org: string, to: string) => `?${new URLSearchParams({ org, to }).toString()}`;

describe("/app/abrir", () => {
  it("mesma org: navega para `to` com replace", async () => {
    const { router, selectOrganization } = setup(link("o1", "/app/tarefas?task=t1"), "o1");
    await waitFor(() => expect(router.state.location.pathname).toBe("/app/tarefas"));
    expect(router.state.location.search).toBe("?task=t1");
    expect(selectOrganization).not.toHaveBeenCalled();
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("acao=assumir é repassada ao destino (a tela confirma)", async () => {
    const search = link("o1", "/app/repasses?handoff=h1") + "&acao=assumir";
    const { router } = setup(search, "o1");
    await waitFor(() => expect(router.state.location.pathname).toBe("/app/repasses"));
    expect(router.state.location.search).toBe("?handoff=h1&acao=assumir");
  });

  it("outra org: troca de org primeiro e só navega depois de ela estar ativa", async () => {
    const select = vi.fn();
    const { router } = setup(link("o2", "/app/entrada?conversation=c1"), "o1", select);
    await waitFor(() => expect(select).toHaveBeenCalledWith("o2"));
    expect(router.state.location.pathname).toBe("/app/abrir");
  });

  it.each(["//evil.com", "https://evil.com/app/x", "/\\evil.com", "/entrada", "/app/./abrir", "/app//abrir"])(
    "bloqueia `to` = %s e cai no Painel sem trocar de org",
    async (to) => {
      const { router, selectOrganization } = setup(link("o2", to), "o1");
      await waitFor(() => expect(router.state.location.pathname).toBe("/app/painel"));
      expect(selectOrganization).not.toHaveBeenCalled();
    },
  );

  it("org que não é do usuário: Painel, sem trocar", async () => {
    const { router, selectOrganization } = setup(link("outra", "/app/painel"), "o1");
    await waitFor(() => expect(router.state.location.pathname).toBe("/app/painel"));
    expect(selectOrganization).not.toHaveBeenCalled();
  });
});
