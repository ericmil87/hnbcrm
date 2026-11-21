import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { AppointmentStatusChip } from "@/components/agenda/AppointmentStatusChip";
import { AppointmentOriginBadge } from "@/components/agenda/AppointmentOriginBadge";
import { DETAIL_COPY } from "@/lib/bookingCopy";
import { VOCAB } from "@/lib/vocab";
import { zonedDateTimeLabel } from "@/lib/agendaZone";
import {
  actionLabel,
  appointmentHistory,
  availableActions,
  isProposalExpired,
  type DetailAction,
  type HistoryInput,
} from "@/lib/appointmentActions";
import { joinNames, longRangePhrase } from "@/lib/bookingFlow";
import { HUMAN_UNDO_COPY } from "@/lib/agendaHumanConfirm";

const t = DETAIL_COPY;

export interface DetailAppointment extends HistoryInput {
  status: string;
  serviceName: string;
  startTime: number;
  endTime: number;
  contactName?: string;
  guestName?: string;
  notes?: string;
  resources: ReadonlyArray<{ name: string }>;
  rescheduleOfId?: string;
  needsAttention?: { code: string };
}

export interface AppointmentDetailViewProps {
  appointment: DetailAppointment;
  openConflicts: number;
  tz: string;
  /** Minuto atual (UTC ms). */
  now: number;
  canEdit: boolean;
  busy: boolean;
  /** A aprovação falhou por proposta vencida/que não vale mais. */
  proposalBroken: boolean;
  /** O servidor disse que não há o que desfazer. */
  undoUnavailable: boolean;
  onAction: (action: DetailAction) => void;
  /** "Abrir conversa" (ausente = sem o atalho). */
  onOpenConversation?: () => void;
  /** C1: o sistema marcou/aprovou a partir de uma confirmação no WhatsApp e a janela de 24 h ainda vale (`humanConfirmUndoKind`). */
  humanUndo?: "created" | "approved" | null;
  onUndoHumanConfirm?: () => void;
}

/** Conteúdo do painel do agendamento, só por props: dados, status, origem, avisos, ações e histórico. */
export function AppointmentDetailView({
  appointment: appt,
  openConflicts,
  tz,
  now,
  canEdit,
  busy,
  proposalBroken,
  undoUnavailable,
  onAction,
  onOpenConversation,
  humanUndo = null,
  onUndoHumanConfirm,
}: AppointmentDetailViewProps) {
  const expired = isProposalExpired(appt.status, appt.startTime, now, appt.needsAttention?.code);
  const actions = availableActions({
    status: appt.status,
    canEdit,
    startTime: appt.startTime,
    now,
    isRescheduleProposal: Boolean(appt.rescheduleOfId),
    needsAttentionCode: appt.needsAttention?.code,
    undoUnavailable,
  });
  // Proposta que não vale mais (vencida ou falhou ao aprovar): a saída é recusar, então o destaque vai para "Recusar".
  const declineFirst = expired || proposalBroken;
  const who = appt.contactName ?? appt.guestName ?? "";
  const where = joinNames(appt.resources.map((r) => r.name));
  const history = appointmentHistory(appt);

  const otherItems: MenuItem[] = actions.other.map((action) => ({
    id: action,
    label: actionLabel(action),
    onSelect: () => onAction(action),
    danger: action === "cancel",
    disabled: busy,
  }));
  const rows: Array<[string, string]> = [
    ...(who ? ([[t.fields.client, who]] as Array<[string, string]>) : []),
    [t.fields.service, appt.serviceName],
    [t.fields.when, longRangePhrase(appt.startTime, appt.endTime, tz)],
    ...(where ? ([[t.fields.where, where]] as Array<[string, string]>) : []),
    ...(appt.createdByName ? ([[t.fields.createdBy, appt.createdByName]] as Array<[string, string]>) : []),
    ...(appt.notes ? ([[t.fields.notes, appt.notes]] as Array<[string, string]>) : []),
  ];
  const notice = (text: string, role: "alert" | "status") => (
    <p role={role} className="rounded-card border border-semantic-warning/40 bg-semantic-warning/5 p-3 text-sm text-text-primary">
      {text}
    </p>
  );

  return (
    <div className="space-y-5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <AppointmentStatusChip status={appt.status} expired={expired} />
        <AppointmentOriginBadge origin={appt.origin} />
      </div>

      {appt.status === "pending_approval" && !declineFirst && <p className="text-sm text-text-secondary">{t.proposalHint}</p>}
      {expired && notice(t.proposalExpired, "alert")}
      {proposalBroken && !expired && notice(t.proposalBroken, "alert")}
      {openConflicts > 0 && notice(t.conflict, "status")}
      {undoUnavailable && <p role="status" className="text-sm text-text-secondary">{t.undoUnavailable}</p>}

      <dl className="space-y-3">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-caption text-text-muted">{label}</dt>
            <dd className="text-sm font-medium text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>

      {(actions.status.length > 0 || otherItems.length > 0) && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={VOCAB.scheduling.name}>
          {actions.status.map((action) => (
            <Button
              key={action}
              type="button"
              variant={action === "rebook" ? "secondary" : action === "decline" ? (declineFirst ? "primary" : "secondary") : "primary"}
              disabled={busy}
              onClick={() => onAction(action)}
            >
              {actionLabel(action)}
            </Button>
          ))}
          {otherItems.length > 0 && (
            <Menu
              ariaLabel="Mais ações do horário"
              items={otherItems}
              trigger={(triggerProps) => (
                <Button type="button" variant="secondary" iconOnly aria-label="Mais ações do horário" {...triggerProps}>
                  <MoreHorizontal size={18} aria-hidden="true" />
                </Button>
              )}
            />
          )}
        </div>
      )}

      {humanUndo && canEdit && onUndoHumanConfirm && (
        <div className="space-y-2 rounded-card border border-semantic-warning/40 bg-semantic-warning/5 p-3">
          <p className="text-sm text-text-primary">{HUMAN_UNDO_COPY[humanUndo].hint}</p>
          <Button type="button" variant="secondary" disabled={busy} onClick={onUndoHumanConfirm}>
            {HUMAN_UNDO_COPY[humanUndo].button}
          </Button>
        </div>
      )}

      {onOpenConversation && (
        <Button type="button" variant="ghost" onClick={onOpenConversation}>
          {t.fields.openConversation}
        </Button>
      )}

      <section aria-label={t.history.title} className="space-y-2">
        <h3 className="text-caption font-semibold uppercase tracking-wide text-text-muted">{t.history.title}</h3>
        <ol className="space-y-1.5">
          {history.map((e, i) => (
            <li key={`${e.at}:${i}`} className="text-sm text-text-primary">
              <span className="tabular-nums text-text-muted">{zonedDateTimeLabel(e.at, tz)}</span> · {e.label}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
