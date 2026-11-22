import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { SlideOver } from "@/components/ui/SlideOver";
import { mutationErrorMessage } from "@/lib/errors";
import { OUTCOME_TARGETS } from "@/lib/agendaPending";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { PendingQueueView, type PendingAppointment, type PendingData } from "./PendingQueueView";

const t = VIEWS_COPY.pendingQueue;

interface PendingQueuePanelProps {
  organizationId: Id<"organizations">;
  open: boolean;
  onClose: () => void;
  data: PendingData | undefined;
  tz: string;
  now: number;
  canEdit: boolean;
  onOpenAppointment: (appointmentId: string) => void;
  onRebook: (appointment: PendingAppointment) => void;
  onResolveConflict: (conflictId: string, appointmentId: string | null) => void;
  onOpenConversation: (conversationId: string) => void;
}

/**
 * Fila de pendências numa folha lateral (tela cheia no celular). Contêiner: as mutations são as de sempre do
 * agendamento (`setAppointmentStatus`, `cancelAppointment`, `undoAppointmentStatus`); cada ação de um toque
 * mostra "Desfazer" no aviso. A lista é reativa: a linha some sozinha quando o servidor muda o status.
 */
export function PendingQueuePanel({ organizationId, open, onClose, data, tz, now, canEdit, onOpenAppointment, onRebook, onResolveConflict, onOpenConversation }: PendingQueuePanelProps) {
  const setStatus = useMutation(api.schedulingMutations.setAppointmentStatus);
  const cancel = useMutation(api.schedulingMutations.cancelAppointment);
  const undo = useMutation(api.schedulingMutations.undoAppointmentStatus);
  const [busyId, setBusyId] = useState<string | null>(null);

  const doUndo = async (appointmentId: string) => {
    try {
      await undo({ organizationId, appointmentId: appointmentId as Id<"schedAppointments"> });
      toast.success(t.toast.undone);
    } catch (e) {
      toast.error(mutationErrorMessage(e, t.toast.failed));
    }
  };

  const run = async (appointmentId: string, action: () => Promise<unknown>, message: string, withUndo: boolean) => {
    if (busyId) return;
    setBusyId(appointmentId);
    try {
      await action();
      toast.success(message, withUndo ? { action: { label: t.undo, onClick: () => void doUndo(appointmentId) } } : undefined);
    } catch (e) {
      toast.error(mutationErrorMessage(e, t.toast.failed));
    } finally {
      setBusyId(null);
    }
  };

  const id = (s: string) => s as Id<"schedAppointments">;
  return (
    <SlideOver open={open} onClose={onClose} title={t.title} bodyClassName="flex-1 overflow-y-auto p-4 md:p-6">
      <PendingQueueView
        data={data}
        tz={tz}
        now={now}
        canEdit={canEdit}
        busyId={busyId}
        onOpen={onOpenAppointment}
        onRebook={onRebook}
        onResolve={onResolveConflict}
        onOpenConversation={onOpenConversation}
        onApprove={(a) => void run(a, () => setStatus({ organizationId, appointmentId: id(a), to: "scheduled" }), t.toast.approved, false)}
        onDecline={(a) => void run(a, () => cancel({ organizationId, appointmentId: id(a) }), t.toast.declined, true)}
        onOutcome={(a, outcome) =>
          void run(
            a,
            () => setStatus({ organizationId, appointmentId: id(a), to: OUTCOME_TARGETS[outcome] as "completed" | "no_show" }),
            outcome === "attended" ? t.toast.attended : t.toast.noShow,
            true
          )
        }
      />
    </SlideOver>
  );
}
