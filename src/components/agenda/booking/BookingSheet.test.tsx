import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";

const h = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  fn: {} as Record<string, ReturnType<typeof vi.fn>>,
  find: vi.fn(),
  client: {} as { query: unknown },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: never, args: unknown) => (args === "skip" ? undefined : h.queries[getFunctionName(ref)]),
  useMutation: (ref: never) => h.fn[getFunctionName(ref)] ?? vi.fn(),
  useConvex: () => h.client,
}));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/hooks/useOrgTimezone", () => ({ useOrgTimezone: () => "America/Sao_Paulo" }));

h.client.query = h.find;

import { BookingSheet } from "./BookingSheet";

const HOUR = 3_600_000;
const sessao = { _id: "svc1", name: "Sessão", durationMin: 60, active: true, requirements: [{ kind: "room" }] };
const avaliacao = { _id: "svc2", name: "Avaliação", durationMin: 45, active: true, requirements: [{ kind: "room" }] };

const slot = (hoursAhead: number, extra: Record<string, unknown> = {}) => {
  const start = Math.ceil((Date.now() + hoursAhead * HOUR) / 300_000) * 300_000;
  return {
    startTime: start,
    endTime: start + HOUR,
    localDate: "2030-01-01",
    label: "x",
    resourceIds: ["room1"],
    resourceNames: ["Sala 1"],
    score: 1,
    reasons: [],
    ...extra,
  };
};

const found = (slots: unknown[]) => ({ slots, hasMore: false, relaxed: false, relaxedDays: [], mode: "rank", earliestBookableAt: 0, truncated: false, reason: "ok" });
const rulesError = (violations: unknown[], alternatives: unknown[] = []) =>
  new ConvexError({ code: "sched_rules", violations, alternatives } as never);

function setup(services = [sessao, avaliacao]) {
  h.queries["schedulingConfig:getConfig"] = {
    enabled: true,
    timezone: "America/Sao_Paulo",
    settings: {},
    services,
    resources: [{ _id: "room1", name: "Sala 1", kind: "room", capacity: 1, active: true }],
  };
  const onClose = vi.fn();
  render(<BookingSheet organizationId={"org1" as never} open onClose={onClose} who={{ contactId: "c1" as never, conversationId: "v1" as never, name: "Maria" }} />);
  return { onClose };
}

describe("BookingSheet", () => {
  beforeEach(() => {
    h.fn = {
      "schedulingMutations:bookAppointment": vi.fn().mockResolvedValue({ appointmentIds: ["a1"], created: true, duplicate: false, inConflict: false, warnings: [] }),
      "schedulingMutations:cancelAppointment": vi.fn().mockResolvedValue(null),
      "schedulingMutations:previewBooking": vi.fn(),
      "schedulingMutations:rescheduleAppointment": vi.fn(),
    };
    h.find.mockReset().mockResolvedValue(found([slot(2, { reasons: ["logo após outro atendimento"] }), slot(4)]));
    h.toast.success.mockReset();
    h.toast.error.mockReset();
  });

  it("caminho feliz em 3 toques: serviço, horário, marcar horário", async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole("button", { name: /Sessão/ })); // 1
    const first = await screen.findAllByRole("button", { pressed: false });
    expect(first.length).toBeGreaterThan(0);
    // O horário encostado vem destacado com o selo e o motivo.
    expect(await screen.findByText("Encostado")).toBeInTheDocument();
    expect(screen.getByText("Logo após outro atendimento")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: /\d{2}:\d{2}/ })[0]); // 2
    expect(screen.getByText("Maria")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" })); // 3
    const book = h.fn["schedulingMutations:bookAppointment"];
    await waitFor(() => expect(book).toHaveBeenCalledTimes(1));
    const args = book.mock.calls[0][0];
    expect(args).toMatchObject({ organizationId: "org1", serviceId: "svc1", contactId: "c1", conversationId: "v1", resourceIds: ["room1"] });
    expect(args.idempotencyKey).toEqual(expect.any(String));
    expect(args).not.toHaveProperty("force");
    expect(h.toast.success).toHaveBeenCalledWith("Horário marcado", expect.objectContaining({ action: expect.objectContaining({ label: "Desfazer" }) }));
    expect(onClose).toHaveBeenCalled();
  });

  it("serviço único já vem escolhido: 2 toques", async () => {
    setup([sessao]);
    await userEvent.click((await screen.findAllByRole("button", { name: /\d{2}:\d{2}/ }))[0]);
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    await waitFor(() => expect(h.fn["schedulingMutations:bookAppointment"]).toHaveBeenCalled());
  });

  it("aviso forçável: lista o aviso e reenvia com force dos códigos mostrados", async () => {
    const book = h.fn["schedulingMutations:bookAppointment"];
    book.mockRejectedValueOnce(
      rulesError([{ code: "OUTSIDE_HOURS", severity: "warn", message: "x", detail: { resourceId: "room1" } }])
    );
    setup([sessao]);
    await userEvent.click((await screen.findAllByRole("button", { name: /\d{2}:\d{2}/ }))[0]);
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    expect(await screen.findByText("Antes de marcar")).toBeInTheDocument();
    expect(screen.getByText("Fora do horário de atendimento: Sala 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Marcar mesmo assim" }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(2));
    expect(book.mock.calls[1][0].force).toEqual(["OUTSIDE_HOURS"]);
    // A mesma chave de idempotência nas duas tentativas.
    expect(book.mock.calls[1][0].idempotencyKey).toBe(book.mock.calls[0][0].idempotencyKey);
  });

  it("capacidade cheia: sem botão de forçar, com as alternativas (formato antigo) de um toque", async () => {
    const book = h.fn["schedulingMutations:bookAppointment"];
    const alt = Math.ceil((Date.now() + 6 * HOUR) / 300_000) * 300_000;
    book.mockRejectedValueOnce(
      rulesError([{ code: "CAPACITY_EXCEEDED", severity: "block", message: "x", detail: { resourceId: "room1" } }], [{ startTime: alt, resourceIds: ["room1"] }])
    );
    setup([sessao]);
    await userEvent.click((await screen.findAllByRole("button", { name: /\d{2}:\d{2}/ }))[0]);
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    // Horário tomado no meio do fluxo: mesmo tratamento.
    expect(await screen.findByText("Esse horário acabou de ser ocupado")).toBeInTheDocument();
    expect(screen.getByText("Sala 1 não tem mais vaga neste horário.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Marcar mesmo assim" })).toBeNull();
    // A busca foi refeita (volta ao passo 2).
    await waitFor(() => expect(h.find.mock.calls.length).toBeGreaterThan(1));
    const dialog = screen.getAllByRole("dialog").at(-1)!;
    const altButtons = Array.from(dialog.querySelectorAll("li button"));
    expect(altButtons).toHaveLength(1);
    await userEvent.click(altButtons[0]);
    // A alternativa escolhida leva ao passo de confirmar com ela.
    await userEvent.click(await screen.findByRole("button", { name: "Marcar horário" }));
    await waitFor(() => expect(book).toHaveBeenCalledTimes(2));
    expect(book.mock.calls[1][0].startTime).toBe(alt);
    expect(book.mock.calls[1][0]).not.toHaveProperty("force");
  });

  it("acompanhante: vai em companions", async () => {
    setup([sessao]);
    await userEvent.click((await screen.findAllByRole("button", { name: /\d{2}:\d{2}/ }))[0]);
    await userEvent.click(screen.getByRole("button", { name: "Adicionar acompanhante" }));
    await userEvent.type(screen.getByLabelText("Nome do acompanhante"), "Joana");
    await userEvent.click(screen.getByRole("button", { name: "Marcar horário" }));
    await waitFor(() => expect(h.fn["schedulingMutations:bookAppointment"]).toHaveBeenCalled());
    expect(h.fn["schedulingMutations:bookAppointment"].mock.calls[0][0].companions).toEqual([{ guestName: "Joana" }]);
  });
});
