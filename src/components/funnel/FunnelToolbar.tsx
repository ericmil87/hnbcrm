import { useMemo } from "react";
import { Archive, LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SearchInput } from "@/components/ui/SearchInput";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select, type SelectOption } from "@/components/ui/Select";
import { memberLabel } from "@/lib/teamMembers";
import {
  PRIORITY_FILTER_OPTIONS,
  TEMPERATURE_FILTER_OPTIONS,
  activeFilterCount,
  type FunnelFilters,
  type FunnelView,
} from "@/lib/funnelFilters";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";
import { FunnelSelector, type FunnelSelectorProps } from "./FunnelSelector";

interface FunnelToolbarProps {
  selector: FunnelSelectorProps;
  filters: FunnelFilters;
  onFiltersChange: (changes: Partial<FunnelFilters>) => void;
  onClearFilters: () => void;
  teamMembers: readonly { _id: string; name: string; type: "human" | "ai" }[] | undefined;
  /** Só com o módulo de unidades ligado e ao menos uma unidade cadastrada. */
  units: readonly { _id: string; name: string }[] | null;
  showArchived: boolean;
  onToggleArchived: () => void;
}

const VIEW_OPTIONS = [
  { value: "board", label: "Modo quadro", icon: <LayoutGrid size={16} aria-hidden="true" /> },
  { value: "list", label: "Modo lista", icon: <List size={16} aria-hidden="true" /> },
];

/** Funil + busca, filtros, modo quadro/lista e leads arquivados. Modo e filtros moram na URL. */
export function FunnelToolbar({
  selector,
  filters,
  onFiltersChange,
  onClearFilters,
  teamMembers,
  units,
  showArchived,
  onToggleArchived,
}: FunnelToolbarProps) {
  const ownerOptions = useMemo<SelectOption[]>(
    () => [
      { value: "all", label: "Todos responsáveis" },
      { value: "unassigned", label: "Não atribuído" },
      ...(teamMembers ?? []).map((m) => ({ value: m._id, label: memberLabel(m) })),
    ],
    [teamMembers]
  );
  const unitOptions = useMemo<SelectOption[]>(
    () => [
      { value: "all", label: "Todas unidades" },
      { value: "none", label: "Sem unidade" },
      ...(units ?? []).map((u) => ({ value: u._id, label: u.name })),
    ],
    [units]
  );

  return (
    <>
      <FunnelSelector {...selector} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput
          value={filters.q}
          onValueChange={(q) => onFiltersChange({ q })}
          placeholder={`Buscar ${VOCAB.lead.many}…`}
          ariaLabel={`Buscar ${VOCAB.lead.many}`}
          className="min-w-[200px] flex-1"
        />

        <div className="min-w-[9rem] flex-1 sm:flex-none sm:w-44">
          <Select
            aria-label="Filtrar por prioridade"
            value={filters.priority}
            onValueChange={(priority) => onFiltersChange({ priority })}
            options={PRIORITY_FILTER_OPTIONS}
          />
        </div>
        <div className="min-w-[9rem] flex-1 sm:flex-none sm:w-44">
          <Select
            aria-label="Filtrar por temperatura"
            value={filters.temp}
            onValueChange={(temp) => onFiltersChange({ temp })}
            options={TEMPERATURE_FILTER_OPTIONS}
          />
        </div>
        <div className="min-w-[9rem] flex-1 sm:flex-none sm:w-48">
          <Select
            aria-label="Filtrar por responsável"
            value={filters.owner}
            onValueChange={(owner) => onFiltersChange({ owner })}
            options={ownerOptions}
          />
        </div>
        {units && units.length > 0 && (
          <div className="min-w-[9rem] flex-1 sm:flex-none sm:w-44">
            <Select
              aria-label="Filtrar por unidade"
              value={filters.unit}
              onValueChange={(unit) => onFiltersChange({ unit })}
              options={unitOptions}
            />
          </div>
        )}

        {activeFilterCount(filters) > 0 && (
          <Button type="button" variant="ghost" size="md" onClick={onClearFilters}>
            Limpar filtros
          </Button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <SegmentedControl
            ariaLabel="Modo de exibição"
            value={filters.view}
            onValueChange={(view) => onFiltersChange({ view: view as FunnelView })}
            options={VIEW_OPTIONS}
          />
          <Button
            type="button"
            variant="secondary"
            aria-pressed={showArchived}
            onClick={onToggleArchived}
            className={cn("whitespace-nowrap", showArchived && "border-brand-500 bg-brand-600/15 text-brand-300")}
          >
            <Archive size={16} aria-hidden="true" />
            Arquivados
          </Button>
        </div>
      </div>
    </>
  );
}
