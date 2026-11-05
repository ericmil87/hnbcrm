import { useDraggable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { EVENT_TYPE_COLORS } from "./constants";
import { Avatar } from "../ui/Avatar";

interface EventBlockProps {
  event: {
    _id: string;
    title: string;
    startTime: string;
    endTime: string;
    eventType: string;
    assignee?: { name: string; type: "human" | "ai" };
    _source?: "event" | "task";
  };
  onClick: () => void;
  compact?: boolean; // For narrow columns (week view on mobile)
}

export function EventBlock({ event, onClick, compact }: EventBlockProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: event._id,
    data: event,
  });

  const colors = EVENT_TYPE_COLORS[event.eventType] || EVENT_TYPE_COLORS.other;
  const startDate = new Date(event.startTime);
  const isTask = event._source === "task";

  const timeString = `${startDate.getHours().toString().padStart(2, "0")}:${startDate.getMinutes().toString().padStart(2, "0")}`;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={`${timeString} ${event.title}`}
      className={cn(
        "rounded border cursor-pointer transition-all h-full overflow-hidden",
        compact ? "rounded-sm px-0.5 py-0.5 text-caption" : "rounded-lg px-2 py-1 text-xs",
        colors.bg,
        colors.border,
        isTask && "border-dashed",
        isDragging && "opacity-50",
        "hover:shadow-md hover:scale-[1.02]"
      )}
    >
      {compact ? (
        // Compact mode: just time + truncated title, no avatar
        <div className="min-w-0">
          <div className={cn("font-medium truncate leading-tight", colors.text)}>
            {timeString}
          </div>
          <div className="text-text-primary truncate leading-tight">
            {event.title}
          </div>
        </div>
      ) : (
        // Full mode: time + title + avatar
        <div className="flex items-start gap-1.5 min-h-0">
          <div className="flex-1 min-w-0">
            <div className={cn("font-medium truncate", colors.text)}>
              {timeString}
            </div>
            <div className="text-text-primary truncate text-caption leading-tight">
              {event.title}
            </div>
          </div>
          {event.assignee && (
            <Avatar
              name={event.assignee.name}
              type={event.assignee.type}
              size="sm"
            />
          )}
        </div>
      )}
    </div>
  );
}
