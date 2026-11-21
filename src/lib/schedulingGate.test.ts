import { describe, expect, it } from "vitest";
import { resolvePermissions, hasPermission, type Role } from "../../convex/lib/permissions";
import { gatedArgs, resolveSchedulingGate } from "./schedulingGate";
import { countUpcoming, pickNextAppointment } from "./nextAppointment";

const canFor = (role: Role, explicit?: Parameters<typeof resolvePermissions>[1]) => {
  const perms = resolvePermissions(role, explicit);
  return (category: Parameters<typeof hasPermission>[1], level: string) => hasPermission(perms, category, level);
};

describe("gate das entradas da Agenda v2 (regra real, sobre as permissões reais)", () => {
  it("módulo desligado: nada, para qualquer papel", () => {
    for (const role of ["admin", "manager", "agent"] as Role[]) {
      expect(resolveSchedulingGate({ scheduling: false }, canFor(role))).toEqual({ enabled: false, canBook: false });
    }
  });
  it("módulo ligado: lê e marca conforme `agenda`", () => {
    expect(resolveSchedulingGate({ scheduling: true }, canFor("admin"))).toEqual({ enabled: true, canBook: true });
    expect(resolveSchedulingGate({ scheduling: true }, canFor("agent", { agenda: "view_own" } as never))).toEqual({ enabled: true, canBook: false });
    expect(resolveSchedulingGate({ scheduling: true }, canFor("agent", { agenda: "none" } as never))).toEqual({ enabled: false, canBook: false });
  });
  it("gate fechado = 'skip': nenhuma assinatura nova", () => {
    expect(gatedArgs({ enabled: false }, { conversationId: "c" })).toBe("skip");
    expect(gatedArgs({ enabled: true }, { conversationId: "c" })).toEqual({ conversationId: "c" });
    const off = resolveSchedulingGate({ scheduling: false }, canFor("admin"));
    expect(gatedArgs(off, { leadId: "l" })).toBe("skip");
  });
});

describe("próximo horário do chip", () => {
  const NOW = 1_000_000;
  const row = (status: string, startTime: number) => ({ status, startTime });
  it("só o que ainda vai acontecer e começa depois de agora", () => {
    const list = [row("completed", NOW + 10), row("scheduled", NOW - 1), row("confirmed", NOW + 50), row("pending_approval", NOW + 20), row("cancelled", NOW + 5)];
    expect(pickNextAppointment(list, NOW)).toEqual(row("pending_approval", NOW + 20));
    expect(countUpcoming(list, NOW)).toBe(2);
  });
  it("atendimento das 15:00 já atendido às 15:40 não é 'próximo'", () => {
    const at1500 = Date.UTC(2026, 10, 26, 18, 0);
    const at1540 = Date.UTC(2026, 10, 26, 18, 40);
    expect(pickNextAppointment([row("completed", at1500), row("checked_in", at1500)], at1540)).toBeUndefined();
  });
  it("sem nada: indefinido", () => {
    expect(pickNextAppointment([], NOW)).toBeUndefined();
  });
});
