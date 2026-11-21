import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";

const h = vi.hoisted(() => ({
  modules: { scheduling: false },
  access: { canView: true, canEdit: true },
  calls: [] as string[],
  data: {} as Record<string, unknown>,
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: never, args: unknown) => {
    const name = getFunctionName(ref);
    if (args !== "skip") h.calls.push(name);
    return args === "skip" ? undefined : h.data[name];
  },
  useMutation: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
}));
vi.mock("@/hooks/useOrgModules", () => ({ useOrgModules: () => ({ modules: h.modules, isLoading: false, anyEnabled: false }) }));
vi.mock("@/hooks/useAgendaAccess", () => ({ useAgendaAccess: () => ({ canViewAll: false, canManage: false, isLoading: false, ...h.access }) }));
vi.mock("@/hooks/useOrgTimezone", () => ({ useOrgTimezone: () => "America/Sao_Paulo" }));

import { NextAppointmentChip } from "./NextAppointmentChip";
import { AppointmentsBlock } from "./AppointmentsBlock";
import { useConversationBooking } from "@/components/agenda/booking/useConversationBooking";

const row = (id: string, startTime: number) => ({ _id: id, serviceName: "Sessão", startTime, status: "scheduled", origin: "staff" });
const SOON = Date.now() + 3 * 3_600_000;

function Harness() {
  const b = useConversationBooking({ organizationId: "org1" as never, conversationId: "v1" as never, name: "Maria", isGroup: false });
  return (
    <div data-testid="root">
      {b.chip}
      {b.menuItem?.(() => {})}
      {b.overlays}
    </div>
  );
}

describe("entradas da Agenda v2 (conversa, lead, contato)", () => {
  beforeEach(() => {
    h.modules = { scheduling: false };
    h.access = { canView: true, canEdit: true };
    h.calls = [];
    h.data = {
      "scheduling:listForConversation": { upcoming: [row("a1", SOON), row("a2", SOON + 1)], recent: [] },
      "scheduling:listForLead": { upcoming: [row("a1", SOON)], recent: [] },
    };
  });

  it("módulo desligado: nada renderizado e nenhuma query da agenda", () => {
    const { container } = render(
      <>
        <NextAppointmentChip organizationId={"org1" as never} conversationId={"v1" as never} onOpen={() => {}} />
        <AppointmentsBlock organizationId={"org1" as never} leadId={"l1" as never} />
        <Harness />
      </>
    );
    expect(container.querySelector("button")).toBeNull();
    expect(screen.getByTestId("root")).toBeEmptyDOMElement();
    expect(h.calls.filter((c) => c.startsWith("scheduling"))).toEqual([]);
  });

  it("módulo ligado sem permissão de agenda: igual a desligado", () => {
    h.modules = { scheduling: true };
    h.access = { canView: false, canEdit: false };
    render(<NextAppointmentChip organizationId={"org1" as never} conversationId={"v1" as never} onOpen={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(h.calls.filter((c) => c.startsWith("scheduling"))).toEqual([]);
  });

  it("módulo ligado: chip do próximo horário abre o painel", async () => {
    h.modules = { scheduling: true };
    const onOpen = vi.fn();
    render(<NextAppointmentChip organizationId={"org1" as never} conversationId={"v1" as never} onOpen={onOpen} />);
    const chip = screen.getByRole("button", { name: /Próximo: .* às \d{2}:\d{2}/ });
    expect(chip).toHaveTextContent("+1");
    await userEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith("a1");
  });

  it("'Marcar horário' no menu só com agenda:edit", () => {
    h.modules = { scheduling: true };
    h.access = { canView: true, canEdit: false };
    const { unmount } = render(<Harness />);
    expect(screen.queryByRole("button", { name: "Marcar horário" })).toBeNull();
    unmount();
    h.access = { canView: true, canEdit: true };
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Marcar horário" })).toBeInTheDocument();
  });

  it("bloco do lead lista os próximos e oferece marcar", () => {
    h.modules = { scheduling: true };
    render(<AppointmentsBlock organizationId={"org1" as never} leadId={"l1" as never} />);
    expect(screen.getByText("Agendamentos")).toBeInTheDocument();
    expect(screen.getByText("Próximos")).toBeInTheDocument();
    expect(screen.getByText("Sessão")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Marcar horário" })).toBeInTheDocument();
  });
});
