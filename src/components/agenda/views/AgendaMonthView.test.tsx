import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { buildMonthCells } from "@/lib/agendaMonth";
import { AgendaMonthView, cellSummary } from "./AgendaMonthView";

const range = {
  days: [
    { localDate: "2026-11-03", active: 5, pending: 1, closedResources: 1, occupancy: [{ kind: "room" as const, bookedMinutes: 450, openMinutes: 480 }] },
    { localDate: "2026-11-04", active: 8, pending: 0, closedResources: 3, occupancy: [{ kind: "room" as const, bookedMinutes: 480, openMinutes: 480 }] },
    { localDate: "2026-11-20", active: 2, pending: 0, closedResources: 0, occupancy: [] },
  ],
  capped: true,
  completeThrough: "2026-11-10",
};

function setup(over = {}) {
  const onPickDay = vi.fn();
  const cells = buildMonthCells("2026-11-01", "2026-11-30", range, 3);
  render(<AgendaMonthView cells={cells} today="2026-11-23" selected="2026-11-23" loading={false} partialFrom={{ through: "2026-11-10" }} onPickDay={onPickDay} {...over} />);
  return { onPickDay, cells };
}

describe("AgendaMonthView", () => {
  it("resume cada dia por texto (marcados, quase cheio, fechado), não só por cor", () => {
    const { cells } = setup();
    const byDate = (d: string) => cells.find((c) => c?.localDate === d)!;
    expect(cellSummary(byDate("2026-11-03")!)).toBe("5 marcados, 1 aguardando, quase cheio, 1 fechados");
    expect(cellSummary(byDate("2026-11-04")!)).toContain("cheio");
    expect(cellSummary(byDate("2026-11-04")!)).toContain("fechado");
    expect(cellSummary(byDate("2026-11-15")!)).toBe("Nada marcado, contagem parcial");
  });
  it("tocar num dia vai para o dia", () => {
    const { onPickDay } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^ter, 03\/11/ }));
    expect(onPickDay).toHaveBeenCalledWith("2026-11-03");
  });
  it("avisa quando o servidor cortou a contagem", () => {
    setup();
    expect(screen.getByRole("status")).toHaveTextContent("A contagem é parcial a partir de qua, 11/11");
  });
  it("sem corte, sem aviso; hoje marcado", () => {
    setup({ partialFrom: null });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /^seg, 23\/11/ })).toHaveAttribute("aria-current", "date");
  });
  it("carregando: esqueleto em vez de dias zerados", () => {
    render(<AgendaMonthView cells={buildMonthCells("2026-11-01", "2026-11-30", undefined)} today="2026-11-23" loading partialFrom={null} onPickDay={() => {}} />);
    expect(screen.getByRole("status", { name: "Carregando o mês…" })).toBeInTheDocument();
  });
});

describe("AgendaMonthView: estrutura e compromissos", () => {
  it("cada semana é uma linha (role row) com 7 células", () => {
    setup();
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(1 + 6); // cabeçalho + 6 semanas de novembro de 2026
    expect(within(rows[1]).getAllByRole("gridcell", { hidden: true })).toHaveLength(7);
  });
  it("indicador próprio de compromissos e tarefas no dia", () => {
    const cells = buildMonthCells("2026-11-01", "2026-11-30", range, 3);
    render(<AgendaMonthView cells={cells} today="2026-11-23" loading={false} partialFrom={null} internalCounts={{ "2026-11-12": 2 }} onPickDay={() => {}} />);
    expect(screen.getByRole("button", { name: /^qui, 12\/11: Nada marcado, 2 compromissos ou tarefas/ })).toBeInTheDocument();
  });
});
