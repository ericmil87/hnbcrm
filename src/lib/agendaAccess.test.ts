import { describe, expect, it } from "vitest";
import { resolvePermissions, hasPermission, type Role } from "../../convex/lib/permissions";
import {
  AGENDA_LEVELS,
  agendaAccess,
  canBookAppointments,
  canConfigureScheduling,
  enableCardState,
  isSchedulingOn,
  schedulingLockedNotice,
} from "./agendaAccess";

const canFor = (role: Role, explicit?: Parameters<typeof resolvePermissions>[1]) => {
  const perms = resolvePermissions(role, explicit);
  return (category: Parameters<typeof hasPermission>[1], level: string) => hasPermission(perms, category, level);
};
const on = { scheduling: true };
const off = { scheduling: false };

describe("agendaAccess (sobre o `can` de usePermissions)", () => {
  it("níveis na ordem do backend", () => {
    expect(AGENDA_LEVELS).toEqual(["none", "view_own", "view_all", "edit", "manage"]);
  });

  it("admin gerencia; gerente e atendente editam (defaults do plano §2.2)", () => {
    expect(agendaAccess(canFor("admin"))).toEqual({ canView: true, canViewAll: true, canEdit: true, canManage: true });
    expect(agendaAccess(canFor("manager"))).toEqual({ canView: true, canViewAll: true, canEdit: true, canManage: false });
    expect(agendaAccess(canFor("agent"))).toEqual({ canView: true, canViewAll: true, canEdit: true, canManage: false });
  });

  it("explícito view_own só vê o próprio e não edita", () => {
    const can = canFor("agent", { agenda: "view_own" } as never);
    expect(agendaAccess(can)).toEqual({ canView: true, canViewAll: false, canEdit: false, canManage: false });
  });

  it("explícito none não vê", () => {
    expect(agendaAccess(canFor("agent", { agenda: "none" } as never)).canView).toBe(false);
  });
});

describe("módulo + permissão", () => {
  it("desligado: nada da v2", () => {
    expect(isSchedulingOn(off)).toBe(false);
    expect(canBookAppointments(off, canFor("admin"))).toBe(false);
    expect(canConfigureScheduling(off, canFor("admin"))).toBe(false);
  });

  it("ligado: marcar exige edit; configurar exige manage", () => {
    expect(canBookAppointments(on, canFor("agent"))).toBe(true);
    expect(canConfigureScheduling(on, canFor("agent"))).toBe(false);
    expect(canConfigureScheduling(on, canFor("admin"))).toBe(true);
  });

  it("cartão Ativar: só desligado e só com agenda:manage; sem settings:manage fica travado", () => {
    expect(enableCardState(off, canFor("admin"))).toBe("ready");
    expect(enableCardState(on, canFor("admin"))).toBe("hidden");
    expect(enableCardState(off, canFor("agent"))).toBe("hidden");
    expect(enableCardState(off, canFor("agent", { agenda: "manage" } as never))).toBe("locked");
  });
});

describe("schedulingLockedNotice", () => {
  const services = { id: "agenda-services", group: "agenda", label: "Serviços" };
  it("módulo desligado e quem gerencia: pede para ligar", () => {
    expect(schedulingLockedNotice(services, off, canFor("admin"))).toBe("Ligue o agendamento para abrir «Serviços».");
  });
  it("outros motivos seguem como falta de permissão", () => {
    expect(schedulingLockedNotice(services, on, canFor("admin"))).toBeNull();
    expect(schedulingLockedNotice(services, off, canFor("agent"))).toBeNull();
    expect(schedulingLockedNotice({ id: "ai", group: "atendente", label: "Visão geral" }, off, canFor("admin"))).toBeNull();
  });
});
