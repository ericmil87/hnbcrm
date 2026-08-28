import { useState } from "react";
import { cn } from "@/lib/utils";
import { Filter, X } from "lucide-react";
import { Button } from "../ui/Button";
import { EVENT_TYPE_LABELS, EVENT_TYPES, type CalendarEventType } from "./constants";

interface CalendarFiltersProps {
  teamMembers: Array<{ _id: string; name: string }>;
  selectedMemberId: string | null;
  selectedEventTypes: CalendarEventType[];
  onMemberChange: (memberId: string | null) => void;
  onEventTypesChange: (types: CalendarEventType[]) => void;
}

export function CalendarFilters({
  teamMembers,
  selectedMemberId,
  selectedEventTypes,
  onMemberChange,
  onEventTypesChange,
}: CalendarFiltersProps) {
  const [isOpen, setIsOpen] = useState(false);

  const toggleEventType = (type: CalendarEventType) => {
    if (selectedEventTypes.includes(type)) {
      onEventTypesChange(selectedEventTypes.filter((t) => t !== type));
    } else {
      onEventTypesChange([...selectedEventTypes, type]);
    }
  };

  const clearFilters = () => {
    onMemberChange(null);
    onEventTypesChange([]);
  };

  const hasFilters = selectedMemberId !== null || selectedEventTypes.length > 0;

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center gap-2 px-2 md:px-3 py-2 rounded-full text-sm font-medium transition-colors min-h-[36px] md:min-h-[44px]",
          hasFilters
            ? "bg-brand-500/10 text-brand-500 border border-brand-500"
            : "bg-surface-raised text-text-secondary border border-border hover:bg-surface-overlay"
        )}
        aria-label="Filtros"
      >
        <Filter size={16} />
        <span className="hidden md:inline">Filtros</span>
        {hasFilters && (
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-brand-500 text-white text-xs font-bold">
            {(selectedMemberId ? 1 : 0) + selectedEventTypes.length}
          </span>
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className={cn(
            "z-50 w-72 bg-surface-overlay border border-border rounded-xl shadow-elevated p-4 space-y-4",
            "fixed inset-x-4 bottom-4 max-h-[70vh] overflow-y-auto",
            "md:absolute md:right-0 md:top-full md:mt-2 md:bottom-auto md:inset-x-auto md:max-h-[600px]"
          )}>
            {/* Team member filter */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">
                Responsável
              </label>
              <select
                value={selectedMemberId || ""}
                onChange={(e) => onMemberChange(e.target.value || null)}
                className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-lg focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 text-sm"
              >
                <option value="">Todos</option>
                {teamMembers.map((member) => (
                  <option key={member._id} value={member._id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Event type filter */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">
                Tipo de Evento
              </label>
              <div className="flex flex-wrap gap-2">
                {EVENT_TYPES.map((type) => (
                  <button
                    key={type}
                    onClick={() => toggleEventType(type)}
                    className={cn(
                      "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                      selectedEventTypes.includes(type)
                        ? "bg-brand-500 text-white"
                        : "bg-surface-raised text-text-secondary border border-border hover:bg-surface-sunken"
                    )}
                  >
                    {EVENT_TYPE_LABELS[type]}
                  </button>
                ))}
              </div>
            </div>

            {/* Clear filters */}
            {hasFilters && (
              <Button
                variant="secondary"
                size="sm"
                onClick={clearFilters}
                className="w-full"
              >
                <X size={16} />
                Limpar Filtros
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
