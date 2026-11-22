/**
 * Agenda v2 (B1): lista SOMENTE LEITURA de fechamentos e exceções (`getConfig.closures`). PURO.
 * A escrita (fechar sala/dia) é de outro PR de backend; a tela só mostra.
 */
import type { Doc } from "../../convex/_generated/dataModel";
import { minutesLabel, shortDateLabel } from "./agendaZone";

export const CLOSURE_MODE_LABELS: Record<Doc<"schedExceptions">["mode"], string> = {
  closed: "Fechado",
  custom: "Horário especial",
  extra: "Horário extra",
  block: "Bloqueio",
};
export const CLOSURE_REASON_LABELS = {
  no_staff: "Sem equipe",
  maintenance: "Manutenção",
  day_off: "Folga",
  holiday: "Feriado",
  other: "Outro motivo",
} as const;
const KIND_ALL: Record<string, string> = { person: "Todos os profissionais", room: "Todas as salas", equipment: "Todos os equipamentos" };

export interface ClosureRow {
  id: string;
  localDate: string;
  dateLabel: string;
  scope: string;
  mode: string;
  /** "09:00–12:00" para horário especial, extra e bloqueio. */
  intervals: string;
  reason: string;
}

export function closureRows(
  closures: ReadonlyArray<Pick<Doc<"schedExceptions">, "_id" | "localDate" | "resourceId" | "resourceKind" | "mode" | "intervals" | "reasonCode" | "reason">>,
  resources: ReadonlyArray<{ _id: string; name: string }>
): ClosureRow[] {
  const names = new Map(resources.map((r) => [r._id as string, r.name]));
  return [...closures]
    .sort((a, b) => (a.localDate < b.localDate ? -1 : a.localDate > b.localDate ? 1 : 0))
    .map((c) => ({
      id: c._id,
      localDate: c.localDate,
      dateLabel: shortDateLabel(c.localDate),
      scope: c.resourceId ? (names.get(c.resourceId) ?? "Item arquivado") : c.resourceKind ? KIND_ALL[c.resourceKind] : "Toda a agenda",
      mode: CLOSURE_MODE_LABELS[c.mode],
      intervals: (c.intervals ?? []).map((i) => `${minutesLabel(i.startMin)}–${minutesLabel(i.endMin)}`).join(" e "),
      reason: [c.reasonCode ? CLOSURE_REASON_LABELS[c.reasonCode] : "", c.reason ?? ""].filter(Boolean).join(": "),
    }));
}
