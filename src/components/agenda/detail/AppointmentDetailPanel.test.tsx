import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";

const h = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  fn: {} as Record<string, ReturnType<typeof vi.fn>>,
  access: { canEdit: true },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: never, args: unknown) => (args === "skip" ? undefined : h.queries[getFunctionName(ref)]),
  useMutation: (ref: never) => h.fn[getFunctionName(ref)] ?? vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/hooks/useOrgTimezone", () => ({ useOrgTimezone: () => "America/Sao_Paulo" }));
vi.mock("@/hooks/useAgendaAccess", () => ({ useAgendaAccess: () => ({ canView: true, canViewAll: true, canManage: false, isLoading: false, ...h.access }) }));

import { AppointmentDetailPanel } from "./AppointmentDetailPanel";

const HOUR = 3_600_000;
const appointment = (over: Record<string, unknown> = {}) => ({
  _id: "a1",
  serviceId: "svc1",
  serviceName: "Sessão",
  status: "pending_approval",
  origin: "ai",
  startTime: Date.now() + 24 * HOUR,
  endTime: Date.now() + 25 * HOUR,
  contactName: "Maria",
  resources: [{ resourceId: "room1", role: "Sala", name: "Sala 1", allocated: true }],
  createdAt: Date.now() - HOUR,
  ...over,
});

function setup(appt: Record<string, unknown>, canEdit = true) {
  h.access.canEdit = canEdit;
  h.queries["scheduling:getAppointment"] = { appointment: appt, openConflicts: [], canEdit };
  h.queries["schedulingConfig:getConfig"] = { resources: [] };
  render(<AppointmentDetailPanel organizationId={"org1" as never} appointmentId={"a1" as never} onClose={vi.fn()} />);
}

describe("AppointmentDetailPanel", () => {
  beforeEach(() => {
    h.fn = {
      "schedulingMutations:setAppointmentStatus": vi.fn().mockResolvedValue(null),
      "schedulingMutations:cancelAppointment": vi.fn().mockResolvedValue(null),
      "schedulingMutations:undoAppointmentStatus": vi.fn().mockResolvedValue({ restoredTo: "scheduled" }),
    };
    h.toast.success.mockReset();
    h.toast.error.mockReset();
  });

  it("mostra dados, status e origem", () => {
    setup(appointment({ status: "confirmed", origin: "staff" }));
    expect(screen.getByText("Maria")).toBeInTheDocument();
    expect(screen.getByText("Confirmado")).toBeInTheDocument();
    expect(screen.getByText("Equipe")).toBeInTheDocument();
    expect(screen.getByText("Sala 1")).toBeInTheDocument();
  });

  it("aprovar proposta vencida falha e oferece (e destaca) 'Recusar proposta'", async () => {
    h.fn["schedulingMutations:setAppointmentStatus"].mockRejectedValueOnce(
      new ConvexError("Esta proposta venceu: o horário proposto já passou. Recuse a proposta e marque de novo.")
    );
    setup(appointment());
    await userEvent.click(screen.getByRole("button", { name: "Aprovar proposta" }));
    expect(await screen.findByText(/não vale mais\. Recuse a proposta/)).toBeInTheDocument();
    expect(h.toast.error).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Recusar proposta" }));
    await waitFor(() => expect(h.fn["schedulingMutations:cancelAppointment"]).toHaveBeenCalledWith({ organizationId: "org1", appointmentId: "a1" }));
  });

  it("confirmar muda o status e oferece desfazer", async () => {
    setup(appointment({ status: "scheduled", origin: "staff" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(h.fn["schedulingMutations:setAppointmentStatus"]).toHaveBeenCalledWith({ organizationId: "org1", appointmentId: "a1", to: "confirmed" }));
    expect(h.toast.success).toHaveBeenCalledWith("Horário confirmado", expect.objectContaining({ action: expect.objectContaining({ label: "Desfazer" }) }));
  });

  it("cancelar pede motivo opcional e oferece desfazer", async () => {
    setup(appointment({ status: "scheduled", origin: "staff" }));
    await userEvent.click(screen.getByRole("button", { name: "Mais ações do horário" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Cancelar horário" }));
    await userEvent.type(screen.getByLabelText("Motivo (opcional)"), "viajou");
    await userEvent.click(screen.getAllByRole("button", { name: "Cancelar horário" }).at(-1)!);
    await waitFor(() => expect(h.fn["schedulingMutations:cancelAppointment"]).toHaveBeenCalledWith({ organizationId: "org1", appointmentId: "a1", reason: "viajou" }));
    expect(h.toast.success).toHaveBeenCalledWith("Horário cancelado", expect.objectContaining({ action: expect.anything() }));
  });

  it("quem só vê não tem ação nenhuma", () => {
    setup(appointment({ status: "scheduled", origin: "staff" }), false);
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mais ações do horário" })).toBeNull();
    expect(screen.getByText("Marcado")).toBeInTheDocument();
  });
});
