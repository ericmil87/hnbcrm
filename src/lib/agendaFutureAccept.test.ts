import { describe, expect, it, vi } from "vitest";
import { futureAcceptCopy, resourceArchiveAccept, resourceEditAccept, runWithFutureAccept, serviceArchiveAccept } from "./agendaFutureAccept";

const res = (saved: boolean) => ({ saved, resourceId: "r", futureOutsideHours: 3, overCapacityBy: 1, capped: true });
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
    expect(ask.mock.calls[0][0]).toMatchObject({ futureOutsideHours: 3, overCapacityBy: 1, capped: true });
  });
  it("recusar não grava", async () => {
    const run = vi.fn((a: boolean) => Promise.resolve(res(a)));
    expect(await runWithFutureAccept(run, needs, () => Promise.resolve(false))).toEqual({ done: false });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("textos e arquivar", () => {
    const c = futureAcceptCopy(needs(res(false))!);
    expect(c.lines.join(" ")).toMatch(/pelo menos 3 horários marcados/);
    expect(c.lines.join(" ")).toMatch(/Nada é cancelado/);
    expect(resourceArchiveAccept("S", { changed: true, futureAppointments: 2, servicesAffected: [] })).toBeNull();
    expect(resourceArchiveAccept("S", { changed: false, futureAppointments: 2, servicesAffected: ["Sessão"] })).not.toBeNull();
    expect(serviceArchiveAccept("S", { changed: false, futureAppointments: 0, futureAppointmentsCapped: false })).toBeNull();
  });
});
