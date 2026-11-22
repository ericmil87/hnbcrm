import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

type Args = Record<string, unknown> | "skip";
const calls: Args[] = [];
let pages: Record<string, unknown>;

vi.mock("convex/react", () => ({
  useQuery: (_fn: unknown, args: Args) => {
    calls.push(args);
    if (args === "skip") return undefined;
    const key = args.after ? `after:${(args.after as { startTime: number }).startTime}` : "first";
    return pages[key];
  },
}));
vi.mock("../../../../convex/_generated/api", () => ({ api: { scheduling: { listAgendaAppointments: "listAgendaAppointments" } } }));

import { useRangeAppointments } from "./useRangeAppointments";

const row = (id: string) => ({ _id: id, status: "scheduled" });

beforeEach(() => {
  calls.length = 0;
  pages = {};
});

describe("useRangeAppointments", () => {
  it("uma leitura de 100 por página, escopada na org e no intervalo; sem `enabled` não assina nada", () => {
    pages.first = { enabled: true, appointments: [row("a")], next: null };
    const { result } = renderHook(() => useRangeAppointments("org1" as never, "2026-11-23", "2026-11-29", true));
    expect(result.current.data).toEqual({ appointments: [row("a")], truncated: false });
    expect(calls[0]).toEqual({ organizationId: "org1", fromLocalDate: "2026-11-23", toLocalDate: "2026-11-29", limit: 100, mode: "grid" });
    calls.length = 0;
    const off = renderHook(() => useRangeAppointments("org1" as never, "2026-11-23", "2026-11-29", false));
    expect(calls.every((c) => c === "skip")).toBe(true);
    expect(off.result.current.data).toBeUndefined();
  });
  it("encadeia o cursor até 3 páginas e junta tudo; sobrando, avisa `truncated`", () => {
    pages.first = { enabled: true, appointments: [row("a")], next: { startTime: 1, creationTime: 1 } };
    pages["after:1"] = { enabled: true, appointments: [row("b")], next: { startTime: 2, creationTime: 2 } };
    pages["after:2"] = { enabled: true, appointments: [row("c")], next: { startTime: 3, creationTime: 3 } };
    const { result } = renderHook(() => useRangeAppointments("org1" as never, "2026-11-23", "2026-11-29", true));
    expect(result.current.data?.appointments.map((x) => x._id)).toEqual(["a", "b", "c"]);
    expect(result.current.data?.truncated).toBe(true);
    // Nunca pede a quarta página.
    expect(calls.some((c) => c !== "skip" && (c.after as { startTime: number } | undefined)?.startTime === 3)).toBe(false);
  });
  it("página seguinte ainda carregando: devolve nada (ou o anterior) em vez de dados parciais", () => {
    pages.first = { enabled: true, appointments: [row("a")], next: { startTime: 1, creationTime: 1 } };
    const { result } = renderHook(() => useRangeAppointments("org1" as never, "2026-11-23", "2026-11-29", true));
    expect(result.current.data).toBeUndefined();
  });
  it("módulo desligado (enabled: false) vira resposta vazia, não esqueleto para sempre", () => {
    pages.first = { enabled: false, appointments: [], next: null };
    const { result } = renderHook(() => useRangeAppointments("org1" as never, "2026-11-23", "2026-11-29", true));
    expect(result.current.data).toEqual({ appointments: [], truncated: false });
  });
});
