import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select, type SelectOption } from "@/components/ui/Select";
import {
  PRIORITY_FILTER_OPTIONS,
  TEMPERATURE_FILTER_OPTIONS,
  type FunnelFilters,
} from "@/lib/funnelFilters";

export interface FunnelFiltersSheetProps {
  open: boolean;
  onClose: () => void;
  filters: FunnelFilters;
  onFiltersChange: (changes: Partial<FunnelFilters>) => void;
  ownerOptions: SelectOption[];
  /** `null` = módulo de unidades desligado ou sem unidades: o campo não aparece. */
  unitOptions: SelectOption[] | null;
  /** Filtros da folha ativos agora (habilita o "Limpar filtros"). */
  activeCount: number;
  onClear: () => void;
}

/**
 * Folha "Filtros" do Funil no celular: prioridade, temperatura, responsável e
 * unidade. Cada mudança grava na URL na hora; "Pronto" só fecha.
 */
export function FunnelFiltersSheet({
  open,
  onClose,
  filters,
  onFiltersChange,
  ownerOptions,
  unitOptions,
  activeCount,
  onClear,
}: FunnelFiltersSheetProps) {
  return (
    <Modal open={open} onClose={onClose} title="Filtros">
      <div className="space-y-4">
        <Select
          label="Prioridade"
          value={filters.priority}
          onValueChange={(priority) => onFiltersChange({ priority })}
          options={PRIORITY_FILTER_OPTIONS}
        />
        <Select
          label="Temperatura"
          value={filters.temp}
          onValueChange={(temp) => onFiltersChange({ temp })}
          options={TEMPERATURE_FILTER_OPTIONS}
        />
        <Select
          label="Responsável"
          value={filters.owner}
          onValueChange={(owner) => onFiltersChange({ owner })}
          options={ownerOptions}
        />
        {unitOptions && (
          <Select
            label="Unidade"
            value={filters.unit}
            onValueChange={(unit) => onFiltersChange({ unit })}
            options={unitOptions}
          />
        )}

        <div className="flex items-center gap-2 pt-2">
          <Button type="button" variant="ghost" size="lg" className="flex-1" disabled={activeCount === 0} onClick={onClear}>
            Limpar filtros
          </Button>
          <Button type="button" variant="primary" size="lg" className="flex-1" onClick={onClose}>
            Pronto
          </Button>
        </div>
      </div>
    </Modal>
  );
}
