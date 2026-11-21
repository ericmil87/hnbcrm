import { useMemo } from "react";
import { DayCell } from "./DayCell";
import { WEEKDAYS_SHORT_ORDERED } from "./constants";
import { isSameDay, localDateKey, monthGridDays, overlapsDay } from "@/lib/agendaDates";

interface MonthViewEvent {
  _id: string;
  title: string;
  startTime: number;
  endTime: number;
  eventType: string;
  _source?: "event" | "task";
}

interface MonthViewProps {
  currentDate: Date;
  events: MonthViewEvent[];
  onEventClick: (eventId: string, source: "event" | "task") => void;
  onSelectDay: (date: Date) => void;
}

export function MonthView({ currentDate, events, onSelectDay }: MonthViewProps) {
  // 6 semanas (42 dias) a partir do início da semana do dia 1.
  const calendarDays = useMemo(() => monthGridDays(currentDate), [currentDate]);

  // Agrupa por dia local; evento de vários dias aparece em todos os dias que cobre.
  const eventsByDay = useMemo(() => {
    const grouped = new Map<string, MonthViewEvent[]>();
    for (const day of calendarDays) {
      grouped.set(
        localDateKey(day),
        events.filter((e) => overlapsDay(e.startTime, e.endTime, day))
      );
    }
    return grouped;
  }, [calendarDays, events]);

  const today = new Date();
  const isToday = (date: Date) => isSameDay(date, today);

  const isCurrentMonth = (date: Date) => {
    return date.getMonth() === currentDate.getMonth();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Weekday headers */}
      <div className="grid grid-cols-7 border-b border-border bg-surface-raised">
        {WEEKDAYS_SHORT_ORDERED.map((day) => (
          <div
            key={day}
            className="text-center py-2 text-xs font-medium text-text-muted border-r border-border last:border-r-0"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 flex-1 overflow-auto">
        {calendarDays.map((day) => (
          <DayCell
            key={localDateKey(day)}
            date={day}
            events={eventsByDay.get(localDateKey(day)) || []}
            isToday={isToday(day)}
            isCurrentMonth={isCurrentMonth(day)}
            onSelectDay={onSelectDay}
          />
        ))}
      </div>
    </div>
  );
}
