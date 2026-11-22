import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { buildMonthCells } from "@/lib/agendaMonth";
import { buildMonthGrid, buildMonthLines, monthGridDates } from "@/lib/agendaMonthLines";
import type { GridAppointment, InternalItem } from "@/lib/agendaGrid";
import { AgendaMonthView, daySummary, type AgendaMonthViewProps } from "./AgendaMonthView";

const TZ = "America/Sao_Paulo";
const at = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h + 3, m);
const appt = (id: string, day: number, h: number, name = `Cliente ${id}`, over: Partial<GridAppointment> = {}): GridAppointment => ({
  _id: id as GridAppointment["_id"],
  serviceName: "Sessão",
  startTime: at(day, h),
  endTime: at(day, h + 1),
  status: "scheduled",
  origin: "staff",
  localDate: `2026-11-${String(day).padStart(2, "0")}`,
  resources: [{ resourceId: "r1" as never, role: "room", name: "Sala 1", allocated: true }],
  contactName: name,
  ...over,
});
const ev = (id: string, day: number, h: number): InternalItem => ({ id, title: `Reunião ${id}`, startTime: at(day, h), endTime: at(day, h + 1), eventType: "meeting", source: "event", allDay: false, memberIds: [] });

const range = {
  days: [
    { localDate: "2026-11-03", active: 5, pending: 1, closedResources: 1, occupancy: [] },
    { localDate: "2026-11-04", active: 2, pending: 0, closedResources: 3, occupancy: [] },
  ],
  capped: false,
  completeThrough: null,
};

function build(appointments: GridAppointment[], internal: InternalItem[] = [], truncated = false) {
  const cells = buildMonthCells("2026-11-01", "2026-11-30", range, 3);
  const lines = buildMonthLines({ dates: monthGridDates("2026-11-10"), tz: TZ, appointments, internal });
  return buildMonthGrid({ date: "2026-11-10", cells, lines, truncated });
}

function setup(over: Partial<AgendaMonthViewProps> = {}, appointments: GridAppointment[] = [appt("a", 3, 9), appt("b", 3, 14, "Beatriz")], internal: InternalItem[] = []) {
  const h = { onOpenDay: vi.fn(), onSelectDay: vi.fn(), onAppointmentClick: vi.fn(), onInternalClick: vi.fn() };
  render(
    <AgendaMonthView
      weeks={build(appointments, internal)}
      tz={TZ}
      now={at(2, 8)}
      today="2026-11-23"
      selected="2026-11-23"
      loading={false}
      tone={{ scheme: "status", resourceOrder: [], serviceOrder: [] }}
      isMobile={false}
      {...h}
      {...over}
    />
  );
  return h;
}

describe("AgendaMonthView (computador)", () => {
  it("cada dia lista 'hora cliente' e abre o painel no clique, sem abrir o dia", () => {
    const h = setup();
    const line = screen.getByRole("button", { name: /Cliente a/ });
    expect(line).toHaveTextContent("09:00");
    expect(line).toHaveTextContent("Cliente a");
    fireEvent.click(line);
    expect(h.onAppointmentClick).toHaveBeenCalledWith("a");
    expect(h.onOpenDay).not.toHaveBeenCalled();
  });
  it("o número do dia e a célula abrem o dia; hoje fica marcado; dias vizinhos aparecem", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /^ter, 03\/11: 2 marcados/ }));
    expect(h.onOpenDay).toHaveBeenCalledWith("2026-11-03");
    expect(screen.getByRole("button", { name: /^seg, 23\/11/ })).toHaveAttribute("aria-current", "date");
    expect(screen.getByRole("button", { name: /^sex, 30\/10/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^ter, 01\/12/ })).toHaveTextContent("1 de dez.");
  });
  it("seis semanas (novembro de 2026 começa num domingo) mais o cabeçalho; sete células por semana", () => {
    setup();
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(1 + 6);
    expect(within(rows[1]).getAllByRole("gridcell")).toHaveLength(7);
  });
  it("o resumo do dia diz marcados, aguardando e fechado por texto", () => {
    // Leitura cortada: o servidor contou 5 e só 2 vieram, então o dia diz 5.
    const d3 = build([appt("a", 3, 9), appt("b", 3, 10)], [], true).flat().find((d) => d.localDate === "2026-11-03")!;
    expect(daySummary(d3)).toContain("5 marcados");
    expect(daySummary(d3)).toContain("1 aguardando");
  });
  it("compromisso da equipe aparece como linha própria e abre o compromisso", () => {
    const h = setup({}, [], [ev("x", 5, 10)]);
    fireEvent.click(screen.getByRole("button", { name: /Reunião x/ }));
    expect(h.onInternalClick).toHaveBeenCalledWith(expect.objectContaining({ id: "x" }));
  });
  it("avisa quando o servidor cortou a contagem", () => {
    setup({ partialFrom: { through: "2026-11-10" } });
    expect(screen.getByRole("status")).toHaveTextContent("A contagem é parcial a partir de");
  });
  it("carregando: esqueleto em vez de dias zerados", () => {
    setup({ loading: true }, []);
    expect(screen.getByRole("status", { name: "Carregando o mês…" })).toBeInTheDocument();
  });
});

describe("AgendaMonthView (celular)", () => {
  it("toque escolhe o dia e a lista dele aparece embaixo; 'Abrir o dia' vai para o dia", () => {
    const h = setup({ isMobile: true, selected: "2026-11-03" });
    fireEvent.click(screen.getByRole("button", { name: /^qua, 04\/11/ }));
    expect(h.onSelectDay).toHaveBeenCalledWith("2026-11-04");
    const list = screen.getByRole("region", { name: /Horários de ter, 03\/11/ });
    expect(within(list).getByText("Cliente a")).toBeInTheDocument();
    expect(within(list).getByText("Beatriz")).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "Abrir o dia" }));
    expect(h.onOpenDay).toHaveBeenCalledWith("2026-11-03");
    fireEvent.click(within(list).getByText("Beatriz"));
    expect(h.onAppointmentClick).toHaveBeenCalledWith("b");
  });
  it("dia sem nada mostra o aviso", () => {
    setup({ isMobile: true, selected: "2026-11-18" });
    expect(screen.getByText("Nada marcado neste dia.")).toBeInTheDocument();
  });
});

describe("AgendaMonthView: '+N mais' abre a lista do dia (computador)", () => {
  const many = Array.from({ length: 8 }, (_, i) => appt(`m${i}`, 10, 8 + i, `Pessoa ${i}`));
  it("popover com todas as linhas; cada linha abre o painel; rodapé abre o dia", () => {
    const h = setup({}, many);
    fireEvent.click(screen.getByRole("button", { name: /a mais em ter, 10\/11/ }));
    const pop = screen.getByRole("dialog", { name: /Horários de ter, 10\/11/ });
    expect(within(pop).getAllByRole("button", { name: /Pessoa/ })).toHaveLength(8);
    fireEvent.click(within(pop).getByRole("button", { name: /Pessoa 7/ }));
    expect(h.onAppointmentClick).toHaveBeenCalledWith("m7");
    expect(h.onOpenDay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /a mais em ter, 10\/11/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Abrir o dia" }));
    expect(h.onOpenDay).toHaveBeenCalledWith("2026-11-10");
  });
});

describe("AgendaMonthView: dia cortado pelo teto e foco do popover", () => {
  function truncatedWeeks() {
    // O servidor contou 9 no dia 3 e só 2 vieram: leitura cortada.
    const cells = buildMonthCells("2026-11-01", "2026-11-30", { days: [{ localDate: "2026-11-03", active: 9, pending: 0, closedResources: 0, occupancy: [] }], capped: false, completeThrough: null }, 3);
    const lines = buildMonthLines({ dates: monthGridDates("2026-11-10"), tz: TZ, appointments: [appt("a", 3, 9), appt("b", 3, 10)], internal: [] });
    return buildMonthGrid({ date: "2026-11-10", cells, lines, truncated: true, loadedThrough: "2026-11-03" });
  }
  it("celular: dia cortado mostra 'não listados' e o botão para abrir o dia, nunca 'sem horários'", () => {
    const h = setup({ isMobile: true, selected: "2026-11-03", weeks: truncatedWeeks() });
    expect(screen.getByText(/\+7 não listados/)).toBeInTheDocument();
    expect(screen.queryByText("Nada marcado neste dia.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abrir o dia" }));
    expect(h.onOpenDay).toHaveBeenCalledWith("2026-11-03");
  });
  it("celular: dia depois do corte sem contagem diz que não foi lido por inteiro, em vez de vazio", () => {
    setup({ isMobile: true, selected: "2026-12-02", weeks: truncatedWeeks() });
    expect(screen.getByText(/não foi lido por inteiro/)).toBeInTheDocument();
    expect(screen.queryByText("Nada marcado neste dia.")).toBeNull();
  });
  it("computador: dia do mês seguinte depois do corte mostra 'Ver o dia' em vez de vazio", () => {
    const h = setup({ weeks: truncatedWeeks() });
    fireEvent.click(screen.getAllByRole("button", { name: "Ver o dia" })[0]);
    expect(h.onOpenDay).toHaveBeenCalled();
  });
  it("popover '+N mais': recebe o foco ao abrir, Tab circula dentro dele e Esc fecha devolvendo o foco", () => {
    const many = Array.from({ length: 8 }, (_, i) => appt(`m${i}`, 10, 8 + i, `Pessoa ${i}`));
    setup({}, many);
    const more = screen.getByRole("button", { name: /a mais em ter, 10\/11/ });
    more.focus();
    fireEvent.click(more);
    const pop = screen.getByRole("dialog");
    expect(pop.contains(document.activeElement)).toBe(true);
    const buttons = within(pop).getAllByRole("button");
    buttons[buttons.length - 1].focus();
    fireEvent.keyDown(buttons[buttons.length - 1], { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(more);
  });
});
