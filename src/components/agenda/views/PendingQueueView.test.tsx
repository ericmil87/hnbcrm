import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PendingQueueView, type PendingData, type PendingQueueViewProps } from "./PendingQueueView";
import { appt, at, NOW } from "./agendaViews.fixtures";

const noCap = { approvals: false, conflicts: false, noOutcome: false, suggestions: false };
const data = (over: Partial<PendingData> = {}): PendingData => ({ approvals: [], conflicts: [], noOutcome: [], suggestions: [], capped: noCap, ...over });

function setup(d: PendingData | undefined, over: Partial<PendingQueueViewProps> = {}) {
  const handlers = { onOpen: vi.fn(), onApprove: vi.fn(), onDecline: vi.fn(), onRebook: vi.fn(), onOutcome: vi.fn(), onResolve: vi.fn(), onOpenConversation: vi.fn() };
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
  it("grupo (mesma partyKey): uma linha só, na pessoa principal, com 'grupo de 2 pessoas'", () => {
    const main = appt(["sala1"], NOW + 3_600_000, NOW + 7_200_000, { status: "pending_approval", origin: "ai", contactName: "Maria", partyKey: "party:x" } as never);
    const guest = appt(["sala1"], NOW + 3_600_000, NOW + 7_200_000, { status: "pending_approval", origin: "ai", guestName: "Acompanhante 1", partyKey: "party:x" } as never);
    setup(data({ approvals: [main, guest] }));
    const section = screen.getByRole("region", { name: /Aguardando aprovação/ });
    expect(within(section).getAllByRole("button", { name: "Aprovar" })).toHaveLength(1);
    expect(within(section).getByText("grupo de 2 pessoas")).toBeInTheDocument();
  });
  it("proposta vencida não oferece Aprovar, só Recusar", () => {
    const a = appt(["sala1"], NOW - 3_600_000, NOW, { status: "pending_approval" });
    setup(data({ approvals: [a] }));
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Recusar proposta" })).toBeInTheDocument();
  });
  it("proposta vencida: chip Vencida (texto) e Marcar de novo leva o agendamento", () => {
    const a = appt(["sala1"], NOW - 3_600_000, NOW, { status: "pending_approval", contactName: "Maria" });
    const h = setup(data({ approvals: [a] }));
    expect(screen.getByText("Vencida")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Marcar de novo" }));
    expect(h.onRebook).toHaveBeenCalledWith(a);
  });
  it("marca proposal_expired do servidor: Vencida mesmo com horário futuro, nunca Aprovar", () => {
    const a = appt(["sala1"], NOW + 3_600_000, NOW + 7_200_000, { status: "pending_approval", needsAttention: { code: "proposal_expired", at: NOW } });
    setup(data({ approvals: [a] }));
    expect(screen.getByText("Vencida")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull();
  });
  it("proposta viva não mostra Vencida nem Marcar de novo", () => {
    setup(data({ approvals: [appt(["sala1"], NOW + 3_600_000, NOW + 7_200_000, { status: "pending_approval" })] }));
    expect(screen.queryByText("Vencida")).toBeNull();
    expect(screen.queryByRole("button", { name: "Marcar de novo" })).toBeNull();
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
  it("conflito de capacidade na fila: texto próprio", () => {
    const a = appt([], at(9), at(10), {}, ["sala1"]);
    setup(data({ conflicts: [{ _id: "c2", kind: "capacity", appointment: a }] }));
    expect(screen.getByText("A sala passou a comportar menos pessoas")).toBeInTheDocument();
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
  it("sugestão (C1): título, quando, motivo, 'Marcar' e 'Dispensar' chamam o aceite e o descarte", () => {
    const s = { _id: "s1", conversationId: "cv1", act: "confirmou", reason: "modo_sugerir", parsed: { localDate: "2026-06-15", timeMin: 600 }, createdAt: NOW };
    const onAcceptSuggestion = vi.fn();
    const onDismissSuggestion = vi.fn();
    setup(data({ suggestions: [s] }), { onAcceptSuggestion, onDismissSuggestion });
    const section = screen.getByRole("region", { name: /Sugestões/ });
    expect(within(section).getByText("Parece uma confirmação de horário")).toBeInTheDocument();
    expect(within(section).getByText("seg, 15/06 às 10:00")).toBeInTheDocument();
    expect(within(section).getByText(/O sistema só sugere/)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "Marcar" }));
    expect(onAcceptSuggestion).toHaveBeenCalledWith("s1");
    fireEvent.click(within(section).getByRole("button", { name: "Dispensar" }));
    expect(onDismissSuggestion).toHaveBeenCalledWith("s1");
  });
  it("sugestão sem dia ou hora não oferece 'Marcar' (só dispensar e abrir a conversa)", () => {
    setup(data({ suggestions: [{ _id: "s2", conversationId: "cv1", act: "confirmou", parsed: { localDate: "2026-06-15" }, createdAt: NOW }] }), { onAcceptSuggestion: vi.fn(), onDismissSuggestion: vi.fn() });
    expect(screen.queryByRole("button", { name: "Marcar" })).toBeNull();
    expect(screen.getByText(/Faltam dia ou hora/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dispensar" })).toBeInTheDocument();
  });
  it("sugestões por tipo: aprovar, substituir, remarcar e cancelar têm o rótulo certo; sem permissão não há ação", () => {
    const base = { conversationId: "cv1", parsed: { localDate: "2026-06-15", timeMin: 600 }, createdAt: NOW };
    setup(data({ suggestions: [
      { ...base, _id: "a", act: "confirmou", reason: "aprovar_pendente" },
      { ...base, _id: "b", act: "remarcou", reason: "substituir_pendente" },
      { ...base, _id: "c", act: "remarcou", reason: "ato_nao_automatico" },
      { ...base, _id: "d", act: "cancelou", reason: "ato_nao_automatico", parsed: {} },
    ] }), { onAcceptSuggestion: vi.fn(), onDismissSuggestion: vi.fn() });
    for (const label of ["Aprovar", "Substituir", "Remarcar", "Cancelar horário"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });
  it("sugestão sem permissão de editar: só abre a conversa", () => {
    setup(data({ suggestions: [{ _id: "s3", conversationId: "cv1", act: "confirmou", parsed: { localDate: "2026-06-15", timeMin: 600 }, createdAt: NOW }] }), { canEdit: false, onAcceptSuggestion: vi.fn(), onDismissSuggestion: vi.fn() });
    expect(screen.queryByRole("button", { name: "Marcar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dispensar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Abrir conversa" })).toBeInTheDocument();
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
    expect(screen.getByText(/Proposta vencida: o horário já passou, então só dá para recusar a proposta ou marcar de novo/)).toBeInTheDocument();
  });
  it("vencida pelo relógio por minuto: 10 minutos depois do início já não oferece Aprovar", () => {
    const start = NOW;
    const a = appt(["sala1"], start, start + 3_600_000, { status: "pending_approval" });
    setup(data({ approvals: [a] }), { now: start + 10 * 60_000 });
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull();
  });
});
