/**
 * Agenda v2 (B3): modelo da fila de pendências (`listPending`). PURO. Contagem do contador do cabeçalho,
 * linhas das quatro seções e a regra de "ação de um toque" do Sem desfecho.
 */
import type { SchedStatus } from "../../convex/lib/schedStatus";
import { appointmentLabel } from "./agendaGrid";
import { zonedDateTimeLabel } from "./agendaZone";

export type PendingSectionKey = "approvals" | "conflicts" | "noOutcome" | "suggestions";
export const PENDING_ORDER: readonly PendingSectionKey[] = ["approvals", "conflicts", "noOutcome", "suggestions"];

export interface PendingCapped {
  approvals: boolean;
  conflicts: boolean;
  noOutcome: boolean;
  suggestions: boolean;
}

export interface PendingCounts {
  approvals: number;
  conflicts: number;
  noOutcome: number;
  suggestions: number;
}

export interface PendingTotal {
  total: number;
  /** Algum teto cortou: o total é um mínimo ("50+"). */
  more: boolean;
}

export function pendingTotal(counts: PendingCounts, capped: PendingCapped): PendingTotal {
  const total = counts.approvals + counts.conflicts + counts.noOutcome + counts.suggestions;
  return { total, more: capped.approvals || capped.conflicts || capped.noOutcome || capped.suggestions };
}

/** "3", "99+" (limite de exibição) ou "50+" quando algum teto cortou. */
export function pendingBadgeLabel({ total, more }: PendingTotal): string {
  if (total > 99) return "99+";
  return more ? `${total}+` : String(total);
}

/** Seções que têm algo (ou foram cortadas), na ordem da tela. Sugestões só aparecem se vier algo. */
export function visibleSections(counts: PendingCounts, capped: PendingCapped): PendingSectionKey[] {
  return PENDING_ORDER.filter((k) => counts[k] > 0 || (k !== "suggestions" && capped[k]));
}

export interface PendingRowInfo {
  who: string;
  when: string;
  service: string;
  place: string;
}

export function pendingRowInfo(
  a: {
    contactName?: string;
    guestName?: string;
    serviceName: string;
    startTime: number;
    resources: ReadonlyArray<{ name: string; allocated: boolean }>;
  },
  tz: string
): PendingRowInfo {
  const names = a.resources.filter((r) => r.allocated).map((r) => r.name);
  return {
    who: appointmentLabel(a),
    when: zonedDateTimeLabel(a.startTime, tz),
    service: a.serviceName,
    place: names.join(" · "),
  };
}

/** Desfechos de um toque na seção "Sem desfecho" (`setAppointmentStatus.to`). */
export const OUTCOME_TARGETS: Record<"attended" | "noShow", SchedStatus> = { attended: "completed", noShow: "no_show" };

/**
 * Proposta (aguardando aprovação) cujo início já passou: não dá mais para aprovar, só recusar. Mesma regra de
 * `isProposalExpired` em `appointmentActions` (o teste confere); copiada porque aquele módulo puxa os textos do
 * painel (`bookingCopy`) e isso criava chunks compartilhados nas telas de Entrada e Lead.
 */
export function proposalExpired(status: string, startTime: number, now: number): boolean {
  return status === "pending_approval" && startTime <= now;
}
