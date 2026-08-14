import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Bookmark, ChevronDown, Share2, X } from "lucide-react";
import { toast } from "sonner";

// Filtros salvos da página de tarefas (savedViews com entityType "tasks").
// O conjunto atual de filtros da página é serializado nos campos de task do
// validator de savedViews.

export interface TaskSavedFilters {
  statuses?: ("pending" | "in_progress" | "completed" | "cancelled")[];
  priorities?: ("low" | "medium" | "high" | "urgent")[];
  taskType?: "task" | "reminder";
  activityType?:
    | "todo"
    | "call"
    | "email"
    | "follow_up"
    | "meeting"
    | "research";
  projectId?: Id<"taskProjects">;
  labelIds?: Id<"taskLabels">[];
  assigneeIds?: Id<"teamMembers">[];
  dueFilter?: "overdue" | "today" | "week" | "month" | "none";
}

interface SavedView {
  _id: Id<"savedViews">;
  name: string;
  isShared?: boolean;
  filters: TaskSavedFilters;
}

interface SavedFiltersMenuProps {
  organizationId: Id<"organizations">;
  /** Filtros atuais da página, prontos para serem salvos. */
  currentFilters: TaskSavedFilters;
  onApply: (filters: TaskSavedFilters) => void;
}

export function SavedFiltersMenu({
  organizationId,
  currentFilters,
  onApply,
}: SavedFiltersMenuProps) {
  const views = useQuery(api.savedViews.getSavedViews, {
    organizationId,
    entityType: "tasks",
  }) as SavedView[] | undefined;

  const createSavedView = useMutation(api.savedViews.createSavedView);
  const deleteSavedView = useMutation(api.savedViews.deleteSavedView);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [name, setName] = useState("");
  const [isShared, setIsShared] = useState(false);
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

  useEffect(() => {
    if (!open) {
      setShowSaveForm(false);
      setName("");
      setIsShared(false);
    }
  }, [open]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Dê um nome para o filtro");
      return;
    }
    setSaving(true);
    try {
      await createSavedView({
        organizationId,
        name: trimmed,
        entityType: "tasks",
        filters: currentFilters,
        isShared,
      });
      toast.success("Filtro salvo");
      setShowSaveForm(false);
      setName("");
      setIsShared(false);
    } catch (error: any) {
      toast.error(error?.message || "Falha ao salvar filtro");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (
    e: React.MouseEvent,
    viewId: Id<"savedViews">
  ) => {
    e.stopPropagation();
    try {
      await deleteSavedView({ viewId });
      toast.success("Filtro excluído");
    } catch (error: any) {
      toast.error(error?.message || "Falha ao excluir filtro");
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm min-h-[36px]",
          "bg-surface-raised border border-border text-text-secondary",
          "hover:text-text-primary hover:bg-surface-overlay transition-colors",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
        )}
      >
        <Bookmark size={14} aria-hidden="true" />
        <span className="hidden sm:inline">Filtros salvos</span>
        <ChevronDown
          size={14}
          className={cn("transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-64 bg-surface-overlay border border-border rounded-xl shadow-elevated overflow-hidden animate-fade-in-up">
          <div className="max-h-56 overflow-y-auto p-2">
            {views === undefined ? (
              <p className="px-3 py-2 text-xs text-text-muted">Carregando...</p>
            ) : views.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-muted">
                Nenhum filtro salvo ainda.
              </p>
            ) : (
              views.map((view) => (
                <div
                  key={view._id}
                  className="group flex items-center gap-1 rounded-lg hover:bg-surface-raised transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onApply(view.filters ?? {});
                      setOpen(false);
                    }}
                    className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 text-left text-sm text-text-primary"
                  >
                    <span className="truncate">{view.name}</span>
                    {view.isShared && (
                      <Share2
                        size={13}
                        className="shrink-0 text-text-muted"
                        aria-label="Compartilhado com a equipe"
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => void handleDelete(e, view._id)}
                    aria-label={`Excluir filtro ${view.name}`}
                    className="p-2 mr-1 rounded-lg text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="border-t border-border p-2">
            {showSaveForm ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleSave();
                    }
                  }}
                  placeholder="Nome do filtro"
                  maxLength={40}
                  autoFocus
                  aria-label="Nome do filtro"
                  className="w-full bg-surface-sunken border border-border-strong rounded-field px-2.5 py-2 text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                  style={{ fontSize: "16px" }}
                />
                <Checkbox
                  checked={isShared}
                  onChange={(e) => setIsShared(e.target.checked)}
                  label={
                    <span className="text-xs text-text-secondary">
                      Compartilhar com a equipe
                    </span>
                  }
                  containerClassName="px-1"
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="flex-1"
                    onClick={() => void handleSave()}
                    disabled={saving || !name.trim()}
                  >
                    Salvar
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowSaveForm(false)}
                    disabled={saving}
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowSaveForm(true)}
                className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium text-brand-500 hover:bg-brand-500/10 transition-colors min-h-[44px]"
              >
                <Bookmark size={16} aria-hidden="true" />
                Salvar filtros atuais
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
