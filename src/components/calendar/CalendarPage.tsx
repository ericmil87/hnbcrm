import { useState, useMemo } from "react";
import { useOutletContext } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { AppOutletContext } from "../layout/AuthLayout";
import { DndContext, DragOverlay, PointerSensor, TouchSensor, useSensor, useSensors, DragEndEvent } from "@dnd-kit/core";
import { useMutation } from "convex/react";
import { Id } from "../../../convex/_generated/dataModel";
import { Plus } from "lucide-react";
import { useCalendarState } from "./useCalendarState";
import { CalendarHeader } from "./CalendarHeader";
import { MonthView } from "./MonthView";
import { WeekView } from "./WeekView";
import { DayView } from "./DayView";
import { CalendarEventModal } from "./CalendarEventModal";
import { EventDetailSlideOver } from "./EventDetailSlideOver";
import { TaskDetailSlideOver } from "./TaskDetailSlideOver";
import { EventBlock } from "./EventBlock";
import type { CalendarEventType } from "./constants";
import { Spinner } from "../ui/Spinner";
import { toast } from "sonner";

export function CalendarPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const {
    view,
    setView,
    currentDate,
    dateRange,
    navigatePrev,
    navigateNext,
    goToToday,
    selectDay,
  } = useCalendarState();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editEventId, setEditEventId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedEventSource, setSelectedEventSource] = useState<"event" | "task" | null>(null);
  const [initialDate, setInitialDate] = useState<Date | undefined>();
  const [initialHour, setInitialHour] = useState<number | undefined>();
  const [initialMinute, setInitialMinute] = useState<number | undefined>();
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [selectedEventTypes, setSelectedEventTypes] = useState<CalendarEventType[]>([]);
  const [activeEvent, setActiveEvent] = useState<any>(null);

  const events = useQuery(api.calendar.getEvents, {
    organizationId,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    includeTasks: true,
    assignedTo: selectedMemberId ? (selectedMemberId as Id<"teamMembers">) : undefined,
    eventType: selectedEventTypes.length > 0 ? selectedEventTypes[0] : undefined,
  });

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });

  const rescheduleEvent = useMutation(api.calendar.rescheduleEvent);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    })
  );

  // Filter events client-side for multiple event types
  const filteredEvents = useMemo(() => {
    if (!events) return [];
    if (selectedEventTypes.length === 0) return events;
    return events.filter((event) => selectedEventTypes.includes(event.eventType));
  }, [events, selectedEventTypes]);

  const handleDragStart = (event: any) => {
    setActiveEvent(event.active.data.current);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveEvent(null);
    const { active, over } = event;

    if (!over) return;

    const eventData = active.data.current;
    const eventId = eventData?._id;

    if (!eventId) return;

    // Prevent dragging tasks
    if (eventData._source === "task") {
      toast.error("Tarefas não podem ser arrastadas no calendário. Edite na página de Tarefas.");
      return;
    }

    // Handle drop on day cell (month view)
    if (over.id.toString().startsWith("day-")) {
      const targetDate = over.data.current?.date as Date;
      if (!targetDate) return;

      const originalStart = new Date(eventData.startTime);
      const newStart = new Date(targetDate);
      newStart.setHours(originalStart.getHours(), originalStart.getMinutes());

      try {
        await rescheduleEvent({
          eventId: eventId as Id<"calendarEvents">,
          newStartTime: newStart.getTime(),
        });
        toast.success("Evento reagendado!");
      } catch (error) {
        toast.error("Erro ao reagendar evento");
        console.error(error);
      }
      return;
    }

    // Handle drop on time slot
    if (over.id.toString().startsWith("slot-")) {
      // O dnd-kit tipa `data.current` como AnyData: o formato é o que o
      // droppable do TimeGrid publica ({ date, hour, minute }).
      const slot = over.data.current as
        | { date?: Date; hour?: number; minute?: number }
        | undefined;
      const { date, hour, minute } = slot ?? {};
      if (!date || hour === undefined || minute === undefined) return;

      const newStart = new Date(date);
      newStart.setHours(hour, minute, 0, 0);

      try {
        await rescheduleEvent({
          eventId: eventId as Id<"calendarEvents">,
          newStartTime: newStart.getTime(),
        });
        toast.success("Evento reagendado!");
      } catch (error) {
        toast.error("Erro ao reagendar evento");
        console.error(error);
      }
    }
  };

  const handleEventClick = (eventId: string, source: "event" | "task") => {
    setSelectedEventId(eventId);
    setSelectedEventSource(source);
  };

  const handleSlotClick = (date: Date, hour: number, minute: number) => {
    setInitialDate(date);
    setInitialHour(hour);
    setInitialMinute(minute);
    setShowCreateModal(true);
  };

  const handleCreateEvent = () => {
    setInitialDate(currentDate);
    setInitialHour(undefined);
    setInitialMinute(undefined);
    setShowCreateModal(true);
  };

  const handleEditEvent = (eventId: string) => {
    setEditEventId(eventId);
    setShowCreateModal(true);
  };

  const handleCloseModal = () => {
    setShowCreateModal(false);
    setEditEventId(null);
    setInitialDate(undefined);
    setInitialHour(undefined);
    setInitialMinute(undefined);
  };

  if (!events || !teamMembers) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex flex-col h-full bg-surface-base">
        <CalendarHeader
          view={view}
          currentDate={currentDate}
          onViewChange={setView}
          onNavigatePrev={navigatePrev}
          onNavigateNext={navigateNext}
          onGoToToday={goToToday}
          onCreateEvent={handleCreateEvent}
          teamMembers={teamMembers.map((m) => ({ _id: m._id, name: m.name }))}
          selectedMemberId={selectedMemberId}
          selectedEventTypes={selectedEventTypes}
          onMemberChange={setSelectedMemberId}
          onEventTypesChange={setSelectedEventTypes}
        />

        <div className="flex-1 overflow-hidden">
          {view === "month" && (
            <MonthView
              currentDate={currentDate}
              events={filteredEvents}
              onEventClick={handleEventClick}
              onSelectDay={selectDay}
            />
          )}

          {view === "week" && (
            <WeekView
              weekStart={(() => {
                const dayOfWeek = currentDate.getDay();
                const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
                const monday = new Date(currentDate);
                monday.setDate(currentDate.getDate() - diff);
                return monday;
              })()}
              events={filteredEvents}
              onEventClick={handleEventClick}
              onSlotClick={handleSlotClick}
            />
          )}

          {view === "day" && (
            <DayView
              date={currentDate}
              events={filteredEvents}
              onEventClick={handleEventClick}
              onSlotClick={handleSlotClick}
              onSelectDay={selectDay}
            />
          )}
        </div>

        {/* Mobile FAB - shows only on mobile, positioned above bottom tab bar */}
        <button
          onClick={handleCreateEvent}
          className="md:hidden fixed bottom-20 right-4 z-30 w-14 h-14 rounded-full bg-brand-500 text-white shadow-lg flex items-center justify-center hover:bg-brand-600 active:scale-95 transition-all"
          aria-label="Novo Evento"
        >
          <Plus size={24} />
        </button>

        <DragOverlay>
          {activeEvent && (
            <EventBlock
              event={activeEvent}
              onClick={() => {}}
            />
          )}
        </DragOverlay>
      </div>

      <CalendarEventModal
        open={showCreateModal}
        onClose={handleCloseModal}
        organizationId={organizationId}
        eventId={editEventId || undefined}
        initialDate={initialDate}
        initialHour={initialHour}
        initialMinute={initialMinute}
      />

      {selectedEventSource === "event" && (
        <EventDetailSlideOver
          open={!!selectedEventId}
          onClose={() => {
            setSelectedEventId(null);
            setSelectedEventSource(null);
          }}
          eventId={selectedEventId}
          onEdit={handleEditEvent}
        />
      )}

      {selectedEventSource === "task" && (
        <TaskDetailSlideOver
          open={!!selectedEventId}
          onClose={() => {
            setSelectedEventId(null);
            setSelectedEventSource(null);
          }}
          taskId={selectedEventId}
        />
      )}
    </DndContext>
  );
}
