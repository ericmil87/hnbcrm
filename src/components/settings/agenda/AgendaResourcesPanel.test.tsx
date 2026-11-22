import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { archive, toast } = vi.hoisted(() => ({
  archive: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("convex/react", () => ({
  useQuery: () => [],
  useMutation: () => archive,
}));
vi.mock("@/hooks/useAgendaConfig", () => ({
  useAgendaConfig: () => ({
    config: {
      enabled: true,
      resources: [{ _id: "r1", name: "Sala 1", kind: "room", active: true, capacity: 1, weekly: [], sortOrder: 0 }],
      services: [],
    },
  }),
}));

import { AgendaResourcesPanel } from "./AgendaResourcesPanel";

describe("AgendaResourcesPanel: Voltar no aviso de horários marcados", () => {
  beforeEach(() => {
    archive.mockReset();
    vi.clearAllMocks();
    archive.mockReset();
  });
  it("Voltar não grava e não mostra o aviso 'Nada foi alterado'", async () => {
    archive.mockResolvedValue({ changed: false, futureAppointments: 3, servicesAffected: [] });
    render(<AgendaResourcesPanel organizationId={"org1" as never} />);
    await userEvent.click(screen.getByRole("button", { name: "Arquivar Sala 1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Voltar" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Voltar" })).toBeNull());
    expect(archive).toHaveBeenCalledTimes(1); // só a chamada sem aceite
    expect(toast).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
  it("aceitar repete com aceite e avisa que arquivou", async () => {
    archive.mockResolvedValueOnce({ changed: false, futureAppointments: 3, servicesAffected: [] }).mockResolvedValueOnce({ changed: true, futureAppointments: 3, servicesAffected: [] });
    render(<AgendaResourcesPanel organizationId={"org1" as never} />);
    await userEvent.click(screen.getByRole("button", { name: "Arquivar Sala 1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Arquivar mesmo assim" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(archive).toHaveBeenCalledTimes(2);
  });
});
