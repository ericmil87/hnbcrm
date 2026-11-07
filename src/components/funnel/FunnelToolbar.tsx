import { useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  Columns3,
  LayoutGrid,
  List,
  ListFilter,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { usePageHeader, type PageMenuItem } from "@/components/layout/pageHeader";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { funnelHeaderPlan, type FunnelHeaderCommand, type FunnelHeaderEntry } from "@/lib/funnelHeader";
import { SearchInput } from "@/components/ui/SearchInput";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select, type SelectOption } from "@/components/ui/Select";
import { memberLabel } from "@/lib/teamMembers";
import {
  PRIORITY_FILTER_OPTIONS,
  TEMPERATURE_FILTER_OPTIONS,
  CLEARED_SHEET_FILTERS,
  activeFilterCount,
  filtersButtonLabel,
  sheetFilterCount,
  type FunnelFilters,
  type FunnelView,
} from "@/lib/funnelFilters";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";
import { FunnelCardPicker, FunnelCardPrefsFields } from "./FunnelCardPicker";
import { FunnelFiltersSheet } from "./FunnelFiltersSheet";
import type { FunnelCardPrefs } from "@/lib/funnelCardPrefs";
import { FunnelSelector, useFunnelBoardMenus, type FunnelSelectorProps } from "./FunnelSelector";

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
  /** Preferência de exibição dos cards (só faz sentido no modo quadro). */
  cardPrefs: FunnelCardPrefs;
  onCardPrefsChange: (next: FunnelCardPrefs) => void;
}

const VIEW_OPTIONS = [
  { value: "board", label: "Modo quadro", icon: <LayoutGrid size={16} aria-hidden="true" /> },
  { value: "list", label: "Modo lista", icon: <List size={16} aria-hidden="true" /> },
];

/** Ícones dos itens de configuração do funil no ⋯ do celular (o desktop segue sem ícone). */
const BOARD_SETTING_ICONS: Record<string, ReactNode> = {
  edit: <Pencil size={16} aria-hidden="true" className="shrink-0" />,
  stages: <Columns3 size={16} aria-hidden="true" className="shrink-0" />,
  delete: <Trash2 size={16} aria-hidden="true" className="shrink-0" />,
};

type MobileSheet = "filters" | "cards" | "archivedBoards";

/**
 * Funil + busca, filtros, modo quadro/lista e leads arquivados. Modo e filtros moram na URL.
 * Celular (< md): "Criar lead" vira o + do cabeçalho do AppShell e as ações
 * secundárias vão para o ⋯; o corpo fica com o seletor de funil e uma linha
 * com busca, "Filtros" (folha, com contador) e o modo quadro/lista em ícones.
 */
export function FunnelToolbar({
  selector,
  filters,
  onFiltersChange,
  onClearFilters,
  teamMembers,
  units,
  showArchived,
  onToggleArchived,
  cardPrefs,
  onCardPrefsChange,
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

  const isMobile = useMediaQuery("(max-width: 767px)");
  const [sheet, setSheet] = useState<MobileSheet | null>(null);
  const closeSheet = () => setSheet(null);
  const { archivedItems, settingsItems } = useFunnelBoardMenus(selector);
  const sheetCount = sheetFilterCount(filters, units !== null);

  // Cabeçalho do AppShell no celular: o plano (ids, rótulos, ordem) é puro em
  // `lib/funnelHeader.ts`; aqui só entram ícones e handlers.
  const headerPlan = funnelHeaderPlan({
    canCreateLead: selector.canCreateLead,
    view: filters.view,
    showArchivedLeads: showArchived,
    hasSelectedBoard: !!selector.selectedBoardId,
    boardSettings: settingsItems.map((item) => ({ id: item.id ?? item.label, label: item.label, danger: item.danger })),
    archivedBoardCount: selector.archivedBoards.length,
  });

  const runCommand = (command: FunnelHeaderCommand) => {
    switch (command.kind) {
      case "createLead":
        return selector.onOpenDialog({ kind: "createLead" });
      case "toggleArchivedLeads":
        return onToggleArchived();
      case "cardDisplay":
        return setSheet("cards");
      case "archivedBoards":
        return setSheet("archivedBoards");
      case "boardSetting":
        return settingsItems.find((item) => (item.id ?? item.label) === command.settingId)?.onSelect();
    }
  };

  const iconFor = (command: FunnelHeaderCommand): ReactNode => {
    const props = { size: 16, "aria-hidden": true, className: "shrink-0" } as const;
    switch (command.kind) {
      case "createLead":
        return <Plus size={22} aria-hidden="true" />;
      case "toggleArchivedLeads":
        return showArchived ? <ArchiveRestore {...props} /> : <Archive {...props} />;
      case "cardDisplay":
        return <SlidersHorizontal {...props} />;
      case "archivedBoards":
        return <Archive {...props} />;
      case "boardSetting":
        return (
          settingsItems.find((item) => (item.id ?? item.label) === command.settingId)?.icon ??
          BOARD_SETTING_ICONS[command.settingId]
        );
    }
  };

  const toPageEntry = ({ command, ...entry }: FunnelHeaderEntry): PageMenuItem => ({
    ...entry,
    icon: iconFor(command),
    onSelect: () => runCommand(command),
  });

  usePageHeader(
    isMobile
      ? {
          menuLabel: "Mais ações",
          menuItems: headerPlan.menuItems.map(toPageEntry),
          actions: headerPlan.actions.map(({ id, label, command }) => ({
            id,
            label,
            icon: iconFor(command),
            onSelect: () => runCommand(command),
          })),
        }
      : null
  );

  if (isMobile) {
    return (
      <>
        <FunnelSelector {...selector} compact />

        <div className="mb-3 flex items-center gap-2">
          <SearchInput
            variant="pill"
            value={filters.q}
            onValueChange={(q) => onFiltersChange({ q })}
            placeholder={`Buscar ${VOCAB.lead.many}…`}
            ariaLabel={`Buscar ${VOCAB.lead.many}`}
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="secondary"
            iconOnly
            aria-label={filtersButtonLabel(sheetCount)}
            aria-haspopup="dialog"
            onClick={() => setSheet("filters")}
            className={cn("relative shrink-0", sheetCount > 0 && "border-brand-500 bg-brand-500/10 text-brand-500")}
          >
            <ListFilter size={18} aria-hidden="true" />
            {sheetCount > 0 && (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand-600 px-1 text-micro font-semibold tabular-nums text-white"
              >
                {sheetCount}
              </span>
            )}
          </Button>
          <SegmentedControl
            iconOnly
            ariaLabel="Modo de exibição"
            value={filters.view}
            onValueChange={(view) => onFiltersChange({ view: view as FunnelView })}
            options={VIEW_OPTIONS}
            className="shrink-0 rounded-full [&>button]:rounded-full"
          />
        </div>

        {showArchived && (
          <div className="mb-3 flex items-center justify-between gap-2 rounded-card border border-brand-500 bg-brand-500/10 py-1 pl-3 pr-1">
            <span className="flex min-w-0 items-center gap-2 text-sm text-text-primary">
              <Archive size={16} aria-hidden="true" className="shrink-0 text-brand-500" />
              <span className="truncate">Mostrando leads arquivados</span>
            </span>
            <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={onToggleArchived}>
              Ver ativos
            </Button>
          </div>
        )}

        <FunnelFiltersSheet
          open={sheet === "filters"}
          onClose={closeSheet}
          filters={filters}
          onFiltersChange={onFiltersChange}
          ownerOptions={ownerOptions}
          unitOptions={units && (units.length > 0 || filters.unit !== "all") ? unitOptions : null}
          activeCount={sheetCount}
          onClear={() => onFiltersChange(CLEARED_SHEET_FILTERS)}
        />

        <Modal open={sheet === "cards"} onClose={closeSheet} title="Exibição dos cards">
          <FunnelCardPrefsFields prefs={cardPrefs} onChange={onCardPrefsChange} />
          <Button type="button" variant="primary" size="lg" className="mt-4 w-full" onClick={closeSheet}>
            Pronto
          </Button>
        </Modal>

        <Modal open={sheet === "archivedBoards"} onClose={closeSheet} title="Funis arquivados">
          <ul className="-mx-4 -my-2">
            {archivedItems.map((item) => (
              <li key={item.id}>
              <button
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  closeSheet();
                  item.onSelect();
                }}
                className={cn(
                  "flex w-full min-h-11 items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors",
                  "hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  item.danger ? "text-semantic-error" : "text-text-primary"
                )}
              >
                {item.icon}
                <span className="min-w-0 truncate">{item.label}</span>
              </button>
              </li>
            ))}
          </ul>
          <Button type="button" variant="primary" size="lg" className="mt-4 w-full" onClick={closeSheet}>
            Pronto
          </Button>
        </Modal>
      </>
    );
  }

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
          {filters.view === "board" && <FunnelCardPicker prefs={cardPrefs} onChange={onCardPrefsChange} />}
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
