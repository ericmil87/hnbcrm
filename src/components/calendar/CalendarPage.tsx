import { usePageTitle } from "@/hooks/usePageTitle";
import { VOCAB } from "@/lib/vocab";
import { useState, useMemo, useEffect } from "react";
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
import { TaskQuickView } from "./TaskQuickView";
import { EventBlock } from "./EventBlock";
import type { CalendarEventType } from "./constants";
import { ErrorBoundary } from "../ErrorBoundary";
import { Spinner } from "../ui/Spinner";
import { toast } from "sonner";
import { useKeepPrevious } from "@/hooks/useKeepPrevious";
import { addDays, startOfWeek } from "@/lib/agendaDates";
import { calendarQueryKey, serverEventTypeFilter } from "@/lib/agendaQuery";
import { memberLabel } from "@/lib/teamMembers";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage } from "@/lib/errors";
import { isCalendarItemDraggable } from "@/lib/agendaPermissions";

/** Fallback vazio que limpa o `?event=` inválido ao montar. */
function ClearEventParam({ onClear }: { onClear: () => void }) {
  useEffect(() => {
    onClear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <></>;
}

export function CalendarPage() {
  usePageTitle(VOCAB.agenda.title);
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
    eventParam,
    setSelectedEvent,
  } = useCalendarState();

  // Criar evento exige poder editar tarefas/agenda (`tasks` >= edit_own).
  const { can } = usePermissions(organizationId);
  const canCreate = can("agenda", "edit");

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editEventId, setEditEventId] = useState<string | null>(null);
  // Evento aberto pela URL (`?event=`); tarefas continuam em estado local.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [initialDate, setInitialDate] = useState<Date | undefined>();
  const [initialHour, setInitialHour] = useState<number | undefined>();
  const [initialMinute, setInitialMinute] = useState<number | undefined>();
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [selectedEventTypes, setSelectedEventTypes] = useState<CalendarEventType[]>([]);
  const [activeEvent, setActiveEvent] = useState<any>(null);

  // A query só aceita UM tipo: com 0 ou 2+ tipos marcados busca todos e o filtro
  // por tipo roda no cliente (filteredEvents).
  const serverEventType = serverEventTypeFilter(selectedEventTypes);
  const rawEvents = useQuery(api.calendar.getEvents, {
    organizationId,
    // O índice do backend filtra pelo INÍCIO do evento: recua um dia para trazer o que
    // começou ontem e cruza a meia-noite (o recorte por dia é feito no cliente).
    // Evento de vários dias que começou antes disso só volta a aparecer em todos os dias
    // quando o backend buscar por sobreposição (correção em PR separado do backend).
    startDate: addDays(dateRange.startDate, -1).getTime(),
    endDate: dateRange.endDate,
    includeTasks: true,
    assignedTo: selectedMemberId ? (selectedMemberId as Id<"teamMembers">) : undefined,
    eventType: serverEventType,
  });
  // Navegar entre datas não desmonta a página nem pisca: mantém o resultado anterior enquanto
  // o novo chega. Trocar organização, responsável ou tipo do servidor descarta o resultado
  // (chave), para nunca mostrar como atual o de outro filtro.
  const events = useKeepPrevious(
    rawEvents,
    calendarQueryKey(organizationId, selectedMemberId, serverEventType)
  );
  const isLoadingEvents = rawEvents === undefined;

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

  const weekStart = useMemo(() => startOfWeek(currentDate), [currentDate]);

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

    // Defesa: o bloco já nasce sem arrasto, mas o servidor é quem decide.
    if (!isCalendarItemDraggable(eventData)) return;

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
        toast.error(mutationErrorMessage(error, "Não foi possível reagendar o evento."));
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
        toast.error(mutationErrorMessage(error, "Não foi possível reagendar o evento."));
        console.error(error);
      }
    }
  };

  const handleEventClick = (eventId: string, source: "event" | "task") => {
    if (source === "event") setSelectedEvent(eventId);
    else setSelectedTaskId(eventId);
  };

  const handleSlotClick = (date: Date, hour: number, minute: number) => {
    if (!canCreate) return;
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

  if (!teamMembers) {
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
          canCreate={canCreate}
          teamMembers={teamMembers.map((m) => ({ _id: m._id, name: memberLabel(m) }))}
          selectedMemberId={selectedMemberId}
          selectedEventTypes={selectedEventTypes}
          onMemberChange={setSelectedMemberId}
          onEventTypesChange={setSelectedEventTypes}
        />

        <div className="relative flex-1 overflow-hidden">
          {isLoadingEvents && (
            <div className="absolute right-3 top-2 z-20 rounded-full bg-surface-raised/90 p-1.5 shadow-sm">
              <Spinner size="sm" />
            </div>
          )}
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
              weekStart={weekStart}
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
        {canCreate && (
        <button
          onClick={handleCreateEvent}
          className="md:hidden fixed bottom-20 right-4 z-30 w-14 h-14 rounded-full bg-brand-600 text-white shadow-lg flex items-center justify-center hover:bg-brand-700 active:scale-95 transition-all"
          aria-label="Novo evento"
        >
          <Plus size={24} />
        </button>
        )}

        <DragOverlay>
          {activeEvent && (
            <EventBlock
              event={activeEvent}
              dragKey="overlay"
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

      {eventParam && (
        // Id inválido ou de outra org: a query falha dentro do filho e o deep-link é ignorado.
        <ErrorBoundary key={eventParam} fallback={<ClearEventParam onClear={() => setSelectedEvent(null)} />}>
          <EventDetailSlideOver
            open
            onClose={() => setSelectedEvent(null)}
            eventId={eventParam}
            onEdit={handleEditEvent}
          />
        </ErrorBoundary>
      )}

      {selectedTaskId && (
        <TaskQuickView
          open
          onClose={() => setSelectedTaskId(null)}
          taskId={selectedTaskId}
        />
      )}
    </DndContext>
  );
}
