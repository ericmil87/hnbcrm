import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { EventDot } from "./EventDot";

interface DayCellProps {
  date: Date;
  events: Array<{
    _id: string;
    title: string;
    eventType: string;
    _source?: "event" | "task";
  }>;
  isToday: boolean;
  isCurrentMonth: boolean;
  onSelectDay: (date: Date) => void;
}

export function DayCell({ date, events, isToday, isCurrentMonth, onSelectDay }: DayCellProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `day-${date.toISOString()}`,
    data: { date },
  });

  const visibleEvents = events.slice(0, 3);
  const overflowCount = events.length - 3;

  return (
    <div
      ref={setNodeRef}
      onClick={() => onSelectDay(date)}
      className={cn(
        "min-h-[80px] md:min-h-[100px] border border-border p-2 cursor-pointer transition-colors",
        isCurrentMonth ? "bg-surface-raised" : "bg-surface-sunken",
        isToday && "bg-brand-500/10 border-brand-500",
        isOver && "bg-brand-500/5",
        "hover:bg-surface-overlay"
      )}
    >
      <div className={cn(
        "text-sm font-medium mb-1",
        isToday ? "text-brand-500" : isCurrentMonth ? "text-text-primary" : "text-text-muted"
      )}>
        {date.getDate()}
      </div>
      <div className="space-y-0.5">
        {visibleEvents.map((event) => (
          <EventDot
            key={event._id}
            eventType={event.eventType}
            isTask={event._source === "task"}
            title={event.title}
          />
        ))}
        {overflowCount > 0 && (
          <div className="text-caption text-text-muted font-medium">
            +{overflowCount} mais
          </div>
        )}
      </div>
    </div>
  );
}
