import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { AlarmClock, ArrowLeft, Bot, ClipboardList, CornerUpLeft, Link2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { SlideOver } from "@/components/ui/SlideOver";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LabelPicker } from "@/components/tasks/LabelPicker";
import { AssigneesPicker } from "@/components/tasks/AssigneesPicker";
import { ReminderSelect } from "@/components/tasks/ReminderSelect";
import { SubtasksSection } from "@/components/tasks/SubtasksSection";
import { DependenciesSection } from "@/components/tasks/DependenciesSection";
import { ACTIVITY_ICONS, ACTIVITY_LABELS, PRIORITY_BADGE, STATUS_LABELS } from "@/components/tasks/TaskKanbanBoard";
import { cn } from "@/lib/utils";
import { memberLabel } from "@/lib/teamMembers";
import { formatDate, formatDateTime } from "@/lib/format";
import { FOLLOW_UP_STATUS_LABELS, followUpBadgeTone, type FollowUpStatus } from "@/lib/followUp";
import { TaskActionsBar, type TaskPriority } from "./TaskActionsBar";
import { TaskFields } from "./TaskFields";
import { TaskAiFollowUp } from "./TaskAiFollowUp";
import { TaskChecklist } from "./TaskChecklist";
import { TaskComments } from "./TaskComments";

const STATUS_BADGE_VARIANT: Record<string, "default" | "info" | "success" | "error"> = {
  pending: "default",
  in_progress: "info",
  completed: "success",
  cancelled: "error",
};

interface TaskDetailSlideOverProps {
  taskId: Id<"tasks">;
  organizationId: Id<"organizations">;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Detalhe da tarefa (casca): consulta a tarefa e cuida da navegação em pilha
 * (abrir subtarefa, voltar). Cada bloco (ações, campos, follow-up da IA,
 * checklist, comentários) vive em seu arquivo e escreve direto no Convex.
 */
export function TaskDetailSlideOver({ taskId, organizationId, isOpen, onClose }: TaskDetailSlideOverProps) {
  // `activeTaskId` é a tarefa exibida agora; `navStack` guarda o histórico do "voltar".
  const [activeTaskId, setActiveTaskId] = useState<Id<"tasks">>(taskId);
  const [navStack, setNavStack] = useState<Id<"tasks">[]>([]);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionValue, setDescriptionValue] = useState("");

  // Reinicia a navegação sempre que o painel é (re)aberto ou o chamador pede outra tarefa raiz.
  useEffect(() => {
    if (isOpen) {
      setActiveTaskId(taskId);
      setNavStack([]);
    }
  }, [isOpen, taskId]);

  const task = useQuery(api.tasks.getTask, { taskId: activeTaskId });
  // Follow-up que o próprio Atendente IA executa: null enquanto a tarefa não tem um.
  const followUp = useQuery(api.attendantFollowUp.getForTask, { taskId: activeTaskId });
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  const parentTask = useQuery(api.tasks.getTask, task?.parentTaskId ? { taskId: task.parentTaskId } : "skip");

  const updateTask = useMutation(api.tasks.updateTask);
  const completeTask = useMutation(api.tasks.completeTask);
  const cancelTask = useMutation(api.tasks.cancelTask);
  const deleteTask = useMutation(api.tasks.deleteTask);
  const snoozeTask = useMutation(api.tasks.snoozeTask);
  const setAssignees = useMutation(api.tasks.setAssignees);

  const memberNames = useMemo(() => {
    const map = new Map<string, string>();
    teamMembers?.forEach((m) => map.set(m._id, memberLabel(m)));
    return map;
  }, [teamMembers]);

  const handleNavigateTo = (targetTaskId: Id<"tasks">) => {
    setNavStack((prev) => [...prev, activeTaskId]);
    setActiveTaskId(targetTaskId);
  };

  const handleBack = () => {
    setNavStack((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      setActiveTaskId(next.pop()!);
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
  const ActivityIcon = task.activityType ? ACTIVITY_ICONS[task.activityType] || ClipboardList : ClipboardList;
  const priorityBadge = PRIORITY_BADGE[task.priority];
  const creatorName = memberNames.get(task.createdBy);
  const now = Date.now();
  // `assignees` pode trazer nulos (membro removido): só os que existem aparecem.
  const assignees = (task.assignees ?? []).filter((a): a is NonNullable<typeof a> => a != null);
  const isBlocked = (task.blockers ?? []).some(
    (b: { status: string }) => b.status !== "completed" && b.status !== "cancelled"
  );

  // Escritas simples: o erro vira toast e a tela segue o que o servidor devolver.
  const save = async (action: () => Promise<unknown>, errorText: string) => {
    try {
      await action();
      return true;
    } catch {
      toast.error(errorText);
      return false;
    }
  };

  const handleComplete = async () => {
    try {
      await completeTask({ taskId: activeTaskId });
      if (isBlocked) toast.warning("Tarefa concluída, mas ainda há dependências pendentes.");
      else toast.success("Tarefa concluída");
    } catch {
      toast.error("Não foi possível concluir a tarefa.");
    }
  };

  const handleCancel = async () => {
    if (await save(() => cancelTask({ taskId: activeTaskId }), "Não foi possível cancelar a tarefa.")) {
      toast.success("Tarefa cancelada");
    }
  };

  const handleDelete = async () => {
    const ok = await save(() => deleteTask({ taskId: activeTaskId }), "Não foi possível excluir a tarefa.");
    if (!ok) return;
    toast.success("Tarefa excluída");
    if (navStack.length > 0) handleBack();
    else onClose();
  };

  const handleSnooze = async (snoozedUntil: number) => {
    const ok = await save(() => snoozeTask({ taskId: activeTaskId, snoozedUntil }), "Não foi possível salvar o lembrete.");
    if (ok) toast.success("Lembrete salvo");
    return ok;
  };

  const handleSaveTitle = async () => {
    if (!titleValue.trim()) return;
    if (await save(() => updateTask({ taskId: activeTaskId, title: titleValue.trim() }), "Não foi possível atualizar o título.")) {
      setEditingTitle(false);
    }
  };

  const handleSaveDescription = async () => {
    const ok = await save(
      () => updateTask({ taskId: activeTaskId, description: descriptionValue.trim() || undefined }),
      "Não foi possível atualizar a descrição."
    );
    if (ok) setEditingDescription(false);
  };

  return (
    <SlideOver
      open={isOpen}
      onClose={onClose}
      title="Detalhes da tarefa"
      titleIcon={
        navStack.length > 0 ? (
          <button
            type="button"
            onClick={handleBack}
            className="hidden md:block p-1.5 -ml-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
            aria-label="Voltar para a tarefa anterior"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
        ) : undefined
      }
    >
      <div className="divide-y divide-border">
        <TaskActionsBar
          isCompleted={isCompleted}
          priority={task.priority as TaskPriority}
          assignees={assignees}
          onComplete={() => void handleComplete()}
          onCancel={() => void handleCancel()}
          onRequestDelete={() => setShowDeleteConfirm(true)}
          onPriorityChange={(priority) =>
            void save(() => updateTask({ taskId: activeTaskId, priority }), "Não foi possível alterar a prioridade.")
          }
          onSnooze={handleSnooze}
        />

        {task.parentTaskId && (
          <div className="px-4 pt-3">
            <button
              type="button"
              onClick={() => handleNavigateTo(task.parentTaskId as Id<"tasks">)}
              className="inline-flex min-h-11 items-center gap-1 text-xs text-brand-400 hover:text-brand-300 transition-colors"
            >
              <CornerUpLeft size={12} aria-hidden="true" />
              Subtarefa de {parentTask === undefined ? "…" : parentTask?.title ?? "tarefa removida"}
            </button>
          </div>
        )}

        {/* Título e selos */}
        <div className="px-4 py-4 space-y-3">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={() => {
                if (!isCompleted) void handleComplete();
              }}
              className={cn(
                "shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center mt-0.5 transition-colors",
                isCompleted ? "border-semantic-success bg-semantic-success" : "border-border-strong hover:border-brand-500"
              )}
              aria-label={isCompleted ? "Concluída" : "Concluir"}
            >
              {isCompleted && (
                <svg width="12" height="10" viewBox="0 0 10 8" fill="none" className="text-white" aria-hidden="true">
                  <path d="M1 4L3.5 6.5L9 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>

            {editingTitle ? (
              <div className="flex-1">
                <input
                  type="text"
                  aria-label="Título da tarefa"
                  value={titleValue}
                  onChange={(e) => setTitleValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSaveTitle();
                    if (e.key === "Escape") setEditingTitle(false);
                  }}
                  onBlur={() => void handleSaveTitle()}
                  className="w-full px-2 py-1 bg-surface-raised border border-brand-500 text-text-primary rounded-field text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-brand-500"
                  autoFocus
                />
              </div>
            ) : (
              <button
                type="button"
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

          <div className="flex flex-wrap gap-2">
            <Badge variant={STATUS_BADGE_VARIANT[task.status]}>{STATUS_LABELS[task.status]}</Badge>
            <Badge variant={priorityBadge.variant}>{priorityBadge.label}</Badge>
            {task.activityType && (
              <Badge variant="brand">
                <ActivityIcon size={12} className="mr-1" aria-hidden="true" />
                {ACTIVITY_LABELS[task.activityType] || task.activityType}
              </Badge>
            )}
            {task.type === "reminder" && <Badge variant="warning">Lembrete</Badge>}
            {isBlocked && (
              <Badge variant="warning">
                <Link2 size={12} className="mr-1" aria-hidden="true" />
                Bloqueada
              </Badge>
            )}
            {task.snoozedUntil && task.snoozedUntil > now && (
              <Badge variant="info">
                <AlarmClock size={12} className="mr-1" aria-hidden="true" />
                Lembrete: {formatDateTime(task.snoozedUntil)}
              </Badge>
            )}
            {followUp && (
              <Badge variant={followUpBadgeTone(followUp.status as FollowUpStatus)}>
                <Bot size={12} className="mr-1" aria-hidden="true" />
                {FOLLOW_UP_STATUS_LABELS[followUp.status as FollowUpStatus] ?? followUp.status}
              </Badge>
            )}
          </div>
        </div>

        <TaskAiFollowUp key={`followup-${activeTaskId}`} taskId={activeTaskId} followUp={followUp} task={task} />

        <TaskFields taskId={activeTaskId} organizationId={organizationId} task={task} isCompleted={isCompleted} now={now} />

        <div className="px-4 py-4">
          <h4 className="text-sm font-semibold text-text-primary mb-2">Responsáveis</h4>
          <AssigneesPicker
            organizationId={organizationId}
            selectedIds={assignees.map((a) => a._id)}
            onChange={(memberIds) =>
              void save(() => setAssignees({ taskId: activeTaskId, memberIds }), "Não foi possível atualizar os responsáveis.")
            }
          />
        </div>

        <div className="px-4 py-4">
          <h4 className="text-sm font-semibold text-text-primary mb-2">Etiquetas</h4>
          <LabelPicker
            organizationId={organizationId}
            selectedIds={(task.labels ?? []).map((l: { _id: Id<"taskLabels"> }) => l._id)}
            onChange={(labelIds) =>
              void save(() => updateTask({ taskId: activeTaskId, labelIds }), "Não foi possível atualizar as etiquetas.")
            }
          />
        </div>

        <div className="px-4 py-4">
          <h4 className="text-sm font-semibold text-text-primary mb-2">Lembrete antecipado</h4>
          <ReminderSelect
            value={task.reminderMinutesBefore || undefined}
            // `reminderMinutesBefore` não aceita `null` para limpar: 0 é o "sem lembrete"
            // (schedulePreDueReminder ignora valores <= 0).
            onChange={(minutes) =>
              void save(
                () => updateTask({ taskId: activeTaskId, reminderMinutesBefore: minutes ?? 0 }),
                "Não foi possível atualizar o lembrete."
              )
            }
            disabled={!task.dueDate}
          />
        </div>

        <div className="px-4 py-4">
          <h4 className="text-sm font-semibold text-text-primary mb-2">Descrição</h4>
          {editingDescription ? (
            <div className="space-y-2">
              <Textarea
                aria-label="Descrição da tarefa"
                value={descriptionValue}
                onChange={(e) => setDescriptionValue(e.target.value)}
                rows={3}
                autoFocus
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void handleSaveDescription()}>
                  Salvar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingDescription(false)}>
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDescriptionValue(task.description || "");
                setEditingDescription(true);
              }}
              className="w-full text-left text-sm text-text-secondary hover:text-text-primary transition-colors min-h-11"
            >
              {task.description || "Adicionar descrição…"}
            </button>
          )}
        </div>

        <TaskChecklist key={`checklist-${activeTaskId}`} taskId={activeTaskId} checklist={task.checklist} />

        <SubtasksSection
          taskId={activeTaskId}
          organizationId={organizationId}
          projectId={task.project?._id ?? null}
          onOpenSubtask={handleNavigateTo}
        />

        <DependenciesSection
          taskId={activeTaskId}
          organizationId={organizationId}
          blockers={task.blockers ?? []}
          onChange={(blockedBy) =>
            void save(() => updateTask({ taskId: activeTaskId, blockedBy }), "Não foi possível atualizar as dependências.")
          }
        />

        <TaskComments key={`comments-${activeTaskId}`} taskId={activeTaskId} organizationId={organizationId} />

        <div className="px-4 py-4 text-xs text-text-muted space-y-1">
          {creatorName && (
            <p>
              Criada por {creatorName} em {formatDate(task.createdAt)}
            </p>
          )}
          <p>Atualizada em {formatDateTime(task.updatedAt)}</p>
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => void handleDelete()}
        title="Excluir tarefa"
        description="Esta ação não pode ser desfeita. Deseja excluir esta tarefa permanentemente?"
        confirmLabel="Excluir"
        variant="danger"
      />
    </SlideOver>
  );
}
