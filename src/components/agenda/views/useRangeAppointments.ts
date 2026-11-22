import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { useKeepPrevious } from "@/hooks/useKeepPrevious";
import type { GridAppointment } from "@/lib/agendaGrid";

/** Páginas lidas por intervalo (100 agendamentos cada): no máximo 300, depois avisa em vez de continuar. */
export const RANGE_PAGES = 3;

export interface RangeAppointments {
  appointments: GridAppointment[];
  /** Há mais agendamentos no período do que as páginas lidas. */
  truncated: boolean;
}

/**
 * Agendamentos de um intervalo (Semana e Mês) com UMA leitura por página de 100 (`listAgendaAppointments`, índice por
 * início), encadeando o cursor até `RANGE_PAGES` páginas. `mode: "grid"`: só os status da grade (cancelados e remarcados não gastam o teto) e,
 * na primeira página, os que começaram antes do período e ainda não terminaram. Nada de leitura por bloco. Troca de intervalo mantém o
 * resultado anterior até o novo chegar (`stale`). `enabled = false` não assina nada.
 */
export function useRangeAppointments(
  organizationId: Id<"organizations">,
  from: string,
  to: string,
  enabled: boolean
): { data: RangeAppointments | undefined; stale: boolean } {
  const base = enabled ? { organizationId, fromLocalDate: from, toLocalDate: to, limit: 100, mode: "grid" as const } : null;
  const p1 = useQuery(api.scheduling.listAgendaAppointments, base ?? "skip");
  const p2 = useQuery(api.scheduling.listAgendaAppointments, base && p1?.next ? { ...base, after: p1.next } : "skip");
  const p3 = useQuery(api.scheduling.listAgendaAppointments, base && p2?.next ? { ...base, after: p2.next } : "skip");

  let fresh: RangeAppointments | undefined;
  // Módulo desligado (`enabled: false`): resposta vazia e definitiva, não esqueleto para sempre.
  if (p1 && !p1.enabled) fresh = { appointments: [], truncated: false };
  else if (p1 && !(p1.next && p2 === undefined) && !(p2?.next && p3 === undefined)) {
    const pages = [p1, p2, p3].filter((p) => p !== undefined);
    const last = pages[pages.length - 1];
    fresh = { appointments: pages.flatMap((p) => p.appointments) as GridAppointment[], truncated: !!last.next || pages.some((p) => "crossingCapped" in p && p.crossingCapped === true) };
  }
  const data = useKeepPrevious(fresh, organizationId);
  return { data, stale: enabled && fresh === undefined && data !== undefined };
}
