import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { GridAppointment } from "@/lib/agendaGrid";
import { AppointmentBlock, InternalBlock } from "./AgendaBlocks";

const TZ = "America/Sao_Paulo";
const at = (h: number, m = 0) => Date.UTC(2026, 10, 26, h + 3, m);
const base: GridAppointment = {
  _id: "a1" as never,
  serviceName: "Sessão",
  startTime: at(11),
  endTime: at(11, 50),
  status: "scheduled",
  origin: "staff",
  localDate: "2026-11-26",
  contactName: "Maria Silva",
  resources: [
    { resourceId: "r1" as never, role: "room", name: "Sala 1", allocated: true },
    { resourceId: "p1" as never, role: "person", name: "Dra. Ana", allocated: true },
  ],
};
const tone = { block: "border-l-4 border-semantic-info bg-semantic-info/10", dot: "bg-semantic-info" };

function mount(a: Partial<GridAppointment>, height: number, props: Partial<React.ComponentProps<typeof AppointmentBlock>> = {}) {
  const onOpen = vi.fn();
  render(
    <AppointmentBlock
      appointment={{ ...base, ...a }}
      expired={false}
      conflict={false}
      tz={TZ}
      box={{ top: 0, height, left: "0px", width: "100%" }}
      tone={tone}
      exceptResourceId="r1"
      onOpen={onOpen}
      {...props}
    />
  );
  return onOpen;
}

function hover(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never;
}

beforeEach(() => hover(false));
afterEach(() => vi.useRealTimers());

describe("AppointmentBlock: texto por altura", () => {
  it("bloco curto vira uma linha 'hora cliente · serviço'", () => {
    mount({}, 28);
    const b = screen.getByRole("button");
    expect(b).toHaveTextContent("11:00 Maria Silva · Sessão");
    expect(b.textContent).not.toContain("11:00 – 11:50");
  });
  it("mais altura: cliente em negrito, horário, serviço e o lugar que a coluna não diz", () => {
    mount({}, 100);
    const b = screen.getByRole("button");
    expect(b).toHaveTextContent("Maria Silva");
    expect(b).toHaveTextContent("11:00 – 11:50");
    expect(b).toHaveTextContent("Sessão");
    expect(b).toHaveTextContent("Dra. Ana");
    expect(b.textContent).not.toContain("Sala 1");
  });
  it("altura média corta o que tem menos prioridade (sem lugar)", () => {
    mount({}, 54);
    const b = screen.getByRole("button");
    expect(b).toHaveTextContent("11:00 – 11:50");
    expect(b.textContent).not.toContain("Dra. Ana");
  });
  it("title e nome acessível trazem tudo", () => {
    mount({ status: "confirmed" }, 28);
    const b = screen.getByRole("button");
    expect(b.getAttribute("title")).toBe("Maria Silva · 11:00 – 11:50 · Sessão · Sala 1, Dra. Ana · Confirmado");
    expect(b.getAttribute("aria-label")).toBe(b.getAttribute("title"));
  });
  it("ícones de estado: pendente de aprovação e origem IA, com texto para leitor de tela", () => {
    mount({ status: "pending_approval", origin: "ai" }, 100, { tone: { ...tone, block: "border-l-4 border-dashed" } });
    const b = screen.getByRole("button");
    expect(b.querySelector('svg.lucide-hourglass')).not.toBeNull();
    expect(b.querySelector('svg.lucide-bot')).not.toBeNull();
    expect(b).toHaveTextContent("Aguardando aprovação");
  });
  it("faixa estreita (3 faixas): nome em até 2 linhas e só a hora de início", () => {
    mount({}, 100, { lanes: 3 });
    const b = screen.getByRole("button");
    expect(b.querySelector(".line-clamp-2")).toHaveTextContent("Maria Silva");
    expect(b.textContent).not.toContain("11:00 – 11:50");
    expect(b).toHaveTextContent("11:00");
  });
  it("clique abre o painel e não propaga", () => {
    const onOpen = mount({}, 60);
    const parent = vi.fn();
    document.body.addEventListener("click", parent);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith("a1");
    expect(parent).not.toHaveBeenCalled();
    document.body.removeEventListener("click", parent);
  });
});

describe("AppointmentBlock: cartão ao passar o mouse (computador)", () => {
  it("abre depois de uma pausa, com cliente, serviço, horário, lugar, situação e origem", () => {
    hover(true);
    vi.useFakeTimers();
    mount({}, 60, { quick: { canEdit: true, onStatus: vi.fn() } });
    fireEvent.mouseEnter(screen.getByRole("button"));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => void vi.advanceTimersByTime(450));
    const card = screen.getByRole("dialog", { name: "Maria Silva" });
    expect(card).toHaveTextContent("11:00 – 11:50");
    expect(card).toHaveTextContent("Sessão");
    expect(card).toHaveTextContent("Sala 1, Dra. Ana");
    expect(card).toHaveTextContent("Marcado");
    expect(card).toHaveTextContent("Equipe");
  });
  it("Confirmar muda a situação (Marcado) e Abrir abre o painel", () => {
    hover(true);
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const onOpen = mount({}, 60, { quick: { canEdit: true, onStatus } });
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Maria/ }));
    act(() => void vi.advanceTimersByTime(450));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(onStatus).toHaveBeenCalledWith("a1", "confirmed");
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Maria/ }));
    act(() => void vi.advanceTimersByTime(450));
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    expect(onOpen).toHaveBeenCalledWith("a1");
  });
  it("Confirmado oferece 'Chegou'; sem permissão, só 'Abrir'; proposta vencida não confirma", () => {
    hover(true);
    vi.useFakeTimers();
    mount({ status: "confirmed" }, 60, { quick: { canEdit: true, onStatus: vi.fn() } });
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Maria/ }));
    act(() => void vi.advanceTimersByTime(450));
    expect(screen.getByRole("button", { name: "Chegou" })).toBeInTheDocument();
  });
  it("sem passar o mouse (celular) não abre cartão", () => {
    vi.useFakeTimers();
    mount({}, 60);
    fireEvent.mouseEnter(screen.getByRole("button"));
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("InternalBlock", () => {
  const item = { id: "e1", title: "Reunião de equipe", startTime: at(14), endTime: at(15), eventType: "meeting", source: "event" as const, allDay: false, memberIds: [] };
  it("compromisso: título, horário e tipo; abre o compromisso", () => {
    const onOpen = vi.fn();
    render(<InternalBlock item={item} tz={TZ} box={{ top: 0, height: 80, left: "0px", width: "100%" }} onOpen={onOpen} />);
    const b = screen.getByRole("button");
    expect(b).toHaveTextContent("Reunião de equipe");
    expect(b).toHaveTextContent("14:00 – 15:00");
    expect(b.className).toContain("border-dashed");
    fireEvent.click(b);
    expect(onOpen).toHaveBeenCalledWith(item);
  });
  it("com arrasto disponível ganha o cursor de arrastar e repassa o início do gesto", () => {
    const onDragStart = vi.fn();
    render(<InternalBlock item={item} tz={TZ} box={{ top: 30, height: 80, left: "0px", width: "100%" }} onOpen={vi.fn()} onDragStart={onDragStart} />);
    const b = screen.getByRole("button");
    expect(b.className).toContain("cursor-grab");
    fireEvent.pointerDown(b, { button: 0 });
    expect(onDragStart).toHaveBeenCalledWith(expect.anything(), 30);
  });
});
