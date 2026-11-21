import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const modules = vi.hoisted(() => ({ value: { scheduling: false } as { scheduling: boolean }, loading: false }));

vi.mock("react-router", () => ({ useOutletContext: () => ({ organizationId: "org1" }) }));
vi.mock("@/hooks/useOrgModules", () => ({ useOrgModules: () => ({ modules: modules.value, isLoading: modules.loading, anyEnabled: false }) }));
vi.mock("@/components/calendar/CalendarPage", () => ({ CalendarPage: () => <div>pagina-de-compromissos</div> }));
vi.mock("./views/AgendaPage", () => ({ AgendaPage: () => <div>pagina-v2</div> }));

import { AgendaEntry } from "./AgendaEntry";

describe("AgendaEntry", () => {
  beforeEach(() => {
    modules.value = { scheduling: false };
    modules.loading = false;
  });

  it("módulo desligado: a página de compromissos de hoje, nada da v2", () => {
    render(<AgendaEntry />);
    expect(screen.getByText("pagina-de-compromissos")).toBeInTheDocument();
    expect(screen.queryByText("pagina-v2")).toBeNull();
  });

  it("módulo ligado: a página da v2", async () => {
    modules.value = { scheduling: true };
    render(<AgendaEntry />);
    expect(await screen.findByText("pagina-v2")).toBeInTheDocument();
    expect(screen.queryByText("pagina-de-compromissos")).toBeNull();
  });

  it("carregando os módulos: spinner, nem a página antiga nem a nova", () => {
    modules.loading = true;
    modules.value = { scheduling: true };
    render(<AgendaEntry />);
    expect(screen.queryByText("pagina-de-compromissos")).toBeNull();
    expect(screen.queryByText("pagina-v2")).toBeNull();
  });
});
