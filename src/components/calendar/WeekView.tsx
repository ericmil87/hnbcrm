import { useMemo } from "react";
import { TimeGrid } from "./TimeGrid";
import { WEEKDAYS_SHORT } from "./constants";
import { cn } from "@/lib/utils";

interface WeekViewEvent {
  _id: string;
  title: string;
  startTime: string;
  endTime: string;
  eventType: string;
  allDay?: boolean;
  assignee?: { name: string; type: "human" | "ai" };
  _source?: "event" | "task";
}

interface WeekViewProps {
  weekStart: Date;
  events: WeekViewEvent[];
  onEventClick: (eventId: string, source: "event" | "task") => void;
  onSlotClick: (date: Date, hour: number, minute: number) => void;
}

export function WeekView({ weekStart, events, onEventClick, onSlotClick }: WeekViewProps) {
  // Always generate all 7 days (Mon-Sun)
  const weekDates = useMemo(() => {
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      dates.push(d);
    }
    return dates;
  }, [weekStart]);

  const { allDayEventsByDay, timedEvents } = useMemo(() => {
    const allDayByDay: WeekViewEvent[][] = weekDates.map(() => []);
    const timed: WeekViewEvent[] = [];

    events.forEach((event) => {
      if (event.allDay) {
        const eventDate = new Date(event.startTime);
        const dayIndex = weekDates.findIndex((d) =>
          d.getDate() === eventDate.getDate() &&
          d.getMonth() === eventDate.getMonth() &&
          d.getFullYear() === eventDate.getFullYear()
        );
        if (dayIndex !== -1) {
          allDayByDay[dayIndex].push(event);
        }
      } else {
        timed.push(event);
      }
    });

    return { allDayEventsByDay: allDayByDay, timedEvents: timed };
  }, [events, weekDates]);

  const isToday = (checkDate: Date) => {
    const today = new Date();
    return (
      checkDate.getDate() === today.getDate() &&
      checkDate.getMonth() === today.getMonth() &&
      checkDate.getFullYear() === today.getFullYear()
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Week header with day columns */}
      <div className="flex border-b border-border bg-surface-raised">
        <div className="w-10 md:w-14 shrink-0 border-r border-border" /> {/* Time column spacer */}
        {weekDates.map((date) => (
          <div
            key={date.toISOString()}
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
              Dia Inteiro
            </div>
          </div>
          {allDayEventsByDay.map((dayEvents, index) => (
            <div
              key={weekDates[index].toISOString()}
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
