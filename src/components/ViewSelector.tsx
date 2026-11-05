import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { ChevronDown, Share2, X, Plus } from "lucide-react";
import { toast } from "sonner";

export interface ViewFilters {
  boardId?: Id<"boards">;
  stageIds?: Id<"stages">[];
  assignedTo?: Id<"teamMembers">;
  priority?: "low" | "medium" | "high" | "urgent";
  temperature?: "cold" | "warm" | "hot";
  tags?: string[];
  hasContact?: boolean;
  company?: string;
  minValue?: number;
  maxValue?: number;
}

interface ViewSelectorProps {
  organizationId: Id<"organizations">;
  entityType: "leads" | "contacts";
  currentViewId: string | null;
  onViewChange: (viewId: string | null, filters: ViewFilters) => void;
  className?: string;
}

interface DefaultView {
  id: string;
  label: string;
  filters: ViewFilters;
}

export function ViewSelector({
  organizationId,
  entityType,
  currentViewId,
  onViewChange,
  className,
}: ViewSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const savedViews = useQuery(api.savedViews.getSavedViews, {
    organizationId,
    entityType,
  });

  const currentTeamMember = useQuery(api.teamMembers.getCurrentTeamMember, {
    organizationId,
  });

  const deleteSavedView = useMutation(api.savedViews.deleteSavedView);

  // Define default views based on entity type
  const defaultViews: DefaultView[] =
    entityType === "leads"
      ? [
          { id: "all", label: "Todos os leads", filters: {} },
          {
            id: "my-leads",
            label: "Meus leads",
            filters: currentTeamMember
              ? { assignedTo: currentTeamMember._id }
              : {},
          },
          {
            id: "unassigned",
            label: "Não atribuídos",
            filters: { assignedTo: undefined },
          },
          { id: "hot", label: "Leads quentes", filters: { temperature: "hot" } },
          {
            id: "high-priority",
            label: "Alta prioridade",
            filters: { priority: "urgent" },
          },
        ]
      : [
          { id: "all", label: "Todos os contatos", filters: {} },
          {
            id: "no-leads",
            label: "Sem leads vinculados",
            filters: { hasContact: false },
          },
        ];

  // Get current view label
  const getCurrentViewLabel = () => {
    // Check if it's a default view
    const defaultView = defaultViews.find((v) => v.id === currentViewId);
    if (defaultView) return defaultView.label;

    // Check if it's a saved view
    if (savedViews) {
      const savedView = savedViews.find((v) => v._id === currentViewId);
      if (savedView) return savedView.name;
    }

    // Fallback
    return defaultViews[0].label;
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const handleSelectView = (viewId: string | null, filters: ViewFilters) => {
    onViewChange(viewId, filters);
    setIsOpen(false);
  };

  const handleDeleteView = async (
    e: React.MouseEvent,
    viewId: Id<"savedViews">
  ) => {
    e.stopPropagation();

    try {
      await deleteSavedView({ viewId });
      toast.success("Filtro salvo excluído");

      // If we're deleting the current view, switch to default
      if (currentViewId === viewId) {
        handleSelectView(defaultViews[0].id, defaultViews[0].filters);
      }
    } catch (error: any) {
      toast.error(error.message || "Não foi possível excluir o filtro salvo.");
    }
  };

  return (
    <div className={cn("relative", className)} ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-full",
          "bg-surface-raised border border-border-strong",
          "text-sm font-medium text-text-primary",
          "hover:bg-surface-overlay transition-colors",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
        )}
      >
        <span>{getCurrentViewLabel()}</span>
        <ChevronDown
          size={16}
          className={cn(
            "text-text-muted transition-transform",
            isOpen && "rotate-180"
          )}
        />
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div
          className={cn(
            "absolute top-full mt-2 left-0 z-50",
            "w-64 bg-surface-overlay border border-border rounded-xl",
            "shadow-elevated overflow-hidden",
            "animate-fade-in-up"
          )}
        >
          {/* Default Views Section */}
          <div className="p-2">
            <div className="px-3 py-2 text-xs font-medium text-text-muted uppercase tracking-wide">
              Padrão
            </div>
            {defaultViews.map((view) => (
              <button
                key={view.id}
                onClick={() => handleSelectView(view.id, view.filters)}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-lg",
                  "text-sm text-text-primary",
                  "hover:bg-surface-raised transition-colors",
                  currentViewId === view.id &&
                    "bg-brand-500/10 text-brand-500 font-medium"
                )}
              >
                {view.label}
              </button>
            ))}
          </div>

          {/* Saved Views Section */}
          {savedViews && savedViews.length > 0 && (
            <>
              <div className="border-t border-border" />
              <div className="p-2">
                <div className="px-3 py-2 text-xs font-medium text-text-muted uppercase tracking-wide">
                  Filtros salvos
                </div>
                {savedViews.map((view) => (
                  <div
                    key={view._id}
                    className={cn(
                      "group flex items-center justify-between px-3 py-2 rounded-lg",
                      "hover:bg-surface-raised transition-colors",
                      currentViewId === view._id &&
                        "bg-brand-500/10"
                    )}
                  >
                    <button
                      onClick={() =>
                        handleSelectView(view._id, view.filters)
                      }
                      className={cn(
                        "flex-1 text-left flex items-center gap-2 text-sm",
                        currentViewId === view._id
                          ? "text-brand-500 font-medium"
                          : "text-text-primary"
                      )}
                    >
                      <span>{view.name}</span>
                      {view.isShared && (
                        <Share2
                          size={14}
                          className="text-text-muted"
                          aria-label="Compartilhado"
                        />
                      )}
                    </button>
                    <button
                      onClick={(e) => handleDeleteView(e, view._id)}
                      className={cn(
                        "p-1 rounded opacity-0 group-hover:opacity-100",
                        "text-text-muted hover:text-semantic-error",
                        "transition-all"
                      )}
                      aria-label="Excluir filtro salvo"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Create New View Button */}
          <div className="border-t border-border" />
          <div className="p-2">
            <button
              onClick={() => {
                setShowCreateModal(true);
                setIsOpen(false);
              }}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 rounded-lg",
                "text-sm font-medium text-brand-500",
                "hover:bg-brand-500/10 transition-colors"
              )}
            >
              <Plus size={16} />
              <span>Criar filtro salvo</span>
            </button>
          </div>
        </div>
      )}

      {/* Create View Modal - We'll import this after creating it */}
      {showCreateModal && (
        <CreateViewModal
          organizationId={organizationId}
          entityType={entityType}
          onClose={() => setShowCreateModal(false)}
          onCreated={(viewId) => {
            setShowCreateModal(false);
            // Fetch the newly created view's filters
            const newView = savedViews?.find((v) => v._id === viewId);
            if (newView) {
              handleSelectView(viewId, newView.filters);
            }
          }}
        />
      )}
    </div>
  );
}

// Import CreateViewModal - will be defined next
import { CreateViewModal } from "./CreateViewModal";
