import { Ban, CalendarCheck, CalendarDays, Flame, Hourglass, Lock, TriangleAlert } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { fillVocab } from "@/lib/agendaCopy";
import type { MonthCell } from "@/lib/agendaMonth";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { addLocalDays, shortDateLabel } from "@/lib/agendaZone";
import { cn } from "@/lib/utils";

const t = VIEWS_COPY.month;

export interface AgendaMonthViewProps {
  cells: ReadonlyArray<MonthCell | null>;
  /** Dia de hoje na org (destaque). */
  today: string;
  /** Dia aberto antes (destaque leve). */
  selected?: string;
  loading: boolean;
  /** Compromissos e tarefas da equipe por dia (indicador próprio; o resto do mês conta só agendamentos). */
  internalCounts?: Readonly<Record<string, number>>;
  /** Último dia com contagem completa quando o servidor cortou; `undefined` = completo. */
  partialFrom?: { through: string | null } | null;
  onPickDay: (localDate: string) => void;
  className?: string;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Resumo falado/escrito de um dia: "5 marcados, quase cheio, 1 fechado". */
export function cellSummary(c: MonthCell, internal = 0): string {
  const parts: string[] = [];
  parts.push(c.active === 0 ? t.emptyDay : c.active === 1 ? t.markedOne : fillVocab(t.marked, { n: c.active }));
  if (c.pending > 0) parts.push(fillVocab(t.pendingMark, { n: c.pending }));
  if (c.level === "full") parts.push(lowerFirst(t.full));
  else if (c.level === "high") parts.push(lowerFirst(t.high));
  if (c.allClosed) parts.push(lowerFirst(t.allClosed));
  else if (c.closedResources > 0) parts.push(fillVocab(t.someClosed, { n: c.closedResources }));
  if (internal > 0) parts.push(lowerFirst(internal === 1 ? t.internalOne : fillVocab(t.internal, { n: internal })));
  if (c.incomplete) parts.push(lowerFirst(t.incomplete));
  return parts.join(", ");
}

const LEVEL_CLASS = {
  empty: "bg-surface-raised",
  some: "bg-brand-500/10",
  high: "bg-semantic-warning/10",
  full: "bg-semantic-error/10",
} as const;

/** Mês de ocupação: um botão por dia (44 px), com contagem, "cheio" por ícone e rótulo, dias fechados e aviso de corte. */
/** Agrupa as células em semanas de 7 (completa a última com vazios). */
export function weeksOf(cells: ReadonlyArray<MonthCell | null>): Array<Array<MonthCell | null>> {
  const out: Array<Array<MonthCell | null>> = [];
  for (let i = 0; i < cells.length; i += 7) {
    const row = cells.slice(i, i + 7);
    while (row.length < 7) row.push(null);
    out.push(row);
  }
  return out;
}

export function AgendaMonthView({ cells, today, selected, loading, internalCounts, partialFrom, onPickDay, className }: AgendaMonthViewProps) {
  const weeks = weeksOf(cells);
  return (
    <div className={cn("space-y-3", className)}>
      {partialFrom && (
        <p role="status" className="flex items-start gap-2 rounded-card border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-2 text-sm text-text-primary">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden="true" />
          {partialFrom.through
            ? fillVocab(t.partial, { data: shortDateLabel(addLocalDays(partialFrom.through, 1)) })
            : t.partialUnknown}
        </p>
      )}
      <div role="grid" aria-label={t.ariaLabel} aria-busy={loading} className="rounded-card border border-border bg-surface-raised p-1.5 md:p-3">
        <div role="row" className="grid grid-cols-7 pb-1">
          {t.weekdays.map((d) => (
            <div key={`wd:${d}`} role="columnheader" className="py-1 text-center text-caption font-medium text-text-muted">
              {d}
            </div>
          ))}
        </div>
        {loading && cells.every((c) => c === null || c.active === 0) ? (
          <div className="grid grid-cols-7 gap-1" role="status" aria-label={t.loading}>
            {Array.from({ length: 35 }, (_, i) => (
              <Skeleton key={`sk:${i}`} className="h-14 rounded-field md:h-20" />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {weeks.map((week, w) => (
              <div key={`week:${w}`} role="row" className="grid grid-cols-7 gap-1">
            {week.map((c, i) =>
              c === null ? (
                <div key={`blank:${w}:${i}`} role="gridcell" aria-hidden="true" />
              ) : (
                <div key={`day:${c.localDate}`} role="gridcell">
                  <button
                    type="button"
                    onClick={() => onPickDay(c.localDate)}
                    aria-label={fillVocab(t.dayAria, { data: shortDateLabel(c.localDate), resumo: cellSummary(c, internalCounts?.[c.localDate] ?? 0) })}
                    aria-current={c.localDate === today ? "date" : undefined}
                    className={cn(
                      "flex h-14 w-full flex-col items-stretch justify-between rounded-field border p-1 text-left transition-colors md:h-20 md:p-2",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 hover:border-brand-500/60",
                      LEVEL_CLASS[c.allClosed ? "empty" : c.level],
                      c.localDate === selected ? "border-brand-500" : "border-border-subtle",
                      c.allClosed && "bg-surface-sunken",
                      c.incomplete && "border-dashed"
                    )}
                  >
                    <span className="flex items-center justify-between">
                      <span
                        className={cn(
                          "text-sm font-semibold tabular-nums",
                          c.localDate === today ? "flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-white" : "text-text-primary"
                        )}
                      >
                        {c.day}
                      </span>
                      <span className="flex items-center gap-0.5 text-text-secondary" aria-hidden="true">
                        {c.allClosed ? <Ban size={14} /> : c.closedResources > 0 ? <Lock size={14} /> : null}
                        {c.level === "full" && !c.allClosed && <Flame size={14} className="text-semantic-error" />}
                        {c.level === "high" && !c.allClosed && <Flame size={14} className="text-semantic-warning" />}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1 text-micro tabular-nums text-text-secondary" aria-hidden="true">
                      {c.active > 0 && (
                        <span className="inline-flex items-center gap-0.5 font-medium">
                          <CalendarCheck size={12} />
                          {c.active}
                          {c.incomplete ? "+" : ""}
                        </span>
                      )}
                      {(internalCounts?.[c.localDate] ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-ai-400">
                          <CalendarDays size={12} />
                          {internalCounts?.[c.localDate]}
                        </span>
                      )}
                      {c.pending > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-semantic-warning">
                          <Hourglass size={12} />
                          {c.pending}
                        </span>
                      )}
                      <span className="hidden md:inline">{c.level === "full" ? t.full : c.level === "high" ? t.high : c.allClosed ? t.allClosed : ""}</span>
                    </span>
                  </button>
                </div>
              )
            )}
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="px-1 text-caption text-text-muted">{t.legend}</p>
    </div>
  );
}
