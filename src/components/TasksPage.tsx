import { useState, useMemo, useEffect } from "react";
import { useOutletContext } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { usePermissions } from "@/hooks/usePermissions";
import { CreateTaskModal } from "./CreateTaskModal";
import { TaskDetailSlideOver } from "./TaskDetailSlideOver";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import {
  Plus,
  Search,
  List,
  Kanban,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Phone,
  Mail,
  CalendarClock,
  Users,
  Microscope,
  ClipboardList,
  Circle,
  Clock,
  AlertCircle,
  Trash2,
  UserPlus,
  Flag,
} from "lucide-react";
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

// ============================================================================
// Types & Constants
// ============================================================================

type ViewMode = "list" | "board";
type SmartFilter = "all" | "today" | "overdue" | "week" | "unassigned" | "reminders";
type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

interface TaskItem {
  _id: Id<"tasks">;
  title: string;
  description?: string;
  type: "task" | "reminder";
  status: TaskStatus;
  priority: "low" | "medium" | "high" | "urgent";
  activityType?: string;
  dueDate?: number;
  completedAt?: number;
  snoozedUntil?: number;
  assignedTo?: Id<"teamMembers">;
  leadId?: Id<"leads">;
  contactId?: Id<"contacts">;
  createdBy: Id<"teamMembers">;
  checklist?: { id: string; title: string; completed: boolean }[];
  tags?: string[];
  recurrence?: { pattern: string };
  createdAt: number;
  updatedAt: number;
}

const ACTIVITY_ICONS: Record<string, React.ElementType> = {
  todo: ClipboardList,
  call: Phone,
  email: Mail,
  follow_up: CalendarClock,
  meeting: Users,
  research: Microscope,
};

const ACTIVITY_LABELS: Record<string, string> = {
  todo: "Tarefa",
  call: "Ligação",
  email: "E-mail",
  follow_up: "Follow-up",
  meeting: "Reunião",
  research: "Pesquisa",
};

const PRIORITY_BADGE: Record<string, { variant: "default" | "info" | "warning" | "error"; label: string }> = {
  low: { variant: "default", label: "Baixa" },
  medium: { variant: "info", label: "Média" },
  high: { variant: "warning", label: "Alta" },
  urgent: { variant: "error", label: "Urgente" },
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  in_progress: "Em Progresso",
  completed: "Concluída",
  cancelled: "Cancelada",
};

// ============================================================================
// TasksPage
// ============================================================================

export function TasksPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { can } = usePermissions(organizationId);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [smartFilter, setSmartFilter] = useState<SmartFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<Id<"tasks"> | null>(null);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterPriority, setFilterPriority] = useState<string>("");
  const [filterAssignee, setFilterAssignee] = useState<string>("");
  const [filterActivityType, setFilterActivityType] = useState<string>("");
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(interval);
  }, []);
  const tasks = useQuery(api.tasks.getTasks, { organizationId });
  const taskCounts = useQuery(api.tasks.getTaskCounts, { organizationId, now });
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  const completeTask = useMutation(api.tasks.completeTask);
  const bulkUpdateTasks = useMutation(api.tasks.bulkUpdateTasks);

  // Build team member map for display
  const memberMap = useMemo(() => {
    const map = new Map<string, { name: string; type: "human" | "ai" }>();
    teamMembers?.forEach((m) => map.set(m._id, { name: m.name, type: m.type }));
    return map;
  }, [teamMembers]);

  // Filter tasks
  const filteredTasks = useMemo(() => {
    if (!tasks) return [];
    let result = [...tasks];

    // Smart filter
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const endOfWeek = new Date(startOfToday);
    endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
    endOfWeek.setHours(23, 59, 59, 999);

    switch (smartFilter) {
      case "today":
        result = result.filter(
          (t) => t.dueDate && t.dueDate >= startOfToday.getTime() && t.dueDate <= endOfToday.getTime() && t.status !== "completed" && t.status !== "cancelled"
        );
        break;
      case "overdue":
        result = result.filter(
          (t) => t.dueDate && t.dueDate < now && t.status !== "completed" && t.status !== "cancelled"
        );
        break;
      case "week":
        result = result.filter(
          (t) => t.dueDate && t.dueDate >= startOfToday.getTime() && t.dueDate <= endOfWeek.getTime() && t.status !== "completed" && t.status !== "cancelled"
        );
        break;
      case "unassigned":
        result = result.filter((t) => !t.assignedTo && t.status !== "completed" && t.status !== "cancelled");
        break;
      case "reminders":
        result = result.filter((t) => t.type === "reminder" && t.status !== "completed" && t.status !== "cancelled");
        break;
    }

    // Dropdown filters
    if (filterStatus) result = result.filter((t) => t.status === filterStatus);
    if (filterPriority) result = result.filter((t) => t.priority === filterPriority);
    if (filterAssignee) result = result.filter((t) => t.assignedTo === filterAssignee);
    if (filterActivityType) result = result.filter((t) => t.activityType === filterActivityType);

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((t) => t.title.toLowerCase().includes(q));
    }

    return result;
  }, [tasks, smartFilter, filterStatus, filterPriority, filterAssignee, filterActivityType, searchQuery, now]);

  // Group tasks by due date buckets for list view
  const groupedTasks = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const endOfWeek = new Date(startOfToday);
    endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
    endOfWeek.setHours(23, 59, 59, 999);

    const groups: { key: string; label: string; tasks: TaskItem[]; color?: string; defaultOpen: boolean }[] = [
      { key: "overdue", label: "Atrasadas", tasks: [], color: "text-semantic-error", defaultOpen: true },
      { key: "today", label: "Hoje", tasks: [], color: "text-brand-500", defaultOpen: true },
      { key: "week", label: "Esta Semana", tasks: [], defaultOpen: true },
      { key: "future", label: "Futuras", tasks: [], defaultOpen: true },
      { key: "noDate", label: "Sem Data", tasks: [], defaultOpen: true },
      { key: "completed", label: "Concluídas", tasks: [], defaultOpen: false },
    ];

    for (const task of filteredTasks) {
      if (task.status === "completed" || task.status === "cancelled") {
        groups[5].tasks.push(task as TaskItem);
      } else if (!task.dueDate) {
        groups[4].tasks.push(task as TaskItem);
      } else if (task.dueDate < startOfToday.getTime()) {
        groups[0].tasks.push(task as TaskItem);
      } else if (task.dueDate <= endOfToday.getTime()) {
        groups[1].tasks.push(task as TaskItem);
      } else if (task.dueDate <= endOfWeek.getTime()) {
        groups[2].tasks.push(task as TaskItem);
      } else {
        groups[3].tasks.push(task as TaskItem);
      }
    }

    return groups.filter((g) => g.tasks.length > 0);
  }, [filteredTasks]);

  const handleCompleteTask = async (taskId: Id<"tasks">) => {
    try {
      await completeTask({ taskId });
      toast.success("Tarefa concluída!");
    } catch (err) {
      toast.error("Falha ao concluir tarefa");
    }
  };

  const toggleSelectTask = (taskId: string) => {
    setSelectedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const handleBulkComplete = async () => {
    try {
      await bulkUpdateTasks({
        taskIds: Array.from(selectedTasks) as Id<"tasks">[],
        action: "complete",
      });
      toast.success(`${selectedTasks.size} tarefas concluídas!`);
      setSelectedTasks(new Set());
    } catch {
      toast.error("Falha ao concluir tarefas");
    }
  };

  const handleBulkDelete = async () => {
    try {
      await bulkUpdateTasks({
        taskIds: Array.from(selectedTasks) as Id<"tasks">[],
        action: "cancel",
      });
      toast.success(`${selectedTasks.size} tarefas canceladas!`);
      setSelectedTasks(new Set());
    } catch {
      toast.error("Falha ao cancelar tarefas");
    }
  };

  if (tasks === undefined) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-7xl">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h1 className="text-2xl font-bold text-text-primary">Tarefas</h1>
        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative flex-1 md:w-64 md:flex-none">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar tarefas..."
              className="w-full pl-9 pr-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
              style={{ fontSize: "16px" }}
            />
          </div>

          {/* View toggle */}
          <div className="flex bg-surface-raised border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode("list")}
              className={cn(
                "p-2 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center",
                viewMode === "list"
                  ? "bg-brand-500/10 text-brand-500"
                  : "text-text-muted hover:text-text-primary"
              )}
              aria-label="Visualização em lista"
            >
              <List size={18} />
            </button>
            <button
              onClick={() => setViewMode("board")}
              className={cn(
                "p-2 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center",
                viewMode === "board"
                  ? "bg-brand-500/10 text-brand-500"
                  : "text-text-muted hover:text-text-primary"
              )}
              aria-label="Visualização em quadro"
            >
              <Kanban size={18} />
            </button>
          </div>

          {can("tasks", "edit_own") && (
            <Button
              variant="primary"
              size="md"
              onClick={() => setShowCreateModal(true)}
            >
              <Plus size={16} />
              <span className="hidden md:inline">Nova Tarefa</span>
            </Button>
          )}
        </div>
      </div>

      {/* Smart list pills */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        <SmartPill
          label="Todas"
          active={smartFilter === "all"}
          onClick={() => setSmartFilter("all")}
        />
        <SmartPill
          label="Hoje"
          count={taskCounts?.today}
          active={smartFilter === "today"}
          onClick={() => setSmartFilter("today")}
        />
        <SmartPill
          label="Atrasadas"
          count={taskCounts?.overdue}
          active={smartFilter === "overdue"}
          onClick={() => setSmartFilter("overdue")}
          countColor="text-semantic-error"
        />
        <SmartPill
          label="Minha Semana"
          active={smartFilter === "week"}
          onClick={() => setSmartFilter("week")}
        />
        <SmartPill
          label="Sem Responsável"
          active={smartFilter === "unassigned"}
          onClick={() => setSmartFilter("unassigned")}
        />
        <SmartPill
          label="Lembretes"
          active={smartFilter === "reminders"}
          onClick={() => setSmartFilter("reminders")}
        />
      </div>

      {/* Filter bar toggle */}
      <button
        onClick={() => setShowFilters(!showFilters)}
        className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary transition-colors"
      >
        <ChevronDown
          size={16}
          className={cn("transition-transform", showFilters && "rotate-180")}
        />
        Filtros
        {(filterStatus || filterPriority || filterAssignee || filterActivityType) && (
          <span className="ml-1 w-2 h-2 rounded-full bg-brand-500" />
        )}
      </button>

      {showFilters && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3 bg-surface-sunken rounded-card border border-border">
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Status</label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="w-full px-2 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
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
            <label className="block text-xs font-medium text-text-muted mb-1">Prioridade</label>
            <select
              value={filterPriority}
              onChange={(e) => setFilterPriority(e.target.value)}
              className="w-full px-2 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
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
            <label className="block text-xs font-medium text-text-muted mb-1">Responsável</label>
            <select
              value={filterAssignee}
              onChange={(e) => setFilterAssignee(e.target.value)}
              className="w-full px-2 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              style={{ fontSize: "16px" }}
            >
              <option value="">Todos</option>
              {teamMembers?.map((m) => (
                <option key={m._id} value={m._id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Tipo de Atividade</label>
            <select
              value={filterActivityType}
              onChange={(e) => setFilterActivityType(e.target.value)}
              className="w-full px-2 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
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
        </div>
      )}

      {/* Bulk actions bar */}
      {selectedTasks.size > 0 && can("tasks", "edit_own") && (
        <div className="sticky top-0 z-10 flex items-center gap-3 p-3 bg-surface-overlay border border-border rounded-card animate-fade-in-up">
          <span className="text-sm font-medium text-text-primary">
            {selectedTasks.size} selecionada{selectedTasks.size > 1 ? "s" : ""}
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="primary" onClick={handleBulkComplete}>
            <CheckSquare size={14} />
            Concluir
          </Button>
          <Button size="sm" variant="danger" onClick={() => setShowBulkDeleteConfirm(true)}>
            <Trash2 size={14} />
            Cancelar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelectedTasks(new Set())}
          >
            Limpar
          </Button>
        </div>
      )}

      {/* Content */}
      {filteredTasks.length === 0 ? (
        <EmptyState
          icon={CheckSquare}
          title="Nenhuma tarefa encontrada"
          description={
            tasks.length === 0
              ? "Crie sua primeira tarefa para organizar seu trabalho."
              : "Tente ajustar os filtros ou a busca."
          }
          action={
            tasks.length === 0 && can("tasks", "edit_own")
              ? { label: "Nova Tarefa", onClick: () => setShowCreateModal(true) }
              : undefined
          }
        />
      ) : viewMode === "list" ? (
        <ListView
          groupedTasks={groupedTasks}
          memberMap={memberMap}
          selectedTasks={selectedTasks}
          onToggleSelect={toggleSelectTask}
          onComplete={handleCompleteTask}
          onOpenDetail={setSelectedTaskId}
          now={now}
        />
      ) : (
        <BoardView
          tasks={filteredTasks as TaskItem[]}
          memberMap={memberMap}
          onOpenDetail={setSelectedTaskId}
          now={now}
        />
      )}

      {/* Modals */}
      <CreateTaskModal
        organizationId={organizationId}
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />

      {selectedTaskId && (
        <TaskDetailSlideOver
          taskId={selectedTaskId}
          organizationId={organizationId}
          isOpen={true}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      <ConfirmDialog
        open={showBulkDeleteConfirm}
        onClose={() => setShowBulkDeleteConfirm(false)}
        onConfirm={handleBulkDelete}
        title="Cancelar Tarefas"
        description={`Deseja cancelar ${selectedTasks.size} tarefa${selectedTasks.size > 1 ? "s" : ""}?`}
        confirmLabel="Cancelar Tarefas"
        variant="danger"
      />
    </div>
  );
}

// ============================================================================
// SmartPill
// ============================================================================

function SmartPill({
  label,
  count,
  active,
  onClick,
  countColor,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  countColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors min-h-[36px]",
        active
          ? "bg-brand-600 text-white"
          : "bg-surface-raised text-text-secondary hover:bg-surface-overlay border border-border"
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            "text-xs font-bold tabular-nums",
            active ? "text-white/80" : countColor || "text-text-muted"
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ============================================================================
// ListView
// ============================================================================

function ListView({
  groupedTasks,
  memberMap,
  selectedTasks,
  onToggleSelect,
  onComplete,
  onOpenDetail,
  now,
}: {
  groupedTasks: { key: string; label: string; tasks: TaskItem[]; color?: string; defaultOpen: boolean }[];
  memberMap: Map<string, { name: string; type: "human" | "ai" }>;
  selectedTasks: Set<string>;
  onToggleSelect: (id: string) => void;
  onComplete: (id: Id<"tasks">) => void;
  onOpenDetail: (id: Id<"tasks">) => void;
  now: number;
}) {
  return (
    <div className="space-y-2">
      {groupedTasks.map((group) => (
        <TaskGroup
          key={group.key}
          label={group.label}
          count={group.tasks.length}
          color={group.color}
          defaultOpen={group.defaultOpen}
        >
          {group.tasks.map((task) => (
            <TaskRow
              key={task._id}
              task={task}
              memberMap={memberMap}
              isSelected={selectedTasks.has(task._id)}
              onToggleSelect={() => onToggleSelect(task._id)}
              onComplete={() => onComplete(task._id)}
              onClick={() => onOpenDetail(task._id)}
              now={now}
            />
          ))}
        </TaskGroup>
      ))}
    </div>
  );
}

// ============================================================================
// TaskGroup (collapsible)
// ============================================================================

function TaskGroup({
  label,
  count,
  color,
  defaultOpen,
  children,
}: {
  label: string;
  count: number;
  color?: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-card border border-border bg-surface-raised overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-surface-overlay transition-colors"
      >
        {open ? <ChevronDown size={16} className="text-text-muted" /> : <ChevronRight size={16} className="text-text-muted" />}
        <span className={cn("text-sm font-semibold", color || "text-text-primary")}>
          {label}
        </span>
        <span className="text-xs font-medium text-text-muted bg-surface-overlay px-1.5 py-0.5 rounded-full tabular-nums">
          {count}
        </span>
      </button>
      {open && <div className="border-t border-border">{children}</div>}
    </div>
  );
}

// ============================================================================
// TaskRow
// ============================================================================

function TaskRow({
  task,
  memberMap,
  isSelected,
  onToggleSelect,
  onComplete,
  onClick,
  now,
}: {
  task: TaskItem;
  memberMap: Map<string, { name: string; type: "human" | "ai" }>;
  isSelected: boolean;
  onToggleSelect: () => void;
  onComplete: () => void;
  onClick: () => void;
  now: number;
}) {
  const isCompleted = task.status === "completed" || task.status === "cancelled";
  const ActivityIcon = task.activityType ? ACTIVITY_ICONS[task.activityType] || ClipboardList : ClipboardList;
  const assignee = task.assignedTo ? memberMap.get(task.assignedTo) : null;
  const priorityBadge = PRIORITY_BADGE[task.priority];
  const checklistTotal = task.checklist?.length ?? 0;
  const checklistDone = task.checklist?.filter((c) => c.completed).length ?? 0;

  return (
    <div
      className={cn(
        "flex items-center gap-2 md:gap-3 px-4 py-2.5 hover:bg-surface-overlay transition-colors border-b border-border last:border-b-0",
        isSelected && "bg-brand-500/5"
      )}
    >
      {/* Select checkbox */}
      <Checkbox
        checked={isSelected}
        onChange={onToggleSelect}
        containerClassName="shrink-0"
        aria-label="Selecionar tarefa"
      />

      {/* Complete checkbox */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (!isCompleted) onComplete();
        }}
        className={cn(
          "shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors",
          isCompleted
            ? "border-semantic-success bg-semantic-success"
            : "border-border-strong hover:border-brand-500"
        )}
        aria-label={isCompleted ? "Tarefa concluída" : "Concluir tarefa"}
      >
        {isCompleted && (
          <svg width="10" height="8" viewBox="0 0 10 8" fill="none" className="text-white">
            <path d="M1 4L3.5 6.5L9 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {/* Activity type icon */}
      <ActivityIcon size={16} className="shrink-0 text-text-muted" />

      {/* Title + meta */}
      <button
        onClick={onClick}
        className="flex-1 min-w-0 text-left"
      >
        <span
          className={cn(
            "text-sm font-medium truncate block",
            isCompleted ? "text-text-muted line-through" : "text-text-primary"
          )}
        >
          {task.title}
        </span>
      </button>

      {/* Checklist progress */}
      {checklistTotal > 0 && (
        <span className="hidden md:inline text-xs text-text-muted tabular-nums shrink-0">
          {checklistDone}/{checklistTotal}
        </span>
      )}

      {/* Priority badge */}
      <Badge variant={priorityBadge.variant} className="hidden md:inline-flex shrink-0 text-[10px]">
        {priorityBadge.label}
      </Badge>

      {/* Assignee */}
      {assignee && (
        <Avatar name={assignee.name} type={assignee.type} size="sm" className="hidden md:inline-flex shrink-0" />
      )}

      {/* Due date */}
      {task.dueDate && (
        <span
          className={cn(
            "text-xs font-medium shrink-0 tabular-nums",
            isCompleted
              ? "text-text-muted"
              : task.dueDate < now
                ? "text-semantic-error"
                : isDueToday(task.dueDate)
                  ? "text-brand-500"
                  : "text-text-secondary"
          )}
        >
          {formatRelativeDate(task.dueDate, now)}
        </span>
      )}
    </div>
  );
}

// ============================================================================
// Board View
// ============================================================================

function BoardView({
  tasks,
  memberMap,
  onOpenDetail,
  now,
}: {
  tasks: TaskItem[];
  memberMap: Map<string, { name: string; type: "human" | "ai" }>;
  onOpenDetail: (id: Id<"tasks">) => void;
  now: number;
}) {
  const updateTask = useMutation(api.tasks.updateTask);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  const columns: { status: TaskStatus; label: string; color: string }[] = [
    { status: "pending", label: "Pendente", color: "bg-semantic-warning" },
    { status: "in_progress", label: "Em Progresso", color: "bg-semantic-info" },
    { status: "completed", label: "Concluída", color: "bg-semantic-success" },
  ];

  const tasksByStatus = useMemo(() => {
    const map: Record<string, TaskItem[]> = {
      pending: [],
      in_progress: [],
      completed: [],
    };
    for (const task of tasks) {
      const key = task.status === "cancelled" ? "completed" : task.status;
      map[key]?.push(task);
    }
    return map;
  }, [tasks]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id as Id<"tasks">;
    const newStatus = over.id as TaskStatus;
    const task = tasks.find((t) => t._id === taskId);
    if (!task || task.status === newStatus) return;

    try {
      await updateTask({
        taskId,
        status: newStatus,
      });
    } catch {
      toast.error("Falha ao mover tarefa");
    }
  };

  const activeTask = activeId ? tasks.find((t) => t._id === activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {columns.map((col) => (
          <BoardColumn
            key={col.status}
            status={col.status}
            label={col.label}
            color={col.color}
            tasks={tasksByStatus[col.status] || []}
            memberMap={memberMap}
            onOpenDetail={onOpenDetail}
            now={now}
          />
        ))}
      </div>

      <DragOverlay>
        {activeTask && (
          <BoardCard
            task={activeTask as TaskItem}
            memberMap={memberMap}
            onOpenDetail={() => {}}
            now={now}
            isDragging
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}

// ============================================================================
// BoardColumn
// ============================================================================

function BoardColumn({
  status,
  label,
  color,
  tasks,
  memberMap,
  onOpenDetail,
  now,
}: {
  status: TaskStatus;
  label: string;
  color: string;
  tasks: TaskItem[];
  memberMap: Map<string, { name: string; type: "human" | "ai" }>;
  onOpenDetail: (id: Id<"tasks">) => void;
  now: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-card border border-border bg-surface-sunken min-h-[200px] transition-colors",
        isOver && "border-brand-500 bg-brand-500/5"
      )}
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <div className={cn("w-2 h-2 rounded-full", color)} />
        <span className="text-sm font-semibold text-text-primary">{label}</span>
        <span className="text-xs text-text-muted tabular-nums">{tasks.length}</span>
      </div>
      <div className="p-2 space-y-2">
        {tasks.map((task) => (
          <DraggableBoardCard
            key={task._id}
            task={task}
            memberMap={memberMap}
            onOpenDetail={onOpenDetail}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// DraggableBoardCard
// ============================================================================

function DraggableBoardCard({
  task,
  memberMap,
  onOpenDetail,
  now,
}: {
  task: TaskItem;
  memberMap: Map<string, { name: string; type: "human" | "ai" }>;
  onOpenDetail: (id: Id<"tasks">) => void;
  now: number;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task._id,
  });

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.5 : 1 }
    : undefined;

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <BoardCard task={task} memberMap={memberMap} onOpenDetail={onOpenDetail} now={now} />
    </div>
  );
}

// ============================================================================
// BoardCard
// ============================================================================

function BoardCard({
  task,
  memberMap,
  onOpenDetail,
  now,
  isDragging,
}: {
  task: TaskItem;
  memberMap: Map<string, { name: string; type: "human" | "ai" }>;
  onOpenDetail: (id: Id<"tasks">) => void;
  now: number;
  isDragging?: boolean;
}) {
  const ActivityIcon = task.activityType ? ACTIVITY_ICONS[task.activityType] || ClipboardList : ClipboardList;
  const assignee = task.assignedTo ? memberMap.get(task.assignedTo) : null;
  const priorityBadge = PRIORITY_BADGE[task.priority];
  const checklistTotal = task.checklist?.length ?? 0;
  const checklistDone = task.checklist?.filter((c) => c.completed).length ?? 0;

  return (
    <button
      onClick={() => onOpenDetail(task._id)}
      className={cn(
        "w-full text-left p-3 rounded-lg bg-surface-raised border border-border hover:border-brand-500/50 transition-colors",
        isDragging && "shadow-elevated"
      )}
    >
      <div className="flex items-start gap-2 mb-2">
        <ActivityIcon size={14} className="text-text-muted mt-0.5 shrink-0" />
        <span className="text-sm font-medium text-text-primary line-clamp-2">{task.title}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant={priorityBadge.variant} className="text-[10px]">
          {priorityBadge.label}
        </Badge>
        {checklistTotal > 0 && (
          <span className="text-[10px] text-text-muted tabular-nums">
            {checklistDone}/{checklistTotal}
          </span>
        )}
        {task.dueDate && (
          <span
            className={cn(
              "text-[10px] font-medium tabular-nums ml-auto",
              task.dueDate < now && task.status !== "completed"
                ? "text-semantic-error"
                : "text-text-muted"
            )}
          >
            {formatRelativeDate(task.dueDate, now)}
          </span>
        )}
      </div>
      {assignee && (
        <div className="mt-2 flex justify-end">
          <Avatar name={assignee.name} type={assignee.type} size="sm" />
        </div>
      )}
    </button>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function isDueToday(dueDate: number): boolean {
  const today = new Date();
  const due = new Date(dueDate);
  return (
    due.getFullYear() === today.getFullYear() &&
    due.getMonth() === today.getMonth() &&
    due.getDate() === today.getDate()
  );
}

function formatRelativeDate(dueDate: number, now: number): string {
  const due = new Date(dueDate);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(dueDate);
  dueDay.setHours(0, 0, 0, 0);

  const diffMs = dueDay.getTime() - today.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < -1) return `${Math.abs(diffDays)}d atrás`;
  if (diffDays === -1) return "Ontem";
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Amanhã";
  if (diffDays <= 7) return `${diffDays}d`;
  return due.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}
