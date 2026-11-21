/**
 * Painel do agendamento (Agenda v2, B2): quais ações oferecer por status e permissão, e o histórico curto.
 * Espelha `convex/lib/schedStatus.ts` (transições da EQUIPE e destinos do desfazer); o servidor continua
 * sendo a barreira, isto só decide o que mostrar. Puro: `now` entra por argumento.
 */
import { UNDO_TARGETS, type SchedStatus } from "../../convex/lib/schedStatus";
import { fillVocab } from "./agendaCopy";
import { originLabel } from "./agendaStatus";
import { DETAIL_COPY } from "./bookingCopy";

export type DetailAction =
  | "approve"
  | "decline"
  | "confirm"
  | "checkIn"
  | "complete"
  | "noShow"
  | "reschedule"
  | "cancel"
  | "swap"
  | "undo";

/** Ações de mudança de status (botões em destaque) e as demais (menu "Mais"). */
export interface DetailActions {
  status: DetailAction[];
  other: DetailAction[];
}

export interface ActionContext {
  status: string;
  canEdit: boolean;
  startTime: number;
  now: number;
  /** Proposta de remarcação da IA (aprove ou recuse antes de mexer no horário). */
  isRescheduleProposal?: boolean;
  /** O servidor já disse que não há o que desfazer (esconde "Desfazer"). */
  undoUnavailable?: boolean;
}

/** Proposta (aguardando aprovação) cujo início já passou: não dá mais para aprovar, só recusar. */
export function isProposalExpired(status: string, startTime: number, now: number): boolean {
  return status === "pending_approval" && startTime <= now;
}

const NONE: DetailActions = { status: [], other: [] };

/** `view_own`/`view_all` (sem `agenda:edit`) não recebem ação alguma. */
export function availableActions(ctx: ActionContext): DetailActions {
  if (!ctx.canEdit) return NONE;
  const started = ctx.now >= ctx.startTime;
  const status = ctx.status as SchedStatus;
  const out: DetailActions = { status: [], other: [] };
  switch (status) {
    case "pending_approval":
      // Vencida: aprovar falharia; a saída é recusar.
      if (!isProposalExpired(ctx.status, ctx.startTime, ctx.now)) out.status.push("approve");
      out.status.push("decline");
      if (!ctx.isRescheduleProposal && !isProposalExpired(ctx.status, ctx.startTime, ctx.now)) out.other.push("reschedule");
      break;
    case "scheduled":
      out.status.push("confirm", "checkIn", "complete");
      if (started) out.status.push("noShow");
      out.other.push("reschedule", "swap", "cancel");
      break;
    case "confirmed":
      out.status.push("checkIn", "complete");
      if (started) out.status.push("noShow");
      out.other.push("reschedule", "swap", "cancel");
      break;
    case "checked_in":
      out.status.push("complete");
      out.other.push("swap");
      break;
    default:
      break;
  }
  if ((UNDO_TARGETS[status] ?? []).length > 0 && !ctx.undoUnavailable) out.other.push("undo");
  return out;
}

/** Rótulo do botão. */
export function actionLabel(action: DetailAction): string {
  return DETAIL_COPY.actions[action];
}

/** Mutation de status do servidor (`setAppointmentStatus.to`) para cada ação de status. */
export const STATUS_TARGET: Partial<Record<DetailAction, "scheduled" | "confirmed" | "checked_in" | "completed" | "no_show">> = {
  approve: "scheduled",
  confirm: "confirmed",
  checkIn: "checked_in",
  complete: "completed",
  noShow: "no_show",
};

export const STATUS_TOAST: Partial<Record<DetailAction, string>> = {
  approve: DETAIL_COPY.toast.approved,
  confirm: DETAIL_COPY.toast.confirmed,
  checkIn: DETAIL_COPY.toast.checkedIn,
  complete: DETAIL_COPY.toast.completed,
  noShow: DETAIL_COPY.toast.noShow,
};

export interface HistoryInput {
  origin: string;
  createdAt: number;
  approvedAt?: number;
  clientConfirmedAt?: number;
  checkedInAt?: number;
  completedAt?: number;
  noShowAt?: number;
  cancelledAt?: number;
  cancelReason?: string;
  lateCancel?: boolean;
  /** Quem marcou (`getAppointment.createdByName`: membro, "IA", "Link público" ou "Sistema"). */
  createdByName?: string;
  /** Mudanças de status com o ator (`getAppointment.statusActors`, da auditoria). */
  statusActors?: ReadonlyArray<{ status: string; at: number; actorName?: string; undo?: boolean }>;
}

export interface HistoryEvent {
  at: number;
  label: string;
}

/** Nome do ator da ÚLTIMA mudança para `status` (ignora "Desfazer": o status restaurado não foi uma ação nova). */
function actorOfStatus(a: HistoryInput, status: string): string | undefined {
  const hit = (a.statusActors ?? []).filter((x) => x.status === status && !x.undo && x.actorName);
  return hit.length > 0 ? hit[hit.length - 1].actorName : undefined;
}

/** Histórico curto, do mais antigo ao mais novo, a partir dos carimbos do agendamento (no máximo 6). */
export function appointmentHistory(a: HistoryInput): HistoryEvent[] {
  const h = DETAIL_COPY.history;
  const by = (status: string, plain: string, withActor: string) => {
    const nome = actorOfStatus(a, status);
    return nome ? fillVocab(withActor, { nome }) : plain;
  };
  const creator = a.createdByName?.trim();
  const events: HistoryEvent[] = [
    { at: a.createdAt, label: creator ? fillVocab(h.createdBy, { nome: creator }) : fillVocab(h.created, { origem: originLabel(a.origin) }) },
  ];
  if (a.approvedAt) events.push({ at: a.approvedAt, label: by("scheduled", h.approved, h.approvedBy) });
  if (a.clientConfirmedAt) events.push({ at: a.clientConfirmedAt, label: by("confirmed", h.confirmed, h.confirmedBy) });
  if (a.checkedInAt) events.push({ at: a.checkedInAt, label: by("checked_in", h.checkedIn, h.checkedInBy) });
  if (a.completedAt) events.push({ at: a.completedAt, label: by("completed", h.completed, h.completedBy) });
  if (a.noShowAt) events.push({ at: a.noShowAt, label: by("no_show", h.noShow, h.noShowBy) });
  if (a.cancelledAt) {
    const reason = a.cancelReason?.trim();
    const head = by("cancelled", h.cancelled, h.cancelledBy);
    events.push({ at: a.cancelledAt, label: reason ? `${head}. ${fillVocab(h.reason, { motivo: reason })}` : head });
  }
  return events.sort((x, y) => x.at - y.at).slice(-6);
}
