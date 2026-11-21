import { describe, expect, it, vi } from "vitest";
import { capacityExcessNotice, futureAcceptCopy, resourceArchiveAccept, resourceEditAccept, runWithFutureAccept, serviceArchiveAccept } from "./agendaFutureAccept";

const res = (saved: boolean) => ({ saved, resourceId: "r", futureOutsideHours: 3, overCapacityBy: 1, futureWithoutSpot: 2, capped: true });
const needs = (r: ReturnType<typeof res>) => resourceEditAccept("Sala 1", r);

describe("agendaFutureAccept", () => {
  it("salvou de primeira: não pergunta", async () => {
    const run = vi.fn().mockResolvedValue(res(true));
    const ask = vi.fn();
    expect(await runWithFutureAccept(run, needs, ask)).toMatchObject({ done: true });
    expect(ask).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("pede aceite e reenvia com acceptFuture", async () => {
    const run = vi.fn((a: boolean) => Promise.resolve(res(a)));
    const ask = vi.fn().mockResolvedValue(true);
    const r = await runWithFutureAccept(run, needs, ask);
    expect(run.mock.calls.map((c) => c[0])).toEqual([false, true]);
    expect(r).toMatchObject({ done: true, result: { saved: true } });
    expect(ask.mock.calls[0][0]).toMatchObject({ futureOutsideHours: 3, overCapacityBy: 1, futureWithoutSpot: 2, capped: true });
  });
  it("recusar não grava", async () => {
    const run = vi.fn((a: boolean) => Promise.resolve(res(a)));
    expect(await runWithFutureAccept(run, needs, () => Promise.resolve(false))).toEqual({ done: false });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("textos e arquivar", () => {
    const c = futureAcceptCopy(needs(res(false))!);
    expect(c.lines.join(" ")).toMatch(/pelo menos 3 horários marcados/);
    expect(c.lines.join(" ")).toMatch(/nada é cancelado e ninguém é avisado/);
    expect(resourceArchiveAccept("S", { changed: true, futureAppointments: 2, servicesAffected: [] })).toBeNull();
    expect(resourceArchiveAccept("S", { changed: false, futureAppointments: 2, servicesAffected: ["Sessão"] })).not.toBeNull();
    expect(serviceArchiveAccept("S", { changed: false, futureAppointments: 0, futureAppointmentsCapped: false })).toBeNull();
  });
  it("sem lugar: singular, plural, 'pelo menos' e o aviso depois de salvar", () => {
    const copy = (n: number, capped: boolean) =>
      futureAcceptCopy(resourceEditAccept("Sala 1", { ...res(false), futureOutsideHours: 0, overCapacityBy: 0, futureWithoutSpot: n, capped })!).lines.join(" ");
    expect(copy(1, false)).toMatch(/^1 agendamento ficará sem lugar e irá para a fila de pendências; nada é cancelado e ninguém é avisado\./);
    expect(copy(4, false)).toMatch(/4 agendamentos ficarão sem lugar e irão para a fila de pendências/);
    expect(copy(4, true)).toMatch(/pelo menos 4 agendamentos ficarão sem lugar/);
    expect(copy(4, false)).toMatch(/mais antigos mantêm a vaga/);
    expect(copy(0, false)).not.toMatch(/sem lugar/);
    expect(capacityExcessNotice("Sala 1", { saved: true, futureWithoutSpot: 0, capped: false })).toBeNull();
    expect(capacityExcessNotice("Sala 1", { saved: false, futureWithoutSpot: 3, capped: false })).toBeNull();
    const n = capacityExcessNotice("Sala 1", { saved: true, futureWithoutSpot: 3, capped: true })!;
    expect(n.message).toMatch(/^Pelo menos 3 agendamentos ficaram sem lugar e foram para a fila/);
    expect(n.href).toBe("/app/calendario?pendencias=1");
    expect(capacityExcessNotice("S", { saved: true, futureWithoutSpot: 1, capped: false })!.message).toMatch(/^1 agendamento ficou sem lugar e foi/);
  });
});
