import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { CalendarX } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { UNDO_TARGETS, type SchedStatus } from "../../../../convex/lib/schedStatus";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { BookingSheet } from "@/components/agenda/booking/BookingSheet";
import { RuleWarningsDialog } from "@/components/agenda/booking/RuleWarningsDialog";
import { useRoundedNow } from "@/components/agenda/booking/useRoundedNow";
import { useOrgTimezone } from "@/hooks/useOrgTimezone";
import { useAgendaAccess } from "@/hooks/useAgendaAccess";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage } from "@/lib/errors";
import { BOOKING_COPY, DETAIL_COPY } from "@/lib/bookingCopy";
import { VOCAB } from "@/lib/vocab";
import { zonedToday } from "@/lib/agendaZone";
import { STATUS_TARGET, STATUS_TOAST, detailPanelTitle, type DetailAction } from "@/lib/appointmentActions";
import { clientLabel, isProposalFailure, parseSchedRulesError, type ViolationView } from "@/lib/bookingFlow";
import { AppointmentDetailView } from "./AppointmentDetailView";

const t = DETAIL_COPY;

export interface AppointmentDetailPanelProps {
  organizationId: Id<"organizations">;
  /** Agendamento aberto; `null` fecha o painel. */
  appointmentId: Id<"schedAppointments"> | null;
  onClose: () => void;
  /** "Abrir conversa" (quando o agendamento tem conversa). Ausente = sem o atalho. */
  onOpenConversation?: (conversationId: Id<"conversations">) => void;
}

/**
 * Painel de um agendamento (chip da conversa, bloco do lead, grade). Contêiner: dados, mutations, toasts e
 * diálogos; a tela é `AppointmentDetailView` (por props). Remarcar reabre o `BookingSheet` em modo remarcar;
 * cancelar pede motivo opcional; mudança de status, cancelar e recusar têm "Desfazer".
 */
export function AppointmentDetailPanel({ organizationId, appointmentId, onClose, onOpenConversation }: AppointmentDetailPanelProps) {
  // Mesma assinatura do corpo (o Convex não busca duas vezes): aqui só para o título seguir a situação.
  const data = useQuery(api.scheduling.getAppointment, appointmentId ? { appointmentId } : "skip");
  const now = useRoundedNow("minute");
  return (
    <SlideOver open={appointmentId !== null} onClose={onClose} title={detailPanelTitle(data?.appointment, now)}>
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
  const canOpenInbox = usePermissions(organizationId).can("inbox", "view_own");
  const data = useQuery(api.scheduling.getAppointment, { appointmentId });
  const config = useQuery(api.schedulingConfig.getConfig, { organizationId, closuresFrom: zonedToday(now, tz) });
  const setStatus = useMutation(api.schedulingMutations.setAppointmentStatus);
  const cancel = useMutation(api.schedulingMutations.cancelAppointment);
  const undo = useMutation(api.schedulingMutations.undoAppointmentStatus);
  const reassign = useMutation(api.schedulingMutations.reassignResources);

  const [busy, setBusy] = useState(false);
  const [proposalBroken, setProposalBroken] = useState(false);
  const [undoUnavailable, setUndoUnavailable] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  const [rebooking, setRebooking] = useState(false);

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
  const who = appt.contactName ?? appt.guestName ?? "";

  const doUndo = async () => {
    try {
      await undo({ organizationId, appointmentId });
      setUndoUnavailable(false);
      toast.success(t.toast.undone);
    } catch (e) {
      // O servidor respondeu que não há o que desfazer (mudou de novo, já voltou): esconde a ação e explica.
      if (e instanceof ConvexError) setUndoUnavailable(true);
      toast.error(mutationErrorMessage(e, BOOKING_COPY.toast.undoFailed));
    }
  };
  const undoAction = { label: VOCAB.scheduling.undo, onClick: () => void doUndo() };

  const run = async (action: DetailAction) => {
    if (busy) return;
    setBusy(true);
    try {
      if (action === "decline") {
        await cancel({ organizationId, appointmentId });
        // O servidor deixa voltar para "aguardando aprovação".
        toast.success(t.toast.declined, { action: undoAction });
      } else {
        const to = STATUS_TARGET[action];
        if (!to) return;
        await setStatus({ organizationId, appointmentId, to });
        toast.success(STATUS_TOAST[action] ?? t.toast.undone, (UNDO_TARGETS[to as SchedStatus] ?? []).length > 0 ? { action: undoAction } : undefined);
      }
      setProposalBroken(false);
      setUndoUnavailable(false);
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
      setUndoUnavailable(false);
    } catch (e) {
      toast.error(mutationErrorMessage(e, t.toast.failed));
    } finally {
      setBusy(false);
    }
  };

  const onAction = (action: DetailAction) => {
    if (action === "reschedule") setRescheduling(true);
    else if (action === "rebook") setRebooking(true);
    else if (action === "cancel") setCancelOpen(true);
    else if (action === "swap") setSwapOpen(true);
    else if (action === "undo") void doUndo();
    else void run(action);
  };

  return (
    <>
      <AppointmentDetailView
        appointment={{ ...appt, createdByName: data.createdByName, statusActors: data.statusActors }}
        openConflicts={data.openConflicts.length}
        tz={tz}
        now={now}
        canEdit={canEdit}
        busy={busy}
        proposalBroken={proposalBroken}
        undoUnavailable={undoUnavailable}
        contactPhone={data.contactPhone}
        onAction={onAction}
        onOpenConversation={appt.conversationId && onOpenConversation && canOpenInbox ? () => onOpenConversation(appt.conversationId!) : undefined}
      />
      {rescheduling && (
        <BookingSheet
          organizationId={organizationId}
          open
          onClose={() => setRescheduling(false)}
          who={{ contactId: appt.contactId, leadId: appt.leadId, conversationId: appt.conversationId, name: clientLabel(who) }}
          reschedule={{ appointmentId, serviceId: appt.serviceId, variantKey: appt.variantKey, startTime: appt.startTime }}
        />
      )}
      {rebooking && (
        <BookingSheet
          organizationId={organizationId}
          open
          onClose={() => setRebooking(false)}
          onDone={() => setRebooking(false)}
          who={{ contactId: appt.contactId, leadId: appt.leadId, conversationId: appt.conversationId, name: clientLabel(who) }}
          initialService={{ serviceId: appt.serviceId, variantKey: appt.variantKey }}
        />
      )}
      <CancelDialog open={cancelOpen} busy={busy} onClose={() => setCancelOpen(false)} onConfirm={(reason) => void confirmCancel(reason)} />
      {swapOpen && (
        <SwapDialog
          tz={tz}
          current={appt.resources.map((r) => ({ resourceId: r.resourceId, role: r.role, name: r.name }))}
          resources={(config?.resources ?? []).filter((r) => r.active).map((r) => ({ _id: r._id, name: r.name, kind: r.kind }))}
          onClose={() => setSwapOpen(false)}
          onApply={async (resourceIds, force) => {
            await reassign({ organizationId, appointmentId, resourceIds, ...(force ? { force } : {}) });
            toast.success(t.toast.swapped);
          }}
        />
      )}
    </>
  );
}

export function CancelDialog({ open, busy, onClose, onConfirm }: { open: boolean; busy: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal open={open} onClose={onClose} title={t.cancel.title}>
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{t.cancel.hint}</p>
        <Textarea label={t.cancel.reason} rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="secondary" className="sm:flex-1" onClick={onClose}>
            {t.cancel.keep}
          </Button>
          <Button type="button" variant="danger" className="sm:flex-1" loading={busy} onClick={() => onConfirm(reason)}>
            {t.cancel.confirm}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface SwapDialogProps {
  tz: string;
  current: Array<{ resourceId: Id<"schedResources">; role: string; name: string }>;
  resources: Array<{ _id: Id<"schedResources">; name: string; kind: string }>;
  onClose: () => void;
  onApply: (resourceIds: Id<"schedResources">[], force?: string[]) => Promise<void>;
}

/** Troca cada recurso alocado por outro do MESMO tipo; avisos do servidor passam pelo `RuleWarningsDialog`. */
function SwapDialog({ tz, current, resources, onClose, onApply }: SwapDialogProps) {
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
            <Button type="button" variant="secondary" className="sm:flex-1" onClick={onClose}>
              {t.swap.keep}
            </Button>
            <Button type="button" className="sm:flex-1" loading={busy} onClick={() => void apply()}>
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
