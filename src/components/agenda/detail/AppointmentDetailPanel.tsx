import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CalendarX, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { UNDO_TARGETS, type SchedStatus } from "../../../../convex/lib/schedStatus";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { AppointmentStatusChip } from "@/components/agenda/AppointmentStatusChip";
import { AppointmentOriginBadge } from "@/components/agenda/AppointmentOriginBadge";
import { BookingSheet } from "@/components/agenda/booking/BookingSheet";
import { RuleWarningsDialog } from "@/components/agenda/booking/RuleWarningsDialog";
import { useRoundedNow } from "@/components/agenda/booking/useRoundedNow";
import { useOrgTimezone } from "@/hooks/useOrgTimezone";
import { useAgendaAccess } from "@/hooks/useAgendaAccess";
import { mutationErrorMessage } from "@/lib/errors";
import { VOCAB } from "@/lib/vocab";
import { zonedDateTimeLabel, zonedToday } from "@/lib/agendaZone";
import {
  STATUS_TARGET,
  STATUS_TOAST,
  actionLabel,
  appointmentHistory,
  availableActions,
  type DetailAction,
} from "@/lib/appointmentActions";
import {
  isProposalFailure,
  joinNames,
  longRangePhrase,
  parseSchedRulesError,
  type ViolationView,
} from "@/lib/bookingFlow";

const t = VOCAB.scheduling.detail;

export interface AppointmentDetailPanelProps {
  organizationId: Id<"organizations">;
  /** Agendamento aberto; `null` fecha o painel. */
  appointmentId: Id<"schedAppointments"> | null;
  onClose: () => void;
  /** "Abrir conversa" (quando o agendamento tem conversa). Ausente = sem o atalho. */
  onOpenConversation?: (conversationId: Id<"conversations">) => void;
}

/**
 * Painel de um agendamento (chip da conversa, bloco do lead, grade): dados, status, origem, histórico
 * curto e as ações do status atual (só com `agenda:edit`). Remarcar reabre o `BookingSheet` em modo
 * remarcar; cancelar pede motivo opcional; toda mudança de status tem desfazer.
 */
export function AppointmentDetailPanel({ organizationId, appointmentId, onClose, onOpenConversation }: AppointmentDetailPanelProps) {
  return (
    <SlideOver open={appointmentId !== null} onClose={onClose} title={t.title}>
      {appointmentId && (
        <DetailBody
          key={`detail:${appointmentId}`}
          organizationId={organizationId}
          appointmentId={appointmentId}
          onOpenConversation={onOpenConversation}
        />
      )}
    </SlideOver>
  );
}

function DetailBody({
  organizationId,
  appointmentId,
  onOpenConversation,
}: {
  organizationId: Id<"organizations">;
  appointmentId: Id<"schedAppointments">;
  onOpenConversation?: (conversationId: Id<"conversations">) => void;
}) {
  const tz = useOrgTimezone(organizationId);
  const now = useRoundedNow("minute");
  const access = useAgendaAccess(organizationId);
  const data = useQuery(api.scheduling.getAppointment, { appointmentId });
  const config = useQuery(api.schedulingConfig.getConfig, { organizationId, closuresFrom: zonedToday(now, tz) });
  const setStatus = useMutation(api.schedulingMutations.setAppointmentStatus);
  const cancel = useMutation(api.schedulingMutations.cancelAppointment);
  const undo = useMutation(api.schedulingMutations.undoAppointmentStatus);
  const reassign = useMutation(api.schedulingMutations.reassignResources);

  const [busy, setBusy] = useState(false);
  const [proposalBroken, setProposalBroken] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);

  if (data === undefined) {
    return (
      <div className="flex justify-center py-10" role="status">
        <Spinner size="md" />
        <span className="sr-only">{t.loading}</span>
      </div>
    );
  }
  if (data === null) {
    return <EmptyState icon={CalendarX} size="sm" title={t.notFound.title} description={t.notFound.hint} />;
  }

  const appt = data.appointment;
  const canEdit = access.canEdit && data.canEdit;
  const isProposal = appt.status === "pending_approval";
  const actions = availableActions({
    status: appt.status,
    canEdit,
    startTime: appt.startTime,
    now,
    isRescheduleProposal: Boolean(appt.rescheduleOfId),
  });
  const who = appt.contactName ?? appt.guestName ?? "";
  const where = joinNames(appt.resources.map((r) => r.name));
  const history = appointmentHistory(appt);

  const doUndo = async () => {
    try {
      await undo({ organizationId, appointmentId });
      toast.success(t.toast.undone);
    } catch (e) {
      toast.error(mutationErrorMessage(e, VOCAB.scheduling.booking.toast.undoFailed));
    }
  };
  const undoAction = { label: VOCAB.scheduling.undo, onClick: () => void doUndo() };

  const run = async (action: DetailAction) => {
    if (busy) return;
    setBusy(true);
    try {
      if (action === "decline") {
        await cancel({ organizationId, appointmentId });
        toast.success(t.toast.declined);
      } else {
        const to = STATUS_TARGET[action];
        if (!to) return;
        await setStatus({ organizationId, appointmentId, to });
        toast.success(STATUS_TOAST[action] ?? t.toast.undone, (UNDO_TARGETS[to as SchedStatus] ?? []).length > 0 ? { action: undoAction } : undefined);
      }
      setProposalBroken(false);
    } catch (e) {
      if (action === "approve" && isProposalFailure(e)) setProposalBroken(true);
      toast.error(mutationErrorMessage(e, t.toast.failed));
    } finally {
      setBusy(false);
    }
  };

  const confirmCancel = async (reason: string) => {
    setBusy(true);
    try {
      await cancel({ organizationId, appointmentId, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      toast.success(VOCAB.scheduling.toast.cancelled, { action: undoAction });
      setCancelOpen(false);
    } catch (e) {
      toast.error(mutationErrorMessage(e, t.toast.failed));
    } finally {
      setBusy(false);
    }
  };

  const onAction = (action: DetailAction) => {
    if (action === "reschedule") setRescheduling(true);
    else if (action === "cancel") setCancelOpen(true);
    else if (action === "swap") setSwapOpen(true);
    else if (action === "undo") void doUndo();
    else void run(action);
  };

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
    ...(appt.notes ? ([[t.fields.notes, appt.notes]] as Array<[string, string]>) : []),
  ];

  return (
    <div className="space-y-5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <AppointmentStatusChip status={appt.status} />
        <AppointmentOriginBadge origin={appt.origin} />
      </div>

      {isProposal && <p className="text-sm text-text-secondary">{t.proposalHint}</p>}
      {proposalBroken && (
        <p role="alert" className="rounded-card border border-semantic-warning/40 bg-semantic-warning/5 p-3 text-sm text-text-primary">
          {t.proposalBroken}
        </p>
      )}
      {data.openConflicts.length > 0 && (
        <p role="status" className="rounded-card border border-semantic-warning/40 bg-semantic-warning/5 p-3 text-sm text-text-primary">
          {t.conflict}
        </p>
      )}

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
              // Proposta que não vale mais: a saída é recusar, então o destaque vai para "Recusar".
              variant={action === "decline" ? (proposalBroken ? "primary" : "secondary") : action === "approve" && proposalBroken ? "secondary" : "primary"}
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

      {appt.conversationId && onOpenConversation && (
        <Button type="button" variant="ghost" onClick={() => onOpenConversation(appt.conversationId!)}>
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

      {rescheduling && (
        <BookingSheet
          organizationId={organizationId}
          open
          onClose={() => setRescheduling(false)}
          who={{ contactId: appt.contactId, leadId: appt.leadId, conversationId: appt.conversationId, name: who }}
          reschedule={{ appointmentId, serviceId: appt.serviceId, variantKey: appt.variantKey }}
        />
      )}
      <CancelDialog open={cancelOpen} busy={busy} onClose={() => setCancelOpen(false)} onConfirm={(reason) => void confirmCancel(reason)} />
      {swapOpen && (
        <SwapDialog
          organizationId={organizationId}
          current={appt.resources.map((r) => ({ resourceId: r.resourceId, role: r.role, name: r.name }))}
          resources={(config?.resources ?? []).filter((r) => r.active).map((r) => ({ _id: r._id, name: r.name, kind: r.kind }))}
          onClose={() => setSwapOpen(false)}
          onApply={async (resourceIds, force) => {
            await reassign({ organizationId, appointmentId, resourceIds, ...(force ? { force } : {}) });
            toast.success(t.toast.swapped);
          }}
        />
      )}
    </div>
  );
}

function CancelDialog({ open, busy, onClose, onConfirm }: { open: boolean; busy: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal open={open} onClose={onClose} title={t.cancel.title}>
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{t.cancel.hint}</p>
        <Textarea label={t.cancel.reason} rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            {t.cancel.keep}
          </Button>
          <Button type="button" variant="danger" className="flex-1" loading={busy} onClick={() => onConfirm(reason)}>
            {t.cancel.confirm}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface SwapDialogProps {
  organizationId: Id<"organizations">;
  current: Array<{ resourceId: Id<"schedResources">; role: string; name: string }>;
  resources: Array<{ _id: Id<"schedResources">; name: string; kind: string }>;
  onClose: () => void;
  onApply: (resourceIds: Id<"schedResources">[], force?: string[]) => Promise<void>;
}

/** Troca cada recurso alocado por outro do MESMO tipo; avisos do servidor passam pelo `RuleWarningsDialog`. */
function SwapDialog({ organizationId, current, resources, onClose, onApply }: SwapDialogProps) {
  const tz = useOrgTimezone(organizationId);
  const kindOf = useMemo(() => new Map(resources.map((r) => [r._id as string, r.kind])), [resources]);
  const [picked, setPicked] = useState<string[]>(() => current.map((c) => c.resourceId));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ViolationView[] | null>(null);
  const names = useMemo(() => new Map(resources.map((r) => [r._id as string, r.name])), [resources]);

  const apply = async (force?: string[]) => {
    setBusy(true);
    try {
      await onApply(picked as Id<"schedResources">[], force);
      setFailure(null);
      onClose();
    } catch (e) {
      const rules = parseSchedRulesError(e);
      if (rules) setFailure(rules.violations);
      else toast.error(mutationErrorMessage(e, t.toast.failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal open onClose={onClose} title={t.swap.title}>
        <div className="space-y-4">
          {current.map((c, i) => {
            const kind = kindOf.get(c.resourceId);
            const options = resources.filter((r) => r.kind === kind);
            return (
              <Select
                key={`${c.resourceId}:${i}`}
                label={c.role || VOCAB.scheduling.resource.any.title}
                value={picked[i]}
                onValueChange={(v) => setPicked((p) => p.map((x, j) => (j === i ? v : x)))}
                options={options.length > 0 ? options.map((r) => ({ value: r._id, label: r.name })) : [{ value: c.resourceId, label: c.name }]}
              />
            );
          })}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
              {t.swap.keep}
            </Button>
            <Button type="button" className="flex-1" loading={busy} onClick={() => void apply()}>
              {t.swap.confirm}
            </Button>
          </div>
        </div>
      </Modal>
      <RuleWarningsDialog
        open={failure !== null}
        violations={failure ?? []}
        alternatives={[]}
        resourceNames={names}
        tz={tz}
        busy={busy}
        onForce={(codes) => void apply(codes)}
        onPickAlternative={() => setFailure(null)}
        onClose={() => setFailure(null)}
      />
    </>
  );
}

