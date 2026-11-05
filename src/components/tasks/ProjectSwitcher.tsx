import type { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import {
  Archive,
  Columns3,
  ListChecks,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { TaskColumnDoc } from "./TaskKanbanBoard";

// Seletor de projetos de tarefas: linha de pills com rolagem horizontal
// (mesma UX no mobile e no desktop) + menu de gestão do projeto ativo,
// visível apenas para admin/manager.

export interface TaskProjectSummary {
  _id: Id<"taskProjects">;
  name: string;
  description?: string;
  color?: string;
  order: number;
  archivedAt?: number;
  openTaskCount: number;
  columns: TaskColumnDoc[];
}

interface ProjectSwitcherProps {
  projects: TaskProjectSummary[] | undefined;
  selectedProjectId: Id<"taskProjects"> | null;
  onSelect: (projectId: Id<"taskProjects"> | null) => void;
  canManage: boolean;
  onCreate: () => void;
  onEdit: (project: TaskProjectSummary) => void;
  onManageColumns: (project: TaskProjectSummary) => void;
  onArchive: (project: TaskProjectSummary) => void;
  onDelete: (project: TaskProjectSummary) => void;
}

export function ProjectSwitcher({
  projects,
  selectedProjectId,
  onSelect,
  canManage,
  onCreate,
  onEdit,
  onManageColumns,
  onArchive,
  onDelete,
}: ProjectSwitcherProps) {
  const selectedProject =
    projects?.find((p) => p._id === selectedProjectId) ?? null;

  // O menu vive num portal do `Menu` (popover no desktop, folha no mobile): a nav
  // é um container de rolagem horizontal e recortaria um dropdown absoluto.
  const manageItems = (project: TaskProjectSummary): MenuItem[] => [
    { id: "edit", label: "Editar projeto", icon: <Pencil size={16} aria-hidden="true" />, onSelect: () => onEdit(project) },
    {
      id: "columns",
      label: "Gerenciar colunas",
      icon: <Columns3 size={16} aria-hidden="true" />,
      onSelect: () => onManageColumns(project),
    },
    { id: "archive", label: "Arquivar projeto", icon: <Archive size={16} aria-hidden="true" />, onSelect: () => onArchive(project) },
    {
      id: "delete",
      label: "Excluir projeto",
      icon: <Trash2 size={16} aria-hidden="true" />,
      danger: true,
      separatorBefore: true,
      onSelect: () => onDelete(project),
    },
  ];

  return (
    <nav
      aria-label="Projetos de tarefas"
      className="flex items-center gap-2 overflow-x-auto pb-1 -mx-4 px-4 md:mx-0 md:px-0"
    >
      <button
        type="button"
        onClick={() => onSelect(null)}
        aria-current={selectedProjectId === null ? "true" : undefined}
        className={cn(
          "flex items-center gap-2 px-3.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors min-h-[44px] shrink-0",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base",
          selectedProjectId === null
            ? "bg-brand-600 text-white"
            : "bg-surface-raised text-text-secondary border border-border hover:bg-surface-overlay"
        )}
      >
        <ListChecks size={16} aria-hidden="true" />
        Todas as tarefas
      </button>

      {projects?.map((project) => {
        const active = project._id === selectedProjectId;
        return (
          <button
            key={project._id}
            type="button"
            onClick={() => onSelect(project._id)}
            aria-current={active ? "true" : undefined}
            className={cn(
              "flex items-center gap-2 px-3.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors min-h-[44px] shrink-0 max-w-[220px]",
              "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base",
              active
                ? "bg-brand-600 text-white"
                : "bg-surface-raised text-text-secondary border border-border hover:bg-surface-overlay"
            )}
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: project.color || "#71717A" }}
              aria-hidden="true"
            />
            <span className="truncate">{project.name}</span>
            {project.openTaskCount > 0 && (
              <span
                className={cn(
                  "text-xs font-bold tabular-nums",
                  active ? "text-white/80" : "text-text-muted"
                )}
              >
                {project.openTaskCount}
              </span>
            )}
          </button>
        );
      })}

      {canManage && (
        <button
          type="button"
          onClick={onCreate}
          className={cn(
            "flex items-center gap-1.5 px-3.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors min-h-[44px] shrink-0",
            "bg-surface-raised text-brand-500 border border-dashed border-border-strong hover:bg-brand-500/10",
            "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
          )}
        >
          <Plus size={16} aria-hidden="true" />
          <span className="hidden sm:inline">Novo projeto</span>
          <span className="sr-only sm:hidden">Novo projeto</span>
        </button>
      )}

      {canManage && selectedProject && (
        <Menu
          ariaLabel={`Gerenciar projeto ${selectedProject.name}`}
          items={manageItems(selectedProject)}
          trigger={(props) => (
            <button
              type="button"
              {...props}
              aria-label={`Gerenciar projeto ${selectedProject.name}`}
              className={cn(
                "flex items-center justify-center min-w-[44px] min-h-[44px] rounded-full transition-colors shrink-0",
                "bg-surface-raised border border-border text-text-secondary hover:text-text-primary hover:bg-surface-overlay",
                "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
              )}
            >
              <MoreVertical size={18} />
            </button>
          )}
        />
      )}
    </nav>
  );
}
