import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppointmentDetailView, type AppointmentDetailViewProps } from "./AppointmentDetailView";
import { CancelDialog } from "./AppointmentDetailPanel";
import { NextAppointmentChipView } from "./NextAppointmentChip";
import { AppointmentsBlockView } from "./AppointmentsBlockInner";

const HOUR = 3_600_000;
const NOW = Date.now();
const appointment = (over: Record<string, unknown> = {}) => ({
  status: "scheduled",
  origin: "staff",
  serviceName: "Sessão",
  startTime: NOW + 24 * HOUR,
  endTime: NOW + 25 * HOUR,
  contactName: "Maria",
  resources: [{ name: "Sala 1" }],
  createdAt: NOW - HOUR,
  ...over,
});

function setup(over: Partial<AppointmentDetailViewProps> = {}, appt: Record<string, unknown> = {}) {
  const onAction = vi.fn();
  render(
    <AppointmentDetailView
      appointment={appointment(appt) as never}
      openConflicts={0}
      tz="America/Sao_Paulo"
      now={NOW}
      canEdit
      busy={false}
      proposalBroken={false}
      undoUnavailable={false}
      onAction={onAction}
      {...over}
    />
  );
  return { onAction };
}

describe("AppointmentDetailView: Desfazer do que veio de uma confirmação no WhatsApp (C1)", () => {
  it("criado pela confirmação: mostra o aviso e 'Desfazer'; o clique chama o desfazer", async () => {
    const onUndoHumanConfirm = vi.fn();
    setup({ humanUndo: "created", onUndoHumanConfirm }, { origin: "human_message" });
    expect(screen.getByText(/marcou este horário a partir de uma confirmação no WhatsApp/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Desfazer \(veio de uma confirmação no WhatsApp\)/ }));
    expect(onUndoHumanConfirm).toHaveBeenCalledTimes(1);
  });
  it("aprovado pelo sistema: 'Desfazer a aprovação'; sem janela ou sem permissão: nada", async () => {
    setup({ humanUndo: "approved", onUndoHumanConfirm: vi.fn() });
    expect(screen.getByRole("button", { name: "Desfazer a aprovação" })).toBeInTheDocument();
  });
  it("sem permissão de editar ou fora da janela, não aparece", () => {
    setup({ humanUndo: "created", onUndoHumanConfirm: vi.fn(), canEdit: false }, { origin: "human_message" });
    expect(screen.queryByText(/Desfazer \(veio/)).toBeNull();
  });
  it("ocupado desabilita o botão", () => {
    setup({ humanUndo: "created", onUndoHumanConfirm: vi.fn(), busy: true }, { origin: "human_message" });
    expect(screen.getByRole("button", { name: /Desfazer \(veio/ })).toBeDisabled();
  });
});

describe("AppointmentDetailView: Resolver (sem lugar)", () => {
  it("com needsAttention mostra Resolver e abre o resolvedor", async () => {
    const onResolve = vi.fn();
    setup({ onResolve, openConflicts: 1 }, { needsAttention: { code: "resource_closed" } });
    await userEvent.click(screen.getByRole("button", { name: "Resolver" }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });
  it("sem needsAttention nem conflito: nada de Resolver", () => {
    const onResolve = vi.fn();
    setup({ onResolve }, {});
    expect(screen.queryByRole("button", { name: "Resolver" })).toBeNull();
  });
  it("só leitura não vê Resolver", () => {
    setup({ onResolve: vi.fn(), canEdit: false, openConflicts: 1 }, { needsAttention: { code: "resource_closed" } });
    expect(screen.queryByRole("button", { name: "Resolver" })).toBeNull();
  });
});

describe("AppointmentDetailView", () => {
  it("mostra dados, status, origem, recursos e histórico", () => {
    setup({}, { status: "confirmed" });
    expect(screen.getByText("Maria")).toBeInTheDocument();
    expect(screen.getByText("Confirmado")).toBeInTheDocument();
    expect(screen.getByText("Equipe")).toBeInTheDocument();
    expect(screen.getByText("Sala 1")).toBeInTheDocument();
    expect(screen.getByText(/Marcado \(Equipe\)/)).toBeInTheDocument();
  });

  it("mostra quem marcou e o ator das mudanças de status", () => {
    setup({}, { status: "completed", createdByName: "Link público", completedAt: NOW - 1000, statusActors: [{ status: "completed", at: NOW - 1000, actorName: "Ana" }] });
    expect(screen.getByText("Marcado por")).toBeInTheDocument();
    expect(screen.getAllByText("Link público").length).toBeGreaterThan(0);
    expect(screen.getByText(/Atendimento concluído por Ana/)).toBeInTheDocument();
    expect(screen.getByText(/Marcado por Link público/)).toBeInTheDocument();
  });

  it("confirmar dispara a ação de status", async () => {
    const { onAction } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(onAction).toHaveBeenCalledWith("confirm");
  });

  it("cancelar e desfazer estão no menu 'Mais ações'", async () => {
    const { onAction } = setup({}, { status: "confirmed" });
    await userEvent.click(screen.getByRole("button", { name: "Mais ações do horário" }));
    expect(screen.getByRole("menuitem", { name: "Remarcar" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Cancelar horário" }));
    expect(onAction).toHaveBeenCalledWith("cancel");
  });

  it("proposta aguardando aprovação: aprovar e recusar", () => {
    setup({}, { status: "pending_approval", origin: "ai" });
    expect(screen.getByRole("button", { name: "Aprovar proposta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recusar proposta" })).toBeInTheDocument();
    expect(screen.getByText("A IA reservou este horário e aguarda você.")).toBeInTheDocument();
  });

  it("proposta vencida: avisa desde a abertura, esconde Aprovar e deixa Recusar proposta como ação principal", () => {
    setup({}, { status: "pending_approval", origin: "ai", startTime: NOW - HOUR, endTime: NOW });
    expect(screen.queryByRole("button", { name: "Aprovar proposta" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Proposta vencida: o horário já passou");
    const decline = screen.getByRole("button", { name: "Recusar proposta" });
    expect(decline.className).toMatch(/bg-brand-600/);
  });

  it("proposta vencida: chip Vencida (texto, não só cor) e ações só Recusar proposta e Marcar de novo", async () => {
    const { onAction } = setup({}, { status: "pending_approval", origin: "ai", startTime: NOW - HOUR, endTime: NOW });
    expect(screen.getByText("Vencida")).toBeInTheDocument();
    expect(screen.queryByText("Aguardando aprovação")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mais ações do horário" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Marcar de novo" }));
    expect(onAction).toHaveBeenCalledWith("rebook");
  });

  it("marcada pelo servidor (proposal_expired) vale mesmo com horário futuro: nunca Aprovar", () => {
    setup({}, { status: "pending_approval", origin: "ai", needsAttention: { code: "proposal_expired" } });
    expect(screen.getByText("Vencida")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprovar proposta" })).toBeNull();
    expect(screen.getByRole("button", { name: "Recusar proposta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Marcar de novo" })).toBeInTheDocument();
  });

  it("proposta viva não oferece Marcar de novo", () => {
    setup({}, { status: "pending_approval", origin: "ai" });
    expect(screen.queryByRole("button", { name: "Marcar de novo" })).toBeNull();
  });

  it("aprovação que falhou (não vale mais): aviso e Recusar em destaque", () => {
    setup({ proposalBroken: true }, { status: "pending_approval", origin: "ai" });
    expect(screen.getByRole("alert")).toHaveTextContent("não vale mais");
    expect(screen.getByRole("button", { name: "Recusar proposta" }).className).toMatch(/bg-brand-600/);
  });

  it("quem só vê não tem ação nenhuma", () => {
    setup({ canEdit: false });
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mais ações do horário" })).toBeNull();
    expect(screen.getByText("Marcado")).toBeInTheDocument();
  });

  it("sem o que desfazer: esconde 'Desfazer' e explica", async () => {
    setup({ undoUnavailable: true }, { status: "cancelled", cancelledAt: NOW });
    expect(screen.getByText("Não há mais o que desfazer neste horário.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mais ações do horário" })).toBeNull();
  });

  it("cancelado com o que desfazer oferece 'Desfazer última mudança'", async () => {
    const { onAction } = setup({}, { status: "cancelled", cancelledAt: NOW });
    await userEvent.click(screen.getByRole("button", { name: "Mais ações do horário" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Desfazer última mudança" }));
    expect(onAction).toHaveBeenCalledWith("undo");
  });

  it("'Abrir conversa' só aparece quando há atalho", () => {
    const open = vi.fn();
    setup({ onOpenConversation: open });
    expect(screen.getByRole("button", { name: "Abrir conversa" })).toBeInTheDocument();
  });
});

describe("CancelDialog", () => {
  it("motivo é opcional e vai no confirmar", async () => {
    const onConfirm = vi.fn();
    render(<CancelDialog open busy={false} onClose={() => undefined} onConfirm={onConfirm} />);
    await userEvent.type(screen.getByLabelText("Motivo (opcional)"), "viajou");
    await userEvent.click(screen.getByRole("button", { name: "Cancelar horário" }));
    expect(onConfirm).toHaveBeenCalledWith("viajou");
  });
});

describe("chip e bloco (aparência)", () => {
  it("chip mostra o rótulo e o '+N'", async () => {
    const onOpen = vi.fn();
    render(<NextAppointmentChipView label="Próximo: qui, 26/11 às 10:00" extra={2} onOpen={onOpen} />);
    const chip = screen.getByRole("button", { name: /Próximo: qui, 26\/11 às 10:00/ });
    expect(chip).toHaveTextContent("+2");
    await userEvent.click(chip);
    expect(onOpen).toHaveBeenCalled();
  });

  it("bloco lista próximos e recentes e oferece marcar só com permissão", async () => {
    const onBook = vi.fn();
    const rows = [{ _id: "a1", serviceName: "Sessão", startTime: NOW + HOUR, status: "scheduled" }];
    const { rerender } = render(
      <AppointmentsBlockView headingId="h" tz="America/Sao_Paulo" upcoming={rows} recent={[{ ...rows[0], _id: "a0", status: "completed" }]} loaded canBook onOpen={() => undefined} onBook={onBook} />
    );
    expect(screen.getByText("Próximos")).toBeInTheDocument();
    expect(screen.getByText("Recentes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    expect(onBook).toHaveBeenCalled();
    rerender(<AppointmentsBlockView headingId="h" tz="America/Sao_Paulo" upcoming={[]} recent={[]} loaded canBook={false} onOpen={() => undefined} onBook={onBook} />);
    expect(screen.queryByRole("button", { name: "Marcar horário" })).toBeNull();
    expect(screen.getByText("Nenhum horário marcado")).toBeInTheDocument();
  });
});
