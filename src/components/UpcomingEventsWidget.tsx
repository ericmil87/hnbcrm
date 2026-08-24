import { useState, useMemo } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import {
  EVENT_TYPE_COLORS,
  EVENT_TYPE_LABELS,
  WEEKDAYS_LONG,
} from "@/components/calendar/constants";
import {
  CalendarDays,
  ChevronRight,
  ChevronDown,
  Clock,
  MapPin,
  User,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

type TimeRange = "today" | "tomorrow" | "7d" | "30d";
type EventTypeFilter = "all" | "meeting" | "call" | "follow_up" | "demo" | "task";

const TIME_RANGE_PRESETS: { value: TimeRange; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "tomorrow", label: "Amanhã" },
  { value: "7d", label: "Próximos 7 Dias" },
  { value: "30d", label: "Próximo Mês" },
];

const EVENT_TYPE_FILTERS: { value: EventTypeFilter; label: string }[] = [
  { value: "meeting", label: "Reuniões" },
  { value: "call", label: "Ligações" },
  { value: "follow_up", label: "Follow-ups" },
  { value: "demo", label: "Demos" },
  { value: "task", label: "Tarefas" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get start-of-day and end-of-day timestamps for a date range preset. */
function computeDateRange(preset: TimeRange): { start: number; end: number } {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86_400_000;

  switch (preset) {
    case "today":
      return { start: todayStart, end: todayStart + dayMs - 1 };
    case "tomorrow":
      return { start: todayStart + dayMs, end: todayStart + 2 * dayMs - 1 };
    case "7d":
      return { start: todayStart, end: todayStart + 7 * dayMs - 1 };
    case "30d":
      return { start: todayStart, end: todayStart + 30 * dayMs - 1 };
  }
}

/** Format a timestamp to HH:MM in pt-BR locale. */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format duration between two timestamps (e.g. "1h30min"). */
function formatDuration(startTs: number, endTs: number): string {
  const diffMin = Math.round((endTs - startTs) / 60_000);
  if (diffMin <= 0) return "";
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  if (hours === 0) return `${mins}min`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h${mins}min`;
}

/** Get human-readable day group label from a date (HOJE, AMANHA, weekday, or date). */
function getDayGroupLabel(date: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);

  const diffMs = target.getTime() - today.getTime();
  const diffDays = Math.round(diffMs / 86_400_000);

  if (diffDays === 0) return "HOJE";
  if (diffDays === 1) return "AMANHÃ";
  if (diffDays >= 2 && diffDays <= 6) return WEEKDAYS_LONG[target.getDay()].toUpperCase();

  return target.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).toUpperCase();
}

/** Get a sortable date key (YYYY-MM-DD) from a timestamp. */
function dateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

interface DayGroup {
  key: string;
  label: string;
  events: any[];
}

function groupEventsByDay(events: any[]): DayGroup[] {
  const map = new Map<string, { label: string; events: any[] }>();

  for (const event of events) {
    const ts = event.startTime;
    const key = dateKey(ts);
    if (!map.has(key)) {
      map.set(key, { label: getDayGroupLabel(new Date(ts)), events: [] });
    }
    map.get(key)!.events.push(event);
  }

  // Sort groups by date key ascending
  const sorted = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return sorted.map(([key, { label, events: evts }]) => ({
    key,
    label,
    events: evts.sort((a: any, b: any) => a.startTime - b.startTime),
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UpcomingEventsWidget({
  organizationId,
}: {
  organizationId: Id<"organizations">;
}) {
  const navigate = useNavigate();

  // Filter state
  const [timeRange, setTimeRange] = useState<TimeRange>("7d");
  const [eventTypeFilter, setEventTypeFilter] = useState<EventTypeFilter>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(() => new Set());

  // Compute timestamps from preset
  const { start, end } = useMemo(() => computeDateRange(timeRange), [timeRange]);

  // Queries
  const rawEvents = useQuery(api.calendar.getEvents, {
    organizationId,
    startDate: start,
    endDate: end,
    eventType: eventTypeFilter !== "all" ? (eventTypeFilter as any) : undefined,
    assignedTo: assigneeFilter !== "all" && assigneeFilter !== "mine"
      ? (assigneeFilter as Id<"teamMembers">)
      : undefined,
    includeTasks: true,
  });

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  const currentMember = useQuery(api.teamMembers.getCurrentTeamMember, { organizationId });

  // Client-side filter for "Meus Eventos"
  const events = useMemo(() => {
    if (!rawEvents) return undefined;
    let filtered = rawEvents;
    // Filter cancelled events
    filtered = filtered.filter((e: any) => e.status !== "cancelled");
    if (assigneeFilter === "mine" && currentMember) {
      filtered = filtered.filter((e: any) => e.assignedTo === currentMember._id);
    }
    return filtered;
  }, [rawEvents, assigneeFilter, currentMember]);

  const dayGroups = useMemo(() => {
    if (!events) return [];
    return groupEventsByDay(events);
  }, [events]);

  const hasActiveFilters =
    timeRange !== "7d" || eventTypeFilter !== "all" || assigneeFilter !== "all";

  const clearFilters = () => {
    setTimeRange("7d");
    setEventTypeFilter("all");
    setAssigneeFilter("all");
  };

  const toggleGroup = (key: string) => {
    setExpandedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleEventClick = (event: any) => {
    // Navigate to calendar page — the calendar page will show the day
    const eventDate = new Date(event.startTime);
    const dateStr = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, "0")}-${String(eventDate.getDate()).padStart(2, "0")}`;
    navigate(`/app/calendario?date=${dateStr}&event=${event._id}`);
  };

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-text-primary">Próximos Eventos</h3>
        <button
          onClick={() => navigate("/app/calendario")}
          className="flex items-center gap-1 text-sm text-brand-500 hover:text-brand-400 transition-colors font-medium"
        >
          Ver calendário
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Filter bar */}
      <div className="space-y-2 mb-4">
        {/* Time range presets */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {TIME_RANGE_PRESETS.map((preset) => (
            <button
              key={preset.value}
              onClick={() => setTimeRange(preset.value)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                timeRange === preset.value
                  ? "bg-brand-500/20 text-brand-400"
                  : "bg-surface-overlay text-text-secondary hover:text-text-primary"
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {/* Event type filter pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {EVENT_TYPE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              onClick={() => setEventTypeFilter(eventTypeFilter === filter.value ? "all" : filter.value)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                eventTypeFilter === filter.value
                  ? "bg-brand-500/20 text-brand-400"
                  : "bg-surface-overlay text-text-secondary hover:text-text-primary"
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {/* Assignee filter */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <button
            onClick={() => setAssigneeFilter("all")}
            className={cn(
              "px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
              assigneeFilter === "all"
                ? "bg-brand-500/20 text-brand-400"
                : "bg-surface-overlay text-text-secondary hover:text-text-primary"
            )}
          >
            Todos
          </button>
          <button
            onClick={() => setAssigneeFilter("mine")}
            className={cn(
              "px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
              assigneeFilter === "mine"
                ? "bg-brand-500/20 text-brand-400"
                : "bg-surface-overlay text-text-secondary hover:text-text-primary"
            )}
          >
            Meus Eventos
          </button>
          {teamMembers?.map((member: any) => (
            <button
              key={member._id}
              onClick={() => setAssigneeFilter(member._id)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                assigneeFilter === member._id
                  ? "bg-brand-500/20 text-brand-400"
                  : "bg-surface-overlay text-text-secondary hover:text-text-primary"
              )}
            >
              {member.name.split(" ")[0]}
            </button>
          ))}
        </div>
      </div>

      {/* Loading skeleton */}
      {events === undefined && (
        <div className="divide-y divide-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-3">
              <Skeleton className="h-1 w-1 rounded-full shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-32 rounded" />
                <Skeleton className="h-3 w-48" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="h-8 w-8 rounded-full shrink-0" />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {events && events.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 px-4">
          <div className="w-12 h-12 rounded-xl bg-surface-overlay flex items-center justify-center mb-3">
            <CalendarDays size={24} className="text-text-muted" />
          </div>
          <p className="text-sm font-medium text-text-primary mb-1">
            Nenhum evento encontrado
          </p>
          <p className="text-xs text-text-muted text-center">
            {hasActiveFilters
              ? "Tente ajustar os filtros."
              : "Os eventos aparecerão aqui conforme forem agendados."}
          </p>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" className="mt-3" onClick={clearFilters}>
              Limpar filtros
            </Button>
          )}
        </div>
      )}

      {/* Day-grouped event list */}
      {events && events.length > 0 && (
        <>
          {dayGroups.map((group) => {
            // Groups with many events can be collapsed
            const isCollapsible = group.events.length > 5;
            const isCollapsed = isCollapsible && !expandedGroupKeys.has(group.key);
            const visibleEvents = isCollapsed
              ? group.events.slice(0, 5)
              : group.events;

            return (
              <div key={group.key}>
                {/* Day group header */}
                <div className="flex items-center gap-3 py-2">
                  <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                    {group.label}
                  </span>
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-[10px] text-text-muted">
                    {group.events.length} {group.events.length === 1 ? "evento" : "eventos"}
                  </span>
                </div>

                {/* Events in group */}
                <div className="divide-y divide-border">
                  {visibleEvents.map((event: any) => {
                    const typeColor =
                      EVENT_TYPE_COLORS[event.eventType] || EVENT_TYPE_COLORS.other;
                    const typeLabel =
                      EVENT_TYPE_LABELS[event.eventType] || event.eventType;
                    const isTask = event._source === "task";
                    const duration = !isTask
                      ? formatDuration(event.startTime, event.endTime)
                      : "";

                    return (
                      <button
                        key={event._id}
                        onClick={() => handleEventClick(event)}
                        className="w-full text-left flex items-center gap-3 py-3 hover:bg-surface-overlay transition-colors cursor-pointer rounded-lg px-1"
                      >
                        {/* Vertical color bar */}
                        <div
                          className={cn(
                            "w-1 self-stretch rounded-full shrink-0",
                            typeColor.bg,
                            typeColor.border,
                            "border-l-4"
                          )}
                          style={{ minHeight: "2rem" }}
                        />

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          {/* Top row: time + type badge */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-medium text-text-secondary tabular-nums flex items-center gap-1">
                              <Clock size={12} className="text-text-muted" />
                              {event.allDay
                                ? "Dia inteiro"
                                : formatTime(event.startTime)}
                              {duration && (
                                <span className="text-text-muted">
                                  ({duration})
                                </span>
                              )}
                            </span>
                            <Badge
                              className={cn(
                                "text-[10px]",
                                typeColor.bg,
                                typeColor.text
                              )}
                            >
                              {typeLabel}
                            </Badge>
                          </div>

                          {/* Title */}
                          <p className="font-medium text-text-primary text-sm mt-0.5 truncate">
                            {event.title}
                          </p>

                          {/* Location + lead indicator */}
                          <div className="flex items-center gap-2 mt-0.5">
                            {event.location && (
                              <span className="text-xs text-text-muted flex items-center gap-0.5 truncate">
                                <MapPin size={10} />
                                {event.location}
                              </span>
                            )}
                            {event.lead && (
                              <span className="text-xs text-text-muted flex items-center gap-0.5 truncate">
                                <User size={10} />
                                {event.lead.title}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Assignee avatar */}
                        {event.assignee && (
                          <Avatar
                            name={event.assignee.name}
                            type={event.assignee.type === "ai" ? "ai" : "human"}
                            size="sm"
                            className="shrink-0"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Show more / less toggle */}
                {isCollapsible && (
                  <button
                    onClick={() => toggleGroup(group.key)}
                    className="w-full flex items-center justify-center gap-1 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
                  >
                    <ChevronDown
                      size={14}
                      className={cn(
                        "transition-transform duration-200",
                        !isCollapsed && "rotate-180"
                      )}
                    />
                    {isCollapsed
                      ? `Mostrar mais ${group.events.length - 5} eventos`
                      : "Mostrar menos"}
                  </button>
                )}
              </div>
            );
          })}

          {/* Footer */}
          <div className="pt-3 border-t border-border mt-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => navigate("/app/calendario")}
            >
              Ver todos no calendário
              <ChevronRight size={14} />
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
