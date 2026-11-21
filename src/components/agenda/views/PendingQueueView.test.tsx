import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PendingQueueView, type PendingData, type PendingQueueViewProps } from "./PendingQueueView";
import { appt, at, NOW } from "./agendaViews.fixtures";

const noCap = { approvals: false, conflicts: false, noOutcome: false, suggestions: false };
const data = (over: Partial<PendingData> = {}): PendingData => ({ approvals: [], conflicts: [], noOutcome: [], suggestions: [], capped: noCap, ...over });

function setup(d: PendingData | undefined, over: Partial<PendingQueueViewProps> = {}) {
  const handlers = { onOpen: vi.fn(), onApprove: vi.fn(), onDecline: vi.fn(), onOutcome: vi.fn(), onResolve: vi.fn(), onOpenConversation: vi.fn() };
  render(<PendingQueueView data={d} tz="America/Sao_Paulo" now={NOW} canEdit busyId={null} {...handlers} {...over} />);
  return handlers;
}

describe("PendingQueueView", () => {
  it("vazio: mensagem positiva", () => {
    setup(data());
    expect(screen.getByText("Nada esperando por você")).toBeInTheDocument();
  });
  it("carregando: indicador", () => {
    setup(undefined);
    expect(screen.getByRole("status")).toHaveTextContent("Carregando…");
  });
  it("aprovações: Aprovar, Recusar e abrir o painel", () => {
    const a = appt(["sala1"], NOW + 3_600_000, NOW + 7_200_000, { status: "pending_approval", origin: "ai", contactName: "Maria" });
    const h = setup(data({ approvals: [a] }));
    const section = screen.getByRole("region", { name: /Aguardando aprovação/ });
    fireEvent.click(within(section).getByRole("button", { name: "Aprovar" }));
    expect(h.onApprove).toHaveBeenCalledWith(a._id);
    fireEvent.click(within(section).getByRole("button", { name: "Recusar" }));
    expect(h.onDecline).toHaveBeenCalledWith(a._id);
    fireEvent.click(within(section).getByRole("button", { name: /Abrir: Maria/ }));
    expect(h.onOpen).toHaveBeenCalledWith(a._id);
  });
  it("proposta vencida não oferece Aprovar, só Recusar", () => {
    const a = appt(["sala1"], NOW - 3_600_000, NOW, { status: "pending_approval" });
    setup(data({ approvals: [a] }));
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Recusar" })).toBeInTheDocument();
  });
  it("sem desfecho: Atendido e Faltou em um toque", () => {
    const a = appt(["sala1"], at(8), at(9), { status: "scheduled" });
    const h = setup(data({ noOutcome: [a] }));
    fireEvent.click(screen.getByRole("button", { name: "Atendido" }));
    expect(h.onOutcome).toHaveBeenCalledWith(a._id, "attended");
    fireEvent.click(screen.getByRole("button", { name: "Faltou" }));
    expect(h.onOutcome).toHaveBeenCalledWith(a._id, "noShow");
  });
  it("conflitos: Resolver leva o id do conflito e do agendamento", () => {
    const a = appt([], at(9), at(10), {}, ["sala1"]);
    const h = setup(data({ conflicts: [{ _id: "c1", appointment: a }] }));
    fireEvent.click(screen.getByRole("button", { name: "Resolver" }));
    expect(h.onResolve).toHaveBeenCalledWith("c1", a._id);
  });
  it("sugestões só aparecem quando vêm", () => {
    setup(data({ approvals: [appt(["sala1"], NOW + 3_600_000, NOW + 7_200_000, { status: "pending_approval" })] }));
    expect(screen.queryByText("Sugestões")).toBeNull();
  });
  it("sugestão abre a conversa", () => {
    const h = setup(data({ suggestions: [{ _id: "s1", conversationId: "cv1", act: "confirmou", parsed: {}, createdAt: NOW }] }));
    fireEvent.click(screen.getByRole("button", { name: "Abrir conversa" }));
    expect(h.onOpenConversation).toHaveBeenCalledWith("cv1");
  });
  it("seção cortada avisa e mostra '+'", () => {
    const a = appt(["sala1"], at(8), at(9));
    setup(data({ noOutcome: [a], capped: { ...noCap, noOutcome: true } }));
    expect(screen.getByText(/Mostrando só os 1 mais recentes/)).toBeInTheDocument();
  });
  it("sem permissão de editar: só abre, sem botões de ação", () => {
    const a = appt(["sala1"], at(8), at(9));
    setup(data({ noOutcome: [a] }), { canEdit: false });
    expect(screen.queryByRole("button", { name: "Atendido" })).toBeNull();
    expect(screen.getByRole("button", { name: /Abrir:/ })).toBeInTheDocument();
  });
  it("linha ocupada desabilita Recusar", () => {
    const a = appt(["sala1"], NOW + 3_600_000, NOW + 7_200_000, { status: "pending_approval" });
    setup(data({ approvals: [a] }), { busyId: a._id });
    expect(screen.getByRole("button", { name: "Recusar" })).toBeDisabled();
  });
  it("conflito mostra o motivo; aprovar com recurso sem lugar pede resolver antes", () => {
    const conflicted = appt(["sala1"], NOW + 3_600_000, NOW + 7_200_000, { status: "pending_approval" }, ["sala2"]);
    const manual = appt([], NOW + 3_600_000, NOW + 7_200_000, { status: "pending_approval", needsAttention: { code: "no_resource", at: NOW } }, ["sala2"]);
    const lost = appt([], at(9), at(10), {}, ["sala1"]);
    setup(data({ approvals: [conflicted, manual], conflicts: [{ _id: "c1", kind: "resource_closed", appointment: lost }] }));
    expect(screen.getByText("A sala ou o profissional fechou")).toBeInTheDocument();
    expect(screen.getAllByText("Resolva o conflito antes de aprovar.")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Aprovar" })).toHaveLength(1);
  });
});

describe("PendingQueueView: casos sem saída", () => {
  it("conflito sem agendamento: texto 'Agendamento removido' e nenhum botão morto", () => {
    setup(data({ conflicts: [{ _id: "c9", appointment: null }] }));
    expect(screen.getByText("Agendamento removido")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolver" })).toBeNull();
  });
  it("proposta vencida explica por que só há Recusar", () => {
    const a = appt(["sala1"], NOW - 3_600_000, NOW, { status: "pending_approval" });
    setup(data({ approvals: [a] }));
    expect(screen.getByText("Proposta vencida: o horário já passou, então só dá para recusar.")).toBeInTheDocument();
  });
  it("vencida pelo relógio por minuto: 10 minutos depois do início já não oferece Aprovar", () => {
    const start = NOW;
    const a = appt(["sala1"], start, start + 3_600_000, { status: "pending_approval" });
    setup(data({ approvals: [a] }), { now: start + 10 * 60_000 });
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull();
  });
});
