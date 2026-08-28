import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { SlideOver } from "../ui/SlideOver";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Avatar } from "../ui/Avatar";
import { Spinner } from "../ui/Spinner";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useState } from "react";
import {
  Calendar,
  CheckCircle2,
  XCircle,
  Trash2,
  User,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";

interface TaskDetailSlideOverProps {
  open: boolean;
  onClose: () => void;
  taskId: string | null;
}

const PRIORITY_LABELS: Record<string, string> = {
  low: "Baixa",
  medium: "Média",
  high: "Alta",
  urgent: "Urgente",
};

const PRIORITY_VARIANTS: Record<string, "default" | "warning" | "error"> = {
  low: "default",
  medium: "warning",
  high: "error",
  urgent: "error",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  in_progress: "Em Andamento",
  completed: "Concluída",
  cancelled: "Cancelada",
};

const STATUS_VARIANTS: Record<string, "default" | "brand" | "success" | "error"> = {
  pending: "default",
  in_progress: "brand",
  completed: "success",
  cancelled: "error",
};

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  call: "Ligação",
  email: "Email",
  meeting: "Reunião",
  follow_up: "Acompanhamento",
  demo: "Demonstração",
  proposal: "Proposta",
  negotiation: "Negociação",
  other: "Outro",
};

export function TaskDetailSlideOver({ open, onClose, taskId }: TaskDetailSlideOverProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const task = useQuery(
    api.tasks.getTask,
    taskId ? { taskId: taskId as Id<"tasks"> } : "skip"
  );

  const updateTask = useMutation(api.tasks.updateTask);
  const deleteTask = useMutation(api.tasks.deleteTask);

  const handleComplete = async () => {
    if (!taskId) return;
    try {
      await updateTask({
        taskId: taskId as Id<"tasks">,
        status: "completed",
      });
      toast.success("Tarefa concluída!");
      onClose();
    } catch (error) {
      toast.error("Erro ao concluir tarefa");
      console.error(error);
    }
  };

  const handleCancel = async () => {
    if (!taskId) return;
    try {
      await updateTask({
        taskId: taskId as Id<"tasks">,
        status: "cancelled",
      });
      toast.success("Tarefa cancelada!");
      onClose();
    } catch (error) {
      toast.error("Erro ao cancelar tarefa");
      console.error(error);
    }
  };

  const handleDelete = async () => {
    if (!taskId) return;
    try {
      await deleteTask({ taskId: taskId as Id<"tasks"> });
      toast.success("Tarefa excluída!");
      setShowDeleteConfirm(false);
      onClose();
    } catch (error) {
      toast.error("Erro ao excluir tarefa");
      console.error(error);
    }
  };

  if (!task) {
    return (
      <SlideOver open={open} onClose={onClose} title="Tarefa">
        <div className="flex justify-center py-8">
          <Spinner size="lg" />
        </div>
      </SlideOver>
    );
  }

  const dueDate = task.dueDate ? new Date(task.dueDate) : null;

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("pt-BR", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  };

  const formatTime = (date: Date) => {
    return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
  };

  return (
    <>
      <SlideOver open={open} onClose={onClose} title="Detalhes da Tarefa">
        <div className="p-4 md:p-6 space-y-6">
          {/* Header */}
          <div>
            <div className="flex items-start gap-3 mb-2 flex-wrap">
              <Badge variant={STATUS_VARIANTS[task.status] || "default"}>
                {STATUS_LABELS[task.status]}
              </Badge>
              <Badge variant={PRIORITY_VARIANTS[task.priority] || "default"}>
                Prioridade: {PRIORITY_LABELS[task.priority]}
              </Badge>
              {task.activityType && (
                <Badge variant="brand">
                  {ACTIVITY_TYPE_LABELS[task.activityType] || task.activityType}
                </Badge>
              )}
            </div>
            <h2 className="text-xl font-semibold text-text-primary">{task.title}</h2>
          </div>

          {/* Due Date */}
          {dueDate && (
            <div className="flex items-start gap-3">
              <Calendar size={20} className="text-text-muted shrink-0 mt-0.5" />
              <div>
                <div className="text-sm text-text-primary font-medium">
                  {formatDate(dueDate)}
                </div>
                <div className="text-xs text-text-muted">
                  {formatTime(dueDate)}
                </div>
              </div>
            </div>
          )}

          {/* Description */}
          {task.description && (
            <div>
              <h3 className="text-sm font-medium text-text-secondary mb-2">Descrição</h3>
              <p className="text-sm text-text-primary whitespace-pre-wrap">{task.description}</p>
            </div>
          )}

          {/* Linked Records */}
          {(task.lead || task.contact) && (
            <div>
              <h3 className="text-sm font-medium text-text-secondary mb-2">Vinculado a</h3>
              <div className="space-y-2">
                {task.lead && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-surface-raised rounded-lg border border-border">
                    <User size={16} className="text-text-muted" />
                    <div>
                      <div className="text-xs text-text-muted">Lead</div>
                      <div className="text-sm font-medium text-text-primary">{task.lead.title}</div>
                    </div>
                  </div>
                )}
                {task.contact && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-surface-raised rounded-lg border border-border">
                    <User size={16} className="text-text-muted" />
                    <div>
                      <div className="text-xs text-text-muted">Contato</div>
                      <div className="text-sm font-medium text-text-primary">
                        {task.contact.firstName} {task.contact.lastName}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Assignee */}
          {task.assignee && (
            <div>
              <h3 className="text-sm font-medium text-text-secondary mb-2">Responsável</h3>
              <div className="flex items-center gap-2">
                <Avatar name={task.assignee.name} type={task.assignee.type} size="sm" />
                <span className="text-sm text-text-primary">{task.assignee.name}</span>
              </div>
            </div>
          )}

          {/* Info: Tasks are edited on Tasks page */}
          <div className="p-3 bg-brand-500/10 border border-brand-500/20 rounded-lg">
            <div className="flex items-start gap-2">
              <AlertCircle size={16} className="text-brand-500 shrink-0 mt-0.5" />
              <p className="text-xs text-text-secondary">
                Para editar esta tarefa, acesse a página de Tarefas
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-2 pt-4 border-t border-border">
            {task.status !== "completed" && task.status !== "cancelled" && (
              <>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={handleComplete}
                >
                  <CheckCircle2 size={16} />
                  Concluir
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={handleCancel}
                >
                  <XCircle size={16} />
                  Cancelar
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              className="w-full justify-start text-semantic-error hover:text-semantic-error hover:bg-semantic-error/10"
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 size={16} />
              Excluir
            </Button>
          </div>
        </div>
      </SlideOver>

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Excluir Tarefa"
        description="Tem certeza que deseja excluir esta tarefa? Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        variant="danger"
      />
    </>
  );
}
