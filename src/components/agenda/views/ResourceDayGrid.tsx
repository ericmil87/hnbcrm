import { AlertTriangle, CalendarDays, CheckSquare, DoorOpen, Lock, MoreVertical, Plus, UserRound } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { AppointmentOriginBadge } from "@/components/agenda/AppointmentOriginBadge";
import { APPOINTMENT_STATUS_ICON } from "@/components/agenda/AppointmentStatusChip";
import { VacancyIndicator } from "@/components/agenda/VacancyIndicator";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { fillVocab } from "@/lib/agendaCopy";
import {
  appointmentLabel,
  blockGeometry,
  gridHeight,
  HOUR_PX,
  hourLabels,
  minuteFromOffset,
  nowLineTop,
  type DayGridModel,
  type DayResource,
  type GridColumn,
  type GridItem,
  type InternalItem,
  type PlacedItem,
} from "@/lib/agendaGrid";
import { statusMeta, vacancyOf } from "@/lib/agendaStatus";
import type { AppointmentStatus } from "@/lib/agendaTypes";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { minutesLabel, zonedRangeLabel, zonedTimeLabel } from "@/lib/agendaZone";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";

const t = VIEWS_COPY.grid;

/** Ação do menu da coluna; o contêiner decide o que cada uma abre. */
export type ColumnAction = "book" | "closeToday" | "closePeriod" | "reopen";

export interface ResourceDayGridProps {
  model: DayGridModel;
  tz: string;
  /** Rótulo do agrupamento para o leitor de tela ("sala" ou "profissional"). */
  groupLabel: string;
  canBook: boolean;
  /** `agenda:edit`: fechar e abrir recurso no dia. */
  canClose: boolean;
  /** Mostra só estas colunas (celular: uma por vez). */
  visibleKeys?: readonly string[];
  onSlotClick: (resource: DayResource | null, minute: number) => void;
  onAppointmentClick: (appointmentId: string) => void;
  onInternalClick: (item: InternalItem) => void;
  onColumnAction: (resource: DayResource, action: ColumnAction) => void;
  className?: string;
}

const HATCH = {
  backgroundImage: "repeating-linear-gradient(135deg, var(--border-default) 0 1px, transparent 1px 9px)",
} as const;

const KIND_ICON = { room: DoorOpen, person: UserRound, equipment: DoorOpen } as const;

function apptAria(item: Extract<GridItem, { kind: "appointment" }>, tz: string): string {
  const a = item.appointment;
  const place = a.resources.filter((r) => r.allocated).map((r) => r.name).join(", ");
  return [
    zonedRangeLabel(a.startTime, a.endTime, tz),
    appointmentLabel(a),
    a.serviceName,
    statusMeta(a.status).label,
    place,
    item.conflict ? t.conflictMark : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function ColumnHeader({
  col,
  canBook,
  canClose,
  onColumnAction,
}: {
  col: GridColumn;
  canBook: boolean;
  canClose: boolean;
  onColumnAction: ResourceDayGridProps["onColumnAction"];
}) {
  const r = col.resource;
  const Icon = col.kind === "internal" ? CalendarDays : r ? KIND_ICON[r.kind] : DoorOpen;
  const v = vacancyOf(col.load.used, col.capacity);
  const showVacancy = col.kind === "resource" && (col.capacity > 1 || v.over);
  const items: MenuItem[] = [];
  if (r && canBook && !col.closed) {
    items.push({ id: "book", label: t.bookHere, icon: <Plus size={16} aria-hidden="true" />, onSelect: () => onColumnAction(r, "book") });
  }
  if (r && canClose) {
    if (col.closed) {
      items.push({ id: "reopen", label: VOCAB.scheduling.openToday, icon: <DoorOpen size={16} aria-hidden="true" />, onSelect: () => onColumnAction(r, "reopen") });
    } else {
      items.push({ id: "close-today", label: VOCAB.scheduling.closeToday, icon: <Lock size={16} aria-hidden="true" />, onSelect: () => onColumnAction(r, "closeToday") });
    }
    items.push({ id: "close-period", label: t.closePeriod, icon: <Lock size={16} aria-hidden="true" />, onSelect: () => onColumnAction(r, "closePeriod") });
  }
  return (
    <div className="flex min-h-[3.25rem] items-start gap-1.5 border-l border-border-subtle px-2 py-1.5">
      <Icon size={16} className="mt-0.5 shrink-0 text-text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-text-primary">{col.label}</p>
        <div className="flex flex-wrap items-center gap-1">
          {showVacancy && (
            <span className="inline-flex items-center gap-1">
              <VacancyIndicator used={col.load.used} capacity={col.capacity} />
              <span className="sr-only">{fillVocab(col.load.basis === "now" ? t.loadNow : t.loadPeak, { label: v.label })}</span>
            </span>
          )}
          {col.closed && (
            <span className="inline-flex items-center gap-1 rounded-full bg-semantic-error/10 px-2 py-0.5 text-xs font-medium text-semantic-error">
              <Lock size={12} aria-hidden="true" />
              {col.kind === "resource" && r?.kind === "room" ? t.closed : t.closedGeneric}
            </span>
          )}
        </div>
        {col.closed && col.closedReason && <p className="truncate text-caption text-text-muted">{col.closedReason}</p>}
      </div>
      {items.length > 0 && (
        <Menu
          ariaLabel={fillVocab(t.columnMenu, { nome: col.label })}
          items={items}
          trigger={(props) => (
            <button
              type="button"
              {...props}
              aria-label={fillVocab(t.columnMenu, { nome: col.label })}
              className="flex h-8 w-8 coarse:h-11 coarse:w-11 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-surface-overlay hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <MoreVertical size={16} aria-hidden="true" />
            </button>
          )}
        />
      )}
    </div>
  );
}

function Block({
  placed,
  windowStartHour,
  children,
  className,
  onClick,
  ariaLabel,
}: {
  placed: PlacedItem;
  windowStartHour: number;
  children: ReactNode;
  className: string;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const { top, height } = blockGeometry(placed.item.startMin, placed.item.endMin, windowStartHour);
  const style = {
    top,
    height: Math.max(height - 2, 18),
    left: `calc(${(placed.column / placed.columns) * 100}% + 2px)`,
    width: `calc(${100 / placed.columns}% - 4px)`,
  };
  const base = "absolute overflow-hidden rounded-field px-1.5 py-1 text-left text-xs";
  if (!onClick) {
    return (
      <div style={style} className={cn(base, className)} aria-label={ariaLabel} role={ariaLabel ? "img" : undefined}>
        {children}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={style}
      aria-label={ariaLabel}
      className={cn(
        base,
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 hover:brightness-110 transition",
        className
      )}
    >
      {children}
    </button>
  );
}

function PlacedBlock({
  placed,
  windowStartHour,
  tz,
  onAppointmentClick,
  onInternalClick,
}: {
  placed: PlacedItem;
  windowStartHour: number;
  tz: string;
  onAppointmentClick: (id: string) => void;
  onInternalClick: (item: InternalItem) => void;
}) {
  const item = placed.item;
  if (item.kind === "busy") {
    return (
      <Block placed={placed} windowStartHour={windowStartHour} className="border border-border-subtle bg-surface-overlay text-text-muted" ariaLabel={t.busy}>
        <span className="flex items-center gap-1">
          <Lock size={12} aria-hidden="true" />
          <span className="truncate">{t.busy}</span>
        </span>
      </Block>
    );
  }
  if (item.kind === "internal") {
    const e = item.internal;
    const Icon = e.source === "task" ? CheckSquare : CalendarDays;
    return (
      <Block
        placed={placed}
        windowStartHour={windowStartHour}
        onClick={() => onInternalClick(e)}
        ariaLabel={`${e.source === "task" ? t.task : t.event}, ${zonedTimeLabel(e.startTime, tz)}, ${e.title}`}
        className="border border-dashed border-ai-500 bg-ai-500/10 text-text-primary"
      >
        <span className="flex items-center gap-1 text-ai-400">
          <Icon size={12} aria-hidden="true" />
          <span className="truncate font-medium tabular-nums">{zonedTimeLabel(e.startTime, tz)}</span>
        </span>
        <span className="block truncate leading-tight">{e.title}</span>
      </Block>
    );
  }
  const a = item.appointment;
  const meta = statusMeta(a.status);
  const Icon = APPOINTMENT_STATUS_ICON[a.status as AppointmentStatus] ?? APPOINTMENT_STATUS_ICON.scheduled;
  return (
    <Block
      placed={placed}
      windowStartHour={windowStartHour}
      onClick={() => onAppointmentClick(a._id)}
      ariaLabel={apptAria(item, tz)}
      className={cn(meta.blockClassName, "text-text-primary")}
    >
      <span className="flex items-center gap-1">
        <Icon size={12} className="shrink-0" aria-hidden="true" />
        <span className="truncate font-medium tabular-nums">{zonedTimeLabel(a.startTime, tz)}</span>
        {item.conflict && <AlertTriangle size={12} className="shrink-0 text-semantic-warning" aria-hidden="true" />}
        <span className="ml-auto shrink-0">
          <AppointmentOriginBadge origin={a.origin} compact className="px-1 py-0" />
        </span>
      </span>
      <span className="block truncate font-medium leading-tight">{appointmentLabel(a)}</span>
      <span className="block truncate text-text-secondary leading-tight">{a.serviceName}</span>
    </Block>
  );
}

/**
 * Dia por recurso (computador e tablet): uma coluna por sala ou profissional, eixo de horas do expediente,
 * faixas lado a lado até a capacidade (sala dupla), coluna fechada hachurada, fora do expediente esmaecido,
 * linha do "agora". Toque ou clique num vazio marca horário ali; o menu da coluna é o caminho por teclado.
 * Sem arrasto. Apresentacional: o contêiner entrega o modelo pronto (`buildDayGridModel`).
 */
export function ResourceDayGrid({
  model,
  tz,
  groupLabel,
  canBook,
  canClose,
  visibleKeys,
  onSlotClick,
  onAppointmentClick,
  onInternalClick,
  onColumnAction,
  className,
}: ResourceDayGridProps) {
  const columns = visibleKeys ? model.columns.filter((c) => visibleKeys.includes(c.key)) : model.columns;
  const height = gridHeight(model.window);
  const nowTop = nowLineTop(model.nowMin, model.window);
  const hours = hourLabels(model.window);
  const template = { gridTemplateColumns: `3.5rem repeat(${columns.length}, minmax(9.5rem, 1fr))` };

  const clickColumn = (col: GridColumn, e: MouseEvent<HTMLDivElement>) => {
    if (!canBook || col.closed || col.kind === "internal") return;
    const rect = e.currentTarget.getBoundingClientRect();
    onSlotClick(col.resource, minuteFromOffset(e.clientY - rect.top, model.window.startHour, model.window.endHour));
  };

  return (
    <div className={cn("overflow-x-auto rounded-card border border-border bg-surface-raised", className)}>
      <div role="group" aria-label={fillVocab(t.ariaLabel, { por: groupLabel })} className="min-w-fit">
        <div className="grid border-b border-border bg-surface-raised" style={template}>
          <div aria-hidden="true" />
          {columns.map((col) => (
            <ColumnHeader key={`head:${col.key}`} col={col} canBook={canBook} canClose={canClose} onColumnAction={onColumnAction} />
          ))}
        </div>

        <div className="relative grid" style={template}>
          <div className="relative" style={{ height }} aria-hidden="true">
            {hours.map((h, i) => (
              <span
                key={`hour:${h}`}
                className="absolute right-2 -translate-y-1/2 text-caption tabular-nums text-text-muted"
                style={{ top: i * HOUR_PX, ...(i === 0 ? { transform: "translateY(2px)" } : {}) }}
              >
                {minutesLabel(h * 60)}
              </span>
            ))}
          </div>
          {columns.map((col) => (
            <div
              key={`col:${col.key}`}
              role="group"
              aria-label={col.label}
              className={cn("relative border-l border-border-subtle", canBook && !col.closed && col.kind !== "internal" && "cursor-pointer")}
              style={{ height }}
              onClick={(e) => clickColumn(col, e)}
            >
              {hours.map((h, i) => (
                <div key={`line:${h}`} aria-hidden="true" className="absolute inset-x-0 border-t border-border-subtle" style={{ top: i * HOUR_PX }} />
              ))}
              {col.offHours.map((s) => (
                <div
                  key={`off:${s.startMin}`}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bg-surface-sunken/70"
                  style={{ top: blockGeometry(s.startMin, s.endMin, model.window.startHour).top, height: ((s.endMin - s.startMin) / 60) * HOUR_PX }}
                />
              ))}
              {col.blocked.map((s) => (
                <div
                  key={`blk:${s.startMin}`}
                  className="pointer-events-none absolute inset-x-0 flex items-start justify-center bg-surface-sunken/70 pt-1 text-caption text-text-muted"
                  style={{ ...HATCH, top: blockGeometry(s.startMin, s.endMin, model.window.startHour).top, height: ((s.endMin - s.startMin) / 60) * HOUR_PX }}
                >
                  <span className="rounded-full bg-surface-raised px-2">{t.blocked}</span>
                </div>
              ))}
              {col.closed && (
                <div className="pointer-events-none absolute inset-0 bg-surface-sunken/60" style={HATCH} aria-hidden="true" />
              )}
              {col.closed && (
                <div className="pointer-events-none absolute inset-x-1 top-2 flex flex-col items-center rounded-field bg-surface-raised px-2 py-1 text-center shadow-card">
                  <span className="flex items-center gap-1 text-xs font-semibold text-text-primary">
                    <Lock size={12} aria-hidden="true" />
                    {col.resource?.kind === "room" ? t.closed : t.closedGeneric}
                  </span>
                  {col.closedReason && <span className="text-caption text-text-secondary">{col.closedReason}</span>}
                </div>
              )}
              {col.placed.map((p) => (
                <PlacedBlock
                  key={`blk:${p.item.id}`}
                  placed={p}
                  windowStartHour={model.window.startHour}
                  tz={tz}
                  onAppointmentClick={onAppointmentClick}
                  onInternalClick={onInternalClick}
                />
              ))}
            </div>
          ))}
          {nowTop !== null && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
              style={{ top: nowTop }}
            >
              <span className="rounded-full bg-semantic-error px-1.5 text-micro font-semibold text-white">{t.now}</span>
              <span className="h-px flex-1 bg-semantic-error" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
