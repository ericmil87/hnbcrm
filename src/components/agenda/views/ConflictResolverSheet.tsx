import { useState } from "react";
import { toast } from "sonner";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import {
  cancelAction,
  manualAction,
  rulesErrorMessage,
  applyReplacements,
  missingGroups,
  suggestionAction,
  suggestionRows,
  type ConflictAction,
  type ResourceLite,
} from "@/lib/agendaConflict";
import { pendingRowInfo } from "@/lib/agendaPending";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { mutationErrorMessage } from "@/lib/errors";
import { ConflictResolverView } from "./ConflictResolverView";
import type { PendingConflict } from "./PendingQueueView";
import { useClosureApi } from "./useResourceClosure";

const t = VIEWS_COPY.conflict;

interface ConflictResolverSheetProps {
  organizationId: Id<"organizations">;
  conflict: PendingConflict & { appointment: NonNullable<PendingConflict["appointment"]> };
  resources: readonly ResourceLite[];
  tz: string;
  onClose: () => void;
  /** "Remarcar": abre a folha de marcar horário em modo remarcar. */
  onReschedule: (conflict: PendingConflict) => void;
}

/** Contêiner do resolvedor de conflito (`resolveConflict`). Erro de regra mostra o motivo; nada fecha com erro. */
export function ConflictResolverSheet({ organizationId, conflict, resources, tz, onClose, onReschedule }: ConflictResolverSheetProps) {
  const api = useClosureApi(organizationId);
  const [busy, setBusy] = useState(false);
  const appt = conflict.appointment;
  const info = pendingRowInfo(appt, tz);

  const run = async (action: ConflictAction) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.resolve(conflict._id, action);
      toast.success(t.toast.resolved);
      onClose();
    } catch (e) {
      toast.error(rulesErrorMessage(e) ?? mutationErrorMessage(e, t.toast.failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={() => !busy && onClose()} title={t.title}>
      <ConflictResolverView
        who={info.who}
        when={info.when}
        service={info.service}
        origin={appt.origin}
        kind={conflict.kind}
        suggestions={suggestionRows(conflict.suggestions, resources, tz)}
        groups={missingGroups(resources, appt.resources, conflict)}
        busy={busy}
        onApplyResources={(choices) => {
          const ids = Object.values(choices);
          void run({ type: "resource", resourceIds: ids.length === 1 ? ids : applyReplacements(appt.resources, choices) });
        }}
        onPickSuggestion={(s) => void run(suggestionAction(s, appt.startTime))}
        onReschedule={() => onReschedule(conflict)}
        onCancel={(reason) => void run(cancelAction(reason))}
        onManual={(note) => void run(manualAction(note))}
        onClose={onClose}
      />
    </Modal>
  );
}
