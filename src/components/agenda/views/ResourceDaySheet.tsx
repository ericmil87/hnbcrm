import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { fillVocab } from "@/lib/agendaCopy";
import { isSituationChanged, periodText, validatePeriod, type ClosureReasonCode, type ClosureResult } from "@/lib/agendaClosure";
import type { ResourceKind } from "@/lib/agendaTypes";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { mutationErrorMessage } from "@/lib/errors";
import { ResourceDaySheetView, type ClosurePreviewState } from "./ResourceDaySheetView";
import { useClosureApi, useClosureRun } from "./useResourceClosure";

const t = VIEWS_COPY.closure;

export interface ClosureTarget {
  /** `null` = a agenda inteira (só `agenda:manage`). */
  resourceId: string | null;
  name: string;
  kind: ResourceKind | null;
  mode: "close" | "reopen";
  /** Mostra De/Até; sem ele a folha age só no dia aberto. */
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

type Raw = { status: "loading" } | { status: "error"; message: string; key: string } | { status: "ready"; result: ClosureResult; key: string };

/**
 * Contêiner de fechar e reabrir (recurso ou agenda inteira): pede a prévia ao abrir e a cada mudança de data,
 * confirma mandando SEMPRE `expectedAffected` (a contagem vista) e `acceptAffected` quando há afetados, trata
 * "a situação mudou" refazendo a prévia e acompanha o lote (`getClosureRun`). A prévia só vale para o escopo
 * (datas) em que foi pedida: ao mudar as datas ela some na hora e o botão de confirmar fica desligado até a
 * prévia nova chegar. Monta só aberto: o estado nasce a cada abertura.
 */
export function ResourceDaySheet({ organizationId, target, tz, date, today, onClose, onOpenPending }: ResourceDaySheetProps) {
  const api = useClosureApi(organizationId);
  const reopen = target.mode === "reopen";
  const org = target.resourceId === null;
  const [from, setFrom] = useState(date);
  const [to, setTo] = useState(date);
  const [reasonCode, setReasonCode] = useState<ClosureReasonCode>(org ? "holiday" : "no_staff");
  const [note, setNote] = useState("");
  const [raw, setRaw] = useState<Raw>({ status: "loading" });
  const [stale, setStale] = useState(false);
  const [retry, setRetry] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<ClosureResult | null>(null);
  const seq = useRef(0);
  const run = useClosureRun(organizationId, committed?.runId ?? null);

  const dateError = target.period ? validatePeriod(from, to, today) : null;
  const scopeKey = `${from}|${to}`;

  const loadPreview = useCallback(
    async (f: string, tt: string) => {
      const mine = ++seq.current;
      const key = `${f}|${tt}`;
      setRaw({ status: "loading" });
      try {
        const scope = { resourceId: target.resourceId ?? undefined, fromLocalDate: f, toLocalDate: tt };
        const result = await (reopen ? api.previewReopen(scope) : api.previewClose(scope));
        if (mine === seq.current) setRaw({ status: "ready", result, key });
      } catch (e) {
        if (mine === seq.current) setRaw({ status: "error", message: mutationErrorMessage(e, t.previewFailed), key });
      }
    },
    [api, reopen, target.resourceId]
  );

  // Prévia ao abrir e a cada mudança de data (pausa curta para quem digita a data).
  useEffect(() => {
    if (dateError) {
      seq.current++;
      return;
    }
    const id = setTimeout(() => void loadPreview(from, to), 250);
    return () => clearTimeout(id);
  }, [from, to, dateError, retry, loadPreview]);

  // Só vale a prévia do escopo que será enviado; qualquer outra é tratada como "carregando".
  const preview: ClosurePreviewState = raw.status !== "loading" && raw.key !== scopeKey ? { status: "loading" } : raw;
  const affected = preview.status === "ready" ? preview.result.affected : 0;

  const confirm = async () => {
    if (preview.status !== "ready" || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const scope = { resourceId: target.resourceId ?? undefined, fromLocalDate: from, toLocalDate: to };
    const guard = { expectedAffected: affected, acceptAffected: affected > 0 };
    try {
      const result = reopen ? await api.reopen(scope, guard) : await api.close(scope, { ...guard, reasonCode, reason: note.trim() || undefined });
      setCommitted(result);
      toast.success(reopen ? (org ? t.reopen.doneOrg : target.kind === "room" ? t.reopen.doneFem : t.reopen.doneMasc) : t.toast.closed);
    } catch (e) {
      if (isSituationChanged(e)) {
        // A contagem mudou desde a prévia: refaz agora e pede para conferir de novo (nada foi gravado).
        setStale(true);
        void loadPreview(from, to);
      } else {
        setSubmitError(mutationErrorMessage(e, reopen ? t.toast.reopenFailed : t.toast.failed));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const quando = periodText(date, date, today);
  const title = org
    ? reopen ? t.titleOrgReopen : t.titleOrg
    : target.period
      ? fillVocab(reopen ? t.titleReopenPeriod : t.titlePeriod, { nome: target.name })
      : fillVocab(reopen ? t.titleReopen : t.titleDay, { nome: target.name, quando });

  return (
    <Modal open onClose={() => !submitting && onClose()} title={title}>
      <ResourceDaySheetView
        mode={target.mode}
        period={target.period}
        resourceName={target.name}
        kind={target.kind}
        org={org}
        tz={tz}
        today={today}
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
        onRetry={() => setRetry((n) => n + 1)}
        onClose={onClose}
        onOpenPending={() => {
          onClose();
          onOpenPending();
        }}
      />
    </Modal>
  );
}
