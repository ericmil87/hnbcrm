import { useMemo } from "react";
import { TimeGrid } from "./TimeGrid";
import { WEEKDAYS_SHORT } from "./constants";
import { cn } from "@/lib/utils";
import { isSameDay, localDateKey, overlapsDay, weekDays } from "@/lib/agendaDates";

interface WeekViewEvent {
  _id: string;
  title: string;
  startTime: number;
  endTime: number;
  eventType: string;
  allDay?: boolean;
  assignee?: { name: string; type: "human" | "ai" } | null;
  _source?: "event" | "task";
}

interface WeekViewProps {
  weekStart: Date;
  events: WeekViewEvent[];
  onEventClick: (eventId: string, source: "event" | "task") => void;
  onSlotClick: (date: Date, hour: number, minute: number) => void;
}

export function WeekView({ weekStart, events, onEventClick, onSlotClick }: WeekViewProps) {
  // Sempre os 7 dias da semana de `weekStart` (início definido em agendaDates).
  const weekDates = useMemo(() => weekDays(weekStart), [weekStart]);

  const { allDayEventsByDay, timedEvents } = useMemo(() => {
    const allDayByDay: WeekViewEvent[][] = weekDates.map(() => []);
    const timed: WeekViewEvent[] = [];

    events.forEach((event) => {
      if (event.allDay) {
        weekDates.forEach((d, i) => {
          if (overlapsDay(event.startTime, event.endTime, d)) allDayByDay[i].push(event);
        });
      } else {
        timed.push(event);
      }
    });

    return { allDayEventsByDay: allDayByDay, timedEvents: timed };
  }, [events, weekDates]);

  const isToday = (checkDate: Date) => isSameDay(checkDate, new Date());

  return (
    <div className="flex flex-col h-full">
      {/* Week header with day columns */}
      <div className="flex border-b border-border bg-surface-raised">
        <div className="w-10 md:w-14 shrink-0 border-r border-border" /> {/* Time column spacer */}
        {weekDates.map((date) => (
          <div
            key={localDateKey(date)}
            className="flex-1 text-center py-1 md:py-2 border-r border-border last:border-r-0 min-w-0"
          >
            <div className="text-caption md:text-xs text-text-muted font-medium leading-tight">
              {WEEKDAYS_SHORT[date.getDay()]}
            </div>
            <div className={cn(
              "text-sm md:text-lg font-semibold tabular-nums leading-tight",
              isToday(date) ? "text-brand-500" : "text-text-primary"
            )}>
              {date.getDate()}
            </div>
          </div>
        ))}
      </div>

      {/* All-day events row */}
      {allDayEventsByDay.some((day) => day.length > 0) && (
        <div className="flex border-b border-border bg-surface-raised max-h-16 md:max-h-24 overflow-y-auto">
          <div className="w-10 md:w-14 shrink-0 border-r border-border px-0.5 md:px-1 py-1 md:py-2">
            <div className="text-[8px] md:text-caption text-text-muted font-medium leading-tight">
              Dia inteiro
            </div>
          </div>
          {allDayEventsByDay.map((dayEvents, index) => (
            <div
              key={localDateKey(weekDates[index])}
              className="flex-1 border-r border-border last:border-r-0 p-0.5 md:p-1 min-w-0"
            >
              <div className="space-y-0.5">
                {dayEvents.map((event) => (
                  <div
                    key={event._id}
                    onClick={() => onEventClick(event._id, event._source || "event")}
                    className="text-caption md:text-xs px-1 py-0.5 rounded bg-surface-overlay border border-border cursor-pointer hover:bg-surface-sunken transition-colors truncate"
                  >
                    {event.title}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Time grid with 7 columns */}
      <TimeGrid
        date={weekStart}
        events={timedEvents}
        onEventClick={onEventClick}
        onSlotClick={onSlotClick}
        columns={7}
        columnDates={weekDates}
      />
    </div>
  );
}
