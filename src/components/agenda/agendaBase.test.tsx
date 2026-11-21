import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppointmentStatusChip, APPOINTMENT_STATUS_ICON } from "./AppointmentStatusChip";
import { AppointmentOriginBadge } from "./AppointmentOriginBadge";
import { VacancyIndicator } from "./VacancyIndicator";
import { SchedulingEnableCardView } from "./SchedulingEnableCard";
import { APPOINTMENT_STATUSES } from "@/lib/agendaTypes";

describe("AppointmentStatusChip", () => {
  it("mostra o rótulo e um ícone svg para cada status", () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(APPOINTMENT_STATUS_ICON[status], status).toBeDefined();
      const { container, unmount } = render(<AppointmentStatusChip status={status} />);
      expect(container.querySelector("svg"), status).not.toBeNull();
      expect(container.querySelector(`[data-status="${status}"]`)).not.toBeNull();
      unmount();
    }
    render(<AppointmentStatusChip status="no_show" />);
    expect(screen.getByText("Faltou")).toBeInTheDocument();
  });

  it("aguardando aprovação é tracejado; os outros não", () => {
    const { container, rerender } = render(<AppointmentStatusChip status="pending_approval" />);
    expect(container.firstElementChild?.className).toContain("border-dashed");
    rerender(<AppointmentStatusChip status="confirmed" />);
    expect(container.firstElementChild?.className).not.toContain("border-dashed");
  });

  it("compacto esconde o texto só da vista, mantendo-o para leitor de tela", () => {
    render(<AppointmentStatusChip status="checked_in" compact />);
    expect(screen.getByText("Chegou")).toHaveClass("sr-only");
  });

  it("status desconhecido cai em Marcado", () => {
    render(<AppointmentStatusChip status="algo_novo" />);
    expect(screen.getByText("Marcado")).toBeInTheDocument();
  });
});

describe("AppointmentOriginBadge", () => {
  it("IA, Equipe e Link", () => {
    const { rerender } = render(<AppointmentOriginBadge origin="ai" />);
    expect(screen.getByText("IA")).toBeInTheDocument();
    rerender(<AppointmentOriginBadge origin="staff" />);
    expect(screen.getByText("Equipe")).toBeInTheDocument();
    rerender(<AppointmentOriginBadge origin="public" />);
    expect(screen.getByText("Link")).toBeInTheDocument();
  });

  it("compacto tem nome acessível", () => {
    render(<AppointmentOriginBadge origin="ai" compact />);
    expect(screen.getByText("IA")).toHaveClass("sr-only");
  });
});

describe("VacancyIndicator", () => {
  it("1/2 com nome acessível; cheio muda de tom", () => {
    const { rerender } = render(<VacancyIndicator used={1} capacity={2} />);
    expect(screen.getByRole("img", { name: "1 de 2 vagas ocupadas" })).toHaveTextContent("1/2");
    expect(screen.getByRole("img").className).not.toContain("semantic-warning");
    rerender(<VacancyIndicator used={2} capacity={2} />);
    expect(screen.getByRole("img").className).toContain("semantic-warning");
  });
});

describe("SchedulingEnableCardView", () => {
  it("explica o que é e o botão Ativar chama onActivate", async () => {
    const onActivate = vi.fn();
    render(<SchedulingEnableCardView state="ready" onActivate={onActivate} />);
    expect(screen.getByText("Atende com hora marcada?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Ativar" }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("mostra a mensagem do servidor quando o plano recusa", () => {
    render(<SchedulingEnableCardView state="ready" error="Seu plano não inclui Agendamento." onActivate={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Seu plano não inclui Agendamento.");
  });

  it("travado: sem botão, com a explicação", () => {
    render(<SchedulingEnableCardView state="locked" onActivate={() => {}} />);
    expect(screen.queryByRole("button", { name: "Ativar" })).toBeNull();
    expect(screen.getByText(/Só quem administra/)).toBeInTheDocument();
  });
});
