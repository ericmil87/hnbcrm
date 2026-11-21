import { useMemo, useEffect, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { HOUR_HEIGHT_PX } from "./constants";
import { isSameDay, localDateKey } from "@/lib/agendaDates";
import { capClusterColumns, clipToDay, gridHourRange, layoutOverlaps, MIN_EVENT_MINUTES } from "@/lib/agendaLayout";
import { EventBlock } from "./EventBlock";
import { Modal } from "../ui/Modal";
import { formatTime } from "@/lib/format";

interface TimeGridEvent {
  _id: string;
  title: string;
  startTime: number;
  endTime: number;
  eventType: string;
  assignee?: { name: string; type: "human" | "ai" } | null;
  _source?: "event" | "task";
}

interface TimeGridProps {
  date: Date;
  events: TimeGridEvent[];
  onEventClick: (eventId: string, source: "event" | "task") => void;
  onSlotClick: (date: Date, hour: number, minute: number) => void;
  columns?: number; // For week view, number of columns
  columnDates?: Date[]; // For week view, the dates of each column
}

interface PlacedEvent {
  event: TimeGridEvent;
  startMin: number;
  endMin: number;
  column: number;
  columns: number;
}

/** Chip "+N" de um cluster com mais colunas que o limite visível. */
interface PlacedOverflow {
  key: string;
  events: TimeGridEvent[];
  startMin: number;
  endMin: number;
  column: number;
  columns: number;
}

interface ColumnLayout {
  placed: PlacedEvent[];
  overflow: PlacedOverflow[];
}

export function TimeGrid({
  date,
  events,
  onEventClick,
  onSlotClick,
  columns = 1,
  columnDates = [date],
}: TimeGridProps) {
  const [currentTime, setCurrentTime] = useState(new Date());

  // Update current time every minute
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  // Por coluna (dia): recorta cada evento ao dia (cruza a meia-noite / vários dias)
  // e reparte colunas entre os que se sobrepõem.
  const [overflowList, setOverflowList] = useState<PlacedOverflow | null>(null);

  const { placedByColumn, range } = useMemo(() => {
    const segments: Array<{ startMin: number; endMin: number }> = [];
    const placed: ColumnLayout[] = columnDates.map((colDate) => {
      const inputs: Array<{ id: string; startMin: number; endMin: number }> = [];
      const byId = new Map<string, TimeGridEvent>();
      for (const event of events) {
        const seg = clipToDay(event.startTime, event.endTime, colDate);
        if (!seg) continue;
        segments.push(seg);
        inputs.push({ id: event._id, ...seg });
        byId.set(event._id, event);
      }
      const { visible, overflow } = capClusterColumns(layoutOverlaps(inputs));
      return {
        placed: visible.map<PlacedEvent>((l) => ({
          event: byId.get(l.id)!,
          startMin: l.startMin,
          endMin: l.endMin,
          column: l.column,
          columns: l.columns,
        })),
        overflow: overflow.map<PlacedOverflow>((o) => ({
          key: `${localDateKey(colDate)}-${o.clusterId}`,
          events: o.hiddenIds.map((id) => byId.get(id)!),
          startMin: o.startMin,
          endMin: o.endMin,
          column: o.column,
          columns: o.columns,
        })),
      } satisfies ColumnLayout;
    });
    return { placedByColumn: placed, range: gridHourRange(segments) };
  }, [columnDates, events]);

  const hours = useMemo(
    () => Array.from({ length: range.endHour - range.startHour }, (_, i) => range.startHour + i),
    [range]
  );
  const pxPerMin = HOUR_HEIGHT_PX / 60;
  const gridStartMin = range.startHour * 60;

  // Posição da linha "agora" (null fora da janela desenhada).
  const nowMin = currentTime.getHours() * 60 + currentTime.getMinutes();
  const currentTimePosition =
    nowMin >= gridStartMin && nowMin < range.endHour * 60 ? (nowMin - gridStartMin) * pxPerMin : null;

  return (
    <div className="flex-1 overflow-auto">
      <div className="flex pt-3">
        {/* Time labels column: alinhada com as linhas (sem espaçador) */}
        <div className="w-10 md:w-14 shrink-0 border-r border-border">
          {hours.map((hour) => (
            <div key={hour} className="relative" style={{ height: HOUR_HEIGHT_PX }}>
              <span className="absolute -top-2.5 right-1 md:right-2 text-caption md:text-xs text-text-muted tabular-nums">
                {hour.toString().padStart(2, "0")}:00
              </span>
            </div>
          ))}
        </div>

        {/* Grid columns */}
        {columnDates.map((colDate, colIndex) => (
          <TimeGridColumn
            key={localDateKey(colDate)}
            date={colDate}
            hours={hours}
            layout={placedByColumn[colIndex]}
            onOverflowClick={setOverflowList}
            gridStartMin={gridStartMin}
            pxPerMin={pxPerMin}
            onEventClick={onEventClick}
            onSlotClick={onSlotClick}
            isToday={isSameDay(colDate, currentTime)}
            currentTimePosition={currentTimePosition}
            compact={columns > 1}
          />
        ))}
      </div>

      <Modal
        open={overflowList !== null}
        onClose={() => setOverflowList(null)}
        title="Eventos no mesmo horário"
      >
        <ul className="space-y-2">
          {overflowList?.events.map((event) => (
            <li key={event._id}>
              <button
                type="button"
                onClick={() => {
                  setOverflowList(null);
                  onEventClick(event._id, event._source || "event");
                }}
                className="flex w-full min-h-[44px] items-center gap-3 rounded-field border border-border bg-surface-raised px-3 text-left text-sm text-text-primary hover:bg-surface-overlay"
              >
                <span className="tabular-nums text-text-muted">{formatTime(event.startTime)}</span>
                <span className="min-w-0 flex-1 truncate">{event.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

interface TimeGridColumnProps {
  date: Date;
  hours: number[];
  layout: ColumnLayout;
  onOverflowClick: (overflow: PlacedOverflow) => void;
  gridStartMin: number;
  pxPerMin: number;
  onEventClick: (eventId: string, source: "event" | "task") => void;
  onSlotClick: (date: Date, hour: number, minute: number) => void;
  isToday: boolean;
  currentTimePosition: number | null;
  compact?: boolean;
}

function TimeGridColumn({
  date,
  hours,
  layout,
  onOverflowClick,
  gridStartMin,
  pxPerMin,
  onEventClick,
  onSlotClick,
  isToday,
  currentTimePosition,
  compact,
}: TimeGridColumnProps) {
  const pad = compact ? 1 : 4;
  const gridHeight = hours.length * HOUR_HEIGHT_PX;
  return (
    <div className="flex-1 relative min-w-0 border-r border-border last:border-r-0">
      {hours.map((hour) => (
        <div key={hour}>
          <TimeSlot date={date} hour={hour} minute={0} onSlotClick={onSlotClick} />
          <TimeSlot date={date} hour={hour} minute={30} onSlotClick={onSlotClick} isHalfHour />
        </div>
      ))}

      {/* Event blocks */}
      <div className="absolute inset-0 pointer-events-none">
        {layout.placed.map(({ event, startMin, endMin, column, columns }) => {
          const top = (startMin - gridStartMin) * pxPerMin;
          // Altura mínima de 30 min, sem passar do fim da grade.
          const height = Math.min(
            Math.max((endMin - startMin) * pxPerMin, MIN_EVENT_MINUTES * pxPerMin),
            Math.max(gridHeight - top, 1)
          );
          const widthPct = 100 / columns;
          return (
            <div
              key={event._id}
              className="absolute pointer-events-auto"
              style={{
                top,
                height,
                left: `calc(${column * widthPct}% + ${pad}px)`,
                width: `calc(${widthPct}% - ${pad * 2}px)`,
              }}
            >
              <EventBlock
                event={event}
                dragKey={localDateKey(date)}
                onClick={() => onEventClick(event._id, event._source || "event")}
                compact={compact || columns > 1}
              />
            </div>
          );
        })}
      </div>

      {layout.overflow.map((o) => {
        const top = (o.startMin - gridStartMin) * pxPerMin;
        const height = Math.min(
          Math.max((o.endMin - o.startMin) * pxPerMin, MIN_EVENT_MINUTES * pxPerMin),
          Math.max(gridHeight - top, 1)
        );
        const widthPct = 100 / o.columns;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onOverflowClick(o)}
            className="absolute z-[5] flex items-start justify-center rounded-sm border border-border bg-surface-overlay pt-1 text-caption font-medium text-text-secondary hover:bg-surface-sunken"
            style={{
              top,
              height,
              left: `calc(${o.column * widthPct}% + ${pad}px)`,
              width: `calc(${widthPct}% - ${pad * 2}px)`,
            }}
            aria-label={`Mais ${o.events.length} eventos neste horário`}
          >
            +{o.events.length}
          </button>
        );
      })}

      {/* Current time indicator */}
      {isToday && currentTimePosition !== null && (
        <div
          className="absolute left-0 right-0 h-0.5 bg-semantic-error pointer-events-none z-10"
          style={{ top: `${currentTimePosition}px` }}
        >
          <div className="absolute -left-1.5 -top-1.5 w-3 h-3 rounded-full bg-semantic-error" />
        </div>
      )}
    </div>
  );
}

interface TimeSlotProps {
  date: Date;
  hour: number;
  minute: number;
  onSlotClick: (date: Date, hour: number, minute: number) => void;
  isHalfHour?: boolean;
}

function TimeSlot({ date, hour, minute, onSlotClick, isHalfHour }: TimeSlotProps) {
  const slotId = `slot-${localDateKey(date)}-${hour}-${minute}`;
  const { setNodeRef, isOver } = useDroppable({
    id: slotId,
    data: { date, hour, minute },
  });

  return (
    <div
      ref={setNodeRef}
      onClick={() => onSlotClick(date, hour, minute)}
      className={cn(
        "h-[30px] border-b cursor-pointer transition-colors",
        isHalfHour ? "border-border-subtle" : "border-border",
        isOver && "bg-brand-500/10"
      )}
    />
  );
}
