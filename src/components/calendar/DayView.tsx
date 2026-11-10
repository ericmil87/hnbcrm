import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { TimeGrid } from "./TimeGrid";
import { WEEKDAYS_SHORT } from "./constants";

interface DayViewEvent {
  _id: string;
  title: string;
  startTime: string;
  endTime: string;
  eventType: string;
  allDay?: boolean;
  assignee?: { name: string; type: "human" | "ai" };
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
      allDayEvents: events.filter((e) => e.allDay),
      timedEvents: events.filter((e) => !e.allDay),
    };
  }, [events]);

  // Generate 7 days centered on current date for mobile swipe strip
  const weekDates = useMemo(() => {
    const dates = [];
    for (let i = -3; i <= 3; i++) {
      const d = new Date(date);
      d.setDate(d.getDate() + i);
      dates.push(d);
    }
    return dates;
  }, [date]);

  const isToday = (checkDate: Date) => {
    const today = new Date();
    return (
      checkDate.getDate() === today.getDate() &&
      checkDate.getMonth() === today.getMonth() &&
      checkDate.getFullYear() === today.getFullYear()
    );
  };

  const isSameDay = (d1: Date, d2: Date) => {
    return (
      d1.getDate() === d2.getDate() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getFullYear() === d2.getFullYear()
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Mobile: horizontal date strip */}
      <div className="md:hidden flex justify-center gap-2 px-4 py-3 border-b border-border overflow-x-auto">
        {weekDates.map((d) => (
          <button
            key={d.toISOString()}
            onClick={() => onSelectDay(d)}
            className={cn(
              "flex flex-col items-center justify-center flex-1 h-[56px] rounded-lg transition-colors shrink-0",
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
          <div className="text-xs font-medium text-text-muted mb-1">Dia Inteiro</div>
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
