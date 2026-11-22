import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { addDays, isSameDay, localDateKey, overlapsDay } from "@/lib/agendaDates";
import { TimeGrid } from "./TimeGrid";
import { WEEKDAYS_SHORT } from "./constants";

interface DayViewEvent {
  _id: string;
  title: string;
  startTime: number;
  endTime: number;
  eventType: string;
  allDay?: boolean;
  assignee?: { name: string; type: "human" | "ai" } | null;
  _source?: "event" | "task";
}

interface DayViewProps {
  date: Date;
  events: DayViewEvent[];
  onEventClick: (eventId: string, source: "event" | "task") => void;
  onSlotClick: (date: Date, hour: number, minute: number) => void;
  onSelectDay: (date: Date) => void;
}

export function DayView({ date, events, onEventClick, onSlotClick, onSelectDay }: DayViewProps) {
  const { allDayEvents, timedEvents } = useMemo(() => {
    return {
      allDayEvents: events.filter((e) => e.allDay && overlapsDay(e.startTime, e.endTime, date)),
      timedEvents: events.filter((e) => !e.allDay),
    };
  }, [events, date]);

  // Generate 7 days centered on current date for mobile swipe strip
  const weekDates = useMemo(() => {
    const dates = [];
    for (let i = -3; i <= 3; i++) {
      dates.push(addDays(date, i));
    }
    return dates;
  }, [date]);

  const isToday = (checkDate: Date) => isSameDay(checkDate, new Date());

  return (
    <div className="flex flex-col h-full">
      {/* Mobile: horizontal date strip */}
      <div className="md:hidden flex justify-center gap-2 px-4 py-3 border-b border-border overflow-x-auto">
        {weekDates.map((d) => (
          <button
            key={localDateKey(d)}
            onClick={() => onSelectDay(d)}
            className={cn(
              "flex flex-col items-center justify-center flex-1 min-h-[56px] rounded-lg transition-colors shrink-0",
              isSameDay(d, date)
                ? "bg-brand-600 text-white"
                : "bg-surface-raised text-text-secondary hover:bg-surface-overlay"
            )}
          >
            <div className="text-xs font-medium">
              {WEEKDAYS_SHORT[d.getDay()]}
            </div>
            <div className={cn(
              "text-lg font-bold",
              isToday(d) && !isSameDay(d, date) && "text-brand-500"
            )}>
              {d.getDate()}
            </div>
          </button>
        ))}
      </div>

      {/* All-day events */}
      {allDayEvents.length > 0 && (
        <div className="px-4 py-2 border-b border-border bg-surface-raised">
          <div className="text-xs font-medium text-text-muted mb-1">Dia inteiro</div>
          <div className="space-y-1">
            {allDayEvents.map((event) => (
              <div
                key={event._id}
                onClick={() => onEventClick(event._id, event._source || "event")}
                className="text-sm px-2 py-1 rounded bg-surface-overlay border border-border cursor-pointer hover:bg-surface-sunken transition-colors"
              >
                {event.title}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Time grid */}
      <TimeGrid
        date={date}
        events={timedEvents}
        onEventClick={onEventClick}
        onSlotClick={onSlotClick}
      />
    </div>
  );
}
