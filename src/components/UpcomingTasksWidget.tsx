import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { useRoundedNow } from "@/hooks/useRoundedNow";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { toast } from "sonner";
import {
  ChevronRight,
  ChevronDown,
  ClipboardList,
  Phone,
  Mail,
  CalendarClock,
  Users,
  Microscope,
  ListChecks,
} from "lucide-react";

// ============================================================================
// Types & Constants
// ============================================================================

type SmartFilter = "today" | "overdue" | "week" | "mine" | "all";
type PriorityFilter = "all" | "urgent" | "high" | "medium" | "low";
type TypeFilter = "all" | "task" | "reminder";

const SMART_FILTERS: { value: SmartFilter; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "overdue", label: "Atrasadas" },
  { value: "week", label: "Esta Semana" },
  { value: "mine", label: "Minhas Tarefas" },
  { value: "all", label: "Todas" },
];

const PRIORITY_FILTERS: { value: PriorityFilter; label: string }[] = [
  { value: "urgent", label: "Urgente" },
  { value: "high", label: "Alta" },
  { value: "medium", label: "M\u00e9dia" },
  { value: "low", label: "Baixa" },
];

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: "task", label: "Tarefas" },
  { value: "reminder", label: "Lembretes" },
];

const ACTIVITY_ICONS: Record<string, React.ElementType> = {
  todo: ClipboardList,
  call: Phone,
  email: Mail,
  follow_up: CalendarClock,
  meeting: Users,
  research: Microscope,
};

const PRIORITY_BADGE: Record<string, { variant: "default" | "info" | "warning" | "error"; label: string }> = {
  low: { variant: "default", label: "Baixa" },
  medium: { variant: "info", label: "M\u00e9dia" },
  high: { variant: "warning", label: "Alta" },
  urgent: { variant: "error", label: "Urgente" },
};

interface TaskItem {
  _id: Id<"tasks">;
  title: string;
  type: "task" | "reminder";
  status: string;
  priority: "low" | "medium" | "high" | "urgent";
  activityType?: string;
  dueDate?: number;
  assignedTo?: Id<"teamMembers">;
  createdBy: Id<"teamMembers">;
}

// ============================================================================
// UpcomingTasksWidget
// ============================================================================

export function UpcomingTasksWidget({
  organizationId,
}: {
  organizationId: Id<"organizations">;
}) {
  const navigate = useNavigate();

  // Filter state
  const [smartFilter, setSmartFilter] = useState<SmartFilter>("today");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  // Collapsed groups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());

  // Relógio LOCAL para agrupar/destacar na tela (atualiza a cada minuto, sem
  // custo no backend). Em args de query vai só o `queryNow` arredondado.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(interval);
  }, []);
  const queryNow = useRoundedNow();

  // Queries
  const tasks = useQuery(api.tasks.getUpcomingTasks, { organizationId });
  const taskCounts = useQuery(api.tasks.getTaskCounts, { organizationId, now: queryNow });
  const currentMember = useQuery(api.teamMembers.getCurrentTeamMember, { organizationId });
  const completeTask = useMutation(api.tasks.completeTask);

  const isLoading = tasks === undefined;
  const hasActiveFilters = smartFilter !== "today" || priorityFilter !== "all" || typeFilter !== "all";

  const clearFilters = () => {
    setSmartFilter("today");
    setPriorityFilter("all");
    setTypeFilter("all");
  };

  // Filter tasks: only pending/in_progress
  const filteredTasks = useMemo(() => {
    if (!tasks) return [];

    let result = (tasks as TaskItem[]).filter(
      (t) => t.status === "pending" || t.status === "in_progress"
    );

    // Smart filter
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const tomorrow = new Date(startOfToday);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const endOfTomorrow = new Date(tomorrow);
    endOfTomorrow.setHours(23, 59, 59, 999);
    const endOfWeek = new Date(startOfToday);
    endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
    endOfWeek.setHours(23, 59, 59, 999);

    switch (smartFilter) {
      case "today":
        result = result.filter(
          (t) =>
            (t.dueDate && t.dueDate <= endOfToday.getTime()) || // due today or overdue
            !t.dueDate // include tasks without due date
        );
        break;
      case "overdue":
        result = result.filter(
          (t) => t.dueDate != null && t.dueDate < startOfToday.getTime()
        );
        break;
      case "week":
        result = result.filter(
          (t) => t.dueDate && t.dueDate <= endOfWeek.getTime()
        );
        break;
      case "mine":
        result = result.filter(
          (t) => currentMember && t.assignedTo === currentMember._id
        );
        break;
      case "all":
        break;
    }

    // Priority filter
    if (priorityFilter !== "all") {
      result = result.filter((t) => t.priority === priorityFilter);
    }

    // Type filter
    if (typeFilter !== "all") {
      result = result.filter((t) => t.type === typeFilter);
    }

    return result;
  }, [tasks, smartFilter, priorityFilter, typeFilter, now, currentMember]);

  // Group tasks by due date buckets
  const groupedTasks = useMemo(() => {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const tomorrow = new Date(startOfToday);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const endOfTomorrow = new Date(tomorrow);
    endOfTomorrow.setHours(23, 59, 59, 999);
    const endOfWeek = new Date(startOfToday);
    endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
    endOfWeek.setHours(23, 59, 59, 999);

    const groups: { key: string; label: string; tasks: TaskItem[]; color: string }[] = [
      { key: "overdue", label: "Atrasadas", tasks: [], color: "text-semantic-error" },
      { key: "today", label: "Hoje", tasks: [], color: "text-brand-500" },
      { key: "tomorrow", label: "Amanh\u00e3", tasks: [], color: "text-text-primary" },
      { key: "week", label: "Esta Semana", tasks: [], color: "text-text-primary" },
      { key: "later", label: "Depois", tasks: [], color: "text-text-secondary" },
      { key: "noDate", label: "Sem Data", tasks: [], color: "text-text-muted" },
    ];

    for (const task of filteredTasks) {
      if (!task.dueDate) {
        groups[5].tasks.push(task);
      } else if (task.dueDate < startOfToday.getTime()) {
        groups[0].tasks.push(task);
      } else if (task.dueDate <= endOfToday.getTime()) {
        groups[1].tasks.push(task);
      } else if (task.dueDate <= endOfTomorrow.getTime()) {
        groups[2].tasks.push(task);
      } else if (task.dueDate <= endOfWeek.getTime()) {
        groups[3].tasks.push(task);
      } else {
        groups[4].tasks.push(task);
      }
    }

    return groups.filter((g) => g.tasks.length > 0);
  }, [filteredTasks, now]);

  const handleComplete = async (taskId: Id<"tasks">) => {
    try {
      await completeTask({ taskId });
      toast.success("Tarefa conclu\u00edda!");
    } catch {
      toast.error("Falha ao concluir tarefa");
    }
  };

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Smart filter count badges
  const filterCounts = useMemo(() => {
    return {
      today: taskCounts?.dueToday ?? 0,
      overdue: taskCounts?.overdue ?? 0,
      week: 0,
      mine: taskCounts?.myPending ?? 0,
      all: 0,
    };
  }, [taskCounts]);

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold text-text-primary">Próximas Tarefas</h3>
          {taskCounts && taskCounts.overdue > 0 && (
            <Badge variant="error">{taskCounts.overdue} atrasada{taskCounts.overdue > 1 ? "s" : ""}</Badge>
          )}
        </div>
        <button
          onClick={() => navigate("/app/tarefas")}
          className="flex items-center gap-1 text-sm text-brand-500 hover:text-brand-400 transition-colors font-medium"
        >
          Ver todas
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Filter pills */}
      <div className="space-y-2 mb-4">
        {/* Smart filters */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {SMART_FILTERS.map((filter) => {
            const count = filterCounts[filter.value];
            return (
              <button
                key={filter.value}
                onClick={() => setSmartFilter(filter.value)}
                className={cn(
                  "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors min-h-[32px]",
                  smartFilter === filter.value
                    ? "bg-brand-500/20 text-brand-400"
                    : "bg-surface-overlay text-text-secondary hover:text-text-primary"
                )}
              >
                {filter.label}
                {count > 0 && (
                  <span
                    className={cn(
                      "text-[10px] font-bold tabular-nums",
                      smartFilter === filter.value
                        ? "text-brand-400"
                        : filter.value === "overdue"
                          ? "text-semantic-error"
                          : "text-text-muted"
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {/* Priority + type filters */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {PRIORITY_FILTERS.map((filter) => (
            <button
              key={filter.value}
              onClick={() => setPriorityFilter(priorityFilter === filter.value ? "all" : filter.value)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                priorityFilter === filter.value
                  ? "bg-brand-500/20 text-brand-400"
                  : "bg-surface-overlay text-text-secondary hover:text-text-primary"
              )}
            >
              {filter.label}
            </button>
          ))}
          <div className="w-px h-4 bg-border mx-1" />
          {TYPE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              onClick={() => setTypeFilter(typeFilter === filter.value ? "all" : filter.value)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                typeFilter === filter.value
                  ? "bg-brand-500/20 text-brand-400"
                  : "bg-surface-overlay text-text-secondary hover:text-text-primary"
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {/* Loading skeleton */}
      {isLoading && (
        <div className="divide-y divide-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-3">
              <Skeleton className="h-5 w-5 rounded-full shrink-0" />
              <Skeleton className="h-4 w-4 rounded shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-3/4" />
              </div>
              <Skeleton className="h-4 w-12 shrink-0 hidden md:block" />
              <Skeleton className="h-3 w-14 shrink-0" />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && filteredTasks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 px-4">
          <div className="w-12 h-12 rounded-xl bg-surface-overlay flex items-center justify-center mb-3">
            <ListChecks size={24} className="text-text-muted" />
          </div>
          <p className="text-sm font-medium text-text-primary mb-1">
            Nenhuma tarefa encontrada
          </p>
          <p className="text-xs text-text-muted text-center">
            {hasActiveFilters
              ? "Tente ajustar os filtros."
              : "As tarefas aparecer\u00e3o aqui automaticamente."}
          </p>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" className="mt-3" onClick={clearFilters}>
              Limpar filtros
            </Button>
          )}
        </div>
      )}

      {/* Date-grouped task entries */}
      {!isLoading && groupedTasks.length > 0 && (
        <div className="space-y-1">
          {groupedTasks.map((group) => {
            const isCollapsed = collapsedGroups.has(group.key);
            return (
              <div key={group.key}>
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(group.key)}
                  className="w-full flex items-center gap-3 py-2 hover:bg-surface-overlay/50 transition-colors rounded-lg px-1"
                >
                  <ChevronDown
                    size={14}
                    className={cn(
                      "text-text-muted transition-transform duration-200 shrink-0",
                      isCollapsed && "-rotate-90"
                    )}
                  />
                  <span className={cn("text-[11px] font-semibold uppercase tracking-wider", group.color)}>
                    {group.label}
                  </span>
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-[10px] text-text-muted tabular-nums">
                    {group.tasks.length}
                  </span>
                </button>

                {/* Tasks in group */}
                {!isCollapsed && (
                  <div className="divide-y divide-border">
                    {group.tasks.map((task) => (
                      <TaskRow
                        key={task._id}
                        task={task}
                        now={now}
                        onComplete={() => handleComplete(task._id)}
                        onNavigate={() => navigate("/app/tarefas")}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Footer */}
          <div className="pt-3 border-t border-border mt-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => navigate("/app/tarefas")}
            >
              Ver todas as tarefas
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ============================================================================
// TaskRow
// ============================================================================

function TaskRow({
  task,
  now,
  onComplete,
  onNavigate,
}: {
  task: TaskItem;
  now: number;
  onComplete: () => void;
  onNavigate: () => void;
}) {
  const ActivityIcon = task.activityType
    ? ACTIVITY_ICONS[task.activityType] || ClipboardList
    : ClipboardList;
  const priorityBadge = PRIORITY_BADGE[task.priority];

  return (
    <div className="flex items-center gap-2 md:gap-3 py-2.5 px-1 hover:bg-surface-overlay/50 transition-colors rounded-lg">
      {/* Complete checkbox */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onComplete();
        }}
        className="shrink-0 w-5 h-5 rounded-full border-2 border-border-strong hover:border-brand-500 flex items-center justify-center transition-colors"
        aria-label="Concluir tarefa"
      />

      {/* Activity type icon */}
      <ActivityIcon size={16} className="shrink-0 text-text-muted" />

      {/* Title */}
      <button
        onClick={onNavigate}
        className="flex-1 min-w-0 text-left"
      >
        <span className="text-sm font-medium text-text-primary truncate block">
          {task.title}
        </span>
      </button>

      {/* Priority badge (desktop) */}
      <Badge variant={priorityBadge.variant} className="hidden md:inline-flex shrink-0 text-[10px]">
        {priorityBadge.label}
      </Badge>

      {/* Due date */}
      {task.dueDate && (
        <span
          className={cn(
            "text-xs font-medium shrink-0 tabular-nums",
            task.dueDate < now
              ? "text-semantic-error"
              : isDueToday(task.dueDate, now)
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
// Helpers
// ============================================================================

function isDueToday(dueDate: number, now: number): boolean {
  const today = new Date(now);
  const due = new Date(dueDate);
  return (
    due.getFullYear() === today.getFullYear() &&
    due.getMonth() === today.getMonth() &&
    due.getDate() === today.getDate()
  );
}

function formatRelativeDate(dueDate: number, now: number): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(dueDate);
  dueDay.setHours(0, 0, 0, 0);

  const diffMs = dueDay.getTime() - today.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < -1) return `${Math.abs(diffDays)}d atr\u00e1s`;
  if (diffDays === -1) return "Ontem";
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Amanh\u00e3";
  if (diffDays <= 7) return `${diffDays}d`;
  return new Date(dueDate).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}
