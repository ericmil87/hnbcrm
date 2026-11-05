import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { CheckSquare, Plus, Phone, Mail, CalendarClock, Users, Microscope, ClipboardList } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { TAB_ROUTES } from "@/lib/routes";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { memberLabel } from "@/lib/teamMembers";
import { CreateTaskModal } from "@/components/CreateTaskModal";

/* ------------------------------------------------------------------ */
/*  Tasks Tab                                                          */
/* ------------------------------------------------------------------ */

const LEAD_TASK_ACTIVITY_ICONS: Record<string, React.ElementType> = {
  todo: ClipboardList,
  call: Phone,
  email: Mail,
  follow_up: CalendarClock,
  meeting: Users,
  research: Microscope,
};

const LEAD_TASK_PRIORITY_BADGE: Record<string, { variant: "default" | "info" | "warning" | "error"; label: string }> = {
  low: { variant: "default", label: "Baixa" },
  medium: { variant: "info", label: "Média" },
  high: { variant: "warning", label: "Alta" },
  urgent: { variant: "error", label: "Urgente" },
};

export function TasksTab({
  leadId,
  organizationId,
}: {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
}) {
  const navigate = useNavigate();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const leadTasks = useQuery(api.tasks.getTasksByLead, { leadId });
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  const lead = useQuery(api.leads.getLead, { leadId });
  const completeTask = useMutation(api.tasks.completeTask);

  const memberMap = new Map<string, { name: string; type: "human" | "ai" }>();
  teamMembers?.forEach((m) => memberMap.set(m._id, { name: memberLabel(m), type: m.type }));

  const now = Date.now();

  const handleComplete = async (taskId: Id<"tasks">) => {
    try {
      await completeTask({ taskId });
      toast.success("Tarefa concluída");
    } catch {
      toast.error("Não foi possível concluir a tarefa.");
    }
  };

  if (leadTasks === undefined) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">
          Tarefas ({leadTasks.length})
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowCreateModal(true)}
        >
          <Plus size={14} />
          Nova tarefa
        </Button>
      </div>

      {leadTasks.length === 0 ? (
        <div className="text-center py-8">
          <CheckSquare size={32} className="mx-auto text-text-muted mb-2" />
          <p className="text-sm text-text-muted">Nenhuma tarefa para este lead</p>
        </div>
      ) : (
        <div className="space-y-1">
          {leadTasks.map((task) => {
            const isCompleted = task.status === "completed" || task.status === "cancelled";
            const ActivityIcon = task.activityType
              ? LEAD_TASK_ACTIVITY_ICONS[task.activityType] || ClipboardList
              : ClipboardList;
            const assignee = task.assignedTo ? memberMap.get(task.assignedTo) : null;
            const pb = LEAD_TASK_PRIORITY_BADGE[task.priority] || LEAD_TASK_PRIORITY_BADGE.medium;

            return (
              <div
                key={task._id}
                className="flex items-center gap-2 px-2 rounded-lg hover:bg-surface-sunken transition-colors"
              >
                {/* Complete checkbox */}
                <button
                  onClick={() => {
                    if (!isCompleted) handleComplete(task._id);
                  }}
                  className={cn(
                    "shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors",
                    isCompleted
                      ? "border-semantic-success bg-semantic-success"
                      : "border-border-strong hover:border-brand-500"
                  )}
                  aria-label={isCompleted ? "Concluída" : "Concluir"}
                >
                  {isCompleted && (
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none" className="text-white">
                      <path d="M1 4L3.5 6.5L9 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>

                {/* A linha inteira abre o detalhe completo em Tarefas; voltar
                    no browser traz de volta para este painel (`?lead=`). */}
                <button
                  type="button"
                  onClick={() => navigate(`${TAB_ROUTES.tasks}?task=${task._id}`)}
                  aria-label={`Abrir a tarefa ${task.title}`}
                  className="flex flex-1 min-w-0 items-center gap-2 min-h-[44px] rounded-lg text-left focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <ActivityIcon size={14} className="shrink-0 text-text-muted" aria-hidden="true" />

                  <span
                    className={cn(
                      "flex-1 text-sm truncate",
                      isCompleted ? "text-text-muted line-through" : "text-text-primary"
                    )}
                  >
                    {task.title}
                  </span>

                  <Badge variant={pb.variant} className="text-[10px] shrink-0">{pb.label}</Badge>

                  {assignee && (
                    <Avatar name={assignee.name} type={assignee.type} size="sm" className="shrink-0" />
                  )}

                  {task.dueDate && (
                    <span
                      className={cn(
                        "text-xs font-medium tabular-nums shrink-0",
                        !isCompleted && task.dueDate < now ? "text-semantic-error" : "text-text-muted"
                      )}
                    >
                      {new Date(task.dueDate).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <CreateTaskModal
        organizationId={organizationId}
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        defaultLeadId={leadId}
        defaultContactId={lead?.contactId ?? undefined}
      />
    </div>
  );
}
