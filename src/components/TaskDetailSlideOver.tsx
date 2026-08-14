import { useEffect, useRef, useState, useMemo } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { SlideOver } from "@/components/ui/SlideOver";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LabelPicker } from "@/components/tasks/LabelPicker";
import { AssigneesPicker } from "@/components/tasks/AssigneesPicker";
import { ReminderSelect } from "@/components/tasks/ReminderSelect";
import { SubtasksSection } from "@/components/tasks/SubtasksSection";
import { DependenciesSection } from "@/components/tasks/DependenciesSection";
import {
  ACTIVITY_ICONS,
  ACTIVITY_LABELS,
  PRIORITY_BADGE,
  STATUS_LABELS,
} from "@/components/tasks/TaskKanbanBoard";
import { cn } from "@/lib/utils";
import { TAB_ROUTES } from "@/lib/routes";
import { toast } from "sonner";
import {
  Check,
  MoreHorizontal,
  Plus,
  X,
  Trash2,
  Ban,
  ClipboardList,
  Send,
  AlarmClock,
  ArrowLeft,
  CornerUpLeft,
  Link2,
  Target,
  MessageSquare,
  User,
} from "lucide-react";

// ============================================================================
// Constants
// ============================================================================

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
// Menções ("@") no composer de comentários
// ============================================================================

interface MentionCandidate {
  _id: Id<"teamMembers">;
  name: string;
  type: "human" | "ai";
  avatarUrl?: string | null;
}

/**
 * Detecta se o caret está no meio de uma menção "@algo" em digitação: precisa
 * haver um "@" antes do caret, precedido por início de texto ou espaço, e sem
 * espaço entre o "@" e o caret (senão a menção já foi "fechada").
 */
function detectMentionTrigger(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const upToCaret = text.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at === -1) return null;
  const prevChar = at > 0 ? upToCaret[at - 1] : " ";
  if (!/\s/.test(prevChar)) return null;
  const query = upToCaret.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

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
  const navigate = useNavigate();

  // Navegação interna: permite abrir uma subtarefa (ou subir para a task-pai)
  // sem sair do slide-over. `activeTaskId` é a task exibida agora;
  // `navStack` guarda o histórico para o botão "voltar".
  const [activeTaskId, setActiveTaskId] = useState<Id<"tasks">>(taskId);
  const [navStack, setNavStack] = useState<Id<"tasks">[]>([]);

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

  // Menção "@" no composer de comentários: dropdown de membros do time.
  const [mentionedMembers, setMentionedMembers] = useState<MentionCandidate[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStartIndex, setMentionStartIndex] = useState<number | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);

  // Reseta a navegação interna sempre que o slide-over é (re)aberto ou o
  // chamador pede outra task raiz.
  useEffect(() => {
    if (isOpen) {
      setActiveTaskId(taskId);
      setNavStack([]);
    }
  }, [isOpen, taskId]);

  // Evita que um rascunho de comentário (e menções pendentes) de uma task
  // vaze para outra ao navegar entre task/subtarefa no mesmo slide-over.
  useEffect(() => {
    setCommentText("");
    setMentionedMembers([]);
    setMentionQuery(null);
    setMentionStartIndex(null);
  }, [activeTaskId]);

  const task = useQuery(api.tasks.getTask, { taskId: activeTaskId });
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  const comments = useQuery(api.taskComments.getComments, { taskId: activeTaskId });
  const projects = useQuery(api.taskProjects.getProjects, { organizationId });
  const columns = useQuery(
    api.taskProjects.getColumns,
    task?.project ? { projectId: task.project._id } : "skip"
  );
  const parentTask = useQuery(
    api.tasks.getTask,
    task?.parentTaskId ? { taskId: task.parentTaskId } : "skip"
  );
  // Leads da org para vincular/trocar o lead da tarefa (mesmo padrão do
  // select de contato do CreateTaskModal).
  const leadOptions = useQuery(api.leads.getLeads, { organizationId, limit: 200 }) as
    | { _id: Id<"leads">; title: string }[]
    | undefined;
  // Conversa do lead: alimenta o atalho "Conversa" (abre a Caixa de Entrada
  // já na conversa certa). Só a mais recente interessa.
  const leadConversations = useQuery(
    api.conversations.getConversations,
    task?.leadId ? { organizationId, leadId: task.leadId, limit: 20 } : "skip"
  ) as { _id: Id<"conversations">; lastMessageAt?: number; updatedAt?: number }[] | undefined;
  const leadConversationId = useMemo(() => {
    if (!leadConversations || leadConversations.length === 0) return null;
    const sorted = [...leadConversations].sort(
      (a, b) => (b.lastMessageAt ?? b.updatedAt ?? 0) - (a.lastMessageAt ?? a.updatedAt ?? 0)
    );
    return sorted[0]._id;
  }, [leadConversations]);

  const updateTask = useMutation(api.tasks.updateTask);
  const completeTask = useMutation(api.tasks.completeTask);
  const cancelTask = useMutation(api.tasks.cancelTask);
  const deleteTask = useMutation(api.tasks.deleteTask);
  const snoozeTask = useMutation(api.tasks.snoozeTask);
  const setAssignees = useMutation(api.tasks.setAssignees);
  const moveTaskToColumn = useMutation(api.tasks.moveTaskToColumn);
  const toggleChecklistItem = useMutation(api.tasks.toggleChecklistItem);
  const updateChecklist = useMutation(api.tasks.updateChecklist);
  const addComment = useMutation(api.taskComments.addComment);

  const memberMap = useMemo(() => {
    const map = new Map<string, { name: string; type: "human" | "ai"; role: string }>();
    teamMembers?.forEach((m) => map.set(m._id, { name: m.name, type: m.type, role: m.role }));
    return map;
  }, [teamMembers]);

  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.trim().toLowerCase();
    return (teamMembers ?? [])
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, 6)
      .map((m) => ({ _id: m._id, name: m.name, type: m.type, avatarUrl: m.avatarUrl }));
  }, [teamMembers, mentionQuery]);

  const handleNavigateTo = (targetTaskId: Id<"tasks">) => {
    setNavStack((prev) => [...prev, activeTaskId]);
    setActiveTaskId(targetTaskId);
  };

  const handleBack = () => {
    setNavStack((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const last = next.pop()!;
      setActiveTaskId(last);
      return next;
    });
  };

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
  const linkedLead = task.lead as { _id: Id<"leads">; title: string } | null;
  const linkedContact = task.contact as
    | { firstName?: string; lastName?: string; email?: string }
    | null;
  const ActivityIcon = task.activityType ? ACTIVITY_ICONS[task.activityType] || ClipboardList : ClipboardList;
  const priorityBadge = PRIORITY_BADGE[task.priority];
  const creator = memberMap.get(task.createdBy);
  const checklistTotal = task.checklist?.length ?? 0;
  const checklistDone = task.checklist?.filter((c: { completed: boolean }) => c.completed).length ?? 0;
  const now = Date.now();
  const activeBlockers = (task.blockers ?? []).filter(
    (b: { status: string }) => b.status !== "completed" && b.status !== "cancelled"
  );
  const isBlocked = activeBlockers.length > 0;

  const handleComplete = async () => {
    try {
      await completeTask({ taskId: activeTaskId });
      if (isBlocked) {
        toast.warning("Tarefa concluída, mas ainda há dependências pendentes.");
      } else {
        toast.success("Tarefa concluída!");
      }
    } catch {
      toast.error("Falha ao concluir tarefa");
    }
  };

  const handleCancel = async () => {
    try {
      await cancelTask({ taskId: activeTaskId });
      toast.success("Tarefa cancelada");
    } catch {
      toast.error("Falha ao cancelar tarefa");
    }
  };

  const handleDelete = async () => {
    try {
      await deleteTask({ taskId: activeTaskId });
      toast.success("Tarefa excluída");
      if (navStack.length > 0) {
        handleBack();
      } else {
        onClose();
      }
    } catch {
      toast.error("Falha ao excluir tarefa");
    }
  };

  const handleSnooze = async () => {
    if (!snoozeDate) return;
    const timeStr = snoozeTime || "09:00";
    const snoozedUntil = new Date(snoozeDate + "T" + timeStr).getTime();
    try {
      await snoozeTask({ taskId: activeTaskId, snoozedUntil });
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
      await updateTask({ taskId: activeTaskId, title: titleValue.trim() });
      setEditingTitle(false);
    } catch {
      toast.error("Falha ao atualizar título");
    }
  };

  const handleSaveDescription = async () => {
    try {
      await updateTask({ taskId: activeTaskId, description: descriptionValue.trim() || undefined });
      setEditingDescription(false);
    } catch {
      toast.error("Falha ao atualizar descrição");
    }
  };

  const handleAssigneesChange = async (memberIds: Id<"teamMembers">[]) => {
    try {
      await setAssignees({ taskId: activeTaskId, memberIds });
    } catch {
      toast.error("Falha ao atualizar responsáveis");
    }
  };

  const handleLabelsChange = async (labelIds: Id<"taskLabels">[]) => {
    try {
      await updateTask({ taskId: activeTaskId, labelIds });
    } catch {
      toast.error("Falha ao atualizar etiquetas");
    }
  };

  const handleReminderChange = async (minutes: number | undefined) => {
    try {
      // reminderMinutesBefore não aceita `null` para limpar — 0 é o sentinel
      // de "sem lembrete" (schedulePreDueReminder ignora valores <= 0).
      await updateTask({ taskId: activeTaskId, reminderMinutesBefore: minutes ?? 0 });
    } catch {
      toast.error("Falha ao atualizar lembrete");
    }
  };

  const handleBlockedByChange = async (blockedBy: Id<"tasks">[]) => {
    try {
      await updateTask({ taskId: activeTaskId, blockedBy });
    } catch {
      toast.error("Falha ao atualizar dependências");
    }
  };

  const handleProjectChange = async (value: string) => {
    try {
      await updateTask({
        taskId: activeTaskId,
        projectId: value ? (value as Id<"taskProjects">) : null,
      });
    } catch {
      toast.error("Falha ao mover de projeto");
    }
  };

  // `updateTask` só aceita um id de lead (sem `null`), então o vínculo pode ser
  const handleLeadChange = async (value: string) => {
    try {
      await updateTask({
        taskId: activeTaskId,
        leadId: value ? (value as Id<"leads">) : null,
      });
      toast.success(value ? "Lead vinculado à tarefa" : "Vínculo com o lead removido");
    } catch {
      toast.error("Falha ao atualizar o vínculo com o lead");
    }
  };

  const handleColumnChange = async (columnId: string) => {
    if (!columnId) return;
    try {
      await moveTaskToColumn({ taskId: activeTaskId, columnId: columnId as Id<"taskColumns"> });
    } catch {
      toast.error("Falha ao mover de coluna");
    }
  };

  const handlePriorityChange = async (priority: string) => {
    try {
      await updateTask({
        taskId: activeTaskId,
        priority: priority as "low" | "medium" | "high" | "urgent",
      });
    } catch {
      toast.error("Falha ao alterar prioridade");
    }
  };

  const handleStatusChange = async (status: string) => {
    try {
      await updateTask({
        taskId: activeTaskId,
        status: status as "pending" | "in_progress" | "completed" | "cancelled",
      });
    } catch {
      toast.error("Falha ao alterar status");
    }
  };

  const handleToggleChecklistItem = async (itemId: string) => {
    try {
      await toggleChecklistItem({ taskId: activeTaskId, itemId });
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
      await updateChecklist({ taskId: activeTaskId, checklist: newItems });
      setNewChecklistItem("");
    } catch {
      toast.error("Falha ao adicionar item");
    }
  };

  const handleAddChecklistItemNoList = async () => {
    if (!newChecklistItem.trim()) return;
    const newItems = [{ id: crypto.randomUUID(), title: newChecklistItem.trim(), completed: false }];
    try {
      await updateChecklist({ taskId: activeTaskId, checklist: newItems });
      setNewChecklistItem("");
    } catch {
      toast.error("Falha ao adicionar item");
    }
  };

  const handleRemoveChecklistItem = async (itemId: string) => {
    if (!task.checklist) return;
    const newItems = task.checklist.filter((i: { id: string }) => i.id !== itemId);
    try {
      await updateChecklist({ taskId: activeTaskId, checklist: newItems });
    } catch {
      toast.error("Falha ao remover item");
    }
  };

  const handleAddComment = async () => {
    if (!commentText.trim() || sendingComment) return;
    setSendingComment(true);
    try {
      await addComment({
        taskId: activeTaskId,
        content: commentText.trim(),
        mentionedUserIds: mentionedMembers.length > 0 ? mentionedMembers.map((m) => m._id) : undefined,
      });
      setCommentText("");
      setMentionedMembers([]);
      setMentionQuery(null);
      setMentionStartIndex(null);
    } catch {
      toast.error("Falha ao adicionar comentário");
    } finally {
      setSendingComment(false);
    }
  };

  // Atualiza o texto do comentário e detecta se o caret está numa menção
  // "@algo" em digitação, para abrir/atualizar o dropdown.
  const handleCommentTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setCommentText(value);
    const caret = e.target.selectionStart ?? value.length;
    const trigger = detectMentionTrigger(value, caret);
    if (trigger) {
      setMentionStartIndex(trigger.start);
      setMentionQuery(trigger.query);
      setMentionActiveIndex(0);
    } else {
      setMentionStartIndex(null);
      setMentionQuery(null);
    }
  };

  // Insere "@Nome " no lugar da menção em digitação e registra o membro para
  // enviar em `mentionedUserIds`.
  const selectMention = (member: MentionCandidate) => {
    if (mentionStartIndex === null) return;
    const textarea = commentInputRef.current;
    const caret = textarea?.selectionStart ?? commentText.length;
    const before = commentText.slice(0, mentionStartIndex);
    const after = commentText.slice(caret);
    const insertion = `@${member.name} `;
    const newText = before + insertion + after;

    setCommentText(newText);
    setMentionedMembers((prev) => (prev.some((m) => m._id === member._id) ? prev : [...prev, member]));
    setMentionQuery(null);
    setMentionStartIndex(null);

    requestAnimationFrame(() => {
      const pos = before.length + insertion.length;
      textarea?.focus();
      textarea?.setSelectionRange(pos, pos);
    });
  };

  const handleCommentKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionActiveIndex((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionActiveIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectMention(mentionCandidates[mentionActiveIndex]);
        return;
      }
      if (e.key === "Escape") {
        // Fecha só o dropdown de menção — não deve fechar o slide-over.
        e.preventDefault();
        e.stopPropagation();
        setMentionQuery(null);
        setMentionStartIndex(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAddComment();
    }
  };

  const removeMention = (memberId: Id<"teamMembers">) => {
    setMentionedMembers((prev) => prev.filter((m) => m._id !== memberId));
  };

  return (
    <SlideOver
      open={isOpen}
      onClose={onClose}
      title="Detalhes da Tarefa"
      titleIcon={
        navStack.length > 0 ? (
          <button
            type="button"
            onClick={handleBack}
            className="hidden md:block p-1.5 -ml-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
            aria-label="Voltar para a tarefa anterior"
          >
            <ArrowLeft size={18} />
          </button>
        ) : undefined
      }
    >
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

          {task.assignees && task.assignees.length > 0 && (
            <div className="flex items-center -space-x-2">
              {task.assignees.slice(0, 4).map((a: any) => (
                <Avatar
                  key={a._id}
                  name={a.name}
                  type={a.type}
                  size="sm"
                  imageUrl={a.avatarUrl ?? null}
                  className="ring-2 ring-surface-raised"
                />
              ))}
            </div>
          )}

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

        {/* Reminder date/time picker (snooze) */}
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

        {/* Subtarefa de ... */}
        {task.parentTaskId && (
          <div className="px-4 pt-3">
            <button
              type="button"
              onClick={() => handleNavigateTo(task.parentTaskId as Id<"tasks">)}
              className="inline-flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 transition-colors"
            >
              <CornerUpLeft size={12} />
              Subtarefa de {parentTask === undefined ? "..." : parentTask?.title ?? "tarefa removida"}
            </button>
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
            {isBlocked && (
              <Badge variant="warning">
                <Link2 size={12} className="mr-1" />
                Bloqueada
              </Badge>
            )}
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

          {/* Project */}
          <FieldRow label="Projeto">
            <select
              value={task.project?._id ?? ""}
              onChange={(e) => handleProjectChange(e.target.value)}
              className="px-2 py-1 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              style={{ fontSize: "16px" }}
            >
              <option value="">Sem projeto</option>
              {projects?.map((p: any) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </select>
          </FieldRow>

          {/* Column (only with project) */}
          {task.project && (
            <FieldRow label="Coluna">
              <select
                value={task.column?._id ?? ""}
                onChange={(e) => handleColumnChange(e.target.value)}
                className="px-2 py-1 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                style={{ fontSize: "16px" }}
              >
                {columns?.map((c: any) => (
                  <option key={c._id} value={c._id}>
                    {c.name}
                    {c.isDoneColumn ? " · Concluído" : ""}
                  </option>
                ))}
              </select>
            </FieldRow>
          )}

          {/* Lead vinculado + atalhos para o funil e a conversa */}
          <div className="space-y-2">
            <FieldRow label="Lead">
              <select
                value={task.leadId ?? ""}
                onChange={(e) => handleLeadChange(e.target.value)}
                aria-label="Lead vinculado à tarefa"
                className="max-w-[14rem] px-2 py-1 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                style={{ fontSize: "16px" }}
              >
                <option value="">Sem lead</option>
                {linkedLead && !leadOptions?.some((l) => l._id === linkedLead._id) && (
                  <option value={linkedLead._id}>{linkedLead.title}</option>
                )}
                {leadOptions?.map((l) => (
                  <option key={l._id} value={l._id}>
                    {l.title}
                  </option>
                ))}
              </select>
            </FieldRow>

            {task.leadId && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-11 max-w-full"
                  onClick={() => navigate(`${TAB_ROUTES.board}?lead=${task.leadId}`)}
                  aria-label={`Abrir o lead ${linkedLead?.title ?? ""} no funil`}
                  title={linkedLead?.title}
                >
                  <Target size={14} className="shrink-0" aria-hidden="true" />
                  <span className="truncate">{linkedLead?.title ?? "Ver no funil"}</span>
                </Button>
                {leadConversationId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-11"
                    onClick={() =>
                      navigate(`${TAB_ROUTES.inbox}?conversation=${leadConversationId}`)
                    }
                    aria-label="Abrir a conversa deste lead"
                  >
                    <MessageSquare size={14} aria-hidden="true" />
                    Conversa
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Contato (sem rota própria por URL — só exibe o nome) */}
          {linkedContact && (
            <FieldRow label="Contato">
              <span className="flex items-center gap-1.5 text-sm text-text-primary truncate">
                <User size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
                {[linkedContact.firstName, linkedContact.lastName].filter(Boolean).join(" ") ||
                  linkedContact.email ||
                  "Sem nome"}
              </span>
            </FieldRow>
          )}

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

        {/* Assignees */}
        <div className="px-4 py-4">
          <h4 className="text-sm font-semibold text-text-primary mb-2">Responsáveis</h4>
          <AssigneesPicker
            organizationId={organizationId}
            selectedIds={(task.assignees ?? []).map((a: any) => a._id)}
            onChange={handleAssigneesChange}
          />
        </div>

        {/* Labels */}
        <div className="px-4 py-4">
          <h4 className="text-sm font-semibold text-text-primary mb-2">Etiquetas</h4>
          <LabelPicker
            organizationId={organizationId}
            selectedIds={(task.labels ?? []).map((l: any) => l._id)}
            onChange={handleLabelsChange}
          />
        </div>

        {/* Reminder */}
        <div className="px-4 py-4">
          <h4 className="text-sm font-semibold text-text-primary mb-2">Lembrete antecipado</h4>
          <ReminderSelect
            value={task.reminderMinutesBefore || undefined}
            onChange={handleReminderChange}
            disabled={!task.dueDate}
          />
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
                  <Checkbox
                    checked={item.completed}
                    onChange={() => handleToggleChecklistItem(item.id)}
                    containerClassName="shrink-0"
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

        {/* Subtasks */}
        <SubtasksSection
          taskId={activeTaskId}
          organizationId={organizationId}
          projectId={task.project?._id ?? null}
          onOpenSubtask={handleNavigateTo}
        />

        {/* Dependencies */}
        <DependenciesSection
          taskId={activeTaskId}
          organizationId={organizationId}
          blockers={task.blockers ?? []}
          onChange={handleBlockedByChange}
        />

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
          {mentionedMembers.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {mentionedMembers.map((m) => (
                <span
                  key={m._id}
                  className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium bg-brand-500/10 text-brand-400"
                >
                  @{m.name}
                  <button
                    type="button"
                    onClick={() => removeMention(m._id)}
                    aria-label={`Remover menção a ${m.name}`}
                    className="p-0.5 rounded-full hover:bg-black/10 transition-colors"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <textarea
                ref={commentInputRef}
                value={commentText}
                onChange={handleCommentTextChange}
                placeholder="Adicionar comentário... (use @ para mencionar)"
                rows={2}
                className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none placeholder:text-text-muted"
                style={{ fontSize: "16px" }}
                onKeyDown={handleCommentKeyDown}
              />

              {mentionQuery !== null && (
                <div className="absolute left-0 right-0 bottom-full z-20 mb-1 bg-surface-overlay border border-border rounded-xl shadow-elevated p-1 max-h-48 overflow-y-auto">
                  {mentionCandidates.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-text-muted">Nenhum membro encontrado.</p>
                  ) : (
                    mentionCandidates.map((m, i) => (
                      <button
                        key={m._id}
                        type="button"
                        onMouseDown={(e) => {
                          // preventDefault evita que o textarea perca foco antes do clique.
                          e.preventDefault();
                          selectMention(m);
                        }}
                        className={cn(
                          "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors",
                          i === mentionActiveIndex ? "bg-surface-raised" : "hover:bg-surface-raised"
                        )}
                      >
                        <Avatar name={m.name} type={m.type} size="sm" imageUrl={m.avatarUrl ?? null} />
                        <span className="text-sm text-text-primary truncate">{m.name}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
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
