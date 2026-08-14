import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { Link2, Plus, X } from "lucide-react";
import { STATUS_LABELS } from "@/components/tasks/TaskKanbanBoard";

interface TaskBlocker {
  _id: Id<"tasks">;
  title: string;
  status: string;
}

interface DependenciesSectionProps {
  taskId: Id<"tasks">;
  organizationId: Id<"organizations">;
  /** Dependências enriquecidas (`task.blockers` de `api.tasks.getTask`). */
  blockers: TaskBlocker[];
  /** Chamado com a lista completa de IDs após adicionar/remover — mapeie para `updateTask({ blockedBy })`. */
  onChange: (blockedBy: Id<"tasks">[]) => void;
  className?: string;
}

export function DependenciesSection({
  taskId,
  organizationId,
  blockers,
  onChange,
  className,
}: DependenciesSectionProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const results = useQuery(
    api.tasks.getTasks,
    open ? { organizationId, search: search.trim() || undefined, limit: 20 } : "skip"
  );

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
    };
  }, [open]);

  // Esc fecha só este popover — precisa ser um handler React que chama
  // stopPropagation antes do evento nativo chegar ao `document`, senão o
  // Escape também fecha o SlideOver por trás.
  const handlePopoverKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    }
  };

  const blockedIds = new Set(blockers.map((b) => b._id));
  const candidates = (results ?? []).filter(
    (t: any) => t._id !== taskId && !blockedIds.has(t._id)
  );

  const addDependency = (id: Id<"tasks">) => {
    onChange([...blockers.map((b) => b._id), id]);
    setOpen(false);
    setSearch("");
  };

  const removeDependency = (id: Id<"tasks">) => {
    onChange(blockers.filter((b) => b._id !== id).map((b) => b._id));
  };

  return (
    <div className={cn("px-4 py-4", className)}>
      <h4 className="text-sm font-semibold text-text-primary mb-2">Dependências</h4>

      {blockers.length > 0 && (
        <div className="space-y-1 mb-2">
          {blockers.map((blocker) => {
            const isDone = blocker.status === "completed" || blocker.status === "cancelled";
            return (
              <div
                key={blocker._id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-surface-sunken"
              >
                <Link2
                  size={14}
                  className={cn("shrink-0", isDone ? "text-text-muted" : "text-semantic-warning")}
                />
                <span
                  className={cn(
                    "flex-1 min-w-0 text-sm truncate",
                    isDone ? "text-text-muted line-through" : "text-text-primary"
                  )}
                >
                  {blocker.title}
                </span>
                <span className="text-xs text-text-muted shrink-0">
                  {STATUS_LABELS[blocker.status] ?? blocker.status}
                </span>
                <button
                  type="button"
                  onClick={() => removeDependency(blocker._id)}
                  aria-label={`Remover dependência ${blocker.title}`}
                  className="p-0.5 text-text-muted hover:text-semantic-error transition-colors shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="relative" ref={rootRef}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-surface-raised border border-border-strong text-text-secondary hover:border-brand-500 hover:text-text-primary transition-colors min-h-[28px]"
          aria-label="Adicionar dependência"
          aria-expanded={open}
        >
          <Plus size={12} />
          Adicionar dependência
        </button>

        {open && (
          <div
            className="absolute z-50 mt-2 w-72 max-w-[85vw] bg-surface-overlay border border-border rounded-xl shadow-elevated p-2"
            onKeyDown={handlePopoverKeyDown}
          >
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar tarefa..."
              className="w-full px-2.5 py-1.5 bg-surface-raised border border-border-strong rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500"
              style={{ fontSize: "16px" }}
              autoFocus
            />
            <div className="max-h-48 overflow-y-auto space-y-0.5 mt-2">
              {results === undefined && (
                <div className="flex justify-center py-3">
                  <Spinner size="sm" />
                </div>
              )}
              {results !== undefined && candidates.length === 0 && (
                <p className="px-2 py-2 text-xs text-text-muted">Nenhuma tarefa encontrada.</p>
              )}
              {candidates.map((t: any) => (
                <button
                  key={t._id}
                  type="button"
                  onClick={() => addDependency(t._id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-raised text-left transition-colors"
                >
                  <span className="flex-1 min-w-0 text-sm text-text-primary truncate">{t.title}</span>
                  <span className="text-xs text-text-muted shrink-0">
                    {STATUS_LABELS[t.status] ?? t.status}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
