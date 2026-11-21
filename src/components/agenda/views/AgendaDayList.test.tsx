import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { buildDayGridModel } from "@/lib/agendaGrid";
import { buildDayList, summarizeResources } from "@/lib/agendaDayList";
import type { ListMode } from "@/lib/agendaViewParams";
import { AgendaDayList, type AgendaDayListProps } from "./AgendaDayList";
import { appt, at, dayInput, NOW, res } from "./agendaViews.fixtures";

function setup(d = dayInput(), mode: ListMode = "hora", over: Partial<AgendaDayListProps> = {}, withFree = true) {
  const handlers = {
    onAppointmentClick: vi.fn(),
    onInternalClick: vi.fn(),
    onFreeClick: vi.fn(),
    onResourceAction: vi.fn(),
    onBook: vi.fn(),
  };
  const grid = buildDayGridModel({ day: d, internal: [], groupBy: "room", now: NOW });
  render(
    <AgendaDayList
      groups={buildDayList({ day: d, internal: [], groupBy: "room", mode, now: NOW, withFree })}
      summaries={summarizeResources(grid)}
      tz={d.timezone}
      mode={mode}
      groupBy="room"
      canBook
      canClose
      isToday
      resources={d.resources}
      {...handlers}
      {...over}
    />
  );
  return handlers;
}

describe("AgendaDayList por horário", () => {
  const d = () =>
    dayInput({
      appointments: [
        appt(["sala1"], at(14), at(15), { contactName: "Maria", serviceName: "Fisioterapia", origin: "ai", status: "pending_approval" }),
        appt(["sala2"], at(9), at(10), { contactName: "João", status: "confirmed" }),
      ],
    });

  it("em ordem cronológica, com cliente, serviço, sala, chip de status e selo de origem", () => {
    setup(d());
    const rows = screen.getAllByRole("button", { name: /Maria|João/ });
    expect(rows[0]).toHaveTextContent("João");
    expect(rows[1]).toHaveTextContent("Maria");
    expect(rows[1]).toHaveTextContent("Fisioterapia · Sala1");
    expect(within(rows[1]).getByText("Aguardando aprovação")).toBeInTheDocument();
    expect(within(rows[1]).getByText("IA")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Confirmado")).toBeInTheDocument();
  });
  it("toque na linha abre o painel", () => {
    const h = setup(d());
    fireEvent.click(screen.getByRole("button", { name: /Maria/ }));
    expect(h.onAppointmentClick).toHaveBeenCalledTimes(1);
  });
  it("resumo por recurso no topo, com as vagas da sala dupla", () => {
    setup(d());
    const summary = screen.getByRole("region", { name: "Resumo por recurso" });
    expect(within(summary).getByText("Sala1")).toBeInTheDocument();
    expect(within(summary).getByText("Sala2")).toBeInTheDocument();
  });
  it("dia vazio: mensagem e botão Marcar horário", () => {
    const h = setup(dayInput());
    expect(screen.getByText("Nenhum horário marcado neste dia")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    expect(h.onBook).toHaveBeenCalled();
  });
  it("ocupado anônimo sem dados de cliente", () => {
    setup(dayInput({ busy: [{ resourceIds: ["sala1"], start: at(9), end: at(10) }] }), "hora", { canBook: false, canClose: false });
    expect(screen.getByText("Ocupado")).toBeInTheDocument();
    expect(screen.queryByText(/Cliente/)).toBeNull();
  });
});

describe("AgendaDayList por recurso", () => {
  it("grupos por sala, vagas '1/2' na dupla e '+ livre' que marca horário no recurso", () => {
    const d = dayInput({ appointments: [appt(["sala2"], at(9), at(10, 45))] });
    const h = setup(d, "recurso");
    const sala2 = screen.getByRole("listitem", { name: "Sala2" });
    expect(within(sala2).getByRole("img", { name: "1 de 2 vagas ocupadas" })).toBeInTheDocument();
    const free = within(sala2).getAllByRole("button", { name: /livre das/ });
    fireEvent.click(free[0]);
    expect(h.onFreeClick).toHaveBeenCalledWith("sala2", 570); // agora (09:30): a sala dupla ainda tem 1 vaga
  });
  it("sem permissão de marcar não há '+ livre'", () => {
    const d = dayInput({ appointments: [appt(["sala2"], at(10), at(11))] });
    setup(d, "recurso", { canBook: false }, false);
    expect(screen.queryByRole("button", { name: /livre das/ })).toBeNull();
  });
  it("recurso fechado: motivo, 'Abrir hoje' e nada de livre", () => {
    const d = dayInput({
      resources: [res("sala1", "room", { closed: true, open: [] }), res("sala2", "room")],
      exceptions: [{ resourceId: "sala1", mode: "closed", reasonCode: "no_staff" }],
      appointments: [appt([], at(9), at(10), {}, ["sala1"])],
    });
    const h = setup(d, "recurso");
    const sala1 = screen.getByRole("listitem", { name: "Sala1" });
    expect(within(sala1).getByText("Fechada hoje")).toBeInTheDocument();
    expect(within(sala1).getByText("Sem equipe")).toBeInTheDocument();
    expect(within(sala1).queryByRole("button", { name: /livre/ })).toBeNull();
    fireEvent.click(within(sala1).getByRole("button", { name: "Abrir hoje" }));
    expect(h.onResourceAction).toHaveBeenCalledWith(expect.objectContaining({ _id: "sala1" }), "reopen");
    // "Sem lugar" vem antes das salas e leva ao painel
    const first = within(screen.getByRole("list", { name: "Horários do dia" })).getAllByRole("listitem")[0];
    expect(first).toHaveAccessibleName("Sem lugar");
  });
  it("menu do resumo: fechar hoje no celular", () => {
    const h = setup(dayInput(), "recurso");
    fireEvent.click(screen.getByRole("button", { name: /^Sala1, Aberta/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fechar hoje" }));
    expect(h.onResourceAction).toHaveBeenCalledWith(expect.objectContaining({ _id: "sala1" }), "closeToday");
  });
});

describe("AgendaDayList: dia que não é hoje", () => {
  it("resumo e grupo fechado dizem 'neste dia'", () => {
    const d = dayInput({ resources: [res("sala1", "room", { closed: true, open: [] }), res("sala2", "room")], exceptions: [{ resourceId: "sala1", mode: "closed" }], appointments: [appt(["sala2"], at(10), at(11))] });
    const h = setup(d, "recurso", { isToday: false });
    const sala1 = screen.getByRole("listitem", { name: "Sala1" });
    expect(within(sala1).getByText("Fechada neste dia")).toBeInTheDocument();
    fireEvent.click(within(sala1).getByRole("button", { name: "Reabrir neste dia" }));
    expect(h.onResourceAction).toHaveBeenCalledWith(expect.objectContaining({ _id: "sala1" }), "reopen");
    fireEvent.click(screen.getByRole("button", { name: /^Sala2, Aberta/ }));
    expect(screen.getByRole("menuitem", { name: "Fechar neste dia" })).toBeInTheDocument();
  });
});
