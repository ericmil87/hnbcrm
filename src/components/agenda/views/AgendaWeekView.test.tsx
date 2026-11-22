import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { GridAppointment, InternalItem } from "@/lib/agendaGrid";
import { buildWeekModel, type WeekResource } from "@/lib/agendaWeekGrid";
import { AgendaWeekView, type AgendaWeekViewProps } from "./AgendaWeekView";

const TZ = "America/Sao_Paulo";
const DATES = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"];
const at = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h + 3, m);
const appt = (id: string, day: number, h: number, name = `Cliente ${id}`, over: Partial<GridAppointment> = {}): GridAppointment => ({
  _id: id as GridAppointment["_id"],
  serviceName: "Sessão",
  startTime: at(day, h),
  endTime: at(day, h + 1),
  status: "scheduled",
  origin: "staff",
  localDate: `2026-11-${day}`,
  resources: [{ resourceId: "r1" as never, role: "room", name: "Sala 1", allocated: true }],
  contactName: name,
  ...over,
});
const ev = (id: string, day: number, h: number, over: Partial<InternalItem> = {}): InternalItem => ({
  id,
  title: `Reunião ${id}`,
  startTime: at(day, h),
  endTime: at(day, h + 1),
  eventType: "meeting",
  source: "event",
  allDay: false,
  memberIds: [],
  ...over,
});
const resources: WeekResource[] = [{ _id: "r1", kind: "room", name: "Sala 1", active: true, weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 })) }];

function setup(appointments: GridAppointment[], internal: InternalItem[] = [], over: Partial<AgendaWeekViewProps> = {}) {
  const model = buildWeekModel({ dates: DATES, tz: TZ, now: at(25, 10), appointments, internal, resources, filterResourceId: null });
  const h = { onSlotClick: vi.fn(), onAppointmentClick: vi.fn(), onInternalClick: vi.fn(), onOpenDay: vi.fn() };
  render(
    <AgendaWeekView
      model={model}
      tz={TZ}
      hourPx={56}
      tone={{ scheme: "status", resourceOrder: [], serviceOrder: [] }}
      canBookOn={() => true}
      {...h}
      {...over}
    />
  );
  return h;
}

describe("AgendaWeekView", () => {
  it("sete dias no cabeçalho, hoje marcado, e cada dia abre o dia", () => {
    const h = setup([]);
    expect(screen.getAllByRole("button", { name: /^(Seg|Ter|Qua|Qui|Sex|Sáb|Dom)\s*\d+/ })).toHaveLength(7);
    const today = screen.getByRole("button", { name: /Qua\s*25/ });
    expect(today).toHaveAttribute("aria-current", "date");
    fireEvent.click(screen.getByRole("button", { name: /Qui\s*26/ }));
    expect(h.onOpenDay).toHaveBeenCalledWith("2026-11-26");
  });

  it("agendamento com cliente e compromisso da equipe aparecem juntos na mesma coluna", () => {
    setup([appt("a", 26, 11, "Maria")], [ev("x", 26, 11)]);
    const col = document.querySelector('[data-day="2026-11-26"]') as HTMLElement;
    expect(within(col).getByRole("button", { name: /Maria/ })).toBeInTheDocument();
    expect(within(col).getByRole("button", { name: /Reunião x/ })).toBeInTheDocument();
  });

  it("clique no vazio marca horário naquele dia e hora (15 em 15); clique no bloco só abre o painel", () => {
    const h = setup([appt("a", 26, 11, "Maria")]);
    const col = document.querySelector('[data-day="2026-11-25"]') as HTMLElement;
    // 56 px por hora, janela de 0 a 24 h: 560 px = 10:00.
    fireEvent.click(col, { clientY: 565 });
    expect(h.onSlotClick).toHaveBeenCalledWith("2026-11-25", 600);
    fireEvent.click(screen.getByRole("button", { name: /Maria/ }));
    expect(h.onAppointmentClick).toHaveBeenCalledWith("a");
    expect(h.onSlotClick).toHaveBeenCalledTimes(1);
  });

  it("dia que não aceita marcar (passado ou sem permissão) ignora o clique no vazio", () => {
    const h = setup([], [], { canBookOn: (d) => d >= "2026-11-25" });
    fireEvent.click(document.querySelector('[data-day="2026-11-24"]') as HTMLElement, { clientY: 565 });
    expect(h.onSlotClick).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-day="2026-11-27"]') as HTMLElement, { clientY: 565 });
    expect(h.onSlotClick).toHaveBeenCalledWith("2026-11-27", 600);
  });

  it("compromisso de dia inteiro vai para a faixa fixa do topo", () => {
    const h = setup([], [ev("f", 27, 0, { allDay: true, startTime: at(27, 0), endTime: at(28, 0), title: "Feriado" })]);
    const band = screen.getByRole("list", { name: "Dia inteiro" });
    fireEvent.click(within(band).getByRole("button", { name: /Feriado/ }));
    expect(h.onInternalClick).toHaveBeenCalledWith(expect.objectContaining({ id: "f" }));
  });

  it("muitos no mesmo horário viram a ficha '+N' que abre o dia", () => {
    const many = Array.from({ length: 5 }, (_, i) => appt(`m${i}`, 24, 10, `Pessoa ${i}`));
    const h = setup(many);
    fireEvent.click(screen.getByRole("button", { name: /a mais, abrir o dia/ }));
    expect(h.onOpenDay).toHaveBeenCalledWith("2026-11-24");
  });

  it("dia fechado aparece no cabeçalho com texto, não só ícone", () => {
    setup([], [], { dayStatus: { "2026-11-26": { closed: 3, all: true }, "2026-11-27": { closed: 1, all: false } } });
    expect(screen.getAllByText("Fechado").length).toBeGreaterThan(0);
    expect(screen.getByText("1 fechado(s)")).toBeInTheDocument();
  });

  it("o cabeçalho e a rolagem ficam dentro da própria grade (sem rolagem da página)", () => {
    setup([]);
    const sc = document.querySelector("[data-grid-scroller]") as HTMLElement;
    expect(sc.className).toContain("overflow-auto");
    expect(sc.querySelector(".sticky.top-0")).not.toBeNull();
  });
});

describe("AgendaWeekView: arrastar, toque e dia fechado", () => {
  beforeAllMatchMedia();
  it("o pedaço de compromisso que continua de um dia anterior (cruza a meia-noite) não arrasta; o do dia de início arrasta", () => {
    const night = ev("n", 25, 22, { endTime: at(26, 2), title: "Plantão" });
    setup([], [night], { onMoveEvent: vi.fn() });
    const start = within(document.querySelector('[data-day="2026-11-25"]') as HTMLElement).getByRole("button", { name: /Plantão/ });
    const cont = within(document.querySelector('[data-day="2026-11-26"]') as HTMLElement).getByRole("button", { name: /Plantão/ });
    expect(start.className).toContain("cursor-grab");
    expect(cont.className).not.toContain("cursor-grab");
  });
  it("alvos de toque: ficha '+N' e faixas de dia inteiro ampliadas no toque (coarse)", () => {
    setup(Array.from({ length: 5 }, (_, i) => appt(`m${i}`, 24, 10)), [ev("f", 27, 0, { allDay: true, startTime: at(27, 0), endTime: at(28, 0), title: "Feriado" })]);
    expect(screen.getByRole("button", { name: /a mais, abrir o dia/ }).className).toContain("coarse:before:-inset-4");
    expect(screen.getByRole("button", { name: /Feriado/ }).className).toContain("coarse:min-h-11");
  });
  it("dia com a agenda toda fechada não abre a folha ao clicar no vazio", () => {
    const h = setup([], [], { canBookOn: (d) => d !== "2026-11-26" });
    fireEvent.click(document.querySelector('[data-day="2026-11-26"]') as HTMLElement, { clientY: 565 });
    expect(h.onSlotClick).not.toHaveBeenCalled();
  });
});

function beforeAllMatchMedia() {
  // Cursor de arrastar só em ponteiro fino com hover.
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: q.includes("hover: hover"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never;
}
