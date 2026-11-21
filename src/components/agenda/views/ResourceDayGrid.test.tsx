import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { buildDayGridModel } from "@/lib/agendaGrid";
import { ResourceDayGrid, type ResourceDayGridProps } from "./ResourceDayGrid";
import { appt, at, dayInput, NOW, res } from "./agendaViews.fixtures";

function setup(model: ReturnType<typeof buildDayGridModel>, over: Partial<ResourceDayGridProps> = {}) {
  const handlers = { onSlotClick: vi.fn(), onAppointmentClick: vi.fn(), onInternalClick: vi.fn(), onColumnAction: vi.fn() };
  render(<ResourceDayGrid model={model} tz="America/Sao_Paulo" groupLabel="sala" canBook canClose isToday {...handlers} {...over} />);
  return handlers;
}
const build = (d = dayInput(), groupBy: "room" | "person" = "room") => buildDayGridModel({ day: d, internal: [], groupBy, now: NOW });

describe("ResourceDayGrid: sala dupla", () => {
  it("duas faixas lado a lado e '2/2' no cabeçalho", () => {
    const d = dayInput({ appointments: [appt(["sala2"], at(9), at(10)), appt(["sala2"], at(9), at(10))] });
    setup(build(d));
    const blocks = screen.getAllByRole("button", { name: /Cliente/ });
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.style.width)).toEqual(["calc(50% - 4px)", "calc(50% - 4px)"]);
    expect(blocks.map((b) => b.style.left).sort()).toEqual(["calc(0% + 2px)", "calc(50% + 2px)"]);
    expect(screen.getByRole("img", { name: "2 de 2 vagas ocupadas" })).toHaveTextContent("2/2");
  });

  it("um agendamento só na sala dupla ocupa metade e mostra '1/2'", () => {
    setup(build(dayInput({ appointments: [appt(["sala2"], at(9), at(10))] })));
    expect(screen.getByRole("button", { name: /Cliente/ }).style.width).toBe("calc(50% - 4px)");
    expect(screen.getByRole("img", { name: "1 de 2 vagas ocupadas" })).toBeInTheDocument();
  });

  it("acima da capacidade: '3/2' com aviso e três faixas", () => {
    const d = dayInput({ appointments: [1, 2, 3].map(() => appt(["sala2"], at(9), at(10))) });
    setup(build(d));
    expect(screen.getByRole("img", { name: /3 de 2 vagas: acima da capacidade/ })).toHaveTextContent("3/2");
    expect(screen.getAllByRole("button", { name: /Cliente/ }).every((b) => b.style.width === "calc(33.3333% - 4px)")).toBe(true);
  });

  it("sala simples não mostra o indicador de vagas", () => {
    setup(build(dayInput({ appointments: [appt(["sala1"], at(9), at(10))] })));
    // Só a sala dupla (Sala2) tem indicador; a Sala1 (capacidade 1) não.
    expect(screen.getAllByRole("img", { name: /vagas/ })).toHaveLength(1);
  });
});

describe("ResourceDayGrid: coluna fechada", () => {
  const closed = () =>
    dayInput({
      resources: [res("sala1", "room", { closed: true, open: [] }), res("sala2", "room")],
      exceptions: [{ resourceId: "sala1", mode: "closed", reasonCode: "maintenance" }],
    });

  it("mostra 'Fechada hoje' com o motivo e não aceita clique para marcar", () => {
    const h = setup(build(closed()));
    expect(screen.getAllByText("Fechada hoje").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Manutenção").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("group", { name: "Sala1" }), { clientY: 120 });
    expect(h.onSlotClick).not.toHaveBeenCalled();
  });
  it("o menu da coluna fechada oferece Abrir hoje", () => {
    const h = setup(build(closed()));
    fireEvent.click(screen.getByRole("button", { name: "Opções de Sala1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Abrir hoje" }));
    expect(h.onColumnAction).toHaveBeenCalledWith(expect.objectContaining({ _id: "sala1" }), "reopen");
  });
});

describe("ResourceDayGrid: ocupado anônimo (view_own)", () => {
  it("mostra 'Ocupado' sem cliente, serviço ou botão", () => {
    const d = dayInput({ busy: [{ resourceIds: ["sala1"], start: at(9), end: at(10) }] });
    setup(build(d), { canBook: false, canClose: false });
    expect(screen.getByRole("img", { name: "Ocupado" })).toBeInTheDocument();
    expect(screen.queryByText(/Cliente|Sessão/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Opções/ })).toBeNull();
  });
});

describe("ResourceDayGrid: cliques", () => {
  it("vazio abre marcar horário com o recurso da coluna e o minuto (15 em 15)", () => {
    const h = setup(build());
    fireEvent.click(screen.getByRole("group", { name: "Sala2" }), { clientY: 130 });
    expect(h.onSlotClick).toHaveBeenCalledWith(expect.objectContaining({ _id: "sala2" }), 600);
  });
  it("bloco abre o painel e não marca horário", () => {
    const a = appt(["sala1"], at(9), at(10));
    const h = setup(build(dayInput({ appointments: [a] })));
    fireEvent.click(screen.getByRole("button", { name: /Cliente/ }));
    expect(h.onAppointmentClick).toHaveBeenCalledWith(a._id);
    expect(h.onSlotClick).not.toHaveBeenCalled();
  });
  it("sem permissão de marcar, o vazio não faz nada", () => {
    const h = setup(build(), { canBook: false });
    fireEvent.click(screen.getByRole("group", { name: "Sala1" }), { clientY: 130 });
    expect(h.onSlotClick).not.toHaveBeenCalled();
  });
  it("menu da coluna: marcar aqui e fechar hoje", () => {
    const h = setup(build());
    fireEvent.click(screen.getByRole("button", { name: "Opções de Sala1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Marcar horário aqui" }));
    expect(h.onColumnAction).toHaveBeenLastCalledWith(expect.objectContaining({ _id: "sala1" }), "book");
    fireEvent.click(screen.getByRole("button", { name: "Opções de Sala1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fechar hoje" }));
    expect(h.onColumnAction).toHaveBeenLastCalledWith(expect.objectContaining({ _id: "sala1" }), "closeToday");
  });
});

describe("ResourceDayGrid: estados dos blocos", () => {
  it("aguardando aprovação tem estilo e rótulo próprios; status não depende só de cor", () => {
    const a = appt(["sala1"], at(14), at(15), { status: "pending_approval" });
    setup(build(dayInput({ appointments: [a] })));
    const block = screen.getByRole("button", { name: /Aguardando aprovação/ });
    expect(block.className).toContain("border-dashed");
  });
  it("compromisso e tarefa ficam em coluna própria, distintos", () => {
    const model = buildDayGridModel({
      day: dayInput(),
      groupBy: "room",
      now: NOW,
      internal: [{ id: "e1", title: "Reunião de equipe", startTime: at(14), endTime: at(15), eventType: "meeting", source: "event", allDay: false, memberIds: [] }],
    });
    const h = setup(model);
    const col = screen.getByRole("group", { name: "Compromissos e tarefas" });
    fireEvent.click(within(col).getByRole("button", { name: /Reunião de equipe/ }));
    expect(h.onInternalClick).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }));
    expect(h.onSlotClick).not.toHaveBeenCalled();
  });
  it("só as colunas visíveis (celular)", () => {
    setup(build(), { visibleKeys: ["res:sala2"] });
    expect(screen.queryByRole("group", { name: "Sala1" })).toBeNull();
    expect(screen.getByRole("group", { name: "Sala2" })).toBeInTheDocument();
  });
});

describe("ResourceDayGrid: dia aberto que não é hoje", () => {
  it("rótulos 'neste dia', nunca 'hoje'", () => {
    const closed = dayInput({ resources: [res("sala1", "room", { closed: true, open: [] }), res("sala2", "room")], exceptions: [{ resourceId: "sala1", mode: "closed", reasonCode: "holiday" }] });
    setup(build(closed), { isToday: false });
    expect(screen.getAllByText("Fechada neste dia").length).toBeGreaterThan(0);
    expect(screen.queryByText("Fechada hoje")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Opções de Sala1" }));
    expect(screen.getByRole("menuitem", { name: "Reabrir neste dia" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Reabrir um período" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Abrir hoje" })).toBeNull();
  });
  it("coluna aberta: 'Fechar neste dia' e a ação continua sendo closeToday para o contêiner", () => {
    const h = setup(build(), { isToday: false });
    fireEvent.click(screen.getByRole("button", { name: "Opções de Sala1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fechar neste dia" }));
    expect(h.onColumnAction).toHaveBeenCalledWith(expect.objectContaining({ _id: "sala1" }), "closeToday");
  });
});

describe("ResourceDayGrid: acima da capacidade", () => {
  it("o grupo que passa da capacidade fica com anel de erro e rótulo acessível; o cabeçalho avisa o pico", () => {
    const d = dayInput({ appointments: [1, 2, 3].map(() => appt(["sala2"], at(9), at(10))).concat([appt(["sala2"], at(15), at(16))]) });
    setup(build(d));
    const blocks = screen.getAllByRole("button", { name: /Cliente/ });
    const over = blocks.filter((b) => /acima da capacidade/.test(b.getAttribute("aria-label") ?? ""));
    expect(over).toHaveLength(3);
    expect(over.every((b) => b.className.includes("ring-semantic-error"))).toBe(true);
    const lone = blocks.find((b) => b.style.top === "420px")!;
    expect(lone.getAttribute("aria-label")).not.toMatch(/acima da capacidade/);
    expect(screen.getByText("Pico 3/2: acima da capacidade")).toBeInTheDocument();
  });
});

describe("ResourceDayGrid: marcar pelo teclado e coluna do profissional", () => {
  it("cada coluna tem um botão 'Marcar horário em ...'", () => {
    const h = setup(build());
    fireEvent.click(screen.getByRole("button", { name: "Marcar horário em Sala2" }));
    expect(h.onColumnAction).toHaveBeenCalledWith(expect.objectContaining({ _id: "sala2" }), "book");
  });
  it("sem permissão de marcar (ou dia passado) o botão some", () => {
    setup(build(), { canBook: false });
    expect(screen.queryByRole("button", { name: /Marcar horário em/ })).toBeNull();
  });
  it("compromisso do profissional aparece na coluna dele, tracejado", () => {
    const model = buildDayGridModel({
      day: dayInput({ resources: [res("ana", "person", { teamMemberId: "m1" })] }),
      groupBy: "person",
      now: NOW,
      internal: [{ id: "e1", title: "Reunião de equipe", startTime: at(14), endTime: at(15), eventType: "meeting", source: "event", allDay: false, memberIds: ["m1"] }],
    });
    setup(model, { groupLabel: "profissional" });
    const col = screen.getByRole("group", { name: "Ana" });
    expect(within(col).getByRole("button", { name: /Reunião de equipe/ }).className).toContain("border-dashed");
    expect(screen.queryByRole("group", { name: "Compromissos e tarefas" })).toBeNull();
  });
});

describe("ResourceDayGrid: dia inteiro e proposta vencida", () => {
  const folga = { id: "e1", title: "Folga", startTime: at(0), endTime: at(23, 59), eventType: "other", source: "event" as const, allDay: true, memberIds: ["m1"] };
  const pessoa = dayInput({ resources: [res("ana", "person", { teamMemberId: "m1" } as never), res("bia", "person", { teamMemberId: "m2" } as never)] });

  it("compromisso de dia inteiro do profissional cobre a coluna dele (faixa com o título), não a do outro", () => {
    const h = setup(buildDayGridModel({ day: pessoa, internal: [folga], groupBy: "person", now: NOW }));
    const ana = screen.getByRole("group", { name: "Ana" });
    const band = within(ana).getByRole("button", { name: /Dia inteiro, Folga/ });
    expect(band).toHaveTextContent("Folga");
    expect(within(screen.getByRole("group", { name: "Bia" })).queryByRole("button", { name: /Dia inteiro/ })).toBeNull();
    fireEvent.click(band);
    expect(h.onInternalClick).toHaveBeenCalledWith(folga);
    // Tocar na faixa abre o compromisso, não marca horário na coluna.
    expect(h.onSlotClick).not.toHaveBeenCalled();
  });

  it("por sala não há faixa (sala não tem dono)", () => {
    setup(buildDayGridModel({ day: dayInput(), internal: [folga], groupBy: "room", now: NOW }));
    expect(screen.queryByRole("button", { name: /Dia inteiro, Folga/ })).toBeNull();
  });

  it("proposta vencida no bloco: rótulo Vencida visível e no nome acessível", () => {
    const a = appt(["sala1"], at(8), at(9), { status: "pending_approval", contactName: "Maria" });
    setup(build(dayInput({ appointments: [a] })));
    const block = screen.getByRole("button", { name: /Maria/ });
    expect(block).toHaveTextContent("Vencida");
    expect(block.getAttribute("aria-label")).toMatch(/Vencida/);
    expect(block.getAttribute("aria-label")).not.toMatch(/Aguardando aprovação/);
  });
});
