import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ClosureLine, ClosureResult } from "@/lib/agendaClosure";
import { ResourceDaySheetView, type ResourceDaySheetViewProps } from "./ResourceDaySheetView";

const result = (over: Partial<ClosureResult> = {}): ClosureResult => ({
  mode: "preview", dates: ["2026-11-23"], affected: 0, reallocated: 0, conflicts: 0, pending: 0, simulated: 0, capped: false, removed: 0, restorable: 0, items: [], ...over,
});
const line = (over: Partial<ClosureLine> = {}): ClosureLine => ({
  appointmentId: "a1", resourceIds: ["r"], resourceNames: ["Sala 3"], startTime: Date.UTC(2026, 10, 23, 13, 0), localDate: "2026-11-23",
  serviceName: "Sessão", contactName: "Maria", outcome: "reallocated", toResourceName: "Sala 2", suggestions: [], ...over,
});

function setup(over: Partial<ResourceDaySheetViewProps> = {}) {
  const handlers = { onDatesChange: vi.fn(), onReasonChange: vi.fn(), onNoteChange: vi.fn(), onConfirm: vi.fn(), onRetry: vi.fn(), onClose: vi.fn(), onOpenPending: vi.fn() };
  const props: ResourceDaySheetViewProps = {
    mode: "close", period: false, resourceName: "Sala 3", kind: "room", tz: "America/Sao_Paulo", from: "2026-11-23", to: "2026-11-23", dateError: null,
    reasonCode: "no_staff", note: "", preview: { status: "ready", result: result() }, stale: false, submitting: false, submitError: null, committed: null, run: undefined,
    ...handlers, ...over,
  };
  render(<ResourceDaySheetView {...props} />);
  return handlers;
}

describe("ResourceDaySheetView: prévia do impacto", () => {
  it("diz que nada é cancelado nem enviado ao cliente", () => {
    setup();
    expect(screen.getByText("Nada é cancelado e nenhuma mensagem é enviada ao cliente.")).toBeInTheDocument();
  });
  it("sala: o que acontece com cada um (muda para qual sala × fica sem lugar) e o aceite no botão", () => {
    const items = [line(), line({ appointmentId: "a2", contactName: "João", outcome: "conflict" })];
    const h = setup({ preview: { status: "ready", result: result({ affected: 5, reallocated: 3, conflicts: 2, simulated: 5, items }) } });
    expect(screen.getByText("5 horários marcados em Sala 3 neste período")).toBeInTheDocument();
    expect(screen.getByText("3 mudam para outra sala")).toBeInTheDocument();
    expect(screen.getByText("2 ficam sem lugar e vão para a fila de pendências")).toBeInTheDocument();
    expect(screen.getByText("Muda para Sala 2")).toBeInTheDocument();
    expect(screen.getByText("Fica sem lugar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar mesmo assim" }));
    expect(h.onConfirm).toHaveBeenCalled();
  });
  it("só movidos: 'Fechar e mover N'", () => {
    setup({ preview: { status: "ready", result: result({ affected: 2, reallocated: 2, simulated: 2, items: [line()] }) } });
    expect(screen.getByRole("button", { name: "Fechar e mover 2" })).toBeEnabled();
  });
  it("profissional: ninguém passa a outro, vira conflito com sugestões", () => {
    const items = [line({ outcome: "conflict", toResourceName: undefined, suggestions: [{}, {}, {}] })];
    setup({ resourceName: "Ana", kind: "person", preview: { status: "ready", result: result({ affected: 1, conflicts: 1, simulated: 1, items }) } });
    expect(screen.getByText(/Ninguém passa para outro profissional sozinho: 1 viram conflitos/)).toBeInTheDocument();
    expect(screen.queryByText(/mudam para outra sala/)).toBeNull();
    expect(screen.getByText("Fica sem lugar, com 3 sugestões")).toBeInTheDocument();
  });
  it("sem afetados: mensagem curta e botão 'Fechar'", () => {
    setup();
    expect(screen.getByText("Nenhum horário marcado neste dia. Pode fechar sem afetar ninguém.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fechar" })).toBeEnabled();
  });
  it("prévia limitada: o resto é 'a definir quando fechar'", () => {
    setup({ preview: { status: "ready", result: result({ affected: 60, reallocated: 40, simulated: 40, items: [line()] }) } });
    expect(screen.getByText("20 a definir quando fechar")).toBeInTheDocument();
  });
  it("sem prévia pronta não dá para confirmar (carregando e erro)", () => {
    setup({ preview: { status: "loading" } });
    expect(screen.getByRole("button", { name: "Fechar" })).toBeDisabled();
  });
  it("erro da prévia: tentar de novo", () => {
    const h = setup({ preview: { status: "error", message: "Sem acesso" } });
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(h.onRetry).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Fechar" })).toBeDisabled();
  });
});

describe("ResourceDaySheetView: situação mudou", () => {
  it("avisa para conferir de novo e continua exigindo novo aceite", () => {
    setup({ stale: true, preview: { status: "ready", result: result({ affected: 3, reallocated: 3, simulated: 3, items: [line()] }) } });
    expect(screen.getByRole("status")).toHaveTextContent("A situação mudou, confira de novo.");
    expect(screen.getByRole("button", { name: "Fechar e mover 3" })).toBeEnabled();
  });
  it("erro de envio aparece sem fechar a folha", () => {
    setup({ submitError: "Sem permissão" });
    expect(screen.getByRole("alert")).toHaveTextContent("Sem permissão");
  });
});

describe("ResourceDaySheetView: período e motivo", () => {
  it("De/Até aparecem no período e o erro de data bloqueia a confirmação", () => {
    const h = setup({ period: true, dateError: "A data final precisa ser igual ou depois da inicial." });
    expect(screen.getByLabelText("De")).toHaveValue("2026-11-23");
    expect(screen.getByRole("alert")).toHaveTextContent("A data final precisa");
    expect(screen.getByRole("button", { name: "Fechar" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Até"), { target: { value: "2026-11-25" } });
    expect(h.onDatesChange).toHaveBeenCalledWith("2026-11-23", "2026-11-25");
  });
  it("motivo em chips", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: "Manutenção" }));
    expect(h.onReasonChange).toHaveBeenCalledWith("maintenance");
  });
  it("fechar hoje não mostra datas", () => {
    setup();
    expect(screen.queryByLabelText("De")).toBeNull();
  });
});

describe("ResourceDaySheetView: depois de confirmar", () => {
  it("andamento do lote com barra e depois o resultado", () => {
    const run = { status: "running" as const, total: 10, totalIsPartial: false, processed: 4, reallocated: 3, conflicts: 1, failed: 0 };
    const { unmount } = render(<div />);
    unmount();
    setup({ committed: result({ mode: "commit", affected: 10, pending: 10, runId: "run1" }), run });
    expect(screen.getByText("Tratando os horários… 4 de 10")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
  });
  it("lote concluído com conflitos oferece a fila", () => {
    const h = setup({
      committed: result({ mode: "commit", affected: 10, runId: "run1" }),
      run: { status: "done", total: 10, totalIsPartial: false, processed: 10, reallocated: 7, conflicts: 3, failed: 0 },
    });
    expect(screen.getByText("Fechamento concluído: 7 mudaram de lugar e 3 ficaram sem lugar.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver pendências" }));
    expect(h.onOpenPending).toHaveBeenCalled();
  });
  it("falhou ou truncado: aviso de que não terminou por inteiro, com atalho para a fila", () => {
    const h = setup({
      committed: result({ mode: "commit", affected: 90, runId: "run1" }),
      run: { status: "failed", failure: "x", total: 90, totalIsPartial: true, processed: 40, reallocated: 30, conflicts: 10, failed: 0 },
    });
    expect(screen.getByText("O fechamento não terminou por inteiro. Confira a fila de pendências.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver pendências" }));
    expect(h.onOpenPending).toHaveBeenCalled();
  });
  it("sem lote (poucos afetados): resultado na hora", () => {
    setup({ committed: result({ mode: "commit", affected: 2, reallocated: 2, conflicts: 0 }) });
    expect(screen.getByText("Fechamento concluído: 2 mudaram de lugar e 0 ficaram sem lugar.")).toBeInTheDocument();
  });
});

describe("ResourceDaySheetView: reabrir", () => {
  it("confirma com 'Reabrir', sem motivo nem datas", () => {
    const h = setup({ mode: "reopen" });
    expect(screen.queryByText("Motivo")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reabrir" }));
    expect(h.onConfirm).toHaveBeenCalled();
  });
  it("coberto por fechamento da agenda inteira: explica e não deixa reabrir", () => {
    setup({ mode: "reopen", preview: { status: "ready", result: result({ reason: "covered_by_org_closure" }) } });
    expect(screen.getByText("A agenda inteira está fechada neste dia. Reabra por lá.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reabrir" })).toBeDisabled();
  });
  it("nada para reabrir", () => {
    setup({ mode: "reopen", preview: { status: "ready", result: result({ reason: "nothing_to_reopen" }) } });
    expect(screen.getByText("Não há fechamento para reabrir neste dia.")).toBeInTheDocument();
  });
});
