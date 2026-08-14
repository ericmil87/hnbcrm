import { useEffect, useRef, useState } from "react";
import type { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/Checkbox";
import { ChevronDown, Tag, X } from "lucide-react";
import type { TaskProjectSummary } from "./ProjectSwitcher";

// Barra de filtros da página de tarefas. Os "smart filters" (pills) e a busca
// continuam na TasksPage; aqui ficam os filtros combináveis enviados ao
// backend (status, prioridade, responsável, tipo, etiquetas e projeto).

export interface TaskFilters {
  status: string;
  priority: string;
  assigneeId: string;
  activityType: string;
  labelIds: Id<"taskLabels">[];
  /** Só usado na visão "Todas as tarefas"; vazio = todos os projetos. */
  projectId: string;
}

export const EMPTY_TASK_FILTERS: TaskFilters = {
  status: "",
  priority: "",
  assigneeId: "",
  activityType: "",
  labelIds: [],
  projectId: "",
};

export function countActiveFilters(filters: TaskFilters): number {
  return (
    (filters.status ? 1 : 0) +
    (filters.priority ? 1 : 0) +
    (filters.assigneeId ? 1 : 0) +
    (filters.activityType ? 1 : 0) +
    (filters.labelIds.length > 0 ? 1 : 0) +
    (filters.projectId ? 1 : 0)
  );
}

interface TaskLabelOption {
  _id: Id<"taskLabels">;
  name: string;
  color: string;
}

interface TaskFiltersBarProps {
  filters: TaskFilters;
  onChange: (filters: TaskFilters) => void;
  teamMembers: { _id: Id<"teamMembers">; name: string }[] | undefined;
  labels: TaskLabelOption[] | undefined;
  projects: TaskProjectSummary[] | undefined;
  /** A visão de projeto já filtra por projeto; o select só aparece em "Todas". */
  showProjectFilter: boolean;
  /** Slot à direita da barra (menu de filtros salvos). */
  trailing?: React.ReactNode;
}

const selectClass =
  "w-full px-2 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500";

export function TaskFiltersBar({
  filters,
  onChange,
  teamMembers,
  labels,
  projects,
  showProjectFilter,
  trailing,
}: TaskFiltersBarProps) {
  const activeCount = countActiveFilters(filters);
  const [open, setOpen] = useState(activeCount > 0);

  const set = <K extends keyof TaskFilters>(key: K, value: TaskFilters[K]) =>
    onChange({ ...filters, [key]: value });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary transition-colors min-h-[36px]"
        >
          <ChevronDown
            size={16}
            className={cn("transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
          Filtros
          {activeCount > 0 && (
            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-brand-500/15 text-brand-500 text-[10px] font-bold tabular-nums">
              {activeCount}
            </span>
          )}
        </button>

        {activeCount > 0 && (
          <button
            type="button"
            onClick={() => onChange({ ...EMPTY_TASK_FILTERS })}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors min-h-[36px]"
          >
            <X size={14} aria-hidden="true" />
            Limpar filtros
          </button>
        )}

        {trailing && <div className="ml-auto">{trailing}</div>}
      </div>

      {open && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3 bg-surface-sunken rounded-card border border-border">
          <div>
            <label
              htmlFor="task-filter-status"
              className="block text-xs font-medium text-text-muted mb-1"
            >
              Status
            </label>
            <select
              id="task-filter-status"
              value={filters.status}
              onChange={(e) => set("status", e.target.value)}
              className={selectClass}
              style={{ fontSize: "16px" }}
            >
              <option value="">Todos</option>
              <option value="pending">Pendente</option>
              <option value="in_progress">Em Progresso</option>
              <option value="completed">Concluída</option>
              <option value="cancelled">Cancelada</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="task-filter-priority"
              className="block text-xs font-medium text-text-muted mb-1"
            >
              Prioridade
            </label>
            <select
              id="task-filter-priority"
              value={filters.priority}
              onChange={(e) => set("priority", e.target.value)}
              className={selectClass}
              style={{ fontSize: "16px" }}
            >
              <option value="">Todas</option>
              <option value="low">Baixa</option>
              <option value="medium">Média</option>
              <option value="high">Alta</option>
              <option value="urgent">Urgente</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="task-filter-assignee"
              className="block text-xs font-medium text-text-muted mb-1"
            >
              Responsável
            </label>
            <select
              id="task-filter-assignee"
              value={filters.assigneeId}
              onChange={(e) => set("assigneeId", e.target.value)}
              className={selectClass}
              style={{ fontSize: "16px" }}
            >
              <option value="">Todos</option>
              {teamMembers?.map((member) => (
                <option key={member._id} value={member._id}>
                  {member.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="task-filter-activity"
              className="block text-xs font-medium text-text-muted mb-1"
            >
              Tipo de Atividade
            </label>
            <select
              id="task-filter-activity"
              value={filters.activityType}
              onChange={(e) => set("activityType", e.target.value)}
              className={selectClass}
              style={{ fontSize: "16px" }}
            >
              <option value="">Todos</option>
              <option value="todo">Tarefa</option>
              <option value="call">Ligação</option>
              <option value="email">E-mail</option>
              <option value="follow_up">Follow-up</option>
              <option value="meeting">Reunião</option>
              <option value="research">Pesquisa</option>
            </select>
          </div>

          <div>
            <span className="block text-xs font-medium text-text-muted mb-1">
              Etiquetas
            </span>
            <LabelFilterSelect
              labels={labels}
              selected={filters.labelIds}
              onChange={(labelIds) => set("labelIds", labelIds)}
            />
          </div>

          {showProjectFilter && (
            <div>
              <label
                htmlFor="task-filter-project"
                className="block text-xs font-medium text-text-muted mb-1"
              >
                Projeto
              </label>
              <select
                id="task-filter-project"
                value={filters.projectId}
                onChange={(e) => set("projectId", e.target.value)}
                className={selectClass}
                style={{ fontSize: "16px" }}
              >
                <option value="">Todos</option>
                {projects?.map((project) => (
                  <option key={project._id} value={project._id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// LabelFilterSelect — multi-seleção (qualquer etiqueta marcada casa)
// ============================================================================

function LabelFilterSelect({
  labels,
  selected,
  onChange,
}: {
  labels: TaskLabelOption[] | undefined;
  selected: Id<"taskLabels">[];
  onChange: (labelIds: Id<"taskLabels">[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const toggle = (labelId: Id<"taskLabels">) => {
    onChange(
      selected.includes(labelId)
        ? selected.filter((id) => id !== labelId)
        : [...selected, labelId]
    );
  };

  const summary =
    selected.length === 0
      ? "Todas"
      : selected.length === 1
        ? (labels?.find((l) => l._id === selected[0])?.name ?? "1 etiqueta")
        : `${selected.length} etiquetas`;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={open}
        className={cn(
          "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-field text-sm",
          "bg-surface-raised border border-border-strong text-text-primary",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
        )}
      >
        <Tag size={14} className="text-text-muted shrink-0" aria-hidden="true" />
        <span className="truncate">{summary}</span>
        <ChevronDown
          size={14}
          className={cn(
            "ml-auto shrink-0 text-text-muted transition-transform",
            open && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="absolute z-40 top-full mt-1 left-0 w-56 max-h-56 overflow-y-auto bg-surface-overlay border border-border rounded-xl shadow-elevated p-2 animate-fade-in-up">
          {labels === undefined ? (
            <p className="px-2 py-2 text-xs text-text-muted">Carregando...</p>
          ) : labels.length === 0 ? (
            <p className="px-2 py-2 text-xs text-text-muted">
              Nenhuma etiqueta criada ainda.
            </p>
          ) : (
            <>
              {labels.map((label) => (
                <Checkbox
                  key={label._id}
                  checked={selected.includes(label._id)}
                  onChange={() => toggle(label._id)}
                  containerClassName="w-full px-2 py-2 rounded-lg hover:bg-surface-raised"
                  label={
                    <span className="flex items-center gap-2 text-sm text-text-primary">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: label.color }}
                        aria-hidden="true"
                      />
                      <span className="truncate">{label.name}</span>
                    </span>
                  }
                />
              ))}
              {selected.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="w-full mt-1 px-2 py-2 text-left text-xs text-text-muted hover:text-text-primary hover:bg-surface-raised rounded-lg transition-colors"
                >
                  Limpar etiquetas
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
