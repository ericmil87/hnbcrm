import { AlertTriangle, Lock, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FilterChips } from "@/components/ui/FilterChips";
import { Input } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { fillVocab } from "@/lib/agendaCopy";
import {
  CLOSURE_REASONS,
  confirmLabel,
  lineOutcomeText,
  reopenNotice,
  runView,
  summarizePreview,
  type ClosureReasonCode,
  type ClosureResult,
  type ClosureRunLike,
} from "@/lib/agendaClosure";
import { CLOSURE_REASON_TEXT } from "@/lib/agendaGrid";
import type { ResourceKind } from "@/lib/agendaTypes";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { periodText } from "@/lib/agendaClosure";
import { zonedTimeLabel } from "@/lib/agendaZone";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";

const t = VIEWS_COPY.closure;

export type ClosurePreviewState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; result: ClosureResult };

export interface ResourceDaySheetViewProps {
  mode: "close" | "reopen";
  /** "Fechar um período": mostra De/Até. */
  period: boolean;
  resourceName: string;
  kind: ResourceKind | null;
  /** Escopo da agenda inteira (sem recurso). */
  org: boolean;
  tz: string;
  today: string;
  from: string;
  to: string;
  onDatesChange: (from: string, to: string) => void;
  dateError: string | null;
  reasonCode: ClosureReasonCode;
  onReasonChange: (code: ClosureReasonCode) => void;
  note: string;
  onNoteChange: (note: string) => void;
  preview: ClosurePreviewState;
  /** O servidor recusou porque a situação mudou: a prévia foi refeita e precisa ser conferida de novo. */
  stale: boolean;
  submitting: boolean;
  submitError: string | null;
  /** Resultado do commit (depois de confirmar). */
  committed: ClosureResult | null;
  /** Andamento do lote; `undefined` = carregando. Só quando o commit devolveu `runId`. */
  run: ClosureRunLike | null | undefined;
  onConfirm: () => void;
  onRetry: () => void;
  onClose: () => void;
  onOpenPending: () => void;
}

/**
 * Folha de fechar e reabrir recurso no dia. PRÉVIA obrigatória do impacto antes de confirmar, com o que acontece
 * com cada agendamento (muda para qual sala × fica sem lugar; profissional nunca é passado a outro sozinho),
 * aceite explícito no botão e, depois, andamento do lote. Apresentacional: o contêiner (`ResourceDaySheet`)
 * faz as chamadas.
 */
export function ResourceDaySheetView(p: ResourceDaySheetViewProps) {
  if (p.committed) return <Done {...p} committed={p.committed} />;
  const reopen = p.mode === "reopen";
  const ready = p.preview.status === "ready" ? p.preview.result : null;
  const summary = ready ? summarizePreview(ready, { resourceName: p.resourceName, kind: p.kind, org: p.org }) : null;
  const notice = reopen && ready ? reopenNotice(ready.reason) : null;
  const canConfirm = !!ready && !p.dateError && !p.submitting && !notice;
  const when = periodText(p.from, p.to, p.today);
  const label = reopen ? `${t.confirm.reopen} em ${when}` : summary ? confirmLabel(summary, when) : `${t.confirm.plain} em ${when}`;

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 rounded-card bg-surface-sunken px-3 py-2 text-sm text-text-secondary">
        <Lock size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        {reopen ? t.reopen.assurance : t.assurance}
      </p>

      <p className="text-sm font-medium text-text-primary">{fillVocab(t.periodLine, { periodo: when })}</p>

      {p.period && (
        <div className="grid grid-cols-2 gap-3">
          <Input type="date" label={t.from} value={p.from} onChange={(e) => p.onDatesChange(e.target.value, p.to < e.target.value ? e.target.value : p.to)} />
          <Input type="date" label={t.to} value={p.to} min={p.from} onChange={(e) => p.onDatesChange(p.from, e.target.value)} />
        </div>
      )}
      {p.dateError && (
        <p role="alert" className="text-sm text-semantic-error">
          {p.dateError}
        </p>
      )}

      {!reopen && (
        <div className="space-y-2">
          <p id="closure-reason-label" className="text-sm font-medium text-text-primary">
            {t.reasonLabel}
          </p>
          <FilterChips
            ariaLabel={t.reasonLabel}
            chips={CLOSURE_REASONS.map((code) => ({ id: code, label: CLOSURE_REASON_TEXT[code], pressed: p.reasonCode === code }))}
            onToggle={(id) => p.onReasonChange(id as ClosureReasonCode)}
          />
          <Input label={t.noteLabel} value={p.note} maxLength={120} placeholder={t.notePlaceholder} onChange={(e) => p.onNoteChange(e.target.value)} />
        </div>
      )}

      <section aria-label={t.previewTitle} aria-live="polite" className="space-y-2">
        <h3 className="text-sm font-semibold text-text-primary">{t.previewTitle}</h3>
        {p.stale && (
          <p role="status" className="flex items-center gap-2 rounded-card border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-2 text-sm text-text-primary">
            <TriangleAlert size={16} className="shrink-0 text-semantic-warning" aria-hidden="true" />
            {t.stale}
          </p>
        )}
        {p.preview.status === "loading" && (
          <div role="status" aria-label={t.loading} className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
        {p.preview.status === "error" && (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-semantic-error">{p.preview.message}</p>
            <Button size="sm" variant="secondary" onClick={p.onRetry}>
              {t.retry}
            </Button>
          </div>
        )}
        {ready && summary && (
          <>
            {notice ? (
              <p className="text-sm text-text-primary">{notice}</p>
            ) : summary.none ? (
              <p className="text-sm text-text-primary">{reopen ? t.reopen.assurance : VOCAB.scheduling.closeImpactNone}</p>
            ) : (
              <ul className="space-y-1 text-sm text-text-primary">
                {summary.sentences.map((s, i) => (
                  <li key={`sentence:${i}`} className={cn(i === 0 && "font-medium")}>
                    {s}
                  </li>
                ))}
              </ul>
            )}
            {ready.items.filter((i) => i.outcome !== "unknown").length > 0 && (
              <ul className="divide-y divide-border-subtle rounded-card border border-border-subtle" aria-label={t.previewTitle}>
                {ready.items
                  .filter((i) => i.outcome !== "unknown")
                  .map((it) => (
                    <li key={`line:${it.appointmentId}`} className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm">
                      <span className="w-12 shrink-0 font-semibold tabular-nums text-text-primary">{zonedTimeLabel(it.startTime, p.tz)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-text-primary">{it.contactName ?? it.serviceName}</span>
                        <span className="block truncate text-caption text-text-secondary">{it.serviceName}</span>
                      </span>
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1 text-caption font-medium",
                          it.outcome === "conflict" ? "text-semantic-warning" : "text-text-secondary"
                        )}
                      >
                        {it.outcome === "conflict" && <AlertTriangle size={12} aria-hidden="true" />}
                        {lineOutcomeText(it)}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </>
        )}
      </section>

      {p.submitError && (
        <p role="alert" className="text-sm text-semantic-error">
          {p.submitError}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" size="lg" onClick={p.onClose} disabled={p.submitting} className="sm:w-auto">
          {t.confirm.back}
        </Button>
        <Button size="lg" onClick={p.onConfirm} disabled={!canConfirm} loading={p.submitting} className="sm:w-auto">
          {p.submitting ? t.confirm.sending : label}
        </Button>
      </div>
    </div>
  );
}

function Done(p: ResourceDaySheetViewProps & { committed: ClosureResult }) {
  const reopen = p.mode === "reopen";
  const run = p.committed.runId ? (p.run ? runView(p.run) : null) : null;
  const incomplete = run?.state === "incomplete";
  const running = run?.state === "running";
  const needsQueue = incomplete || p.committed.conflicts > 0 || (run?.state === "done" && (p.run?.conflicts ?? 0) + (p.run?.failed ?? 0) > 0);
  const immediate = p.committed.pending === 0 && !p.committed.runId
    ? p.committed.affected === 0
      ? t.run.doneNone
      : fillVocab(t.run.done, { moved: p.committed.reallocated, conflicts: p.committed.conflicts })
    : null;
  return (
    <div className="space-y-4">
      <div role="status" aria-live="polite" className="space-y-2">
        {reopen ? (
          <p className="text-sm text-text-primary">{p.org ? t.reopen.doneOrg : p.kind === "room" ? t.reopen.doneFem : t.reopen.doneMasc}</p>
        ) : (
          <>
            <p className={cn("flex items-start gap-2 text-sm", incomplete ? "text-semantic-warning" : "text-text-primary")}>
              {incomplete && <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />}
              {run ? run.text : (immediate ?? fillVocab(t.run.runningPartial, { done: 0 }))}
            </p>
            {running && run?.progress !== null && run?.progress !== undefined && (
              <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(run.progress * 100)}>
                <div className="h-full bg-brand-600 transition-all" style={{ width: `${Math.round(run.progress * 100)}%` }} />
              </div>
            )}
          </>
        )}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" size="lg" onClick={p.onClose} className="sm:w-auto">
          {t.run.close}
        </Button>
        {needsQueue && !reopen && (
          <Button size="lg" onClick={p.onOpenPending} className="sm:w-auto">
            {t.run.openQueue}
          </Button>
        )}
      </div>
    </div>
  );
}
