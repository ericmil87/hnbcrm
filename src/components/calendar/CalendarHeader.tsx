import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "../ui/Button";
import { CalendarFilters } from "./CalendarFilters";
import { MONTHS_LONG, WEEKDAYS_LONG } from "./constants";

type CalendarView = "month" | "week" | "day";

interface CalendarHeaderProps {
  view: CalendarView;
  currentDate: Date;
  onViewChange: (view: CalendarView) => void;
  onNavigatePrev: () => void;
  onNavigateNext: () => void;
  onGoToToday: () => void;
  onCreateEvent: () => void;
  teamMembers: Array<{ _id: string; name: string }>;
  selectedMemberId: string | null;
  selectedEventTypes: string[];
  onMemberChange: (memberId: string | null) => void;
  onEventTypesChange: (types: string[]) => void;
}

export function CalendarHeader({
  view,
  currentDate,
  onViewChange,
  onNavigatePrev,
  onNavigateNext,
  onGoToToday,
  onCreateEvent,
  teamMembers,
  selectedMemberId,
  selectedEventTypes,
  onMemberChange,
  onEventTypesChange,
}: CalendarHeaderProps) {
  const getDateLabel = () => {
    const month = MONTHS_LONG[currentDate.getMonth()];
    const year = currentDate.getFullYear();

    if (view === "month") {
      return `${month} ${year}`;
    }

    if (view === "week") {
      // Get week start (Monday) and end (Sunday)
      const dayOfWeek = currentDate.getDay();
      const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const weekStart = new Date(currentDate);
      weekStart.setDate(currentDate.getDate() - diff);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);

      const startDay = weekStart.getDate();
      const endDay = weekEnd.getDate();
      const startMonth = MONTHS_LONG[weekStart.getMonth()].slice(0, 3);
      const endMonth = MONTHS_LONG[weekEnd.getMonth()].slice(0, 3);

      if (weekStart.getMonth() === weekEnd.getMonth()) {
        return `${startDay}-${endDay} ${startMonth}`;
      }
      return `${startDay} ${startMonth} - ${endDay} ${endMonth}`;
    }

    // Day view
    const dayOfWeek = WEEKDAYS_LONG[currentDate.getDay()];
    const day = currentDate.getDate();
    return `${dayOfWeek}, ${day} ${month.slice(0, 3)}`;
  };

  return (
    <div className="border-b border-border bg-surface-raised px-4 py-3 space-y-3">
      {/* Row 1: View toggle pills (left) + Hoje + Filter + Create (desktop) (right) */}
      <div className="flex items-center justify-between gap-2">
        {/* View toggle pills - compact on mobile */}
        <div className="flex gap-1 bg-surface-sunken rounded-full p-0.5 md:p-1">
          <button
            onClick={() => onViewChange("day")}
            className={cn(
              "px-2 py-1 md:px-3 md:py-1.5 rounded-full text-xs md:text-sm font-medium transition-colors min-w-[48px] md:min-w-[60px]",
              view === "day"
                ? "bg-brand-500 text-white"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            Dia
          </button>
          <button
            onClick={() => onViewChange("week")}
            className={cn(
              "px-2 py-1 md:px-3 md:py-1.5 rounded-full text-xs md:text-sm font-medium transition-colors min-w-[48px] md:min-w-[60px]",
              view === "week"
                ? "bg-brand-500 text-white"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            Semana
          </button>
          <button
            onClick={() => onViewChange("month")}
            className={cn(
              "px-2 py-1 md:px-3 md:py-1.5 rounded-full text-xs md:text-sm font-medium transition-colors min-w-[48px] md:min-w-[60px]",
              view === "month"
                ? "bg-brand-500 text-white"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            Mês
          </button>
        </div>

        {/* Right side: Hoje + Filters + Create */}
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onGoToToday} className="px-2 md:px-3">
            Hoje
          </Button>
          <CalendarFilters
            teamMembers={teamMembers}
            selectedMemberId={selectedMemberId}
            selectedEventTypes={selectedEventTypes}
            onMemberChange={onMemberChange}
            onEventTypesChange={onEventTypesChange}
          />
          <Button onClick={onCreateEvent} size="sm" className="hidden md:flex">
            <Plus size={16} />
            Novo Evento
          </Button>
        </div>
      </div>

      {/* Row 2: Centered date navigation */}
      <div className="flex items-center justify-center gap-2">
        <button
          onClick={onNavigatePrev}
          className="p-1.5 md:p-2 rounded-full text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors min-w-[36px] min-h-[36px] md:min-w-[44px] md:min-h-[44px] flex items-center justify-center"
          aria-label="Anterior"
        >
          <ChevronLeft size={20} />
        </button>

        <div className="min-w-[120px] md:min-w-[160px] text-center">
          <h2 className="text-base md:text-lg font-semibold text-text-primary">
            {getDateLabel()}
          </h2>
        </div>

        <button
          onClick={onNavigateNext}
          className="p-1.5 md:p-2 rounded-full text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors min-w-[36px] min-h-[36px] md:min-w-[44px] md:min-h-[44px] flex items-center justify-center"
          aria-label="Próximo"
        >
          <ChevronRight size={20} />
        </button>
      </div>
    </div>
  );
}
