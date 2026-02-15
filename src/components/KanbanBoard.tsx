import React, { useState, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { LeadDetailPanel } from "./LeadDetailPanel";
import { CreateLeadModal } from "./CreateLeadModal";
import { ManageStagesModal } from "./ManageStagesModal";
import { EditBoardModal } from "./EditBoardModal";
import { CloseReasonModal } from "./CloseReasonModal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { Plus, Settings2, X, ChevronDown, Clock, MoreHorizontal, Palette, Edit2, Trash2 } from "lucide-react";
import { SpotlightTooltip } from "@/components/onboarding/SpotlightTooltip";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCorners,
  DragEndEvent,
  DragStartEvent,
  useDraggable,
  useDroppable,
} from "@dnd-kit/core";
import { toast } from "sonner";

interface KanbanBoardProps {
  organizationId: Id<"organizations">;
}

interface Lead {
  _id: Id<"leads">;
  title: string;
  value: number;
  priority: string;
  temperature: string;
  stageId: Id<"stages">;
  lastActivityAt: number;
  contact?: {
    _id: Id<"contacts">;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    company?: string;
  } | null;
  assignee?: {
    _id: Id<"teamMembers">;
    name: string;
    type: "human" | "ai";
  } | null;
  tags?: string[];
}

interface Stage {
  _id: Id<"stages">;
  name: string;
  color: string;
  isClosedWon?: boolean;
  isClosedLost?: boolean;
}

// Draggable Card Component
function DraggableCard({ lead, onClick }: { lead: Lead; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead._id,
  });

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        opacity: isDragging ? 0.5 : 1,
      }
    : undefined;

  const priorityColor = {
    urgent: "bg-semantic-error",
    high: "bg-semantic-warning",
    medium: "bg-brand-500",
    low: "bg-surface-overlay",
  }[lead.priority] || "bg-surface-overlay";

  const getPriorityVariant = (priority: string): "error" | "warning" | "default" => {
    if (priority === "urgent") return "error";
    if (priority === "high") return "warning";
    return "default";
  };

  const getTemperatureVariant = (temperature: string): "error" | "warning" | "info" => {
    if (temperature === "hot") return "error";
    if (temperature === "warm") return "warning";
    return "info";
  };

  const getPriorityLabel = (priority: string): string => {
    const labels: Record<string, string> = {
      urgent: "Urgente",
      high: "Alta",
      medium: "Média",
      low: "Baixa",
    };
    return labels[priority] || priority;
  };

  const getTemperatureLabel = (temperature: string): string => {
    const labels: Record<string, string> = {
      hot: "Quente",
      warm: "Morno",
      cold: "Frio",
    };
    return labels[temperature] || temperature;
  };

  // Calculate days since last activity
  const daysSinceActivity = Math.floor((Date.now() - lead.lastActivityAt) / 86400000);
  const agingLabel = daysSinceActivity >= 7 ? `${Math.floor(daysSinceActivity / 7)}sem` : `${daysSinceActivity}d`;
  const agingColor = daysSinceActivity > 7
    ? "text-semantic-error"
    : daysSinceActivity >= 3
      ? "text-semantic-warning"
      : "text-semantic-success";

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className="bg-surface-raised p-4 rounded-card border border-border cursor-pointer hover:border-border-strong hover:shadow-card-hover transition-all touch-none relative"
    >
      {/* Priority Color Bar */}
      <div className={cn("absolute left-0 top-0 bottom-0 w-1 rounded-l-card", priorityColor)} />

      <h4 className="font-medium text-text-primary mb-2 pl-2">{lead.title}</h4>

      {lead.contact ? (
        <p className="text-sm text-text-secondary mb-2 pl-2">
          {lead.contact.firstName} {lead.contact.lastName}
          {lead.contact.company && ` • ${lead.contact.company}`}
        </p>
      ) : (
        <p className="text-xs text-text-muted mb-2 pl-2 italic">Sem contato</p>
      )}

      <div className="flex items-center justify-between mb-3 pl-2">
        <span className="text-lg font-semibold text-brand-400 tabular-nums">
          R$ {lead.value.toLocaleString("pt-BR")}
        </span>

        {lead.assignee && (
          <Avatar name={lead.assignee.name} type={lead.assignee.type} size="sm" />
        )}
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap pl-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={getPriorityVariant(lead.priority)}>
            {getPriorityLabel(lead.priority)}
          </Badge>

          <Badge variant={getTemperatureVariant(lead.temperature)}>
            {getTemperatureLabel(lead.temperature)}
          </Badge>

          {lead.tags && lead.tags.length > 0 && (
            <>
              {lead.tags.slice(0, 2).map((tag, idx) => (
                <Badge key={idx} variant="default">
                  {tag}
                </Badge>
              ))}
              {lead.tags.length > 2 && (
                <span className="text-xs text-text-muted">+{lead.tags.length - 2} mais</span>
              )}
            </>
          )}
        </div>

        {/* Days in Stage Indicator */}
        <div className={cn("flex items-center gap-1 text-xs font-medium", agingColor)}>
          <Clock size={12} />
          <span>{agingLabel}</span>
        </div>
      </div>
    </div>
  );
}

// Droppable Column Component
function DroppableColumn({
  stage,
  leads,
  totalValue,
  isOver,
  onLeadClick,
  onQuickAdd,
  onStageMenu,
}: {
  stage: Stage;
  leads: Lead[];
  totalValue: number;
  isOver: boolean;
  onLeadClick: (leadId: Id<"leads">) => void;
  onQuickAdd: () => void;
  onStageMenu: (e: React.MouseEvent) => void;
}) {
  const { setNodeRef } = useDroppable({
    id: stage._id,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex-shrink-0 w-80 bg-surface-sunken rounded-card p-4 flex flex-col snap-start transition-all",
        isOver && "ring-2 ring-brand-500/50"
      )}
    >
      {/* Color accent bar at top */}
      <div className="h-[3px] rounded-t-card -mx-4 -mt-4 mb-3" style={{ backgroundColor: stage.color }} />

      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: stage.color }} />
            <h3 className="font-semibold text-text-primary">{stage.name}</h3>
            {stage.isClosedWon && <Badge variant="success">Ganho</Badge>}
            {stage.isClosedLost && <Badge variant="error">Perdido</Badge>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onStageMenu}
              className="p-1 rounded-full text-text-muted hover:text-brand-500 hover:bg-surface-raised transition-colors"
              aria-label="Menu da etapa"
            >
              <MoreHorizontal size={16} />
            </button>
            <button
              onClick={onQuickAdd}
              className="p-1 rounded-full text-text-muted hover:text-brand-500 hover:bg-surface-raised transition-colors"
              aria-label="Adicionar lead rápido"
            >
              <Plus size={16} />
            </button>
          </div>
        </div>
        <div className="text-xs text-text-muted tabular-nums">
          {leads.length} leads · R$ {totalValue.toLocaleString("pt-BR")}
        </div>
      </div>

      <div className="space-y-3 flex-1 overflow-y-auto">
        {leads.map((lead) => (
          <DraggableCard key={lead._id} lead={lead} onClick={() => onLeadClick(lead._id)} />
        ))}
      </div>
    </div>
  );
}

// Quick Add Form Component
function QuickAddForm({
  stageId,
  boardId,
  organizationId,
  onClose,
}: {
  stageId: Id<"stages">;
  boardId: Id<"boards">;
  organizationId: Id<"organizations">;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [value, setValue] = useState(0);
  const createLead = useMutation(api.leads.createLead);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    try {
      await toast.promise(
        createLead({
          organizationId,
          boardId,
          stageId,
          title: title.trim(),
          value,
          priority: "medium",
          temperature: "cold",
        }),
        {
          loading: "Criando lead...",
          success: "Lead criado!",
          error: "Falha ao criar lead",
        }
      );
      onClose();
    } catch (error) {
      console.error("Failed to create lead:", error);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-surface-raised p-3 rounded-card border border-border mb-3">
      <div className="space-y-2">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Título do lead..."
          className="w-full px-3 py-2 bg-surface-sunken border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted text-sm"
          style={{ fontSize: "16px" }}
          autoFocus
        />
        <input
          type="number"
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          placeholder="Valor (R$)"
          min={0}
          className="w-full px-3 py-2 bg-surface-sunken border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted text-sm"
          style={{ fontSize: "16px" }}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" className="flex-1">
            Criar
          </Button>
          <Button type="button" onClick={onClose} variant="secondary" size="sm">
            <X size={16} />
          </Button>
        </div>
      </div>
    </form>
  );
}

// Stage Edit Popover Component
function StageEditPopover({
  stage,
  anchor,
  onClose,
  onUpdate,
  onDelete,
}: {
  stage: Stage;
  anchor: { top: number; left: number };
  onClose: () => void;
  onUpdate: (stageId: Id<"stages">, updates: Record<string, unknown>) => void;
  onDelete: (stageId: Id<"stages">) => void;
}) {
  const [name, setName] = useState(stage.name);
  const [selectedColor, setSelectedColor] = useState(stage.color);

  const PRESET_COLORS = [
    "#71717A", // zinc
    "#EF4444", // red
    "#F97316", // orange
    "#EAB308", // yellow
    "#22C55E", // green
    "#14B8A6", // teal
    "#3B82F6", // blue
    "#8B5CF6", // violet
    "#EC4899", // pink
    "#6366F1", // indigo
    "#06B6D4", // cyan
    "#A855F7", // purple
  ];

  // Clamp to viewport so popover never overflows off-screen
  const popoverWidth = 288; // w-72
  const popoverHeight = 420; // approximate
  const top = Math.min(anchor.top, window.innerHeight - popoverHeight - 8);
  const left = Math.min(anchor.left, window.innerWidth - popoverWidth - 8);

  const handleSaveName = () => {
    if (name.trim() && name.trim() !== stage.name) {
      onUpdate(stage._id, { name: name.trim() });
    }
  };

  const handleColorSelect = (color: string) => {
    setSelectedColor(color);
    onUpdate(stage._id, { color });
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed w-72 bg-surface-overlay border border-border rounded-card shadow-elevated z-50 p-4 space-y-4"
        style={{ top, left }}
      >
        {/* Name field */}
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Nome</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); }}
            onBlur={handleSaveName}
            className="w-full px-3 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm"
            style={{ fontSize: "16px" }}
          />
        </div>

        {/* Color picker */}
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Cor</label>
          <div className="grid grid-cols-6 gap-2">
            {PRESET_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => handleColorSelect(color)}
                className={cn(
                  "w-8 h-8 rounded-lg transition-all",
                  selectedColor === color
                    ? "ring-2 ring-brand-500 ring-offset-2 ring-offset-surface-overlay scale-110"
                    : "hover:scale-110"
                )}
                style={{ backgroundColor: color }}
                aria-label={`Cor ${color}`}
              />
            ))}
          </div>
          {/* Custom color input */}
          <div className="flex items-center gap-2 mt-2">
            <input
              type="color"
              value={selectedColor}
              onChange={(e) => handleColorSelect(e.target.value)}
              className="w-8 h-8 rounded cursor-pointer border border-border-strong"
              title="Cor personalizada"
            />
            <span className="text-xs text-text-muted">Personalizada</span>
          </div>
        </div>

        {/* Won/Lost toggles */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={stage.isClosedWon || false}
              onChange={(e) => {
                onUpdate(stage._id, { isClosedWon: e.target.checked, isClosedLost: false });
              }}
              className="w-4 h-4 text-brand-600 bg-surface-raised border-border-strong rounded focus:ring-2 focus:ring-brand-500"
            />
            <span className="text-xs text-text-secondary">Fechado - Ganho</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={stage.isClosedLost || false}
              onChange={(e) => {
                onUpdate(stage._id, { isClosedLost: e.target.checked, isClosedWon: false });
              }}
              className="w-4 h-4 text-brand-600 bg-surface-raised border-border-strong rounded focus:ring-2 focus:ring-brand-500"
            />
            <span className="text-xs text-text-secondary">Fechado - Perdido</span>
          </label>
        </div>

        {/* Divider + Delete */}
        <div className="pt-2 border-t border-border">
          <button
            onClick={() => {
              if (confirm(`Excluir a etapa "${stage.name}"?`)) {
                onDelete(stage._id);
                onClose();
              }
            }}
            className="w-full px-3 py-2 text-left text-sm text-semantic-error hover:bg-semantic-error/10 rounded-field transition-colors flex items-center gap-2"
          >
            <Trash2 size={14} />
            Excluir Etapa
          </button>
        </div>
      </div>
    </>
  );
}

// Add Stage Column Component
function AddStageColumn({
  boardId,
  onAddStage,
}: {
  boardId: Id<"boards">;
  onAddStage: (name: string, color: string) => void;
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3B82F6");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    onAddStage(name.trim(), color);
    setName("");
    setColor("#3B82F6");
    setIsAdding(false);
  };

  if (!isAdding) {
    return (
      <div className="flex-shrink-0 w-80">
        <button
          onClick={() => setIsAdding(true)}
          className="w-full h-32 bg-surface-sunken rounded-card border-2 border-dashed border-border hover:border-brand-500 text-text-muted hover:text-brand-500 transition-all flex flex-col items-center justify-center gap-2"
        >
          <Plus size={24} />
          <span className="text-sm font-medium">Adicionar Etapa</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 w-80">
      <form onSubmit={handleSubmit} className="bg-surface-sunken rounded-card p-4 border border-border">
        <h4 className="text-sm font-semibold text-text-primary mb-3">Nova Etapa</h4>
        <div className="space-y-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome da etapa"
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted text-sm"
            style={{ fontSize: "16px" }}
            autoFocus
            required
          />
          <div>
            <label className="block text-xs text-text-muted mb-1">Cor</label>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-full h-8 bg-surface-raised border border-border-strong rounded-field cursor-pointer"
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" size="sm" className="flex-1">
              Criar
            </Button>
            <Button
              type="button"
              onClick={() => {
                setIsAdding(false);
                setName("");
                setColor("#3B82F6");
              }}
              variant="secondary"
              size="sm"
            >
              <X size={16} />
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

export function KanbanBoard({ organizationId }: KanbanBoardProps) {
  const [selectedBoardId, setSelectedBoardId] = useState<Id<"boards"> | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<Id<"leads"> | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showManageStages, setShowManageStages] = useState(false);
  const [showEditBoard, setShowEditBoard] = useState(false);
  const [showCreateBoard, setShowCreateBoard] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [quickAddStageId, setQuickAddStageId] = useState<Id<"stages"> | null>(null);
  const [draggedLeadId, setDraggedLeadId] = useState<Id<"leads"> | null>(null);
  const [stageMenuId, setStageMenuId] = useState<Id<"stages"> | null>(null);
  const [stageMenuAnchor, setStageMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const [showCloseReasonModal, setShowCloseReasonModal] = useState(false);
  const [pendingClose, setPendingClose] = useState<{
    leadId: Id<"leads">;
    stageId: Id<"stages">;
    isWon: boolean;
    currentValue: number;
  } | null>(null);

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [temperatureFilter, setTemperatureFilter] = useState<string>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");

  const boards = useQuery(api.boards.getBoards, { organizationId });
  const stages = useQuery(
    api.boards.getStages,
    selectedBoardId ? { boardId: selectedBoardId } : "skip"
  );
  const leads = useQuery(
    api.leads.getLeads,
    selectedBoardId ? { organizationId, boardId: selectedBoardId } : "skip"
  );
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });

  const moveLeadToStage = useMutation(api.leads.moveLeadToStage);
  const deleteBoard = useMutation(api.boards.deleteBoard);
  const createBoard = useMutation(api.boards.createBoard);
  const createBoardWithStages = useMutation(api.boards.createBoardWithStages);
  const updateStage = useMutation(api.boards.updateStage);
  const deleteStage = useMutation(api.boards.deleteStage);
  const createStage = useMutation(api.boards.createStage);

  // DnD Sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    })
  );

  // Select first board by default
  React.useEffect(() => {
    if (boards && boards.length > 0 && !selectedBoardId) {
      setSelectedBoardId(boards[0]._id);
    }
  }, [boards, selectedBoardId]);

  // Filter leads client-side
  const filteredLeads = useMemo(() => {
    if (!leads) return [];

    return leads.filter((lead) => {
      // Search filter
      if (searchQuery && !lead.title.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }

      // Priority filter
      if (priorityFilter !== "all" && lead.priority !== priorityFilter) {
        return false;
      }

      // Temperature filter
      if (temperatureFilter !== "all" && lead.temperature !== temperatureFilter) {
        return false;
      }

      // Assignee filter
      if (assigneeFilter !== "all") {
        if (assigneeFilter === "unassigned" && lead.assignee) {
          return false;
        }
        if (assigneeFilter !== "unassigned" && lead.assignee?._id !== assigneeFilter) {
          return false;
        }
      }

      return true;
    });
  }, [leads, searchQuery, priorityFilter, temperatureFilter, assigneeFilter]);

  const handleDragStart = (event: DragStartEvent) => {
    setDraggedLeadId(event.active.id as Id<"leads">);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggedLeadId(null);

    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const leadId = active.id as Id<"leads">;
    const stageId = over.id as Id<"stages">;

    // Check if target stage is closed (won or lost)
    const targetStage = stages?.find((s) => s._id === stageId);
    const lead = leads?.find((l) => l._id === leadId);

    if (targetStage && lead && (targetStage.isClosedWon || targetStage.isClosedLost)) {
      // Show close reason modal
      setPendingClose({
        leadId,
        stageId,
        isWon: !!targetStage.isClosedWon,
        currentValue: lead.value,
      });
      setShowCloseReasonModal(true);
      return;
    }

    // Normal move (non-closed stage)
    toast.promise(moveLeadToStage({ leadId, stageId }), {
      loading: "Movendo lead...",
      success: "Lead movido!",
      error: "Falha ao mover lead",
    });
  };

  const handleDeleteBoard = async () => {
    if (!selectedBoardId) return;
    if (!confirm("Tem certeza que deseja excluir este pipeline? Esta ação não pode ser desfeita.")) {
      return;
    }

    try {
      await deleteBoard({ boardId: selectedBoardId });
      toast.success("Pipeline excluído!");
      setSelectedBoardId(null);
      setShowSettingsMenu(false);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message.includes("leads")
          ? "Não é possível excluir um pipeline com leads. Mova ou exclua todos os leads primeiro."
          : "Falha ao excluir pipeline"
      );
    }
  };

  const handleCreateBoard = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const name = formData.get("name") as string;
    const color = formData.get("color") as string;

    if (!name.trim()) return;

    // Default stages
    const defaultStages = [
      { name: "Novo Lead", color: "#71717A" },
      { name: "Qualificado", color: "#3B82F6" },
      { name: "Proposta", color: "#EAB308" },
      { name: "Negociação", color: "#FB923C" },
      { name: "Fechado", color: "#22C55E", isClosedWon: true },
    ];

    try {
      await toast.promise(
        createBoardWithStages({
          organizationId,
          name: name.trim(),
          color: color || "#FF6B00",
          stages: defaultStages,
        }),
        {
          loading: "Criando pipeline...",
          success: "Pipeline criado!",
          error: "Falha ao criar pipeline",
        }
      );
      setShowCreateBoard(false);
    } catch (error) {
      console.error("Failed to create board:", error);
    }
  };

  const selectedBoard = boards?.find((b) => b._id === selectedBoardId);
  const draggedLead = leads?.find((l) => l._id === draggedLeadId);

  if (!boards) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (boards.length === 0) {
    return (
      <div className="text-center py-12">
        <h3 className="text-lg font-medium text-text-primary mb-2">Nenhum pipeline encontrado</h3>
        <p className="text-text-secondary mb-4">Crie seu primeiro pipeline de vendas para começar.</p>
        <Button onClick={() => setShowCreateBoard(true)} variant="primary" size="md">
          <Plus size={20} />
          Criar Pipeline
        </Button>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="h-full flex flex-col">
        <SpotlightTooltip spotlightId="board" organizationId={organizationId} />

        {/* Board Selector + Settings + Create Lead */}
        <div className="mb-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex gap-2 overflow-x-auto flex-1 min-w-0">
              {boards.map((board) => (
                <button
                  key={board._id}
                  onClick={() => setSelectedBoardId(board._id)}
                  className={cn(
                    "px-4 py-2 rounded-full font-semibold whitespace-nowrap transition-all duration-150 flex items-center gap-2",
                    selectedBoardId === board._id
                      ? "bg-brand-600 text-white border-b-2 border-brand-400"
                      : "bg-surface-overlay text-text-secondary hover:bg-surface-raised"
                  )}
                >
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: board.color }}
                  />
                  {board.name}
                </button>
              ))}
              <button
                onClick={() => setShowCreateBoard(true)}
                className="px-4 py-2 rounded-full font-semibold whitespace-nowrap bg-surface-overlay text-brand-400 hover:bg-surface-raised transition-all duration-150 flex items-center gap-1"
                aria-label="Criar pipeline"
              >
                <Plus size={16} />
                Novo
              </button>
            </div>

            {/* Settings Dropdown (only for active pipeline) */}
            {selectedBoardId && (
              <div className="relative">
                <button
                  onClick={() => setShowSettingsMenu(!showSettingsMenu)}
                  className="p-2 rounded-full text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors"
                  aria-label="Configurações do pipeline"
                >
                  <Settings2 size={20} />
                </button>

                {showSettingsMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setShowSettingsMenu(false)}
                    />
                    <div className="absolute right-0 top-full mt-2 w-56 bg-surface-overlay border border-border rounded-card shadow-elevated z-20 py-1">
                      <button
                        onClick={() => {
                          setShowEditBoard(true);
                          setShowSettingsMenu(false);
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-text-primary hover:bg-surface-raised transition-colors"
                      >
                        Editar Pipeline
                      </button>
                      <button
                        onClick={() => {
                          setShowManageStages(true);
                          setShowSettingsMenu(false);
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-text-primary hover:bg-surface-raised transition-colors"
                      >
                        Gerenciar Etapas
                      </button>
                      <button
                        onClick={handleDeleteBoard}
                        className="w-full px-4 py-2 text-left text-sm text-semantic-error hover:bg-semantic-error/10 transition-colors"
                      >
                        Excluir Pipeline
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            <Button
              onClick={() => setShowCreateModal(true)}
              variant="primary"
              size="md"
              className="whitespace-nowrap"
            >
              <Plus size={20} />
              Criar Lead
            </Button>
          </div>
        </div>

        {/* Search & Filters */}
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar leads..."
            className="flex-1 min-w-[200px] px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted text-sm"
            style={{ fontSize: "16px" }}
          />

          <div className="relative">
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="appearance-none pl-3 pr-8 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm cursor-pointer"
              style={{ fontSize: "16px" }}
            >
              <option value="all">Todas Prioridades</option>
              <option value="urgent">Urgente</option>
              <option value="high">Alta</option>
              <option value="medium">Média</option>
              <option value="low">Baixa</option>
            </select>
            <ChevronDown size={16} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          </div>

          <div className="relative">
            <select
              value={temperatureFilter}
              onChange={(e) => setTemperatureFilter(e.target.value)}
              className="appearance-none pl-3 pr-8 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm cursor-pointer"
              style={{ fontSize: "16px" }}
            >
              <option value="all">Todas Temperaturas</option>
              <option value="hot">Quente</option>
              <option value="warm">Morno</option>
              <option value="cold">Frio</option>
            </select>
            <ChevronDown size={16} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          </div>

          <div className="relative">
            <select
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              className="appearance-none pl-3 pr-8 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm cursor-pointer"
              style={{ fontSize: "16px" }}
            >
              <option value="all">Todos Responsáveis</option>
              <option value="unassigned">Não atribuído</option>
              {teamMembers?.map((member) => (
                <option key={member._id} value={member._id}>
                  {member.name}
                </option>
              ))}
            </select>
            <ChevronDown size={16} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          </div>
        </div>

        {/* Kanban Board */}
        {stages && (
          <div className="flex-1 overflow-x-auto">
            <div className="flex gap-6 h-full min-w-max pb-6 scroll-smooth snap-x snap-mandatory">
              {stages.map((stage) => {
                const stageLeads = filteredLeads?.filter((lead) => lead.stageId === stage._id) || [];
                const totalValue = stageLeads.reduce((sum, lead) => sum + lead.value, 0);
                const isOver = draggedLeadId !== null;

                return (
                  <div key={stage._id} className="flex-shrink-0 w-80 relative">
                    {quickAddStageId === stage._id && (
                      <QuickAddForm
                        stageId={stage._id}
                        boardId={selectedBoardId!}
                        organizationId={organizationId}
                        onClose={() => setQuickAddStageId(null)}
                      />
                    )}
                    <DroppableColumn
                      stage={stage}
                      leads={stageLeads}
                      totalValue={totalValue}
                      isOver={isOver}
                      onLeadClick={(leadId) => setSelectedLeadId(leadId)}
                      onQuickAdd={() => setQuickAddStageId(stage._id)}
                      onStageMenu={(e: React.MouseEvent) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setStageMenuAnchor({ top: rect.bottom + 4, left: rect.left - 240 });
                        setStageMenuId(stage._id);
                      }}
                    />

                    {/* Stage Menu */}
                    {stageMenuId === stage._id && stageMenuAnchor && (
                      <StageEditPopover
                        stage={stage}
                        anchor={stageMenuAnchor}
                        onClose={() => { setStageMenuId(null); setStageMenuAnchor(null); }}
                        onUpdate={(stageId, updates) => {
                          toast.promise(
                            updateStage({ stageId, ...updates }),
                            {
                              loading: "Atualizando...",
                              success: "Etapa atualizada!",
                              error: "Falha ao atualizar",
                            }
                          );
                        }}
                        onDelete={(stageId) => {
                          toast.promise(deleteStage({ stageId }), {
                            loading: "Excluindo...",
                            success: "Etapa excluída!",
                            error: (e) => e.message || "Falha ao excluir",
                          });
                        }}
                      />
                    )}
                  </div>
                );
              })}

              {/* Add Stage Column */}
              {selectedBoardId && (
                <AddStageColumn
                  boardId={selectedBoardId}
                  onAddStage={(name, color) => {
                    toast.promise(
                      createStage({ boardId: selectedBoardId, name, color }),
                      {
                        loading: "Criando etapa...",
                        success: "Etapa criada!",
                        error: "Falha ao criar etapa",
                      }
                    );
                  }}
                />
              )}
            </div>
          </div>
        )}

        {/* Drag Overlay */}
        <DragOverlay>
          {draggedLead ? (
            <div className="bg-surface-raised p-4 rounded-card border border-brand-500 shadow-elevated opacity-90 w-80">
              <h4 className="font-medium text-text-primary mb-2">{draggedLead.title}</h4>
              <span className="text-lg font-semibold text-brand-400 tabular-nums">
                R$ {draggedLead.value.toLocaleString("pt-BR")}
              </span>
            </div>
          ) : null}
        </DragOverlay>
      </div>

      {/* Lead Detail Panel */}
      {selectedLeadId && (
        <LeadDetailPanel
          leadId={selectedLeadId}
          organizationId={organizationId}
          onClose={() => setSelectedLeadId(null)}
        />
      )}

      {/* Create Lead Modal */}
      {showCreateModal && selectedBoardId && (
        <CreateLeadModal
          organizationId={organizationId}
          boardId={selectedBoardId}
          onClose={() => setShowCreateModal(false)}
        />
      )}

      {/* Manage Stages Modal */}
      {showManageStages && selectedBoardId && (
        <ManageStagesModal
          boardId={selectedBoardId}
          organizationId={organizationId}
          onClose={() => setShowManageStages(false)}
        />
      )}

      {/* Edit Board Modal */}
      {showEditBoard && selectedBoard && (
        <EditBoardModal
          board={selectedBoard}
          onClose={() => setShowEditBoard(false)}
        />
      )}

      {/* Create Board Modal */}
      {showCreateBoard && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowCreateBoard(false)}
          />
          <div className="relative z-10 w-full bg-surface-overlay border border-border rounded-t-xl sm:rounded-xl sm:max-w-md sm:mx-4 p-6">
            <h2 className="text-lg font-semibold text-text-primary mb-4">Nova Pipeline</h2>
            <form onSubmit={handleCreateBoard} className="space-y-4">
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1">
                  Nome <span className="text-semantic-error">*</span>
                </label>
                <input
                  type="text"
                  name="name"
                  placeholder="ex: Vendas B2B"
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                  style={{ fontSize: "16px" }}
                  required
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1">Cor</label>
                <input
                  type="color"
                  name="color"
                  defaultValue="#FF6B00"
                  className="w-full h-10 bg-surface-raised border border-border-strong rounded-field cursor-pointer"
                />
              </div>
              <div className="text-xs text-text-muted bg-surface-sunken p-3 rounded-field">
                Etapas padrão: Novo Lead, Qualificado, Proposta, Negociação, Fechado
              </div>
              <div className="flex gap-2 pt-2">
                <Button
                  type="button"
                  onClick={() => setShowCreateBoard(false)}
                  variant="secondary"
                  size="md"
                  className="flex-1"
                >
                  Cancelar
                </Button>
                <Button type="submit" variant="primary" size="md" className="flex-1">
                  Criar
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Close Reason Modal */}
      {showCloseReasonModal && pendingClose && (
        <CloseReasonModal
          open={showCloseReasonModal}
          onClose={() => {
            setShowCloseReasonModal(false);
            setPendingClose(null);
          }}
          leadId={pendingClose.leadId}
          stageId={pendingClose.stageId}
          isWon={pendingClose.isWon}
          currentValue={pendingClose.currentValue}
        />
      )}
    </DndContext>
  );
}
