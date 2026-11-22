import { useState } from "react";
import { CalendarClock, CheckCheck, Undo2, XCircle } from "lucide-react";
import { OriginMark as AppointmentOriginBadge } from "./OriginMark";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { fillVocab } from "@/lib/agendaCopy";
import { conflictKindText, type MissingGroup, type SuggestionRow } from "@/lib/agendaConflict";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { VOCAB } from "@/lib/vocab";

const t = VIEWS_COPY.conflict;

export interface ConflictResolverViewProps {
  who: string;
  when: string;
  service: string;
  origin: string;
  kind: string | undefined;
  suggestions: readonly SuggestionRow[];
  /** O que saiu (sala e/ou profissional) e quem pode substituir cada um. */
  groups: readonly MissingGroup[];
  busy: boolean;
  /** Troca de recursos: `choices` = ausente -> substituto (todos os ausentes têm escolha). */
  onApplyResources: (choices: Record<string, string>) => void;
  onPickSuggestion: (s: SuggestionRow) => void;
  onReschedule: () => void;
  onCancel: (reason: string) => void;
  onManual: (note: string) => void;
  onClose: () => void;
}

type Sub = null | "cancel" | "manual";

const optionClass =
  "flex min-h-11 w-full items-center gap-2 rounded-card border border-border bg-surface-raised px-3 text-left text-sm text-text-primary hover:bg-surface-overlay disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";

/**
 * Resolver um conflito (horário que ficou sem sala ou profissional): outro lugar (sugestões primeiro), remarcar,
 * cancelar com motivo ou "Resolvido por fora" com nota. Apresentacional: o contêiner chama `resolveConflict`.
 */
export function ConflictResolverView(p: ConflictResolverViewProps) {
  const [sub, setSub] = useState<Sub>(null);
  const [text, setText] = useState("");
  const [choices, setChoices] = useState<Record<string, string>>({});
  const single = p.groups.length === 1;
  const allChosen = p.groups.length > 0 && p.groups.every((g) => choices[g.missing._id]);

  if (sub) {
    const cancel = sub === "cancel";
    return (
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{cancel ? "" : t.manualHint}</p>
        <Textarea
          label={cancel ? t.cancelReason : t.manualNote}
          value={text}
          maxLength={200}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" size="lg" disabled={p.busy} onClick={() => setSub(null)}>
            {t.back}
          </Button>
          <Button size="lg" variant={cancel ? "danger" : "primary"} loading={p.busy} onClick={() => (cancel ? p.onCancel(text) : p.onManual(text))}>
            {cancel ? t.cancelConfirm : t.manualConfirm}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-card bg-surface-sunken px-3 py-2">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{p.who}</p>
          <AppointmentOriginBadge origin={p.origin} />
        </div>
        <p className="text-caption tabular-nums text-text-secondary">{p.when}</p>
        <p className="text-caption text-text-secondary">{p.service}</p>
        {conflictKindText(p.kind) && <p className="mt-1 text-caption font-medium text-semantic-warning">{conflictKindText(p.kind)}</p>}
      </div>

      {p.suggestions.length > 0 && (
        <section aria-labelledby="conflict-suggestions" className="space-y-2">
          <h3 id="conflict-suggestions" className="text-sm font-semibold text-text-primary">
            {t.suggestions}
          </h3>
          <ul className="space-y-2">
            {p.suggestions.map((s) => (
              <li key={`sug:${s.key}`}>
                <button type="button" disabled={p.busy} onClick={() => p.onPickSuggestion(s)} className={optionClass}>
                  <CalendarClock size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="conflict-resources" className="space-y-3">
        <h3 id="conflict-resources" className="text-sm font-semibold text-text-primary">
          {t.chooseResource}
        </h3>
        {p.groups.every((g) => g.candidates.length === 0) ? (
          <p className="text-sm text-text-muted">{t.noCandidates}</p>
        ) : (
          p.groups.map((g) => (
            <div key={`missing:${g.missing._id}`} className="space-y-2">
              {!single && <p className="text-caption font-medium text-text-secondary">{fillVocab(t.replaceFor, { nome: g.missing.name })}</p>}
              {g.candidates.length === 0 ? (
                <p className="text-sm text-text-muted">{t.noCandidates}</p>
              ) : (
                <ul className="space-y-2">
                  {g.candidates.map((r) => (
                    <li key={`cand:${g.missing._id}:${r._id}`}>
                      <button
                        type="button"
                        disabled={p.busy}
                        aria-pressed={single ? undefined : choices[g.missing._id] === r._id}
                        onClick={() => (single ? p.onApplyResources({ [g.missing._id]: r._id }) : setChoices((c) => ({ ...c, [g.missing._id]: r._id })))}
                        className={`${optionClass} ${!single && choices[g.missing._id] === r._id ? "border-brand-500 bg-brand-500/10" : ""}`}
                      >
                        <span className="flex-1">{r.name}</span>
                        <span className="text-caption text-text-muted">{VOCAB.scheduling.resource[r.kind].title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
        {!single && p.groups.length > 1 && (
          <Button size="sm" disabled={!allChosen || p.busy} onClick={() => p.onApplyResources(choices)}>
            {t.applyChoices}
          </Button>
        )}
      </section>

      <div className="space-y-2 border-t border-border-subtle pt-3">
        <button type="button" disabled={p.busy} onClick={p.onReschedule} className={optionClass}>
          <Undo2 size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
          {t.reschedule}
        </button>
        <button
          type="button"
          disabled={p.busy}
          onClick={() => {
            setText("");
            setSub("manual");
          }}
          className={optionClass}
        >
          <CheckCheck size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
          {t.manual}
        </button>
        <button
          type="button"
          disabled={p.busy}
          onClick={() => {
            setText("");
            setSub("cancel");
          }}
          className={optionClass}
        >
          <XCircle size={16} className="shrink-0 text-semantic-error" aria-hidden="true" />
          {t.cancel}
        </button>
      </div>
    </div>
  );
}
