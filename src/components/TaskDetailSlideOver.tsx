import { useState, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Check,
  Clock,
  MoreHorizontal,
  Plus,
  X,
  Trash2,
  UserPlus,
  Flag,
  Ban,
  CalendarClock,
  Phone,
  Mail,
  Users,
  Microscope,
  ClipboardList,
  Send,
  ExternalLink,
  AlarmClock,
} from "lucide-react";

// ============================================================================
// Constants
// ============================================================================

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

const STATUS_BADGE_VARIANT: Record<string, "default" | "info" | "success" | "error"> = {
  pending: "default",
  in_progress: "info",
  completed: "success",
  cancelled: "error",
};

const RECURRENCE_LABELS: Record<string, string> = {
  daily: "Diária",
  weekly: "Semanal",
  biweekly: "Quinzenal",
  monthly: "Mensal",
};

// ============================================================================
// Props
// ============================================================================

interface TaskDetailSlideOverProps {
  taskId: Id<"tasks">;
  organizationId: Id<"organizations">;
  isOpen: boolean;
  onClose: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function TaskDetailSlideOver({
  taskId,
  organizationId,
  isOpen,
  onClose,
}: TaskDetailSlideOverProps) {
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionValue, setDescriptionValue] = useState("");
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [commentText, setCommentText] = useState("");
  const [sendingComment, setSendingComment] = useState(false);
  const [showSnoozeDate, setShowSnoozeDate] = useState(false);
  const [snoozeDate, setSnoozeDate] = useState("");
  const [snoozeTime, setSnoozeTime] = useState("");

  const task = useQuery(api.tasks.getTask, { taskId });
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  const comments = useQuery(api.taskComments.getComments, { taskId });

  const updateTask = useMutation(api.tasks.updateTask);
  const completeTask = useMutation(api.tasks.completeTask);
  const cancelTask = useMutation(api.tasks.cancelTask);
  const deleteTask = useMutation(api.tasks.deleteTask);
  const snoozeTask = useMutation(api.tasks.snoozeTask);
  const assignTask = useMutation(api.tasks.assignTask);
  const toggleChecklistItem = useMutation(api.tasks.toggleChecklistItem);
  const updateChecklist = useMutation(api.tasks.updateChecklist);
  const addComment = useMutation(api.taskComments.addComment);

  const memberMap = useMemo(() => {
    const map = new Map<string, { name: string; type: "human" | "ai"; role: string }>();
    teamMembers?.forEach((m) => map.set(m._id, { name: m.name, type: m.type, role: m.role }));
    return map;
  }, [teamMembers]);

  if (!isOpen) return null;

  if (task === undefined) {
    return (
      <SlideOver open={isOpen} onClose={onClose} title="Tarefa">
        <div className="flex justify-center items-center h-48">
          <Spinner size="lg" />
        </div>
      </SlideOver>
    );
  }

  if (task === null) {
    return (
      <SlideOver open={isOpen} onClose={onClose} title="Tarefa">
        <div className="p-6 text-center text-text-muted">Tarefa não encontrada.</div>
      </SlideOver>
    );
  }

  const isCompleted = task.status === "completed" || task.status === "cancelled";
  const ActivityIcon = task.activityType ? ACTIVITY_ICONS[task.activityType] || ClipboardList : ClipboardList;
  const priorityBadge = PRIORITY_BADGE[task.priority];
  const assignee = task.assignedTo ? memberMap.get(task.assignedTo) : null;
  const creator = memberMap.get(task.createdBy);
  const checklistTotal = task.checklist?.length ?? 0;
  const checklistDone = task.checklist?.filter((c: { completed: boolean }) => c.completed).length ?? 0;
  const now = Date.now();

  const handleComplete = async () => {
    try {
      await completeTask({ taskId });
      toast.success("Tarefa concluída!");
    } catch {
      toast.error("Falha ao concluir tarefa");
    }
  };

  const handleCancel = async () => {
    try {
      await cancelTask({ taskId });
      toast.success("Tarefa cancelada");
    } catch {
      toast.error("Falha ao cancelar tarefa");
    }
  };

  const handleDelete = async () => {
    try {
      await deleteTask({ taskId });
      toast.success("Tarefa excluída");
      onClose();
    } catch {
      toast.error("Falha ao excluir tarefa");
    }
  };

  const handleSnooze = async () => {
    if (!snoozeDate) return;
    const timeStr = snoozeTime || "09:00";
    const snoozedUntil = new Date(snoozeDate + "T" + timeStr).getTime();
    try {
      await snoozeTask({ taskId, snoozedUntil });
      toast.success("Lembrete salvo");
      setShowSnoozeDate(false);
      setSnoozeDate("");
      setSnoozeTime("");
    } catch {
      toast.error("Falha ao salvar lembrete");
    }
  };

  const handleSaveTitle = async () => {
    if (!titleValue.trim()) return;
    try {
      await updateTask({ taskId, title: titleValue.trim() });
      setEditingTitle(false);
    } catch {
      toast.error("Falha ao atualizar título");
    }
  };

  const handleSaveDescription = async () => {
    try {
      await updateTask({ taskId, description: descriptionValue.trim() || undefined });
      setEditingDescription(false);
    } catch {
      toast.error("Falha ao atualizar descrição");
    }
  };

  const handleAssigneeChange = async (memberId: string) => {
    try {
      await assignTask({
        taskId,
        assignedTo: memberId ? (memberId as Id<"teamMembers">) : undefined,
      });
    } catch {
      toast.error("Falha ao atribuir");
    }
  };

  const handlePriorityChange = async (priority: string) => {
    try {
      await updateTask({
        taskId,
        priority: priority as "low" | "medium" | "high" | "urgent",
      });
    } catch {
      toast.error("Falha ao alterar prioridade");
    }
  };

  const handleStatusChange = async (status: string) => {
    try {
      await updateTask({
        taskId,
        status: status as "pending" | "in_progress" | "completed" | "cancelled",
      });
    } catch {
      toast.error("Falha ao alterar status");
    }
  };

  const handleToggleChecklistItem = async (itemId: string) => {
    try {
      await toggleChecklistItem({ taskId, itemId });
    } catch {
      toast.error("Falha ao atualizar item");
    }
  };

  const handleAddChecklistItem = async () => {
    if (!newChecklistItem.trim() || !task.checklist) return;
    const newItems = [
      ...task.checklist,
      { id: crypto.randomUUID(), title: newChecklistItem.trim(), completed: false },
    ];
    try {
      await updateChecklist({ taskId, checklist: newItems });
      setNewChecklistItem("");
    } catch {
      toast.error("Falha ao adicionar item");
    }
  };

  const handleAddChecklistItemNoList = async () => {
    if (!newChecklistItem.trim()) return;
    const newItems = [{ id: crypto.randomUUID(), title: newChecklistItem.trim(), completed: false }];
    try {
      await updateChecklist({ taskId, checklist: newItems });
      setNewChecklistItem("");
    } catch {
      toast.error("Falha ao adicionar item");
    }
  };

  const handleRemoveChecklistItem = async (itemId: string) => {
    if (!task.checklist) return;
    const newItems = task.checklist.filter((i: { id: string }) => i.id !== itemId);
    try {
      await updateChecklist({ taskId, checklist: newItems });
    } catch {
      toast.error("Falha ao remover item");
    }
  };

  const handleAddComment = async () => {
    if (!commentText.trim() || sendingComment) return;
    setSendingComment(true);
    try {
      await addComment({ taskId, content: commentText.trim() });
      setCommentText("");
    } catch {
      toast.error("Falha ao adicionar comentário");
    } finally {
      setSendingComment(false);
    }
  };

  return (
    <SlideOver open={isOpen} onClose={onClose} title="Detalhes da Tarefa">
      <div className="divide-y divide-border">
        {/* Action bar */}
        <div className="flex items-center gap-2 px-4 py-3 bg-surface-raised">
          {!isCompleted && (
            <Button variant="primary" size="sm" onClick={handleComplete}>
              <Check size={14} />
              Concluir
            </Button>
          )}

          {!isCompleted && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowSnoozeDate(!showSnoozeDate)}
            >
              <AlarmClock size={14} />
              Lembrete
            </Button>
          )}

          <div className="flex-1" />

          {/* Actions menu */}
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowActionsMenu(!showActionsMenu)}
              aria-label="Mais ações"
            >
              <MoreHorizontal size={16} />
            </Button>

            {showActionsMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowActionsMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 bg-surface-overlay border border-border rounded-xl shadow-elevated p-1 min-w-[180px]">
                  <select
                    value={task.assignedTo || ""}
                    onChange={(e) => {
                      handleAssigneeChange(e.target.value);
                      setShowActionsMenu(false);
                    }}
                    className="w-full px-3 py-2 bg-transparent text-text-primary text-sm rounded-lg hover:bg-surface-raised cursor-pointer"
                    style={{ fontSize: "16px" }}
                  >
                    <option value="">Sem responsável</option>
                    {teamMembers?.map((m) => (
                      <option key={m._id} value={m._id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={task.priority}
                    onChange={(e) => {
                      handlePriorityChange(e.target.value);
                      setShowActionsMenu(false);
                    }}
                    className="w-full px-3 py-2 bg-transparent text-text-primary text-sm rounded-lg hover:bg-surface-raised cursor-pointer"
                    style={{ fontSize: "16px" }}
                  >
                    <option value="low">Prioridade: Baixa</option>
                    <option value="medium">Prioridade: Média</option>
                    <option value="high">Prioridade: Alta</option>
                    <option value="urgent">Prioridade: Urgente</option>
                  </select>
                  {!isCompleted && (
                    <button
                      onClick={() => {
                        handleCancel();
                        setShowActionsMenu(false);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-semantic-warning rounded-lg hover:bg-surface-raised transition-colors"
                    >
                      <Ban size={14} />
                      Cancelar Tarefa
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setShowDeleteConfirm(true);
                      setShowActionsMenu(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-semantic-error rounded-lg hover:bg-surface-raised transition-colors"
                  >
                    <Trash2 size={14} />
                    Excluir
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Reminder date/time picker */}
        {showSnoozeDate && (
          <div className="flex items-center gap-2 px-4 py-2 bg-surface-sunken">
            <input
              type="date"
              value={snoozeDate}
              onChange={(e) => setSnoozeDate(e.target.value)}
              className="flex-1 px-3 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              style={{ fontSize: "16px" }}
            />
            <input
              type="time"
              value={snoozeTime}
              onChange={(e) => setSnoozeTime(e.target.value)}
              placeholder="09:00"
              className="w-28 px-3 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              style={{ fontSize: "16px" }}
            />
            <Button size="sm" onClick={handleSnooze} disabled={!snoozeDate}>
              Salvar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowSnoozeDate(false);
                setSnoozeDate("");
                setSnoozeTime("");
              }}
            >
              <X size={14} />
            </Button>
          </div>
        )}

        {/* Title + Badges */}
        <div className="px-4 py-4 space-y-3">
          <div className="flex items-start gap-3">
            {/* Complete checkbox */}
            <button
              onClick={() => {
                if (!isCompleted) handleComplete();
              }}
              className={cn(
                "shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center mt-0.5 transition-colors",
                isCompleted
                  ? "border-semantic-success bg-semantic-success"
                  : "border-border-strong hover:border-brand-500"
              )}
              aria-label={isCompleted ? "Concluída" : "Concluir"}
            >
              {isCompleted && (
                <svg width="12" height="10" viewBox="0 0 10 8" fill="none" className="text-white">
                  <path d="M1 4L3.5 6.5L9 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>

            {/* Title */}
            {editingTitle ? (
              <div className="flex-1">
                <input
                  type="text"
                  value={titleValue}
                  onChange={(e) => setTitleValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveTitle();
                    if (e.key === "Escape") setEditingTitle(false);
                  }}
                  onBlur={handleSaveTitle}
                  className="w-full px-2 py-1 bg-surface-raised border border-brand-500 text-text-primary rounded-field text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-brand-500"
                  style={{ fontSize: "18px" }}
                  autoFocus
                />
              </div>
            ) : (
              <button
                onClick={() => {
                  setTitleValue(task.title);
                  setEditingTitle(true);
                }}
                className={cn(
                  "flex-1 text-left text-lg font-semibold",
                  isCompleted ? "text-text-muted line-through" : "text-text-primary"
                )}
              >
                {task.title}
              </button>
            )}
          </div>

          {/* Badges row */}
          <div className="flex flex-wrap gap-2">
            <Badge variant={STATUS_BADGE_VARIANT[task.status]}>
              {STATUS_LABELS[task.status]}
            </Badge>
            <Badge variant={priorityBadge.variant}>{priorityBadge.label}</Badge>
            {task.activityType && (
              <Badge variant="brand">
                <ActivityIcon size={12} className="mr-1" />
                {ACTIVITY_LABELS[task.activityType] || task.activityType}
              </Badge>
            )}
            {task.type === "reminder" && <Badge variant="warning">Lembrete</Badge>}
            {task.snoozedUntil && task.snoozedUntil > now && (
              <Badge variant="info">
                <AlarmClock size={12} className="mr-1" />
                Lembrete: {new Date(task.snoozedUntil).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
              </Badge>
            )}
          </div>
        </div>

        {/* Fields */}
        <div className="px-4 py-4 space-y-4">
          {/* Status */}
          <FieldRow label="Status">
            <select
              value={task.status}
              onChange={(e) => handleStatusChange(e.target.value)}
              className="px-2 py-1 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              style={{ fontSize: "16px" }}
            >
              <option value="pending">Pendente</option>
              <option value="in_progress">Em Progresso</option>
              <option value="completed">Concluída</option>
              <option value="cancelled">Cancelada</option>
            </select>
          </FieldRow>

          {/* Assignee */}
          <FieldRow label="Responsável">
            <select
              value={task.assignedTo || ""}
              onChange={(e) => handleAssigneeChange(e.target.value)}
              className="px-2 py-1 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              style={{ fontSize: "16px" }}
            >
              <option value="">Sem responsável</option>
              {teamMembers?.map((m) => (
                <option key={m._id} value={m._id}>
                  {m.name}
                </option>
              ))}
            </select>
          </FieldRow>

          {/* Due date */}
          <FieldRow label="Vencimento">
            {task.dueDate ? (
              <span
                className={cn(
                  "text-sm font-medium",
                  !isCompleted && task.dueDate < now ? "text-semantic-error" : "text-text-primary"
                )}
              >
                {new Date(task.dueDate).toLocaleDateString("pt-BR", {
                  day: "2-digit",
                  month: "long",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            ) : (
              <span className="text-sm text-text-muted">Sem data</span>
            )}
          </FieldRow>

          {/* Recurrence */}
          {task.recurrence && (
            <FieldRow label="Recorrência">
              <span className="text-sm text-text-primary">
                {RECURRENCE_LABELS[task.recurrence.pattern] || task.recurrence.pattern}
              </span>
            </FieldRow>
          )}

          {/* Tags */}
          {task.tags && task.tags.length > 0 && (
            <FieldRow label="Tags">
              <div className="flex flex-wrap gap-1">
                {task.tags.map((tag: string) => (
                  <span
                    key={tag}
                    className="inline-flex items-center px-2 py-0.5 bg-brand-500/10 text-brand-400 text-xs font-medium rounded-full"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </FieldRow>
          )}
        </div>

        {/* Description */}
        <div className="px-4 py-4">
          <h4 className="text-sm font-semibold text-text-primary mb-2">Descrição</h4>
          {editingDescription ? (
            <div className="space-y-2">
              <textarea
                value={descriptionValue}
                onChange={(e) => setDescriptionValue(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 bg-surface-raised border border-brand-500 text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
                style={{ fontSize: "16px" }}
                autoFocus
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveDescription}>
                  Salvar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingDescription(false)}>
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                setDescriptionValue(task.description || "");
                setEditingDescription(true);
              }}
              className="w-full text-left text-sm text-text-secondary hover:text-text-primary transition-colors min-h-[32px]"
            >
              {task.description || "Adicionar descrição..."}
            </button>
          )}
        </div>

        {/* Checklist */}
        <div className="px-4 py-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-text-primary">Checklist</h4>
            {checklistTotal > 0 && (
              <span className="text-xs text-text-muted tabular-nums">
                {checklistDone}/{checklistTotal}
              </span>
            )}
          </div>

          {/* Progress bar */}
          {checklistTotal > 0 && (
            <div className="w-full bg-surface-sunken rounded-full h-1.5 mb-3">
              <div
                className="h-1.5 rounded-full bg-brand-500 transition-all duration-300"
                style={{ width: `${checklistTotal > 0 ? (checklistDone / checklistTotal) * 100 : 0}%` }}
              />
            </div>
          )}

          {/* Items */}
          {task.checklist && task.checklist.length > 0 && (
            <div className="space-y-1 mb-2">
              {task.checklist.map((item: { id: string; title: string; completed: boolean }) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-sunken transition-colors group"
                >
                  <input
                    type="checkbox"
                    checked={item.completed}
                    onChange={() => handleToggleChecklistItem(item.id)}
                    className="shrink-0 h-4 w-4 rounded border-border-strong text-brand-500 focus:ring-brand-500 cursor-pointer"
                  />
                  <span
                    className={cn(
                      "flex-1 text-sm",
                      item.completed ? "text-text-muted line-through" : "text-text-primary"
                    )}
                  >
                    {item.title}
                  </span>
                  <button
                    onClick={() => handleRemoveChecklistItem(item.id)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-text-muted hover:text-semantic-error transition-all"
                    aria-label="Remover item"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add item */}
          <div className="flex gap-2">
            <input
              type="text"
              value={newChecklistItem}
              onChange={(e) => setNewChecklistItem(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  task.checklist ? handleAddChecklistItem() : handleAddChecklistItemNoList();
                }
              }}
              placeholder="Adicionar item..."
              className="flex-1 px-3 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 placeholder:text-text-muted"
              style={{ fontSize: "16px" }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => (task.checklist ? handleAddChecklistItem() : handleAddChecklistItemNoList())}
              aria-label="Adicionar item ao checklist"
            >
              <Plus size={16} />
            </Button>
          </div>
        </div>

        {/* Comments */}
        <div className="px-4 py-4">
          <h4 className="text-sm font-semibold text-text-primary mb-3">Comentários</h4>

          {comments === undefined ? (
            <div className="flex justify-center py-4">
              <Spinner size="sm" />
            </div>
          ) : comments.length === 0 ? (
            <p className="text-sm text-text-muted mb-3">Nenhum comentário ainda.</p>
          ) : (
            <div className="space-y-3 mb-3">
              {comments.map((comment) => {
                const author = memberMap.get(comment.authorId);
                return (
                  <div key={comment._id} className="flex gap-2">
                    <Avatar
                      name={author?.name || "?"}
                      type={comment.authorType}
                      size="sm"
                      className="shrink-0 mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium text-text-primary">
                          {author?.name || "Desconhecido"}
                        </span>
                        <span className="text-xs text-text-muted">
                          {new Date(comment.createdAt).toLocaleDateString("pt-BR", {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <p className="text-sm text-text-secondary whitespace-pre-wrap break-words">
                        {comment.content}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Add comment */}
          <div className="flex gap-2">
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Adicionar comentário..."
              rows={2}
              className="flex-1 px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none placeholder:text-text-muted"
              style={{ fontSize: "16px" }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleAddComment();
                }
              }}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={handleAddComment}
              disabled={sendingComment || !commentText.trim()}
              className="self-end"
              aria-label="Enviar comentário"
            >
              <Send size={14} />
            </Button>
          </div>
        </div>

        {/* Metadata */}
        <div className="px-4 py-4 text-xs text-text-muted space-y-1">
          {creator && (
            <p>
              Criado por {creator.name} em{" "}
              {new Date(task.createdAt).toLocaleDateString("pt-BR", {
                day: "2-digit",
                month: "long",
                year: "numeric",
              })}
            </p>
          )}
          <p>
            Atualizado em{" "}
            {new Date(task.updatedAt).toLocaleDateString("pt-BR", {
              day: "2-digit",
              month: "long",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Excluir Tarefa"
        description="Esta ação não pode ser desfeita. Deseja excluir esta tarefa permanentemente?"
        confirmLabel="Excluir"
        variant="danger"
      />
    </SlideOver>
  );
}

// ============================================================================
// FieldRow
// ============================================================================

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-text-secondary shrink-0">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
