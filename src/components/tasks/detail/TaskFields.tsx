import { useMemo } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { MessageSquare, Target, User } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { TAB_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";

const STATUS_OPTIONS = [
  { value: "pending", label: "Pendente" },
  { value: "in_progress", label: "Em andamento" },
  { value: "completed", label: "Concluída" },
  { value: "cancelled", label: "Cancelada" },
];

const RECURRENCE_LABELS: Record<string, string> = {
  daily: "Diária",
  weekly: "Semanal",
  biweekly: "Quinzenal",
  monthly: "Mensal",
};

type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** Tarefa como vem de `getTask` (retorno solto): só lemos o que a seção usa. */
interface TaskFieldsTask {
  status: TaskStatus;
  leadId?: Id<"leads"> | null;
  lead: { _id: Id<"leads">; title: string } | null;
  contact: { firstName?: string; lastName?: string; email?: string } | null;
  project?: { _id: Id<"taskProjects"> } | null;
  column?: { _id: Id<"taskColumns"> } | null;
  dueDate?: number | null;
  recurrence?: { pattern: string } | null;
  tags?: string[];
}

interface TaskFieldsProps {
  taskId: Id<"tasks">;
  organizationId: Id<"organizations">;
  task: TaskFieldsTask;
  isCompleted: boolean;
  now: number;
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-text-secondary shrink-0">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Linha de campo com lista suspensa; a largura fica por conta do contêiner. */
function SelectRow({
  label,
  value,
  onValueChange,
  options,
  ariaLabel,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  ariaLabel?: string;
}) {
  return (
    <FieldRow label={label}>
      <div className="w-48 sm:w-56">
        <Select size="sm" aria-label={ariaLabel ?? label} value={value} onValueChange={onValueChange} options={options} />
      </div>
    </FieldRow>
  );
}

/** Campos da tarefa: status, projeto, coluna, lead, contato, vencimento, recorrência e etiquetas de texto. */
export function TaskFields({ taskId, organizationId, task, isCompleted, now }: TaskFieldsProps) {
  const navigate = useNavigate();
  const projects = useQuery(api.taskProjects.getProjects, { organizationId });
  const columns = useQuery(api.taskProjects.getColumns, task.project ? { projectId: task.project._id } : "skip");
  // Leads da org para vincular/trocar o lead da tarefa.
  const leadOptions = useQuery(api.leads.getLeads, { organizationId, limit: 200 }) as
    | { _id: Id<"leads">; title: string }[]
    | undefined;
  // Conversa do lead: alimenta o atalho "Conversa". Só a mais recente interessa.
  const leadConversations = useQuery(
    api.conversations.getConversations,
    task.leadId ? { organizationId, leadId: task.leadId, limit: 20 } : "skip"
  ) as { _id: Id<"conversations">; lastMessageAt?: number; updatedAt?: number }[] | undefined;
  const leadConversationId = useMemo(() => {
    if (!leadConversations || leadConversations.length === 0) return null;
    const sorted = [...leadConversations].sort(
      (a, b) => (b.lastMessageAt ?? b.updatedAt ?? 0) - (a.lastMessageAt ?? a.updatedAt ?? 0)
    );
    return sorted[0]._id;
  }, [leadConversations]);

  const updateTask = useMutation(api.tasks.updateTask);
  const moveTaskToColumn = useMutation(api.tasks.moveTaskToColumn);

  const run = async (action: () => Promise<unknown>, errorText: string) => {
    try {
      await action();
    } catch {
      toast.error(errorText);
    }
  };

  const linkedLead = task.lead;
  const linkedContact = task.contact;
  const contactName = linkedContact
    ? [linkedContact.firstName, linkedContact.lastName].filter(Boolean).join(" ") || linkedContact.email || "Sem nome"
    : null;

  return (
    <div className="px-4 py-4 space-y-4">
      <SelectRow
        label="Status"
        value={task.status}
        options={STATUS_OPTIONS}
        onValueChange={(status) =>
          run(() => updateTask({ taskId, status: status as TaskStatus }), "Não foi possível alterar o status.")
        }
      />

      <SelectRow
        label="Projeto"
        value={task.project?._id ?? ""}
        options={[
          { value: "", label: "Sem projeto" },
          ...(projects ?? []).map((p: { _id: string; name: string }) => ({ value: p._id, label: p.name })),
        ]}
        onValueChange={(value) =>
          run(
            () => updateTask({ taskId, projectId: value ? (value as Id<"taskProjects">) : null }),
            "Não foi possível mover de projeto."
          )
        }
      />

      {task.project && (
        <SelectRow
          label="Coluna"
          value={task.column?._id ?? ""}
          options={(columns ?? []).map((c: { _id: string; name: string; isDoneColumn?: boolean }) => ({
            value: c._id,
            label: `${c.name}${c.isDoneColumn ? " · Concluído" : ""}`,
          }))}
          onValueChange={(columnId) => {
            if (!columnId) return;
            void run(
              () => moveTaskToColumn({ taskId, columnId: columnId as Id<"taskColumns"> }),
              "Não foi possível mover de coluna."
            );
          }}
        />
      )}

      {/* Lead vinculado + atalhos para o funil e a conversa */}
      <div className="space-y-2">
        <SelectRow
          label="Lead"
          ariaLabel="Lead vinculado à tarefa"
          value={task.leadId ?? ""}
          options={[
            { value: "", label: "Sem lead" },
            ...(linkedLead && !leadOptions?.some((l) => l._id === linkedLead._id)
              ? [{ value: linkedLead._id as string, label: linkedLead.title }]
              : []),
            ...(leadOptions ?? []).map((l) => ({ value: l._id as string, label: l.title })),
          ]}
          onValueChange={(value) =>
            run(async () => {
              await updateTask({ taskId, leadId: value ? (value as Id<"leads">) : null });
              toast.success(value ? "Lead vinculado à tarefa" : "Vínculo com o lead removido");
            }, "Não foi possível atualizar o vínculo com o lead.")
          }
        />

        {task.leadId && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="max-w-full"
              onClick={() => navigate(`${TAB_ROUTES.board}?lead=${task.leadId}`)}
              aria-label={`Abrir o lead ${linkedLead?.title ?? ""} no funil`}
            >
              <Target size={14} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{linkedLead?.title ?? "Ver no funil"}</span>
            </Button>
            {leadConversationId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate(`${TAB_ROUTES.inbox}?conversation=${leadConversationId}`)}
                aria-label="Abrir a conversa deste lead"
              >
                <MessageSquare size={14} aria-hidden="true" />
                Conversa
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Contato: sem rota própria na URL, só exibe o nome */}
      {contactName && (
        <FieldRow label="Contato">
          <span className="flex items-center gap-1.5 text-sm text-text-primary truncate">
            <User size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
            {contactName}
          </span>
        </FieldRow>
      )}

      <FieldRow label="Vencimento">
        {task.dueDate ? (
          <span
            className={cn(
              "text-sm font-medium tabular-nums",
              !isCompleted && task.dueDate < now ? "text-semantic-error" : "text-text-primary"
            )}
          >
            {formatDateTime(task.dueDate)}
          </span>
        ) : (
          <span className="text-sm text-text-muted">Sem data</span>
        )}
      </FieldRow>

      {task.recurrence && (
        <FieldRow label="Recorrência">
          <span className="text-sm text-text-primary">
            {RECURRENCE_LABELS[task.recurrence.pattern] || task.recurrence.pattern}
          </span>
        </FieldRow>
      )}

      {task.tags && task.tags.length > 0 && (
        <FieldRow label="Etiquetas">
          <div className="flex flex-wrap gap-1">
            {task.tags.map((tag) => (
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
  );
}
