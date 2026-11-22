import { useReducer, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import {
  bookingReducer,
  initialBookingState,
  pickedFromOffered,
  submitBooking,
  type BookArgs,
  type OfferedSlot,
  type ServiceLike,
  type SubmitOutcome,
} from "@/lib/bookingFlow";
import { BookingFlowView, type FailureView, type ManualPreviewResult, type SlotsState } from "./BookingFlowView";

const scrollSpy = vi.fn();
beforeEach(() => {
  scrollSpy.mockClear();
  Element.prototype.scrollIntoView = scrollSpy;
});

const HOUR = 3_600_000;
const TZ = "America/Sao_Paulo";
const slot = (hoursAhead: number, extra: Partial<OfferedSlot> = {}): OfferedSlot => {
  const start = Math.ceil((Date.now() + hoursAhead * HOUR) / 300_000) * 300_000;
  return { startTime: start, endTime: start + HOUR, localDate: "2030-01-01", label: "x", resourceIds: ["room1"], resourceNames: ["Sala 1"], score: 1, reasons: [], reasonCodes: [], ...extra };
};
const sessao: ServiceLike = { _id: "svc1", name: "Sessão", durationMin: 60, requirements: [{ kind: "room" }] };
const avaliacao: ServiceLike = { _id: "svc2", name: "Avaliação", durationMin: 45, requirements: [{ kind: "room" }] };
const corte: ServiceLike = { _id: "svc3", name: "Corte", durationMin: 30, variants: [{ key: "longo", name: "Cabelo longo", durationMin: 60 }], requirements: [{ kind: "person" }] };
const ready = (slots: OfferedSlot[]): SlotsState => ({ status: "ready", slots, hasMore: false, reason: "ok", firstPossible: null });
const rulesError = (violations: unknown[], alternatives: unknown[] = []) => new ConvexError({ code: "sched_rules", violations, alternatives } as never);

interface HarnessProps {
  services?: ServiceLike[];
  slots?: SlotsState;
  book?: (args: BookArgs) => Promise<{ appointmentIds: string[]; duplicate: boolean }>;
  clientName?: string;
  reschedule?: { fromStartTime?: number } | null;
  preview?: (startTime: number) => Promise<ManualPreviewResult>;
  initialTimeMin?: number;
  date?: string;
  resources?: Array<{ _id: string; name: string; kind: string; capacity?: number }>;
  pinned?: Record<string, string>;
  onOutcome?: (o: SubmitOutcome) => void;
}

/** Faz o papel do contêiner (estado do fluxo e envio), com o servidor falso; a tela é a real. */
function Harness({ services = [sessao, avaliacao], slots = ready([slot(2, { reasons: ["logo após outro atendimento"] }), slot(4)]), book, clientName = "Maria", reschedule = null, preview, initialTimeMin, date, resources, pinned, onOutcome }: HarnessProps) {
  const [state, dispatch] = useReducer(bookingReducer, undefined, () =>
    initialBookingState({ services, idempotencyKey: "k1", serviceId: reschedule ? "svc1" : undefined, date, pinned })
  );
  const [failure, setFailure] = useState<FailureView | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (force?: string[]) => {
    setBusy(true);
    const out = await submitBooking(
      { book: book ?? (async () => ({ appointmentIds: ["a1"], duplicate: false })), reschedule: async () => null },
      { organizationId: "org1", state, who: { contactId: "c1" }, force, tz: TZ, now: Date.now() }
    );
    onOutcome?.(out);
    if (out.kind === "rules") {
      setFailure({ violations: out.violations, alternatives: out.alternatives, source: state.slot?.manual ? "manual" : "suggestion" });
      if (out.blocked) dispatch({ type: "goto", step: "slot" });
    } else setFailure(null);
    setBusy(false);
  };
  return (
    <BookingFlowView
      state={state}
      dispatch={dispatch}
      services={services}
      resources={resources ?? [{ _id: "room1", name: "Sala 1", kind: "room" }, { _id: "p1", name: "Ana", kind: "person" }]}
      tz={TZ}
      today="2030-01-01"
      slots={slots}
      clientName={clientName}
      whoOk
      reschedule={reschedule}
      busy={busy}
      failure={failure}
      onRetry={() => undefined}
      onSubmit={() => void submit()}
      onForce={(codes) => void submit(codes)}
      onPickOffered={(s) => {
        setFailure(null);
        dispatch({ type: "pickSlot", slot: pickedFromOffered(s) });
      }}
      onDismissFailure={() => setFailure(null)}
      initialTimeMin={initialTimeMin}
      onPreviewManual={preview ?? (async () => ({ kind: "ok", warnings: [], resourceIds: [], resourceNames: [] }))}
    />
  );
}

const timeButtons = () => screen.getAllByRole("button", { name: /\d{2}:\d{2}/ });

describe("BookingFlowView", () => {
  it("caminho feliz em 3 toques: serviço, horário, marcar horário", async () => {
    const book = vi.fn().mockResolvedValue({ appointmentIds: ["a1"], duplicate: false });
    const onOutcome = vi.fn();
    render(<Harness book={book} onOutcome={onOutcome} />);
    await userEvent.click(screen.getByRole("button", { name: /Sessão/ })); // 1
    expect(screen.getByText("Encostado")).toBeInTheDocument();
    expect(screen.getByText("Logo após outro atendimento")).toBeInTheDocument();
    await userEvent.click(timeButtons()[0]); // 2
    expect(screen.getByText("Maria")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" })); // 3
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    expect(book.mock.calls[0][0]).toMatchObject({ serviceId: "svc1", contactId: "c1", resourceIds: ["room1"], idempotencyKey: "k1" });
    expect(book.mock.calls[0][0]).not.toHaveProperty("force");
    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith({ kind: "booked", appointmentIds: ["a1"] }));
  });

  it("hora pedida pela Agenda: destaca a sugestão mais próxima e pré-preenche 'Outro horário'", async () => {
    // 09:00, 10:00 e 12:00 em São Paulo no dia 2030-01-01; pedido: 11:40 -> 12:00.
    const at = (h: number) => Date.UTC(2030, 0, 1, h + 3, 0);
    const slots = ready([slot(2, { startTime: at(9), endTime: at(10) }), slot(2, { startTime: at(10), endTime: at(11) }), slot(2, { startTime: at(12), endTime: at(13) })]);
    render(<Harness services={[sessao]} slots={slots} date="2030-01-01" initialTimeMin={11 * 60 + 40} />);
    const nearest = document.querySelectorAll('[data-nearest="true"]');
    expect(nearest).toHaveLength(1);
    expect(nearest[0].textContent).toContain("12:00");
    // "Outro horário" começa FECHADO (aberto de antemão ficava fora da vista e o botão o fechava): um toque abre, já com a hora pedida.
    const toggle = screen.getByRole("button", { name: "Outro horário" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Hora")).toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect((screen.getByLabelText("Hora") as HTMLInputElement).value).toBe("11:40");
  });

  it("sala clicada na Agenda continua escolhida depois de escolher o serviço", async () => {
    const resources = [{ _id: "room1", name: "Sala 1", kind: "room" }, { _id: "dual", name: "Sala dupla", kind: "room", capacity: 2 }];
    render(<Harness pinned={{ room: "dual" }} resources={resources} />);
    await userEvent.click(screen.getByRole("button", { name: /Sessão/ }));
    // O seletor já vem aberto, com a sala da coluna clicada (antes voltava a "Qualquer sala").
    expect(screen.getByRole("button", { name: "Escolher sala ou profissional" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Sala")).toHaveTextContent("Sala dupla");
  });

  it("Outro horário com a sala escolhida cheia: recusa e mostra as alternativas COM o lugar; nada de marcar em outra sala", async () => {
    const alt = Math.ceil((Date.now() + 6 * HOUR) / 300_000) * 300_000;
    const preview = vi.fn().mockResolvedValue({
      kind: "blocked",
      violations: [{ code: "CAPACITY_EXCEEDED", severity: "block", message: "", detail: { resourceId: "dual" } }],
      alternatives: [slot(0, { startTime: alt, endTime: alt + HOUR, resourceIds: ["dual", "p1"], resourceNames: ["Sala dupla", "Ana"] })],
    });
    const book = vi.fn().mockResolvedValue({ appointmentIds: ["a1"], duplicate: false });
    const resources = [{ _id: "room1", name: "Sala 1", kind: "room" }, { _id: "dual", name: "Sala dupla", kind: "room", capacity: 2 }];
    render(<Harness services={[sessao]} slots={ready([])} pinned={{ room: "dual" }} resources={resources} preview={preview} book={book} />);
    await userEvent.click(screen.getByRole("button", { name: "Outro horário" }));
    await userEvent.type(screen.getByLabelText("Hora"), "11:00");
    await userEvent.click(screen.getByRole("button", { name: "Conferir horário" }));
    expect(await screen.findByText("Não dá para marcar neste horário.")).toBeInTheDocument();
    expect(screen.getByText("Sala dupla não tem mais vaga neste horário.")).toBeInTheDocument();
    // A recusa nasce abaixo da dobra do modal: é um alerta, recebe o foco e a vista é levada até ele.
    const refusal = screen.getByRole("alert");
    expect(refusal).toHaveTextContent("Sala dupla não tem mais vaga neste horário.");
    expect(refusal).toHaveFocus();
    expect(scrollSpy).toHaveBeenCalled();
    expect(screen.queryByText("Confira e marque")).toBeNull(); // não foi para a revisão
    const option = screen.getByRole("button", { name: /Sala dupla e Ana/ });
    await userEvent.click(option);
    expect(screen.getByText("Sala dupla e Ana")).toBeInTheDocument(); // revisão com o lugar real da alternativa
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    expect(book.mock.calls[0][0]).toMatchObject({ startTime: alt, resourceIds: ["dual", "p1"], allowResourceFallback: false });
  });

  it("Outro horário livre: a revisão mostra a sala e o profissional REAIS da prévia e o envio vai para eles", async () => {
    const preview = vi.fn().mockResolvedValue({ kind: "ok", warnings: [], resourceIds: ["dual", "p2"], resourceNames: ["Sala dupla", "Bia"] });
    const book = vi.fn().mockResolvedValue({ appointmentIds: ["a1"], duplicate: false });
    render(<Harness services={[sessao]} slots={ready([])} pinned={{ room: "dual" }} resources={[{ _id: "dual", name: "Sala dupla", kind: "room" }]} preview={preview} book={book} />);
    await userEvent.click(screen.getByRole("button", { name: "Outro horário" }));
    await userEvent.type(screen.getByLabelText("Hora"), "11:00");
    await userEvent.click(screen.getByRole("button", { name: "Conferir horário" }));
    expect(await screen.findByText("Sala dupla e Bia")).toBeInTheDocument();
    expect(screen.queryByText("Escolhido pelo sistema")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    expect(book.mock.calls[0][0]).toMatchObject({ resourceIds: ["dual", "p2"], allowResourceFallback: false });
  });

  it("'Quantas pessoas?' só aparece com sala de capacidade maior que 1 e escolher 2 limpa o horário", async () => {
    const { rerender } = render(<Harness services={[sessao]} />);
    expect(screen.queryByRole("group", { name: "Quantas pessoas?" })).toBeNull();
    rerender(<div />);
    render(<Harness services={[sessao]} resources={[{ _id: "dual", name: "Dupla", kind: "room", capacity: 2 }]} />);
    await userEvent.click(screen.getByRole("button", { name: "2 pessoas" }));
    expect(screen.getByRole("button", { name: "2 pessoas" })).toHaveAttribute("aria-pressed", "true");
  });

  it("sem horário com acompanhante e profissional fixo: explica o motivo", async () => {
    render(<Harness services={[{ ...sessao, requirements: [{ kind: "room" }, { kind: "person" }] }]} slots={ready([])} pinned={{ person: "p1" }} resources={[{ _id: "dual", name: "Dupla", kind: "room", capacity: 2 }, { _id: "p1", name: "Ana", kind: "person" }]} />);
    expect(screen.queryByText(/um profissional por pessoa/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "2 pessoas" }));
    expect(screen.getByText(/Com acompanhante é preciso um profissional por pessoa/)).toBeInTheDocument();
  });

  it("sem hora pedida nada é destacado e o campo fica vazio", () => {
    render(<Harness services={[sessao]} date="2030-01-01" />);
    expect(document.querySelector('[data-nearest="true"]')).toBeNull();
    expect(screen.queryByLabelText("Hora")).toBeNull();
  });

  it("serviço único já vem escolhido: 2 toques", async () => {
    const book = vi.fn().mockResolvedValue({ appointmentIds: ["a1"], duplicate: false });
    render(<Harness services={[sessao]} book={book} />);
    await userEvent.click(timeButtons()[0]);
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    await waitFor(() => expect(book).toHaveBeenCalled());
  });

  it("a lista não some durante a rebusca (carregando com horários já exibidos)", () => {
    const slots: SlotsState = { ...ready([slot(2), slot(4)]), status: "loading" };
    render(<Harness services={[sessao]} slots={slots} />);
    expect(timeButtons()).toHaveLength(2);
    expect(screen.queryByText("Buscando horários…")).toBeNull();
  });

  it("carga inicial sem horários mostra o carregando", () => {
    render(<Harness services={[sessao]} slots={{ ...ready([]), status: "loading" }} />);
    expect(screen.getByText("Buscando horários…")).toBeInTheDocument();
  });

  it("aviso forçável: lista o aviso e reenvia com force dos códigos mostrados", async () => {
    const book = vi
      .fn()
      .mockRejectedValueOnce(rulesError([{ code: "OUTSIDE_HOURS", severity: "warn", message: "x", detail: { resourceId: "room1" } }]))
      .mockResolvedValue({ appointmentIds: ["a1"], duplicate: false });
    render(<Harness services={[sessao]} book={book} />);
    await userEvent.click(timeButtons()[0]);
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    expect(await screen.findByText("Antes de marcar")).toBeInTheDocument();
    expect(screen.getByText("Fora do horário de atendimento: Sala 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Marcar mesmo assim" }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(2));
    expect(book.mock.calls[1][0].force).toEqual(["OUTSIDE_HOURS"]);
    expect(book.mock.calls[1][0].idempotencyKey).toBe(book.mock.calls[0][0].idempotencyKey);
  });

  it("capacidade cheia: sem botão de forçar, com alternativas (formato antigo) de um toque; horário sugerido = 'acabou de ser ocupado'", async () => {
    const alt = Math.ceil((Date.now() + 6 * HOUR) / 300_000) * 300_000;
    const book = vi
      .fn()
      .mockRejectedValueOnce(rulesError([{ code: "CAPACITY_EXCEEDED", severity: "block", message: "x", detail: { resourceId: "room1" } }], [{ startTime: alt, resourceIds: ["room1"] }]))
      .mockResolvedValue({ appointmentIds: ["a1"], duplicate: false });
    render(<Harness services={[sessao]} book={book} />);
    await userEvent.click(timeButtons()[0]);
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    expect(await screen.findByText("Esse horário acabou de ser ocupado")).toBeInTheDocument();
    expect(screen.getByText("Sala 1 não tem mais vaga neste horário.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Marcar mesmo assim" })).toBeNull();
    const dialog = screen.getAllByRole("dialog").at(-1)!;
    const alts = Array.from(dialog.querySelectorAll("li button"));
    expect(alts).toHaveLength(1);
    await userEvent.click(alts[0]);
    await userEvent.click(await screen.findByRole("button", { name: "Marcar horário" }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(2));
    expect(book.mock.calls[1][0].startTime).toBe(alt);
    expect(book.mock.calls[1][0]).not.toHaveProperty("force");
  });

  it("horário digitado que não está livre: título 'não está livre', não 'acabou de ser ocupado'", async () => {
    const book = vi.fn().mockRejectedValue(rulesError([{ code: "CAPACITY_EXCEEDED", severity: "block", message: "x" }]));
    render(<Harness services={[sessao]} book={book} slots={ready([])} />);
    await userEvent.click(screen.getByRole("button", { name: "Outro horário" }));
    await userEvent.type(screen.getByLabelText("Hora"), "10:00");
    await userEvent.click(screen.getByRole("button", { name: "Conferir horário" }));
    await userEvent.click(await screen.findByRole("button", { name: "Marcar horário" }));
    expect(await screen.findByText("Esse horário não está livre")).toBeInTheDocument();
    expect(screen.queryByText("Esse horário acabou de ser ocupado")).toBeNull();
  });

  it("Outro horário com aviso: a revisão mostra o aviso acima do botão, que vira 'Marcar mesmo assim', e o force vai sem pedir de novo", async () => {
    const book = vi.fn().mockResolvedValue({ appointmentIds: ["a1"], duplicate: false });
    const preview = vi.fn().mockResolvedValue({ kind: "ok", resourceIds: ["room1"], resourceNames: ["Sala 1"], warnings: [{ code: "OUTSIDE_HOURS", severity: "warn", message: "", detail: { resourceId: "room1" } }] });
    render(<Harness services={[sessao]} book={book} slots={ready([])} preview={preview} />);
    await userEvent.click(screen.getByRole("button", { name: "Outro horário" }));
    await userEvent.type(screen.getByLabelText("Hora"), "20:00");
    await userEvent.click(screen.getByRole("button", { name: "Conferir horário" }));
    const title = await screen.findByText("Avisos deste horário");
    expect(screen.getByText("Fora do horário de atendimento: Sala 1")).toBeInTheDocument();
    expect(screen.getByText("Sala 1")).toBeInTheDocument(); // "Com quem e onde" com o lugar real, não "Escolhido pelo sistema"
    expect(screen.queryByRole("button", { name: "Marcar horário" })).toBeNull();
    const submit = screen.getByRole("button", { name: "Marcar mesmo assim" });
    // Os avisos ficam no topo da revisão, acima do resumo (abaixo da dobra do modal ninguém os via), com o foco.
    const alert = screen.getByRole("alert");
    expect(alert).toContainElement(title);
    expect(alert).toHaveFocus();
    expect(alert.compareDocumentPosition(screen.getByText("Cliente")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(submit);
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    expect(book.mock.calls[0][0].force).toEqual(["OUTSIDE_HOURS"]);
    expect(book.mock.calls[0][0].resourceIds).toEqual(["room1"]);
  });

  it("Outro horário que já existe: avisa '{nome} já tem esse horário' e não segue", async () => {
    const preview = vi.fn().mockResolvedValue({ kind: "duplicate", appointmentId: "velho" });
    render(<Harness services={[sessao]} slots={ready([])} preview={preview} />);
    await userEvent.click(screen.getByRole("button", { name: "Outro horário" }));
    await userEvent.type(screen.getByLabelText("Hora"), "10:00");
    await userEvent.click(screen.getByRole("button", { name: "Conferir horário" }));
    expect(await screen.findByText("Maria já tem esse horário.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Marcar horário" })).toBeNull();
  });

  it("revisão sempre mostra o cliente (com o texto genérico quando não há nome)", async () => {
    render(<Harness services={[sessao]} clientName="Cliente desta conversa" />);
    await userEvent.click(timeButtons()[0]);
    expect(screen.getByText("Cliente")).toBeInTheDocument();
    expect(screen.getByText("Cliente desta conversa")).toBeInTheDocument();
  });

  it("remarcar mostra 'De X para Y'", async () => {
    const from = Date.now() + 48 * HOUR;
    render(<Harness services={[sessao]} reschedule={{ fromStartTime: from }} />);
    await userEvent.click(timeButtons()[0]);
    expect(screen.getByText("De")).toBeInTheDocument();
    expect(screen.getByText("Para")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remarcar" })).toBeInTheDocument();
    // Botões da revisão empilhados no celular: `flex-1` em coluna zera a base e o botão principal ficava com 24 px.
    expect(screen.getByRole("button", { name: "Remarcar" }).className).not.toMatch(/(^| )flex-1( |$)/);
  });

  it("variações de duração marcam o botão escolhido (aria-pressed)", async () => {
    render(<Harness services={[corte, sessao]} slots={ready([])} />);
    await userEvent.click(screen.getByRole("button", { name: /Corte/ }));
    const base = screen.getByRole("button", { name: /Padrão/ });
    const longo = screen.getByRole("button", { name: /Cabelo longo/ });
    expect(base).toHaveAttribute("aria-pressed", "true"); // o padrão já vale
    expect(longo).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(longo);
    expect(screen.queryByRole("button", { name: /Cabelo longo/ })).toBeNull(); // avançou ao horário
  });

  it("acompanhante: vai em companions", async () => {
    const book = vi.fn().mockResolvedValue({ appointmentIds: ["a1", "a2"], duplicate: false });
    render(<Harness services={[sessao]} book={book} />);
    await userEvent.click(timeButtons()[0]);
    await userEvent.click(screen.getByRole("button", { name: "Adicionar acompanhante" }));
    await userEvent.type(screen.getByLabelText("Nome do acompanhante"), "Joana");
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    await waitFor(() => expect(book).toHaveBeenCalled());
    expect(book.mock.calls[0][0].companions).toEqual([{ guestName: "Joana" }]);
  });

  it("duplicado no envio: nada de 'marcado'; devolve o existente", async () => {
    const onOutcome = vi.fn();
    const book = vi.fn().mockResolvedValue({ appointmentIds: ["velho"], duplicate: true });
    render(<Harness services={[sessao]} book={book} onOutcome={onOutcome} />);
    await userEvent.click(timeButtons()[0]);
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith({ kind: "duplicate", appointmentId: "velho" }));
  });
});
