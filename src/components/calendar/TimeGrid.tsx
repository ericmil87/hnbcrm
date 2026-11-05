import { useMemo, useEffect, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { TIME_SLOTS } from "./constants";
import { EventBlock } from "./EventBlock";

interface TimeGridEvent {
  _id: string;
  title: string;
  startTime: string;
  endTime: string;
  eventType: string;
  assignee?: { name: string; type: "human" | "ai" };
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

  const isToday = (checkDate: Date) => {
    const today = new Date();
    return (
      checkDate.getDate() === today.getDate() &&
      checkDate.getMonth() === today.getMonth() &&
      checkDate.getFullYear() === today.getFullYear()
    );
  };

  // Group events by column (day)
  const eventsByColumn = useMemo(() => {
    return columnDates.map((colDate) => {
      const colStart = new Date(colDate);
      colStart.setHours(0, 0, 0, 0);
      const colEnd = new Date(colDate);
      colEnd.setHours(23, 59, 59, 999);

      return events.filter((event) => {
        const eventStart = new Date(event.startTime);
        return eventStart >= colStart && eventStart <= colEnd;
      });
    });
  }, [columnDates, events]);

  // Calculate position for event block
  const getEventStyle = (event: TimeGridEvent) => {
    const startDate = new Date(event.startTime);
    const endDate = new Date(event.endTime);
    const startHour = startDate.getHours();
    const startMinute = startDate.getMinutes();
    const endHour = endDate.getHours();
    const endMinute = endDate.getMinutes();

    const top = ((startHour - 6) * 60 + startMinute) * (60 / 60); // pixels per minute
    const duration = (endHour - startHour) * 60 + (endMinute - startMinute);
    const height = Math.max(duration * (60 / 60), 30); // minimum 30px

    return { top: `${top}px`, height: `${height}px` };
  };

  // Current time indicator position
  const currentTimePosition = useMemo(() => {
    const hour = currentTime.getHours();
    const minute = currentTime.getMinutes();
    if (hour < 6 || hour >= 22) return null;
    return ((hour - 6) * 60 + minute) * (60 / 60);
  }, [currentTime]);

  return (
    <div className="flex-1 overflow-auto">
      <div className="flex">
        {/* Time labels column */}
        <div className="w-10 md:w-14 shrink-0 border-r border-border">
          <div className="h-12" /> {/* Header spacer */}
          {TIME_SLOTS.map((hour) => (
            <div key={hour} className="h-[60px] relative">
              <span className="absolute -top-2.5 right-1 md:right-2 text-caption md:text-xs text-text-muted tabular-nums">
                {hour.toString().padStart(2, "0")}:00
              </span>
            </div>
          ))}
        </div>

        {/* Grid columns */}
        {columnDates.map((colDate, colIndex) => (
          <TimeGridColumn
            key={colDate.toISOString()}
            date={colDate}
            events={eventsByColumn[colIndex]}
            onEventClick={onEventClick}
            onSlotClick={onSlotClick}
            getEventStyle={getEventStyle}
            isToday={isToday(colDate)}
            currentTimePosition={currentTimePosition}
            compact={columns > 1}
          />
        ))}
      </div>
    </div>
  );
}

interface TimeGridColumnProps {
  date: Date;
  events: TimeGridEvent[];
  onEventClick: (eventId: string, source: "event" | "task") => void;
  onSlotClick: (date: Date, hour: number, minute: number) => void;
  getEventStyle: (event: TimeGridEvent) => { top: string; height: string };
  isToday: boolean;
  currentTimePosition: number | null;
  compact?: boolean;
}

function TimeGridColumn({
  date,
  events,
  onEventClick,
  onSlotClick,
  getEventStyle,
  isToday,
  currentTimePosition,
  compact,
}: TimeGridColumnProps) {
  return (
    <div className="flex-1 relative min-w-0 border-r border-border last:border-r-0">
      {TIME_SLOTS.map((hour) => (
        <div key={hour}>
          <TimeSlot
            date={date}
            hour={hour}
            minute={0}
            onSlotClick={onSlotClick}
          />
          <TimeSlot
            date={date}
            hour={hour}
            minute={30}
            onSlotClick={onSlotClick}
            isHalfHour
          />
        </div>
      ))}

      {/* Event blocks */}
      <div className="absolute inset-0 pointer-events-none">
        <div className={cn("relative h-full pointer-events-auto", compact ? "px-px" : "px-1")}>
          {events.map((event) => {
            const style = getEventStyle(event);
            return (
              <div
                key={event._id}
                className={compact ? "absolute left-px right-px" : "absolute left-1 right-1"}
                style={{ top: style.top, height: style.height }}
              >
                <EventBlock event={event} onClick={() => onEventClick(event._id, event._source || "event")} compact={compact} />
              </div>
            );
          })}
        </div>
      </div>

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
  const slotId = `slot-${date.toISOString()}-${hour}-${minute}`;
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
