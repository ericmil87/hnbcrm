import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { fillVocab } from "@/lib/agendaCopy";
import { isSituationChanged, validatePeriod, type ClosureReasonCode, type ClosureResult } from "@/lib/agendaClosure";
import type { ResourceKind } from "@/lib/agendaTypes";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { mutationErrorMessage } from "@/lib/errors";
import { ResourceDaySheetView, type ClosurePreviewState } from "./ResourceDaySheetView";
import { useClosureApi, useClosureRun } from "./useResourceClosure";

const t = VIEWS_COPY.closure;

export interface ClosureTarget {
  resourceId: string;
  name: string;
  kind: ResourceKind;
  mode: "close" | "reopen";
  period: boolean;
}

interface ResourceDaySheetProps {
  organizationId: Id<"organizations">;
  target: ClosureTarget;
  tz: string;
  /** Dia aberto na agenda (data local da org): ponto de partida de "De" e "Até". */
  date: string;
  today: string;
  onClose: () => void;
  onOpenPending: () => void;
}

/**
 * Contêiner de "Fechar hoje / Fechar um período / Reabrir": pede a prévia ao abrir e a cada mudança de data
 * (mesmo núcleo do commit, não grava), confirma mandando SEMPRE `expectedAffected` (a contagem vista) e
 * `acceptAffected` quando há afetados, trata "a situação mudou" refazendo a prévia e acompanha o lote
 * (`getClosureRun`). Monta só aberto: o estado nasce a cada abertura.
 */
export function ResourceDaySheet({ organizationId, target, tz, date, today, onClose, onOpenPending }: ResourceDaySheetProps) {
  const api = useClosureApi(organizationId);
  const reopen = target.mode === "reopen";
  const [from, setFrom] = useState(date);
  const [to, setTo] = useState(date);
  const [reasonCode, setReasonCode] = useState<ClosureReasonCode>("no_staff");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<ClosurePreviewState>({ status: "loading" });
  const [stale, setStale] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<ClosureResult | null>(null);
  const seq = useRef(0);
  const run = useClosureRun(organizationId, committed?.runId ?? null);

  const dateError = target.period && !reopen ? validatePeriod(from, to, today) : null;

  const loadPreview = useCallback(
    async (f: string, tt: string) => {
      const mine = ++seq.current;
      setPreview({ status: "loading" });
      try {
        const scope = { resourceId: target.resourceId, fromLocalDate: f, toLocalDate: tt };
        const result = await (reopen ? api.previewReopen(scope) : api.previewClose(scope));
        if (mine === seq.current) setPreview({ status: "ready", result });
      } catch (e) {
        if (mine === seq.current) setPreview({ status: "error", message: mutationErrorMessage(e, t.previewFailed) });
      }
    },
    [api, reopen, target.resourceId]
  );

  // Prévia ao abrir e a cada mudança de data (com uma pausa curta para quem digita a data).
  useEffect(() => {
    if (dateError) {
      seq.current++;
      return;
    }
    const id = setTimeout(() => void loadPreview(from, to), 250);
    return () => clearTimeout(id);
  }, [from, to, dateError, refresh, loadPreview]);

  const affected = preview.status === "ready" ? preview.result.affected : 0;

  const confirm = async () => {
    if (preview.status !== "ready" || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const scope = { resourceId: target.resourceId, fromLocalDate: from, toLocalDate: to };
    const guard = { expectedAffected: affected, acceptAffected: affected > 0 };
    try {
      const result = reopen ? await api.reopen(scope, guard) : await api.close(scope, { ...guard, reasonCode, reason: note.trim() || undefined });
      setCommitted(result);
      toast.success(reopen ? t.reopen.done : t.toast.closed);
    } catch (e) {
      if (isSituationChanged(e)) {
        // A contagem mudou desde a prévia: refaz e pede para conferir de novo (nada foi gravado).
        setStale(true);
        setRefresh((n) => n + 1);
      } else {
        setSubmitError(mutationErrorMessage(e, reopen ? t.toast.reopenFailed : t.toast.failed));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const title = reopen
    ? fillVocab(t.titleReopen, { nome: target.name })
    : fillVocab(target.period ? t.titlePeriod : t.titleToday, { nome: target.name });

  return (
    <Modal open onClose={() => !submitting && onClose()} title={title}>
      <ResourceDaySheetView
        mode={target.mode}
        period={target.period && !reopen}
        resourceName={target.name}
        kind={target.kind}
        tz={tz}
        from={from}
        to={to}
        onDatesChange={(f, tt) => {
          setFrom(f);
          setTo(tt);
          setStale(false);
        }}
        dateError={dateError}
        reasonCode={reasonCode}
        onReasonChange={setReasonCode}
        note={note}
        onNoteChange={setNote}
        preview={preview}
        stale={stale}
        submitting={submitting}
        submitError={submitError}
        committed={committed}
        run={run}
        onConfirm={() => void confirm()}
        onRetry={() => setRefresh((n) => n + 1)}
        onClose={onClose}
        onOpenPending={() => {
          onClose();
          onOpenPending();
        }}
      />
    </Modal>
  );
}
