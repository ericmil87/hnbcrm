import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { LabelPicker } from "@/components/tasks/LabelPicker";
import { AssigneesPicker } from "@/components/tasks/AssigneesPicker";
import { ReminderSelect } from "@/components/tasks/ReminderSelect";
import { cn } from "@/lib/utils";
import {
  Plus,
  X,
  Phone,
  Mail,
  CalendarClock,
  Users as UsersIcon,
  Search,
  ClipboardList,
} from "lucide-react";

const ACTIVITY_TYPES = [
  { value: "todo", label: "Tarefa" },
  { value: "call", label: "Ligação" },
  { value: "email", label: "E-mail" },
  { value: "follow_up", label: "Follow-up" },
  { value: "meeting", label: "Reunião" },
  { value: "research", label: "Pesquisa" },
] as const;

const PRIORITIES = [
  { value: "low", label: "Baixa", color: "bg-surface-overlay text-text-secondary" },
  { value: "medium", label: "Média", color: "bg-semantic-info/10 text-semantic-info" },
  { value: "high", label: "Alta", color: "bg-semantic-warning/10 text-semantic-warning" },
  { value: "urgent", label: "Urgente", color: "bg-semantic-error/10 text-semantic-error" },
] as const;

const RECURRENCE_OPTIONS = [
  { value: "", label: "Nenhuma" },
  { value: "daily", label: "Diária" },
  { value: "weekly", label: "Semanal" },
  { value: "biweekly", label: "Quinzenal" },
  { value: "monthly", label: "Mensal" },
] as const;

interface CreateTaskModalProps {
  organizationId: Id<"organizations">;
  isOpen: boolean;
  onClose: () => void;
  defaultLeadId?: Id<"leads">;
  defaultContactId?: Id<"contacts">;
  /** Projeto pré-selecionado (ex.: aberto a partir de uma coluna do kanban). */
  defaultProjectId?: Id<"taskProjects">;
}

export function CreateTaskModal({
  organizationId,
  isOpen,
  onClose,
  defaultLeadId,
  defaultContactId,
  defaultProjectId,
}: CreateTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"task" | "reminder">("task");
  const [activityType, setActivityType] = useState<string>("todo");
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? "");
  const [assigneeIds, setAssigneeIds] = useState<Id<"teamMembers">[]>([]);
  const [labelIds, setLabelIds] = useState<Id<"taskLabels">[]>([]);
  const [reminderMinutesBefore, setReminderMinutesBefore] = useState<number | undefined>(undefined);
  const [leadId, setLeadId] = useState<string>(defaultLeadId ?? "");
  const [contactId, setContactId] = useState<string>(defaultContactId ?? "");
  const [recurrence, setRecurrence] = useState("");
  const [checklist, setChecklist] = useState<{ id: string; title: string; completed: boolean }[]>([]);
  const [newChecklistItem, setNewChecklistItem] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [leadSearch, setLeadSearch] = useState("");

  const contacts = useQuery(api.contacts.getContacts, { organizationId });
  const projects = useQuery(api.taskProjects.getProjects, { organizationId });
  const leads = useQuery(api.leads.getLeads, { organizationId, limit: 200 }) as
    | { _id: Id<"leads">; title: string; contact?: { firstName?: string; lastName?: string } | null }[]
    | undefined;
  const createTask = useMutation(api.tasks.createTask);

  // Busca client-side na lista de leads; o lead já escolhido continua na lista
  // mesmo quando não casa com o termo, para o select nunca ficar em branco.
  const filteredLeads = useMemo(() => {
    const all = leads ?? [];
    const term = leadSearch.trim().toLowerCase();
    if (!term) return all;
    return all.filter((l) => l.title.toLowerCase().includes(term) || l._id === leadId);
  }, [leads, leadSearch, leadId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    try {
      let dueDateTs: number | undefined;
      if (dueDate) {
        const dateStr = dueTime ? `${dueDate}T${dueTime}` : `${dueDate}T23:59`;
        dueDateTs = new Date(dateStr).getTime();
      }

      await createTask({
        organizationId,
        title: title.trim(),
        description: description.trim() || undefined,
        type,
        activityType: activityType as "todo" | "call" | "email" | "follow_up" | "meeting" | "research",
        dueDate: dueDateTs,
        priority,
        projectId: projectId ? (projectId as Id<"taskProjects">) : undefined,
        assigneeIds: assigneeIds.length > 0 ? assigneeIds : undefined,
        labelIds: labelIds.length > 0 ? labelIds : undefined,
        reminderMinutesBefore: dueDateTs ? reminderMinutesBefore : undefined,
        leadId: leadId ? (leadId as Id<"leads">) : undefined,
        contactId: contactId ? (contactId as Id<"contacts">) : undefined,
        recurrence: recurrence
          ? { pattern: recurrence as "daily" | "weekly" | "biweekly" | "monthly" }
          : undefined,
        checklist: checklist.length > 0 ? checklist : undefined,
        tags: tags.length > 0 ? tags : undefined,
      });

      toast.success("Tarefa criada com sucesso!");
      resetForm();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao criar tarefa");
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setType("task");
    setActivityType("todo");
    setDueDate("");
    setDueTime("");
    setPriority("medium");
    setProjectId(defaultProjectId ?? "");
    setAssigneeIds([]);
    setLabelIds([]);
    setReminderMinutesBefore(undefined);
    setLeadId(defaultLeadId ?? "");
    setContactId(defaultContactId ?? "");
    setRecurrence("");
    setChecklist([]);
    setNewChecklistItem("");
    setTags([]);
    setTagInput("");
    setLeadSearch("");
  };

  // Reseta o formulário sempre que o modal é (re)aberto — sem isso, fechar
  // (Esc/backdrop) sem enviar e reabrir mantinha o rascunho anterior.
  useEffect(() => {
    if (isOpen) {
      resetForm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, defaultLeadId, defaultContactId, defaultProjectId]);

  const addChecklistItem = () => {
    if (!newChecklistItem.trim()) return;
    setChecklist((prev) => [
      ...prev,
      { id: crypto.randomUUID(), title: newChecklistItem.trim(), completed: false },
    ]);
    setNewChecklistItem("");
  };

  const removeChecklistItem = (id: string) => {
    setChecklist((prev) => prev.filter((item) => item.id !== id));
  };

  const addTag = () => {
    const tag = tagInput.trim();
    if (!tag || tags.includes(tag)) return;
    setTags((prev) => [...prev, tag]);
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    setTags((prev) => prev.filter((t) => t !== tag));
  };

  return (
    <Modal open={isOpen} onClose={onClose} title="Nova Tarefa">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Title */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Título <span className="text-semantic-error">*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="O que precisa ser feito?"
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
            required
            autoFocus
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Descrição
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Detalhes adicionais..."
            rows={2}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted resize-none text-sm"
            style={{ fontSize: "16px" }}
          />
        </div>

        {/* Type: Tarefa / Lembrete */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">Tipo</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setType("task")}
              className={cn(
                "flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors",
                type === "task"
                  ? "bg-brand-500/10 text-brand-500 border-2 border-brand-500"
                  : "bg-surface-raised text-text-secondary border-2 border-border hover:border-border-strong"
              )}
            >
              Tarefa
            </button>
            <button
              type="button"
              onClick={() => setType("reminder")}
              className={cn(
                "flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors",
                type === "reminder"
                  ? "bg-brand-500/10 text-brand-500 border-2 border-brand-500"
                  : "bg-surface-raised text-text-secondary border-2 border-border hover:border-border-strong"
              )}
            >
              Lembrete
            </button>
          </div>
        </div>

        {/* Activity Type */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Tipo de Atividade
          </label>
          <select
            value={activityType}
            onChange={(e) => setActivityType(e.target.value)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            style={{ fontSize: "16px" }}
          >
            {ACTIVITY_TYPES.map((at) => (
              <option key={at.value} value={at.value}>
                {at.label}
              </option>
            ))}
          </select>
        </div>

        {/* Project */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Projeto
          </label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            style={{ fontSize: "16px" }}
          >
            <option value="">Sem projeto</option>
            {projects?.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {/* Due date + time */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">
              Data de Vencimento
            </label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              style={{ fontSize: "16px" }}
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">
              Horário
            </label>
            <input
              type="time"
              value={dueTime}
              onChange={(e) => setDueTime(e.target.value)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              style={{ fontSize: "16px" }}
            />
          </div>
        </div>

        {/* Reminder */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Lembrete antecipado
          </label>
          <ReminderSelect
            value={reminderMinutesBefore}
            onChange={setReminderMinutesBefore}
            disabled={!dueDate}
          />
        </div>

        {/* Priority pill selector */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Prioridade
          </label>
          <div className="flex gap-2">
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPriority(p.value)}
                className={cn(
                  "flex-1 px-2 py-1.5 text-xs font-medium rounded-full transition-colors",
                  priority === p.value
                    ? cn(p.color, "ring-2 ring-brand-500 ring-offset-1 ring-offset-surface-base")
                    : "bg-surface-raised text-text-muted hover:text-text-secondary"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Assignees */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Responsáveis
          </label>
          <AssigneesPicker
            organizationId={organizationId}
            selectedIds={assigneeIds}
            onChange={setAssigneeIds}
          />
        </div>

        {/* Labels */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Etiquetas
          </label>
          <LabelPicker organizationId={organizationId} selectedIds={labelIds} onChange={setLabelIds} />
        </div>

        {/* Lead */}
        {!defaultLeadId && (
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">
              Lead
            </label>
            {(leads?.length ?? 0) > 8 && (
              <div className="relative mb-2">
                <Search
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={leadSearch}
                  onChange={(e) => setLeadSearch(e.target.value)}
                  placeholder="Buscar lead pelo título..."
                  aria-label="Buscar lead"
                  className="w-full pl-9 pr-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  style={{ fontSize: "16px" }}
                />
              </div>
            )}
            <select
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              style={{ fontSize: "16px" }}
            >
              <option value="">Sem lead</option>
              {filteredLeads.map((l) => {
                const contactName = [l.contact?.firstName, l.contact?.lastName]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <option key={l._id} value={l._id}>
                    {l.title}
                    {contactName ? ` (${contactName})` : ""}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {/* Contact */}
        {!defaultContactId && (
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">
              Contato
            </label>
            <select
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              style={{ fontSize: "16px" }}
            >
              <option value="">Nenhum</option>
              {contacts?.map((c) => (
                <option key={c._id} value={c._id}>
                  {[c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Sem nome"}
                  {c.company ? ` (${c.company})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Recurrence */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Recorrência
          </label>
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            style={{ fontSize: "16px" }}
          >
            {RECURRENCE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {/* Checklist */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Checklist
          </label>
          {checklist.length > 0 && (
            <div className="space-y-1 mb-2">
              {checklist.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 px-3 py-1.5 bg-surface-sunken rounded-lg"
                >
                  <ClipboardList size={14} className="text-text-muted shrink-0" />
                  <span className="flex-1 text-sm text-text-primary truncate">
                    {item.title}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeChecklistItem(item.id)}
                    className="p-0.5 text-text-muted hover:text-semantic-error transition-colors"
                    aria-label="Remover item"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={newChecklistItem}
              onChange={(e) => setNewChecklistItem(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addChecklistItem();
                }
              }}
              placeholder="Adicionar item..."
              className="flex-1 px-3 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
              style={{ fontSize: "16px" }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={addChecklistItem}
              aria-label="Adicionar item ao checklist"
            >
              <Plus size={16} />
            </Button>
          </div>
        </div>

        {/* Tags */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">Tags</label>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-brand-500/10 text-brand-400 text-xs font-medium rounded-full"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="hover:text-brand-300"
                    aria-label={`Remover tag ${tag}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder="Adicionar tag..."
              className="flex-1 px-3 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
              style={{ fontSize: "16px" }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={addTag}
              aria-label="Adicionar tag"
            >
              <Plus size={16} />
            </Button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-4">
          <Button
            type="button"
            onClick={onClose}
            variant="secondary"
            size="md"
            className="flex-1"
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            disabled={submitting || !title.trim()}
            variant="primary"
            size="md"
            className="flex-1"
          >
            {submitting ? "Criando..." : "Criar Tarefa"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
