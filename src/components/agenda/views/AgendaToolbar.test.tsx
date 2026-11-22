import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AgendaColorLegend } from "./AgendaColorLegend";
import { AgendaToolbar, type AgendaToolbarProps } from "./AgendaToolbar";

afterEach(() => vi.restoreAllMocks());

function props(over: Partial<AgendaToolbarProps> = {}): AgendaToolbarProps {
  return {
    view: "dia",
    onViewChange: vi.fn(),
    group: "sala",
    onGroupChange: vi.fn(),
    listMode: "hora",
    onListModeChange: vi.fn(),
    dateLabel: "26 de novembro de 2026",
    atToday: false,
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onToday: vi.fn(),
    canBook: true,
    onBook: vi.fn(),
    canCreateEvent: true,
    onNewEvent: vi.fn(),
    canManage: true,
    onCloseAll: vi.fn(),
    onReopenAll: vi.fn(),
    pendingLabel: "3",
    pendingTotal: 3,
    onOpenPending: vi.fn(),
    weekFilter: null,
    color: "status",
    onColorChange: vi.fn(),
    density: "padrao",
    onDensityChange: vi.fn(),
    isMobile: false,
    ...over,
  };
}

describe("AgendaToolbar (computador): uma barra só", () => {
  it("tem Hoje, setas, título do período, visão, Pendências com contador, menu e 'Marcar horário' na mesma barra", () => {
    render(<AgendaToolbar {...props()} />);
    const bar = screen.getByRole("toolbar");
    expect(within(bar).getByRole("button", { name: "Hoje" })).toBeEnabled();
    expect(within(bar).getByRole("button", { name: "Dia anterior" })).toBeInTheDocument();
    expect(within(bar).getByRole("heading", { name: "26 de novembro de 2026" })).toBeInTheDocument();
    expect(within(bar).getByRole("radiogroup", { name: "Visão da agenda" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /Pendências da agenda: 3/ })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Mais opções" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Marcar horário" })).toBeInTheDocument();
    // Não há mais um título "Agenda" separado nem uma segunda linha de abas.
    expect(screen.queryByRole("heading", { name: "Agenda" })).toBeNull();
  });
  it("ordem das visões como no Google e setas conforme a visão", () => {
    const { rerender } = render(<AgendaToolbar {...props({ view: "semana" })} />);
    const labels = within(screen.getByRole("radiogroup", { name: "Visão da agenda" })).getAllByRole("radio").map((r) => r.textContent);
    expect(labels).toEqual(["Dia", "Semana", "Mês", "Lista"]);
    expect(screen.getByRole("button", { name: "Semana anterior" })).toBeInTheDocument();
    rerender(<AgendaToolbar {...props({ view: "mes" })} />);
    expect(screen.getByRole("button", { name: "Próximo mês" })).toBeInTheDocument();
  });
  it("Hoje fica desligado quando o período já tem hoje", () => {
    render(<AgendaToolbar {...props({ atToday: true })} />);
    expect(screen.getByRole("button", { name: "Hoje" })).toBeDisabled();
  });
  it("agrupamento Sala/Profissional só em Dia e Lista; some em Semana e Mês", () => {
    const { rerender } = render(<AgendaToolbar {...props()} />);
    expect(screen.getByRole("radiogroup", { name: "Agrupar por" })).toBeInTheDocument();
    rerender(<AgendaToolbar {...props({ view: "semana" })} />);
    expect(screen.queryByRole("radiogroup", { name: "Agrupar por" })).toBeNull();
    rerender(<AgendaToolbar {...props({ view: "mes" })} />);
    expect(screen.queryByRole("radiogroup", { name: "Agrupar por" })).toBeNull();
  });
  it("trocar de visão e de agrupamento avisa o contêiner", () => {
    const p = props();
    render(<AgendaToolbar {...p} />);
    fireEvent.click(screen.getByRole("radio", { name: "Mês" }));
    expect(p.onViewChange).toHaveBeenCalledWith("mes");
    fireEvent.click(screen.getByRole("radio", { name: "Profissional" }));
    expect(p.onGroupChange).toHaveBeenCalledWith("profissional");
  });
  it("Semana: seletor 'Todos' filtra por sala ou profissional", () => {
    const onChange = vi.fn();
    render(
      <AgendaToolbar
        {...props({ view: "semana", weekFilter: { options: [{ id: "r1", label: "Sala 1", kind: "room" }, { id: "p1", label: "Dra. Ana", kind: "person" }], value: null, onChange } })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Todos/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Dra. Ana" }));
    expect(onChange).toHaveBeenCalledWith("p1");
  });
  it("menu ⋯: novo compromisso, fechar agenda, cores e densidade", () => {
    const p = props({ view: "lista" });
    render(<AgendaToolbar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Mais opções" }));
    const names = screen.getAllByRole("menuitem").concat(screen.getAllByRole("menuitemradio")).map((i) => i.textContent);
    expect(names).toEqual(expect.arrayContaining(["Novo compromisso", "Fechar a agenda inteira", "Colorir por serviço", "Densidade compacta", "Ordem da lista: por recurso"]));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Colorir por serviço" }));
    expect(p.onColorChange).toHaveBeenCalledWith("servico");
  });
  it("sem permissão de marcar, não há 'Marcar horário'; sem leitura de pendências, não há o botão", () => {
    render(<AgendaToolbar {...props({ canBook: false, pendingLabel: null, canCreateEvent: false, canManage: false })} />);
    expect(screen.queryByRole("button", { name: "Marcar horário" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Pendências/ })).toBeNull();
  });
});

describe("AgendaToolbar (celular): uma linha compacta", () => {
  it("setas, título, Hoje, Pendências e a visão em menu; sem 'Marcar horário' (é o botão flutuante)", () => {
    const p = props({ isMobile: true, view: "lista" });
    render(<AgendaToolbar {...p} />);
    expect(screen.getByRole("button", { name: "Ir para hoje" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Marcar horário" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Visão: Lista" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Semana" }));
    expect(p.onViewChange).toHaveBeenCalledWith("semana");
  });
  it("Hoje some quando já está em hoje", () => {
    render(<AgendaToolbar {...props({ isMobile: true, atToday: true })} />);
    expect(screen.queryByRole("button", { name: "Ir para hoje" })).toBeNull();
  });
});

describe("AgendaColorLegend", () => {
  const resources = [{ _id: "r1", name: "Sala 1" }, { _id: "r2", name: "Sala 2" }];
  const services = [{ _id: "s1", name: "Sessão" }];
  it("por sala ou profissional lista os recursos; por serviço, os serviços", () => {
    const { rerender } = render(<AgendaColorLegend scheme="recurso" resources={resources} services={services} />);
    expect(screen.getByRole("list", { name: "Cores" })).toHaveTextContent("Sala 1");
    rerender(<AgendaColorLegend scheme="servico" resources={resources} services={services} />);
    expect(screen.getByRole("list", { name: "Cores" })).toHaveTextContent("Sessão");
    expect(screen.getByRole("list", { name: "Cores" })).not.toHaveTextContent("Sala 1");
  });
  it("por situação lista as situações e só aparece no computador", () => {
    render(<AgendaColorLegend scheme="status" resources={resources} services={services} />);
    const list = screen.getByRole("list", { name: "Cores" });
    expect(list).toHaveTextContent("Confirmado");
    expect(list.className).toContain("hidden md:flex");
  });
});
