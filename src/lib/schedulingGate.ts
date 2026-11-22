import { canBookAppointments, isSchedulingOn } from "./agendaAccess";

type Can = Parameters<typeof canBookAppointments>[1];

export interface SchedulingGate {
  /** Pode LER a agenda v2 (módulo ligado e `agenda:view_own` ou mais): chip, bloco e queries. */
  enabled: boolean;
  /** Pode marcar (módulo ligado e `agenda:edit`). */
  canBook: boolean;
}

/** Regra única das entradas da Agenda v2 fora da página; o hook `useSchedulingGate` só alimenta isto. */
export function resolveSchedulingGate(modules: { scheduling: boolean }, can: Can): SchedulingGate {
  return { enabled: isSchedulingOn(modules) && can("agenda", "view_own"), canBook: canBookAppointments(modules, can) };
}

/** Argumentos de query da agenda: com o gate fechado, `"skip"` (nenhuma assinatura nova). */
export function gatedArgs<T>(gate: Pick<SchedulingGate, "enabled">, args: T): T | "skip" {
  return gate.enabled ? args : "skip";
}
