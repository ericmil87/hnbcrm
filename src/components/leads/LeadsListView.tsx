import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/Checkbox";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatRelativeTime } from "@/lib/auditUtils";

// Tabela de leads (view "Lista" do pipeline) + variante em cards para mobile.
// Componente puramente apresentacional: não faz nenhuma query/mutation —
// todos os dados e callbacks chegam via props. O integrador é responsável
// por ordenar `leads` conforme sortKey/sortOrder antes de passar para cá.

export type LeadPriority = "low" | "medium" | "high" | "urgent";
export type LeadTemperature = "cold" | "warm" | "hot";

export type LeadSortKey =
  | "title"
  | "value"
  | "stage"
  | "priority"
  | "temperature"
  | "assignee"
  | "updatedAt";

export interface EnrichedLead {
  _id: string;
  title: string;
  value: number;
  currency: string;
  priority: LeadPriority;
  temperature: LeadTemperature;
  tags: string[];
  assignedTo?: string;
  updatedAt: number;
  lastActivityAt?: number;
  contact?: { name?: string } | null;
  stage?: { name: string; color?: string } | null;
  assignee?: { name: string; type?: "human" | "ai" } | null;
}

export interface LeadsListViewProps {
  leads: EnrichedLead[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  allSelected: boolean;
  sortKey: LeadSortKey;
  sortOrder: "asc" | "desc";
  onSort: (key: LeadSortKey) => void;
  onRowClick: (id: string) => void;
}

const PRIORITY_LABELS: Record<LeadPriority, string> = {
  urgent: "Urgente",
  high: "Alta",
  medium: "Média",
  low: "Baixa",
};

const TEMPERATURE_LABELS: Record<LeadTemperature, string> = {
  hot: "Quente",
  warm: "Morno",
  cold: "Frio",
};

function getPriorityVariant(priority: LeadPriority): "error" | "warning" | "default" {
  if (priority === "urgent") return "error";
  if (priority === "high") return "warning";
  return "default";
}

function getTemperatureVariant(temperature: LeadTemperature): "error" | "warning" | "info" {
  if (temperature === "hot") return "error";
  if (temperature === "warm") return "warning";
  return "info";
}

function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: currency || "BRL",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `R$ ${value.toLocaleString("pt-BR")}`;
  }
}

interface SortableHeaderProps {
  label: string;
  columnKey: LeadSortKey;
  sortKey: LeadSortKey;
  sortOrder: "asc" | "desc";
  onSort: (key: LeadSortKey) => void;
  className?: string;
}

function SortableHeader({ label, columnKey, sortKey, sortOrder, onSort, className }: SortableHeaderProps) {
  const active = sortKey === columnKey;
  return (
    <th scope="col" className={cn("px-4 py-3 text-left text-xs font-medium text-text-secondary", className)}>
      <button
        type="button"
        onClick={() => onSort(columnKey)}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:text-text-primary",
          active && "text-text-primary"
        )}
      >
        {label}
        {active &&
          (sortOrder === "asc" ? (
            <ChevronUp size={14} className="text-brand-500" />
          ) : (
            <ChevronDown size={14} className="text-brand-500" />
          ))}
      </button>
    </th>
  );
}

export function LeadsListView({
  leads,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  allSelected,
  sortKey,
  sortOrder,
  onSort,
  onRowClick,
}: LeadsListViewProps) {
  if (leads.length === 0) {
    return <EmptyState icon={Search} title="Nenhum lead encontrado" />;
  }

  return (
    <div className="rounded-card border border-border bg-surface-raised">
      {/* Desktop: tabela real */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="w-10 px-4 py-3">
                <Checkbox
                  checked={allSelected}
                  onChange={onToggleSelectAll}
                  aria-label="Selecionar todos os leads"
                />
              </th>
              <SortableHeader label="Título" columnKey="title" sortKey={sortKey} sortOrder={sortOrder} onSort={onSort} />
              <SortableHeader label="Estágio" columnKey="stage" sortKey={sortKey} sortOrder={sortOrder} onSort={onSort} />
              <SortableHeader label="Valor" columnKey="value" sortKey={sortKey} sortOrder={sortOrder} onSort={onSort} />
              <SortableHeader label="Prioridade" columnKey="priority" sortKey={sortKey} sortOrder={sortOrder} onSort={onSort} />
              <SortableHeader label="Temperatura" columnKey="temperature" sortKey={sortKey} sortOrder={sortOrder} onSort={onSort} />
              <SortableHeader label="Responsável" columnKey="assignee" sortKey={sortKey} sortOrder={sortOrder} onSort={onSort} />
              <SortableHeader label="Atualizado" columnKey="updatedAt" sortKey={sortKey} sortOrder={sortOrder} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => {
              const selected = selectedIds.has(lead._id);
              return (
                <tr
                  key={lead._id}
                  onClick={() => onRowClick(lead._id)}
                  className={cn(
                    "cursor-pointer border-b border-border-subtle transition-colors last:border-b-0 hover:bg-surface-overlay",
                    selected && "bg-brand-500/10"
                  )}
                >
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected}
                      onChange={() => onToggleSelect(lead._id)}
                      aria-label={`Selecionar ${lead.title}`}
                    />
                  </td>
                  <td className="max-w-xs px-4 py-3">
                    <div className="truncate font-medium text-text-primary">{lead.title}</div>
                    {lead.contact?.name && (
                      <div className="truncate text-xs text-text-secondary">{lead.contact.name}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: lead.stage?.color || "#71717A" }}
                      />
                      <span className="truncate text-sm text-text-secondary">{lead.stage?.name ?? "—"}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold tabular-nums text-brand-400">
                    {formatCurrency(lead.value, lead.currency)}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={getPriorityVariant(lead.priority)}>{PRIORITY_LABELS[lead.priority]}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={getTemperatureVariant(lead.temperature)}>
                      {TEMPERATURE_LABELS[lead.temperature]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {lead.assignee ? (
                      <div className="flex items-center gap-2">
                        <Avatar name={lead.assignee.name} type={lead.assignee.type} size="sm" />
                        <span className="max-w-[120px] truncate text-sm text-text-secondary">
                          {lead.assignee.name}
                        </span>
                      </div>
                    ) : (
                      <span className="text-sm text-text-muted">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-text-muted">
                    {formatRelativeTime(lead.updatedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: cards */}
      <div className="divide-y divide-border-subtle md:hidden">
        {leads.map((lead) => {
          const selected = selectedIds.has(lead._id);
          return (
            <div
              key={lead._id}
              className={cn("flex items-start gap-3 p-4 transition-colors active:bg-surface-overlay", selected && "bg-brand-500/10")}
            >
              <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={selected}
                  onChange={() => onToggleSelect(lead._id)}
                  aria-label={`Selecionar ${lead.title}`}
                />
              </div>
              <div className="min-w-0 flex-1 cursor-pointer" onClick={() => onRowClick(lead._id)}>
                <div className="truncate font-medium text-text-primary">{lead.title}</div>
                {lead.contact?.name && (
                  <div className="truncate text-xs text-text-secondary">{lead.contact.name}</div>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: lead.stage?.color || "#71717A" }}
                    />
                    <span className="truncate">{lead.stage?.name ?? "—"}</span>
                  </span>
                  <span>•</span>
                  <span className="font-semibold tabular-nums text-brand-400">
                    {formatCurrency(lead.value, lead.currency)}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <Badge variant={getPriorityVariant(lead.priority)}>{PRIORITY_LABELS[lead.priority]}</Badge>
                  <Badge variant={getTemperatureVariant(lead.temperature)}>
                    {TEMPERATURE_LABELS[lead.temperature]}
                  </Badge>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
