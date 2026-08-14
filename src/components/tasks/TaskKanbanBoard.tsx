import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCorners,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  ClipboardList,
  Mail,
  Microscope,
  Phone,
  Users,
} from "lucide-react";
import { toast } from "sonner";

// Kanban do projeto: uma coluna por `taskColumns`, ordem manual por `order`
// fracionário. Este arquivo também hospeda as primitivas visuais do card
// (chips de etiqueta, pilha de responsáveis, data relativa) reaproveitadas
// pela lista da TasksPage.

// ============================================================================
// Tipos compartilhados
// ============================================================================

export interface TaskLabelRef {
  _id: Id<"taskLabels">;
  name: string;
  color: string;
}

export interface TaskAssigneeRef {
  _id: Id<"teamMembers">;
  name: string;
  type: "human" | "ai";
}

export interface TaskListItem {
  _id: Id<"tasks">;
  title: string;
  description?: string;
  type: "task" | "reminder";
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "low" | "medium" | "high" | "urgent";
  activityType?: string;
  dueDate?: number;
  completedAt?: number;
  snoozedUntil?: number;
  assignedTo?: Id<"teamMembers">;
  assigneeIds?: Id<"teamMembers">[];
  assignees?: TaskAssigneeRef[];
  labelIds?: Id<"taskLabels">[];
  labels?: TaskLabelRef[];
  projectId?: Id<"taskProjects">;
  columnId?: Id<"taskColumns">;
  order?: number;
  leadId?: Id<"leads">;
  contactId?: Id<"contacts">;
  createdBy: Id<"teamMembers">;
  checklist?: { id: string; title: string; completed: boolean }[];
  tags?: string[];
  recurrence?: { pattern: string };
  createdAt: number;
  updatedAt: number;
}

export interface TaskColumnDoc {
  _id: Id<"taskColumns">;
  projectId: Id<"taskProjects">;
  name: string;
  order: number;
  color?: string;
  wipLimit?: number;
  isDoneColumn?: boolean;
}

// ============================================================================
// Constantes visuais compartilhadas
// ============================================================================

export const ACTIVITY_ICONS: Record<string, React.ElementType> = {
  todo: ClipboardList,
  call: Phone,
  email: Mail,
  follow_up: CalendarClock,
  meeting: Users,
  research: Microscope,
};

export const ACTIVITY_LABELS: Record<string, string> = {
  todo: "Tarefa",
  call: "Ligação",
  email: "E-mail",
  follow_up: "Follow-up",
  meeting: "Reunião",
  research: "Pesquisa",
};

export const PRIORITY_BADGE: Record<
  string,
  { variant: "default" | "info" | "warning" | "error"; label: string }
> = {
  low: { variant: "default", label: "Baixa" },
  medium: { variant: "info", label: "Média" },
  high: { variant: "warning", label: "Alta" },
  urgent: { variant: "error", label: "Urgente" },
};

export const STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  in_progress: "Em Progresso",
  completed: "Concluída",
  cancelled: "Cancelada",
};

export function formatRelativeDate(dueDate: number, now: number): string {
  const due = new Date(dueDate);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(dueDate);
  dueDay.setHours(0, 0, 0, 0);

  const diffDays = Math.round(
    (dueDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (diffDays < -1) return `${Math.abs(diffDays)}d atrás`;
  if (diffDays === -1) return "Ontem";
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Amanhã";
  if (diffDays <= 7) return `${diffDays}d`;
  return due.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

// ============================================================================
// Primitivas de card (usadas no kanban e na lista)
// ============================================================================

export function TaskLabelChips({
  labels,
  max = 3,
  className,
}: {
  labels?: TaskLabelRef[];
  max?: number;
  className?: string;
}) {
  if (!labels || labels.length === 0) return null;
  const visible = labels.slice(0, max);
  const hidden = labels.length - visible.length;

  return (
    <span className={cn("inline-flex items-center gap-1 min-w-0", className)}>
      {visible.map((label) => (
        <span
          key={label._id}
          className="inline-flex items-center gap-1 max-w-[110px] rounded-full px-2 py-0.5 text-[10px] font-medium border truncate"
          style={{
            color: label.color,
            borderColor: `${label.color}59`,
            backgroundColor: `${label.color}1A`,
          }}
          title={label.name}
        >
          {label.name}
        </span>
      ))}
      {hidden > 0 && (
        <span
          className="text-[10px] font-medium text-text-muted tabular-nums"
          title={labels
            .slice(max)
            .map((l) => l.name)
            .join(", ")}
        >
          +{hidden}
        </span>
      )}
    </span>
  );
}

export function TaskAssigneeStack({
  assignees,
  max = 3,
  size = "sm",
  className,
}: {
  assignees?: TaskAssigneeRef[];
  max?: number;
  size?: "sm" | "md";
  className?: string;
}) {
  if (!assignees || assignees.length === 0) return null;
  const visible = assignees.slice(0, max);
  const hidden = assignees.length - visible.length;

  return (
    <div
      className={cn("flex items-center", className)}
      title={assignees.map((a) => a.name).join(", ")}
    >
      <div className="flex -space-x-2">
        {visible.map((member) => (
          <Avatar
            key={member._id}
            name={member.name}
            type={member.type}
            size={size}
            className="ring-2 ring-surface-raised rounded-full"
          />
        ))}
      </div>
      {hidden > 0 && (
        <span className="ml-1 text-[10px] font-medium text-text-muted tabular-nums">
          +{hidden}
        </span>
      )}
    </div>
  );
}

// ============================================================================
// Ordem fracionária
// ============================================================================

const ORDER_STEP = 1000;
const COLUMN_PREFIX = "col:";

/** Ordem de uma task na posição `index`; tasks legadas sem `order` caem na posição. */
function orderOf(task: TaskListItem | undefined, index: number): number {
  return task?.order ?? (index + 1) * ORDER_STEP;
}

function computeOrder(before: number | null, after: number | null): number {
  if (before === null && after === null) return ORDER_STEP;
  if (before === null) return after! - ORDER_STEP;
  if (after === null) return before + ORDER_STEP;
  return (before + after) / 2;
}

// ============================================================================
// TaskKanbanBoard
// ============================================================================

interface TaskKanbanBoardProps {
  columns: TaskColumnDoc[] | undefined;
  tasks: TaskListItem[];
  onOpenDetail: (id: Id<"tasks">) => void;
  now: number;
  /** Quando falso, o quadro é somente leitura (sem drag-and-drop). */
  canEdit: boolean;
}

export function TaskKanbanBoard({
  columns,
  tasks,
  onOpenDetail,
  now,
  canEdit,
}: TaskKanbanBoardProps) {
  const moveTaskToColumn = useMutation(api.tasks.moveTaskToColumn);
  const reorderTask = useMutation(api.tasks.reorderTask);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  const sortedColumns = useMemo(
    () => [...(columns ?? [])].sort((a, b) => a.order - b.order),
    [columns]
  );

  const taskById = useMemo(() => {
    const map = new Map<string, TaskListItem>();
    for (const task of tasks) map.set(task._id, task);
    return map;
  }, [tasks]);

  /** Tasks por coluna, já na ordem manual; tasks sem coluna ficam à parte. */
  const { byColumn, orphans } = useMemo(() => {
    const known = new Set(sortedColumns.map((c) => c._id as string));
    const grouped = new Map<string, TaskListItem[]>();
    for (const column of sortedColumns) grouped.set(column._id, []);
    const loose: TaskListItem[] = [];

    for (const task of tasks) {
      if (task.columnId && known.has(task.columnId)) {
        grouped.get(task.columnId)!.push(task);
      } else {
        loose.push(task);
      }
    }
    for (const list of grouped.values()) {
      list.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    }
    return { byColumn: grouped, orphans: loose };
  }, [tasks, sortedColumns]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const activeTask = taskById.get(String(active.id));
    if (!activeTask) return;

    const overId = String(over.id);
    const destColumnId = overId.startsWith(COLUMN_PREFIX)
      ? (overId.slice(COLUMN_PREFIX.length) as Id<"taskColumns">)
      : taskById.get(overId)?.columnId;
    if (!destColumnId || !byColumn.has(destColumnId)) return;

    const destList = byColumn.get(destColumnId)!;
    const sameColumn = activeTask.columnId === destColumnId;
    const currentIndex = destList.findIndex((t) => t._id === activeTask._id);

    let insertAt: number;
    if (overId.startsWith(COLUMN_PREFIX)) {
      insertAt = sameColumn ? destList.length - 1 : destList.length;
    } else {
      const overIndex = destList.findIndex((t) => t._id === overId);
      insertAt = overIndex === -1 ? destList.length : overIndex;
    }

    if (sameColumn && insertAt === currentIndex) return;

    const without = destList.filter((t) => t._id !== activeTask._id);
    const projected = [
      ...without.slice(0, insertAt),
      activeTask,
      ...without.slice(insertAt),
    ];
    const before =
      insertAt > 0 ? orderOf(projected[insertAt - 1], insertAt - 1) : null;
    const after =
      insertAt + 1 < projected.length
        ? orderOf(projected[insertAt + 1], insertAt + 1)
        : null;
    const order = computeOrder(before, after);

    const destColumn = sortedColumns.find((c) => c._id === destColumnId);

    try {
      if (sameColumn) {
        await reorderTask({ taskId: activeTask._id, order });
      } else {
        await moveTaskToColumn({
          taskId: activeTask._id,
          columnId: destColumnId,
          order,
        });
        if (destColumn?.isDoneColumn) toast.success("Tarefa concluída!");
      }
    } catch {
      toast.error("Falha ao mover tarefa");
    }
  };

  const activeTask = activeId ? taskById.get(activeId) : null;

  if (columns === undefined) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="w-[280px] shrink-0 h-48 rounded-card border border-border bg-surface-sunken animate-pulse"
          />
        ))}
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
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 md:mx-0 md:px-0 snap-x snap-mandatory md:snap-none">
        {orphans.length > 0 && (
          <section className="w-[280px] shrink-0 snap-start rounded-card border border-dashed border-border-strong bg-surface-sunken">
            <header className="flex items-center gap-2 px-3 py-3 border-b border-border">
              <AlertTriangle size={14} className="text-semantic-warning shrink-0" />
              <h3 className="text-sm font-semibold text-text-primary truncate">
                Sem coluna
              </h3>
              <span className="ml-auto text-xs text-text-muted tabular-nums">
                {orphans.length}
              </span>
            </header>
            <SortableContext
              items={orphans.map((t) => t._id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="p-2 space-y-2">
                {orphans.map((task) => (
                  <SortableTaskCard
                    key={task._id}
                    task={task}
                    onOpenDetail={onOpenDetail}
                    now={now}
                    disabled={!canEdit}
                  />
                ))}
              </div>
            </SortableContext>
          </section>
        )}

        {sortedColumns.map((column) => (
          <KanbanColumn
            key={column._id}
            column={column}
            tasks={byColumn.get(column._id) ?? []}
            onOpenDetail={onOpenDetail}
            now={now}
            canEdit={canEdit}
          />
        ))}
      </div>

      <DragOverlay>
        {activeTask && (
          <TaskCard task={activeTask} onOpenDetail={() => {}} now={now} isDragging />
        )}
      </DragOverlay>
    </DndContext>
  );
}

// ============================================================================
// KanbanColumn
// ============================================================================

function KanbanColumn({
  column,
  tasks,
  onOpenDetail,
  now,
  canEdit,
}: {
  column: TaskColumnDoc;
  tasks: TaskListItem[];
  onOpenDetail: (id: Id<"tasks">) => void;
  now: number;
  canEdit: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${column._id}` });
  const hasWipLimit = typeof column.wipLimit === "number" && column.wipLimit > 0;
  const overLimit = hasWipLimit && tasks.length > column.wipLimit!;

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "w-[280px] shrink-0 snap-start rounded-card border bg-surface-sunken transition-colors",
        isOver ? "border-brand-500 bg-brand-500/5" : "border-border"
      )}
    >
      <header className="flex items-center gap-2 px-3 py-3 border-b border-border">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: column.color || "#71717A" }}
          aria-hidden="true"
        />
        <h3 className="text-sm font-semibold text-text-primary truncate">
          {column.name}
        </h3>
        {column.isDoneColumn && (
          <Check
            size={14}
            className="text-semantic-success shrink-0"
            aria-label="Coluna de conclusão"
          />
        )}
        <span
          className={cn(
            "ml-auto text-xs tabular-nums shrink-0",
            overLimit ? "text-semantic-error font-semibold" : "text-text-muted"
          )}
          title={
            hasWipLimit
              ? `Limite de trabalho em progresso: ${column.wipLimit}`
              : undefined
          }
        >
          {hasWipLimit ? `${tasks.length}/${column.wipLimit}` : tasks.length}
        </span>
        {overLimit && (
          <AlertTriangle
            size={14}
            className="text-semantic-error shrink-0"
            aria-label="Limite de trabalho em progresso excedido"
          />
        )}
      </header>

      <SortableContext
        items={tasks.map((t) => t._id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="p-2 space-y-2 min-h-[120px]">
          {tasks.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-text-muted">
              Arraste tarefas para cá
            </p>
          ) : (
            tasks.map((task) => (
              <SortableTaskCard
                key={task._id}
                task={task}
                onOpenDetail={onOpenDetail}
                now={now}
                disabled={!canEdit}
              />
            ))
          )}
        </div>
      </SortableContext>
    </section>
  );
}

// ============================================================================
// SortableTaskCard
// ============================================================================

function SortableTaskCard({
  task,
  onOpenDetail,
  now,
  disabled,
}: {
  task: TaskListItem;
  onOpenDetail: (id: Id<"tasks">) => void;
  now: number;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task._id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      {...attributes}
      {...listeners}
      tabIndex={-1}
    >
      <TaskCard task={task} onOpenDetail={onOpenDetail} now={now} />
    </div>
  );
}

// ============================================================================
// TaskCard
// ============================================================================

export function TaskCard({
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
  const isClosed = task.status === "completed" || task.status === "cancelled";

  return (
    <button
      type="button"
      onClick={() => onOpenDetail(task._id)}
      className={cn(
        "w-full text-left p-3 rounded-lg bg-surface-raised border border-border transition-colors",
        "hover:border-brand-500/50 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-sunken",
        isDragging && "shadow-elevated border-brand-500/50"
      )}
    >
      <div className="flex items-start gap-2 mb-2">
        <ActivityIcon
          size={14}
          className="text-text-muted mt-0.5 shrink-0"
          aria-label={
            task.activityType ? ACTIVITY_LABELS[task.activityType] : "Tarefa"
          }
        />
        <span
          className={cn(
            "text-sm font-medium line-clamp-2",
            isClosed ? "text-text-muted line-through" : "text-text-primary"
          )}
        >
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
              task.dueDate < now && !isClosed
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
  );
}
