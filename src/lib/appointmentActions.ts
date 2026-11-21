/**
 * Painel do agendamento (Agenda v2, B2): quais ações oferecer por status e permissão, e o histórico curto.
 * Espelha `convex/lib/schedStatus.ts` (transições da EQUIPE e destinos do desfazer); o servidor continua
 * sendo a barreira, isto só decide o que mostrar. Puro: `now` entra por argumento.
 */
import { UNDO_TARGETS, type SchedStatus } from "../../convex/lib/schedStatus";
import { fillVocab } from "./agendaCopy";
import { originLabel } from "./agendaStatus";
import { VOCAB } from "./vocab";

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
      out.status.push("approve", "decline");
      if (!ctx.isRescheduleProposal) out.other.push("reschedule");
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
  if ((UNDO_TARGETS[status] ?? []).length > 0) out.other.push("undo");
  return out;
}

/** Rótulo do botão. */
export function actionLabel(action: DetailAction): string {
  return VOCAB.scheduling.detail.actions[action];
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
  approve: VOCAB.scheduling.detail.toast.approved,
  confirm: VOCAB.scheduling.detail.toast.confirmed,
  checkIn: VOCAB.scheduling.detail.toast.checkedIn,
  complete: VOCAB.scheduling.detail.toast.completed,
  noShow: VOCAB.scheduling.detail.toast.noShow,
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
}

export interface HistoryEvent {
  at: number;
  label: string;
}

/** Histórico curto, do mais antigo ao mais novo, a partir dos carimbos do agendamento (no máximo 6). */
export function appointmentHistory(a: HistoryInput): HistoryEvent[] {
  const h = VOCAB.scheduling.detail.history;
  const events: HistoryEvent[] = [{ at: a.createdAt, label: fillVocab(h.created, { origem: originLabel(a.origin) }) }];
  if (a.approvedAt) events.push({ at: a.approvedAt, label: h.approved });
  if (a.clientConfirmedAt) events.push({ at: a.clientConfirmedAt, label: h.confirmed });
  if (a.checkedInAt) events.push({ at: a.checkedInAt, label: h.checkedIn });
  if (a.completedAt) events.push({ at: a.completedAt, label: h.completed });
  if (a.noShowAt) events.push({ at: a.noShowAt, label: h.noShow });
  if (a.cancelledAt) {
    const reason = a.cancelReason?.trim();
    events.push({ at: a.cancelledAt, label: reason ? `${h.cancelled}. ${fillVocab(h.reason, { motivo: reason })}` : h.cancelled });
  }
  return events.sort((x, y) => x.at - y.at).slice(-6);
}
