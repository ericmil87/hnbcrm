import { useState, useMemo, useEffect, useCallback } from "react";
import { useOutletContext, useSearchParams } from "react-router";
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
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import {
  ProjectSwitcher,
  type TaskProjectSummary,
} from "@/components/tasks/ProjectSwitcher";
import { ProjectFormModal } from "@/components/tasks/ProjectFormModal";
import { ColumnsEditorModal } from "@/components/tasks/ColumnsEditorModal";
import {
  TaskKanbanBoard,
  TaskAssigneeStack,
  TaskLabelChips,
  TaskLeadChip,
  ACTIVITY_ICONS,
  ACTIVITY_LABELS,
  PRIORITY_BADGE,
  formatRelativeDate,
  type TaskColumnDoc,
  type TaskListItem,
} from "@/components/tasks/TaskKanbanBoard";
import {
  TaskFiltersBar,
  EMPTY_TASK_FILTERS,
  type TaskFilters,
} from "@/components/tasks/TaskFiltersBar";
import {
  SavedFiltersMenu,
  type TaskSavedFilters,
} from "@/components/tasks/SavedFiltersMenu";
import {
  Plus,
  Search,
  List,
  Kanban,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Trash2,
  X,
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
type TaskPriority = "low" | "medium" | "high" | "urgent";
type ActivityType = "todo" | "call" | "email" | "follow_up" | "meeting" | "research";

const SEARCH_DEBOUNCE_MS = 300;

// ============================================================================
// TasksPage
// ============================================================================

export function TasksPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { can, role } = usePermissions(organizationId);
  const canEdit = can("tasks", "edit_own");
  const canManageProjects = role === "admin" || role === "manager";

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTaskId = (searchParams.get("task") as Id<"tasks"> | null) ?? null;

  const [selectedProjectId, setSelectedProjectId] =
    useState<Id<"taskProjects"> | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [smartFilter, setSmartFilter] = useState<SmartFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<TaskFilters>(() => ({
    ...EMPTY_TASK_FILTERS,
  }));
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(() => new Set());
  const [showBulkCancelConfirm, setShowBulkCancelConfirm] = useState(false);

  // Gestão de projetos
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectBeingEdited, setProjectBeingEdited] =
    useState<TaskProjectSummary | null>(null);
  const [columnsProject, setColumnsProject] = useState<TaskProjectSummary | null>(
    null
  );
  const [pendingProjectAction, setPendingProjectAction] = useState<{
    type: "archive" | "delete";
    project: TaskProjectSummary;
  } | null>(null);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(interval);
  }, []);

  // Busca server-side (full-text) com debounce
  useEffect(() => {
    const timeout = setTimeout(
      () => setSearch(searchInput.trim()),
      SEARCH_DEBOUNCE_MS
    );
    return () => clearTimeout(timeout);
  }, [searchInput]);

  const projects = useQuery(api.taskProjects.getProjects, { organizationId }) as
    | TaskProjectSummary[]
    | undefined;
  const labels = useQuery(api.taskLabels.getLabels, { organizationId }) as
    | { _id: Id<"taskLabels">; name: string; color: string }[]
    | undefined;
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  const taskCounts = useQuery(api.tasks.getTaskCounts, { organizationId, now });
  const columns = useQuery(
    api.taskProjects.getColumns,
    selectedProjectId ? { projectId: selectedProjectId } : "skip"
  ) as TaskColumnDoc[] | undefined;

  const selectedProject =
    projects?.find((p) => p._id === selectedProjectId) ?? null;
  const isProjectBoard = selectedProjectId !== null && viewMode === "board";

  // Filtro efetivo de projeto: o seletor manda; na visão "Todas" vale o select.
  const projectFilterId =
    selectedProjectId ??
    (filters.projectId ? (filters.projectId as Id<"taskProjects">) : null);

  const taskQueryArgs = useMemo(
    () => ({
      organizationId,
      ...(projectFilterId ? { projectId: projectFilterId } : {}),
      ...(search ? { search } : {}),
      ...(filters.status ? { status: filters.status as TaskStatus } : {}),
      ...(filters.priority ? { priority: filters.priority as TaskPriority } : {}),
      ...(filters.assigneeId
        ? { assigneeId: filters.assigneeId as Id<"teamMembers"> }
        : {}),
      ...(filters.activityType
        ? { activityType: filters.activityType as ActivityType }
        : {}),
      ...(filters.labelIds.length > 0 ? { labelIds: filters.labelIds } : {}),
      ...(isProjectBoard ? { sortBy: "order", sortOrder: "asc" as const } : {}),
    }),
    [organizationId, projectFilterId, search, filters, isProjectBoard]
  );

  const tasks = useQuery(api.tasks.getTasks, taskQueryArgs) as
    | TaskListItem[]
    | undefined;

  const completeTask = useMutation(api.tasks.completeTask);
  const bulkUpdateTasks = useMutation(api.tasks.bulkUpdateTasks);
  const archiveProject = useMutation(api.taskProjects.archiveProject);
  const deleteProject = useMutation(api.taskProjects.deleteProject);

  const projectMap = useMemo(() => {
    const map = new Map<string, { name: string; color?: string }>();
    projects?.forEach((p) => map.set(p._id, { name: p.name, color: p.color }));
    return map;
  }, [projects]);

  // Deep-link ?task=<id> — o sino e os e-mails apontam para /app/tarefas?task=…
  const openTaskDetail = useCallback(
    (taskId: Id<"tasks">) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("task", taskId);
          return next;
        },
        { preventScrollReset: true }
      );
    },
    [setSearchParams]
  );

  const closeTaskDetail = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("task");
        return next;
      },
      { replace: true, preventScrollReset: true }
    );
  }, [setSearchParams]);

  // Smart filters continuam no cliente (dependem do relógio local)
  const filteredTasks = useMemo(() => {
    if (!tasks) return [];
    let result = [...tasks];

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const endOfWeek = new Date(startOfToday);
    endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
    endOfWeek.setHours(23, 59, 59, 999);

    const isOpen = (t: TaskListItem) =>
      t.status !== "completed" && t.status !== "cancelled";

    switch (smartFilter) {
      case "today":
        result = result.filter(
          (t) =>
            t.dueDate &&
            t.dueDate >= startOfToday.getTime() &&
            t.dueDate <= endOfToday.getTime() &&
            isOpen(t)
        );
        break;
      case "overdue":
        result = result.filter((t) => t.dueDate && t.dueDate < now && isOpen(t));
        break;
      case "week":
        result = result.filter(
          (t) =>
            t.dueDate &&
            t.dueDate >= startOfToday.getTime() &&
            t.dueDate <= endOfWeek.getTime() &&
            isOpen(t)
        );
        break;
      case "unassigned":
        result = result.filter(
          (t) =>
            (t.assigneeIds?.length ?? 0) === 0 && !t.assignedTo && isOpen(t)
        );
        break;
      case "reminders":
        result = result.filter((t) => t.type === "reminder" && isOpen(t));
        break;
    }

    return result;
  }, [tasks, smartFilter, now]);

  // Agrupamento por vencimento (visão em lista)
  const groupedTasks = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const endOfWeek = new Date(startOfToday);
    endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
    endOfWeek.setHours(23, 59, 59, 999);

    const groups: {
      key: string;
      label: string;
      tasks: TaskListItem[];
      color?: string;
      defaultOpen: boolean;
    }[] = [
      { key: "overdue", label: "Atrasadas", tasks: [], color: "text-semantic-error", defaultOpen: true },
      { key: "today", label: "Hoje", tasks: [], color: "text-brand-500", defaultOpen: true },
      { key: "week", label: "Esta Semana", tasks: [], defaultOpen: true },
      { key: "future", label: "Futuras", tasks: [], defaultOpen: true },
      { key: "noDate", label: "Sem Data", tasks: [], defaultOpen: true },
      { key: "completed", label: "Concluídas", tasks: [], defaultOpen: false },
    ];

    for (const task of filteredTasks) {
      if (task.status === "completed" || task.status === "cancelled") {
        groups[5].tasks.push(task);
      } else if (!task.dueDate) {
        groups[4].tasks.push(task);
      } else if (task.dueDate < startOfToday.getTime()) {
        groups[0].tasks.push(task);
      } else if (task.dueDate <= endOfToday.getTime()) {
        groups[1].tasks.push(task);
      } else if (task.dueDate <= endOfWeek.getTime()) {
        groups[2].tasks.push(task);
      } else {
        groups[3].tasks.push(task);
      }
    }

    return groups.filter((g) => g.tasks.length > 0);
  }, [filteredTasks]);

  // Filtros atuais no formato de savedViews
  const currentSavedFilters = useMemo<TaskSavedFilters>(() => {
    const saved: TaskSavedFilters = {};
    if (filters.status) saved.statuses = [filters.status as TaskStatus];
    if (filters.priority) saved.priorities = [filters.priority as TaskPriority];
    if (filters.activityType)
      saved.activityType = filters.activityType as ActivityType;
    if (filters.assigneeId)
      saved.assigneeIds = [filters.assigneeId as Id<"teamMembers">];
    if (filters.labelIds.length > 0) saved.labelIds = filters.labelIds;
    if (projectFilterId) saved.projectId = projectFilterId;
    if (smartFilter === "reminders") saved.taskType = "reminder";
    if (smartFilter === "today" || smartFilter === "overdue" || smartFilter === "week") {
      saved.dueFilter = smartFilter;
    }
    return saved;
  }, [filters, projectFilterId, smartFilter]);

  const applySavedFilters = useCallback((saved: TaskSavedFilters) => {
    setSelectedProjectId(saved.projectId ?? null);
    setFilters({
      status: saved.statuses?.[0] ?? "",
      priority: saved.priorities?.[0] ?? "",
      assigneeId: saved.assigneeIds?.[0] ?? "",
      activityType: saved.activityType ?? "",
      labelIds: saved.labelIds ?? [],
      projectId: "",
    });
    if (saved.taskType === "reminder") {
      setSmartFilter("reminders");
    } else if (
      saved.dueFilter === "today" ||
      saved.dueFilter === "overdue" ||
      saved.dueFilter === "week"
    ) {
      setSmartFilter(saved.dueFilter);
    } else {
      setSmartFilter("all");
    }
    setSelectedTasks(new Set());
    toast.success("Filtro aplicado");
  }, []);

  const handleCompleteTask = async (taskId: Id<"tasks">) => {
    try {
      await completeTask({ taskId });
      toast.success("Tarefa concluída!");
    } catch {
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

  const handleBulkCancel = async () => {
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

  const handleSelectProject = (projectId: Id<"taskProjects"> | null) => {
    setSelectedProjectId(projectId);
    setSelectedTasks(new Set());
    // Sem projeto não existe kanban de colunas; o filtro de projeto é exclusivo
    // da visão "Todas as tarefas".
    if (projectId) setFilters((prev) => ({ ...prev, projectId: "" }));
  };

  const handleConfirmProjectAction = async () => {
    if (!pendingProjectAction) return;
    const { type, project } = pendingProjectAction;
    try {
      if (type === "archive") {
        await archiveProject({ projectId: project._id });
        toast.success("Projeto arquivado");
      } else {
        await deleteProject({ projectId: project._id });
        toast.success("Projeto excluído");
      }
      if (selectedProjectId === project._id) setSelectedProjectId(null);
    } catch (error: any) {
      toast.error(error?.message || "Falha ao atualizar projeto");
    } finally {
      setPendingProjectAction(null);
    }
  };

  const hasActiveQuery =
    !!search ||
    smartFilter !== "all" ||
    !!filters.status ||
    !!filters.priority ||
    !!filters.assigneeId ||
    !!filters.activityType ||
    filters.labelIds.length > 0 ||
    !!filters.projectId;

  return (
    <div className="space-y-4 max-w-7xl">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h1 className="text-2xl font-bold text-text-primary">Tarefas</h1>
        <div className="flex items-center gap-2">
          {/* Busca (full-text no servidor) */}
          <div className="relative flex-1 md:w-64 md:flex-none">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Buscar tarefas..."
              aria-label="Buscar tarefas"
              className="w-full pl-9 pr-9 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
              style={{ fontSize: "16px" }}
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                aria-label="Limpar busca"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Alternância de visualização */}
          <div className="flex bg-surface-raised border border-border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setViewMode("list")}
              aria-pressed={viewMode === "list"}
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
              type="button"
              onClick={() => setViewMode("board")}
              aria-pressed={viewMode === "board"}
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

          {canEdit && (
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

      {/* Seletor de projetos */}
      <ProjectSwitcher
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelect={handleSelectProject}
        canManage={canManageProjects}
        onCreate={() => {
          setProjectBeingEdited(null);
          setProjectFormOpen(true);
        }}
        onEdit={(project) => {
          setProjectBeingEdited(project);
          setProjectFormOpen(true);
        }}
        onManageColumns={(project) => setColumnsProject(project)}
        onArchive={(project) =>
          setPendingProjectAction({ type: "archive", project })
        }
        onDelete={(project) =>
          setPendingProjectAction({ type: "delete", project })
        }
      />

      {selectedProject?.description && (
        <p className="text-sm text-text-secondary">
          {selectedProject.description}
        </p>
      )}

      {/* Smart list pills */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        <SmartPill
          label="Todas"
          active={smartFilter === "all"}
          onClick={() => setSmartFilter("all")}
        />
        <SmartPill
          label="Hoje"
          count={taskCounts?.dueToday}
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

      {/* Filtros + filtros salvos */}
      <TaskFiltersBar
        filters={filters}
        onChange={setFilters}
        teamMembers={teamMembers}
        labels={labels}
        projects={projects}
        showProjectFilter={selectedProjectId === null}
        trailing={
          <SavedFiltersMenu
            organizationId={organizationId}
            currentFilters={currentSavedFilters}
            onApply={applySavedFilters}
          />
        }
      />

      {/* Ações em massa */}
      {selectedTasks.size > 0 && canEdit && (
        <div className="sticky top-14 md:top-16 z-10 flex items-center gap-3 p-3 bg-surface-overlay border border-border rounded-card animate-fade-in-up">
          <span className="text-sm font-medium text-text-primary">
            {selectedTasks.size} selecionada{selectedTasks.size > 1 ? "s" : ""}
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="primary" onClick={handleBulkComplete}>
            <CheckSquare size={14} />
            Concluir
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setShowBulkCancelConfirm(true)}
          >
            <Trash2 size={14} />
            Cancelar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelectedTasks(new Set())}>
            Limpar
          </Button>
        </div>
      )}

      {/* Conteúdo */}
      {tasks === undefined ? (
        <div className="flex justify-center items-center h-64">
          <Spinner size="lg" />
        </div>
      ) : isProjectBoard ? (
        <TaskKanbanBoard
          columns={columns}
          tasks={filteredTasks}
          onOpenDetail={openTaskDetail}
          now={now}
          canEdit={canEdit}
        />
      ) : filteredTasks.length === 0 ? (
        <EmptyState
          icon={CheckSquare}
          title="Nenhuma tarefa encontrada"
          description={
            hasActiveQuery
              ? "Tente ajustar os filtros ou a busca."
              : selectedProject
                ? `Nenhuma tarefa em ${selectedProject.name} ainda.`
                : "Crie sua primeira tarefa para organizar seu trabalho."
          }
          action={
            !hasActiveQuery && canEdit
              ? { label: "Nova Tarefa", onClick: () => setShowCreateModal(true) }
              : undefined
          }
        />
      ) : viewMode === "list" ? (
        <ListView
          groupedTasks={groupedTasks}
          projectMap={projectMap}
          showProject={selectedProjectId === null}
          selectedTasks={selectedTasks}
          onToggleSelect={toggleSelectTask}
          onComplete={handleCompleteTask}
          onOpenDetail={openTaskDetail}
          now={now}
        />
      ) : (
        <StatusBoardView
          tasks={filteredTasks}
          onOpenDetail={openTaskDetail}
          now={now}
        />
      )}

      {/* Modais */}
      <CreateTaskModal
        organizationId={organizationId}
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        defaultProjectId={selectedProjectId ?? undefined}
      />

      {selectedTaskId && (
        <TaskDetailSlideOver
          taskId={selectedTaskId}
          organizationId={organizationId}
          isOpen={true}
          onClose={closeTaskDetail}
        />
      )}

      <ProjectFormModal
        open={projectFormOpen}
        onClose={() => setProjectFormOpen(false)}
        organizationId={organizationId}
        project={projectBeingEdited}
        onCreated={(projectId) => handleSelectProject(projectId)}
      />

      <ColumnsEditorModal
        open={columnsProject !== null}
        onClose={() => setColumnsProject(null)}
        projectId={columnsProject?._id ?? null}
        projectName={columnsProject?.name}
      />

      <ConfirmDialog
        open={pendingProjectAction !== null}
        onClose={() => setPendingProjectAction(null)}
        onConfirm={handleConfirmProjectAction}
        title={
          pendingProjectAction?.type === "delete"
            ? "Excluir projeto"
            : "Arquivar projeto"
        }
        description={
          pendingProjectAction?.type === "delete"
            ? `Excluir “${pendingProjectAction.project.name}”? As tarefas continuam existindo, mas saem do projeto e do quadro.`
            : `Arquivar “${pendingProjectAction?.project.name}”? Ele sai da lista de projetos, sem afetar as tarefas.`
        }
        confirmLabel={
          pendingProjectAction?.type === "delete" ? "Excluir" : "Arquivar"
        }
        variant={pendingProjectAction?.type === "delete" ? "danger" : "default"}
      />

      <ConfirmDialog
        open={showBulkCancelConfirm}
        onClose={() => setShowBulkCancelConfirm(false)}
        onConfirm={handleBulkCancel}
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
      type="button"
      onClick={onClick}
      aria-pressed={active}
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
  projectMap,
  showProject,
  selectedTasks,
  onToggleSelect,
  onComplete,
  onOpenDetail,
  now,
}: {
  groupedTasks: {
    key: string;
    label: string;
    tasks: TaskListItem[];
    color?: string;
    defaultOpen: boolean;
  }[];
  projectMap: Map<string, { name: string; color?: string }>;
  showProject: boolean;
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
              project={
                showProject && task.projectId
                  ? projectMap.get(task.projectId)
                  : undefined
              }
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
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-surface-overlay transition-colors"
      >
        {open ? (
          <ChevronDown size={16} className="text-text-muted" aria-hidden="true" />
        ) : (
          <ChevronRight size={16} className="text-text-muted" aria-hidden="true" />
        )}
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
  project,
  isSelected,
  onToggleSelect,
  onComplete,
  onClick,
  now,
}: {
  task: TaskListItem;
  project?: { name: string; color?: string };
  isSelected: boolean;
  onToggleSelect: () => void;
  onComplete: () => void;
  onClick: () => void;
  now: number;
}) {
  const isCompleted = task.status === "completed" || task.status === "cancelled";
  const ActivityIcon = task.activityType
    ? ACTIVITY_ICONS[task.activityType] || ClipboardList
    : ClipboardList;
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
      <Checkbox
        checked={isSelected}
        onChange={onToggleSelect}
        containerClassName="shrink-0"
        aria-label={`Selecionar tarefa ${task.title}`}
      />

      <button
        type="button"
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
            <path
              d="M1 4L3.5 6.5L9 1"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>

      <ActivityIcon
        size={16}
        className="shrink-0 text-text-muted"
        aria-label={task.activityType ? ACTIVITY_LABELS[task.activityType] : "Tarefa"}
      />

      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={onClick}
          className="w-full text-left rounded focus:outline-none focus:ring-2 focus:ring-brand-500"
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
        {/* Meta fora do botão do título: o chip do lead é clicável por si. */}
        {(task.labels?.length || project || task.lead || task.contact) && (
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            {project && (
              <span className="inline-flex items-center gap-1 text-[10px] text-text-muted">
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: project.color || "#71717A" }}
                  aria-hidden="true"
                />
                {project.name}
              </span>
            )}
            <TaskLeadChip lead={task.lead} contact={task.contact} />
            <TaskLabelChips labels={task.labels} />
          </div>
        )}
      </div>

      {checklistTotal > 0 && (
        <span className="hidden md:inline text-xs text-text-muted tabular-nums shrink-0">
          {checklistDone}/{checklistTotal}
        </span>
      )}

      <Badge
        variant={priorityBadge.variant}
        className="hidden md:inline-flex shrink-0 text-[10px]"
      >
        {priorityBadge.label}
      </Badge>

      <TaskAssigneeStack
        assignees={task.assignees}
        className="hidden md:flex shrink-0"
      />

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
// StatusBoardView — quadro por status (visão "Todas as tarefas")
// ============================================================================

function StatusBoardView({
  tasks,
  onOpenDetail,
  now,
}: {
  tasks: TaskListItem[];
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
    const map: Record<string, TaskListItem[]> = {
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
      await updateTask({ taskId, status: newStatus });
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
          <StatusColumn
            key={col.status}
            status={col.status}
            label={col.label}
            color={col.color}
            tasks={tasksByStatus[col.status] || []}
            onOpenDetail={onOpenDetail}
            now={now}
          />
        ))}
      </div>

      <DragOverlay>
        {activeTask && (
          <StatusCard task={activeTask} onOpenDetail={() => {}} now={now} isDragging />
        )}
      </DragOverlay>
    </DndContext>
  );
}

function StatusColumn({
  status,
  label,
  color,
  tasks,
  onOpenDetail,
  now,
}: {
  status: TaskStatus;
  label: string;
  color: string;
  tasks: TaskListItem[];
  onOpenDetail: (id: Id<"tasks">) => void;
  now: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "rounded-card border border-border bg-surface-sunken min-h-[200px] transition-colors",
        isOver && "border-brand-500 bg-brand-500/5"
      )}
    >
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <span className={cn("w-2 h-2 rounded-full", color)} aria-hidden="true" />
        <h3 className="text-sm font-semibold text-text-primary">{label}</h3>
        <span className="text-xs text-text-muted tabular-nums">{tasks.length}</span>
      </header>
      <div className="p-2 space-y-2">
        {tasks.map((task) => (
          <DraggableStatusCard
            key={task._id}
            task={task}
            onOpenDetail={onOpenDetail}
            now={now}
          />
        ))}
      </div>
    </section>
  );
}

function DraggableStatusCard({
  task,
  onOpenDetail,
  now,
}: {
  task: TaskListItem;
  onOpenDetail: (id: Id<"tasks">) => void;
  now: number;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task._id,
  });

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        opacity: isDragging ? 0.5 : 1,
      }
    : undefined;

  return (
    <div ref={setNodeRef} style={style} {...attributes} tabIndex={-1} {...listeners}>
      <StatusCard task={task} onOpenDetail={onOpenDetail} now={now} />
    </div>
  );
}

function StatusCard({
  task,
  onOpenDetail,
  now,
  isDragging,
}: {
  task: TaskListItem;
  onOpenDetail: (id: Id<"tasks">) => void;
  now: number;
  isDragging?: boolean;
}) {
  const ActivityIcon = task.activityType
    ? ACTIVITY_ICONS[task.activityType] || ClipboardList
    : ClipboardList;
  const priorityBadge = PRIORITY_BADGE[task.priority];
  const checklistTotal = task.checklist?.length ?? 0;
  const checklistDone = task.checklist?.filter((c) => c.completed).length ?? 0;

  // Mesmo arranjo do card do kanban: o botão cobre o conteúdo não-interativo e
  // o chip do lead fica fora dele (um <button> não pode conter outro).
  return (
    <div
      className={cn(
        "w-full text-left p-3 rounded-lg bg-surface-raised border border-border transition-colors",
        "hover:border-brand-500/50 focus-within:border-brand-500/50",
        isDragging && "shadow-elevated"
      )}
    >
      <button
        type="button"
        onClick={() => onOpenDetail(task._id)}
        aria-label={`Abrir tarefa ${task.title}`}
        className="w-full text-left rounded focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-sunken"
      >
        <div className="flex items-start gap-2 mb-2">
          <ActivityIcon
            size={14}
            className="text-text-muted mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span className="text-sm font-medium text-text-primary line-clamp-2">
            {task.title}
          </span>
        </div>

        <TaskLabelChips labels={task.labels} className="mb-2 flex-wrap" />

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
                "text-[10px] font-medium tabular-nums",
                task.dueDate < now && task.status !== "completed"
                  ? "text-semantic-error"
                  : "text-text-muted"
              )}
            >
              {formatRelativeDate(task.dueDate, now)}
            </span>
          )}
          <TaskAssigneeStack assignees={task.assignees} className="ml-auto" />
        </div>
      </button>

      {(task.lead || task.contact) && (
        <div className="mt-2 flex">
          <TaskLeadChip lead={task.lead} contact={task.contact} />
        </div>
      )}
    </div>
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
