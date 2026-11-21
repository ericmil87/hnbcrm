import { CalendarDays, CheckSquare, ChevronRight, DoorOpen, Lock, Plus, TriangleAlert, UserRound } from "lucide-react";
import { Fragment } from "react";
import { AppointmentOriginBadge } from "@/components/agenda/AppointmentOriginBadge";
import { AppointmentStatusChip } from "@/components/agenda/AppointmentStatusChip";
import { VacancyIndicator } from "@/components/agenda/VacancyIndicator";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { fillVocab } from "@/lib/agendaCopy";
import { appointmentLabel, type GroupBy, type InternalItem } from "@/lib/agendaGrid";
import type { ListEntry, ListGroup, ResourceSummary } from "@/lib/agendaDayList";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import type { ListMode } from "@/lib/agendaViewParams";
import { minutesLabel, zonedRangeLabel, zonedTimeLabel } from "@/lib/agendaZone";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";
import type { ColumnAction } from "./ResourceDayGrid";
import type { DayResource } from "@/lib/agendaGrid";

const t = VIEWS_COPY.list;

export interface AgendaDayListProps {
  groups: ListGroup[];
  summaries: ResourceSummary[];
  tz: string;
  mode: ListMode;
  groupBy: GroupBy;
  canBook: boolean;
  canClose: boolean;
  /** Recursos para o menu do resumo (fechar/abrir). */
  resources: readonly DayResource[];
  onAppointmentClick: (appointmentId: string) => void;
  onInternalClick: (item: InternalItem) => void;
  /** "+ livre": marca horário no recurso, a partir do minuto do dia. */
  onFreeClick: (resourceId: string, startMin: number) => void;
  onResourceAction: (resource: DayResource, action: ColumnAction) => void;
  onBook: () => void;
  className?: string;
}

const rowBase =
  "flex w-full min-h-14 items-center gap-3 rounded-card border bg-surface-raised px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base";

function TimeCell({ start, end }: { start: string; end?: string }) {
  return (
    <span className="w-12 shrink-0 text-sm font-semibold tabular-nums text-text-primary">
      {start}
      {end && <span className="block text-caption font-normal text-text-muted">{end}</span>}
    </span>
  );
}

function EntryRow({
  entry,
  tz,
  showPlace,
  canBook,
  onAppointmentClick,
  onInternalClick,
  onFreeClick,
}: {
  entry: ListEntry;
  tz: string;
  showPlace: boolean;
  canBook: boolean;
  onAppointmentClick: (id: string) => void;
  onInternalClick: (item: InternalItem) => void;
  onFreeClick: (resourceId: string, startMin: number) => void;
}) {
  if (entry.kind === "free") {
    if (!canBook) return null;
    const label = fillVocab(t.freeFrom, { de: minutesLabel(entry.gap.startMin), ate: minutesLabel(entry.gap.endMin) });
    return (
      <button
        type="button"
        onClick={() => onFreeClick(entry.resourceId, entry.gap.startMin)}
        className="flex w-full min-h-11 items-center gap-2 rounded-card border border-dashed border-border px-3 text-left text-sm text-brand-500 hover:bg-brand-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <Plus size={16} aria-hidden="true" />
        {label}
      </button>
    );
  }
  if (entry.kind === "busy") {
    return (
      <div className={cn(rowBase, "cursor-default border-border-subtle text-text-muted")}>
        <TimeCell start={zonedTimeLabel(entry.startTime, tz)} end={zonedTimeLabel(entry.endTime, tz)} />
        <Lock size={16} aria-hidden="true" />
        <span className="text-sm">{t.busy}</span>
        <span className="sr-only">{t.busyHint}</span>
      </div>
    );
  }
  if (entry.kind === "internal") {
    const e = entry.internal;
    const Icon = e.source === "task" ? CheckSquare : CalendarDays;
    return (
      <button
        type="button"
        onClick={() => onInternalClick(e)}
        className={cn(rowBase, "border-dashed border-ai-500 bg-ai-500/10")}
      >
        <TimeCell start={e.allDay ? "Dia" : zonedTimeLabel(e.startTime, tz)} end={e.allDay ? "todo" : undefined} />
        <Icon size={16} className="shrink-0 text-ai-400" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-primary">{e.title}</span>
          <span className="block truncate text-caption text-text-secondary">
            {e.source === "task" ? VIEWS_COPY.grid.task : VIEWS_COPY.grid.event}
            {e.assigneeName ? ` · ${e.assigneeName}` : ""}
          </span>
        </span>
      </button>
    );
  }
  const a = entry.appointment;
  return (
    <button
      type="button"
      onClick={() => onAppointmentClick(a._id)}
      aria-label={[zonedRangeLabel(a.startTime, a.endTime, tz), appointmentLabel(a), a.serviceName, entry.place].filter(Boolean).join(", ")}
      className={cn(rowBase, "border-border-subtle hover:bg-surface-overlay")}
    >
      <TimeCell start={zonedTimeLabel(a.startTime, tz)} end={zonedTimeLabel(a.endTime, tz)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-text-primary">{appointmentLabel(a)}</span>
        <span className="block truncate text-caption text-text-secondary">
          {a.serviceName}
          {showPlace && entry.place ? ` · ${entry.place}` : ""}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <AppointmentStatusChip status={a.status} />
          <AppointmentOriginBadge origin={a.origin} />
          {entry.conflict && (
            <span className="inline-flex items-center gap-1 text-caption font-medium text-semantic-warning">
              <TriangleAlert size={12} aria-hidden="true" />
              {t.noPlace}
            </span>
          )}
        </span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
    </button>
  );
}

function SummaryChip({
  s,
  resource,
  canBook,
  canClose,
  onAction,
}: {
  s: ResourceSummary;
  resource: DayResource | undefined;
  canBook: boolean;
  canClose: boolean;
  onAction: AgendaDayListProps["onResourceAction"];
}) {
  const feminine = s.kind === "room";
  const state =
    s.state === "closed"
      ? feminine ? t.closed : t.closedGeneric
      : s.state === "full"
        ? feminine ? t.full : t.fullGeneric
        : feminine ? t.open : t.openGeneric;
  const Icon = s.kind === "person" ? UserRound : DoorOpen;
  const tone =
    s.state === "closed"
      ? "border-semantic-error/40 bg-semantic-error/10"
      : s.state === "full"
        ? "border-semantic-warning/40 bg-semantic-warning/10"
        : "border-border bg-surface-raised";
  const content = (
    <>
      <Icon size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
      <span className="min-w-0 text-left">
        <span className="block truncate text-sm font-medium text-text-primary">{s.name}</span>
        <span className="flex items-center gap-1.5 text-caption text-text-secondary">
          {s.state === "closed" && <Lock size={12} aria-hidden="true" />}
          {state}
          {s.state !== "closed" && (s.capacity > 1 || s.vacancy.over) && <VacancyIndicator used={s.vacancy.used} capacity={s.capacity} />}
        </span>
      </span>
    </>
  );
  const items: MenuItem[] = [];
  if (resource && canBook && s.state !== "closed") {
    items.push({ id: "book", label: VIEWS_COPY.grid.bookHere, icon: <Plus size={16} aria-hidden="true" />, onSelect: () => onAction(resource, "book") });
  }
  if (resource && canClose) {
    if (s.state === "closed") items.push({ id: "reopen", label: VOCAB.scheduling.openToday, onSelect: () => onAction(resource, "reopen") });
    else items.push({ id: "close-today", label: VOCAB.scheduling.closeToday, onSelect: () => onAction(resource, "closeToday") });
    items.push({ id: "close-period", label: VIEWS_COPY.grid.closePeriod, onSelect: () => onAction(resource, "closePeriod") });
  }
  const cls = cn("flex min-h-11 items-center gap-2 rounded-card border px-3 py-1.5", tone);
  if (items.length === 0) return <li className={cls}>{content}</li>;
  return (
    <li>
      <Menu
        ariaLabel={fillVocab(VIEWS_COPY.grid.columnMenu, { nome: s.name })}
        align="start"
        items={items}
        trigger={(props) => (
          <button
            type="button"
            {...props}
            aria-label={`${s.name}, ${state}`}
            className={cn(cls, "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500")}
          >
            {content}
          </button>
        )}
      />
    </li>
  );
}

function groupTitle(g: ListGroup, groupBy: GroupBy): string {
  if (g.kind === "noPlace") return t.noPlace;
  if (g.kind === "internal") return t.internal;
  if (g.kind === "unassigned") return t.unassigned[groupBy === "room" ? "room" : "person"];
  return g.title;
}

/**
 * Lista do dia (padrão no celular): resumo por recurso no topo (aberta, cheia, fechada; toque abre o menu
 * de fechar/abrir), depois os horários por hora ou por recurso. Linhas de 56 px, status com ícone e rótulo.
 * Apresentacional.
 */
export function AgendaDayList(p: AgendaDayListProps) {
  const resourceById = new Map(p.resources.map((r) => [r._id, r]));
  const showPlace = p.mode === "hora";
  const empty = p.groups.length === 0;

  return (
    <div className={cn("space-y-4", p.className)}>
      {p.summaries.length > 0 && (
        <section aria-label={t.summaryLabel}>
          <ul className="flex flex-wrap gap-2">
            {p.summaries.map((s) => (
              <SummaryChip
                key={`sum:${s.resourceId}`}
                s={s}
                resource={resourceById.get(s.resourceId)}
                canBook={p.canBook}
                canClose={p.canClose}
                onAction={p.onResourceAction}
              />
            ))}
          </ul>
        </section>
      )}

      {empty ? (
        <EmptyState
          icon={CalendarDays}
          size="sm"
          title={t.empty.title}
          description={t.empty.hint}
          action={p.canBook ? { label: VOCAB.scheduling.book, onClick: p.onBook } : undefined}
        />
      ) : (
        <div role="list" aria-label={t.ariaLabel} className="space-y-4">
          {p.groups.map((g) => (
            <section key={`group:${g.key}`} role="listitem" aria-label={groupTitle(g, p.groupBy) || undefined} className="space-y-2">
              {(g.title || g.kind !== "time") && (
                <div className="flex items-center gap-2 px-1">
                  <h2 className="text-sm font-semibold text-text-primary">{groupTitle(g, p.groupBy)}</h2>
                  {g.kind === "noPlace" && <TriangleAlert size={14} className="text-semantic-warning" aria-hidden="true" />}
                  {g.vacancy && g.capacity !== undefined && (g.capacity > 1 || g.vacancy.over) && !g.closed && (
                    <VacancyIndicator used={g.vacancy.used} capacity={g.capacity} />
                  )}
                  {g.closed && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-semantic-error/10 px-2 py-0.5 text-xs font-medium text-semantic-error">
                      <Lock size={12} aria-hidden="true" />
                      {resourceById.get(g.resourceId ?? "")?.kind === "room" ? VIEWS_COPY.grid.closed : VIEWS_COPY.grid.closedGeneric}
                    </span>
                  )}
                  {g.closed && g.closedReason && <span className="truncate text-caption text-text-muted">{g.closedReason}</span>}
                  {g.closed && p.canClose && g.resourceId && resourceById.get(g.resourceId) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => p.onResourceAction(resourceById.get(g.resourceId!)!, "reopen")}
                    >
                      {VOCAB.scheduling.openToday}
                    </Button>
                  )}
                </div>
              )}
              <ul className="space-y-2">
                {g.entries.map((e) => (
                  <Fragment key={`entry:${e.id}`}>
                    <li>
                      <EntryRow
                        entry={e}
                        tz={p.tz}
                        showPlace={showPlace}
                        canBook={p.canBook}
                        onAppointmentClick={p.onAppointmentClick}
                        onInternalClick={p.onInternalClick}
                        onFreeClick={p.onFreeClick}
                      />
                    </li>
                  </Fragment>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

