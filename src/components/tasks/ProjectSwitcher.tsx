import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
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

// Dimensões do menu (w-56 + 4 itens e a divisória): usadas só para decidir
// alinhamento/flip antes da medição real do nó.
const MENU_WIDTH = 224;
const MENU_HEIGHT = 200;
const MENU_GAP = 8;

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(
    null
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedProject =
    projects?.find((p) => p._id === selectedProjectId) ?? null;

  // O menu vive num portal (`document.body`) porque a nav é um container de
  // rolagem horizontal — `overflow-x: auto` também recorta no eixo Y, então um
  // dropdown absoluto aqui dentro ficaria escondido/cortado.
  const positionMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = menuRef.current?.offsetWidth ?? MENU_WIDTH;
    const height = menuRef.current?.offsetHeight ?? MENU_HEIGHT;
    const maxLeft = Math.max(MENU_GAP, window.innerWidth - width - MENU_GAP);
    const left = Math.min(Math.max(MENU_GAP, rect.right - width), maxLeft);
    const openUp =
      rect.bottom + MENU_GAP + height > window.innerHeight &&
      rect.top - MENU_GAP - height >= 0;
    const top = openUp
      ? rect.top - MENU_GAP - height
      : rect.bottom + MENU_GAP;
    setMenuPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    positionMenu();
  }, [menuOpen, positionMenu]);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    // `capture` p/ acompanhar também a rolagem de containers internos
    // (a própria nav, o main da página).
    const handleReflow = () => positionMenu();
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleReflow, true);
    window.addEventListener("resize", handleReflow);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleReflow, true);
      window.removeEventListener("resize", handleReflow);
    };
  }, [menuOpen, positionMenu]);

  // Fecha o menu se o projeto ativo deixar de existir (exclusão/arquivamento).
  useEffect(() => {
    if (!selectedProject) setMenuOpen(false);
  }, [selectedProject]);

  const runAction = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

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
        <>
          <button
            type="button"
            ref={triggerRef}
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={`Gerenciar projeto ${selectedProject.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={cn(
              "flex items-center justify-center min-w-[44px] min-h-[44px] rounded-full transition-colors shrink-0",
              "bg-surface-raised border border-border text-text-secondary hover:text-text-primary hover:bg-surface-overlay",
              "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
            )}
          >
            <MoreVertical size={18} />
          </button>

          {menuOpen &&
            createPortal(
              <div
                role="menu"
                ref={menuRef}
                style={{
                  top: menuPos?.top ?? 0,
                  left: menuPos?.left ?? 0,
                  visibility: menuPos ? "visible" : "hidden",
                }}
                className="fixed z-[60] w-56 bg-surface-overlay border border-border rounded-xl shadow-elevated overflow-hidden animate-fade-in-up"
              >
                <MenuItem
                  icon={Pencil}
                  label="Editar projeto"
                  onClick={() => runAction(() => onEdit(selectedProject))}
                />
                <MenuItem
                  icon={Columns3}
                  label="Gerenciar colunas"
                  onClick={() =>
                    runAction(() => onManageColumns(selectedProject))
                  }
                />
                <MenuItem
                  icon={Archive}
                  label="Arquivar projeto"
                  onClick={() => runAction(() => onArchive(selectedProject))}
                />
                <div className="border-t border-border" />
                <MenuItem
                  icon={Trash2}
                  label="Excluir projeto"
                  danger
                  onClick={() => runAction(() => onDelete(selectedProject))}
                />
              </div>,
              document.body
            )}
        </>
      )}
    </nav>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors min-h-[44px]",
        danger
          ? "text-semantic-error hover:bg-semantic-error/10"
          : "text-text-primary hover:bg-surface-raised"
      )}
    >
      <Icon size={16} className="shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}
