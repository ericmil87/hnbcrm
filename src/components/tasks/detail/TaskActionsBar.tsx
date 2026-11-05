import { useState } from "react";
import { AlarmClock, Ban, Check, MoreHorizontal, Trash2, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Menu, type MenuItem } from "@/components/ui/Menu";

export type TaskPriority = "low" | "medium" | "high" | "urgent";

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: "low", label: "Baixa" },
  { value: "medium", label: "Média" },
  { value: "high", label: "Alta" },
  { value: "urgent", label: "Urgente" },
];

/** Hora padrão do lembrete quando só a data é informada. */
const DEFAULT_SNOOZE_TIME = "09:00";

export interface TaskActionAssignee {
  _id: string;
  name: string;
  type: "human" | "ai";
  avatarUrl?: string | null;
}

interface TaskActionsBarProps {
  /** Concluída ou cancelada: some "Concluir", "Lembrete" e "Cancelar tarefa". */
  isCompleted: boolean;
  priority: TaskPriority;
  assignees: readonly TaskActionAssignee[];
  onComplete: () => void;
  onCancel: () => void;
  /** Só pede a confirmação; quem renderiza o diálogo é o painel. */
  onRequestDelete: () => void;
  onPriorityChange: (priority: TaskPriority) => void;
  /** Devolve `true` quando salvou (a barra então recolhe o seletor). */
  onSnooze: (snoozedUntil: number) => Promise<boolean>;
}

/** Barra de ações do detalhe da tarefa: concluir, lembrete, responsáveis e menu "Mais ações". */
export function TaskActionsBar({
  isCompleted,
  priority,
  assignees,
  onComplete,
  onCancel,
  onRequestDelete,
  onPriorityChange,
  onSnooze,
}: TaskActionsBarProps) {
  const [showSnooze, setShowSnooze] = useState(false);
  const [snoozeDate, setSnoozeDate] = useState("");
  const [snoozeTime, setSnoozeTime] = useState("");

  const closeSnooze = () => {
    setShowSnooze(false);
    setSnoozeDate("");
    setSnoozeTime("");
  };

  const saveSnooze = async () => {
    if (!snoozeDate) return;
    const until = new Date(`${snoozeDate}T${snoozeTime || DEFAULT_SNOOZE_TIME}`).getTime();
    if (await onSnooze(until)) closeSnooze();
  };

  const menuItems: MenuItem[] = [
    ...PRIORITY_OPTIONS.map((option) => ({
      id: `priority-${option.value}`,
      label: `Prioridade: ${option.label}`,
      icon:
        option.value === priority ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <span className="inline-block w-3.5" aria-hidden="true" />
        ),
      onSelect: () => onPriorityChange(option.value),
    })),
    ...(!isCompleted
      ? [
          {
            id: "cancel",
            label: "Cancelar tarefa",
            icon: <Ban size={14} aria-hidden="true" />,
            separatorBefore: true,
            onSelect: onCancel,
          },
        ]
      : []),
    {
      id: "delete",
      label: "Excluir",
      icon: <Trash2 size={14} aria-hidden="true" />,
      danger: true,
      separatorBefore: true,
      onSelect: onRequestDelete,
    },
  ];

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-3 bg-surface-raised">
        {!isCompleted && (
          <Button variant="primary" size="sm" onClick={onComplete}>
            <Check size={14} aria-hidden="true" />
            Concluir
          </Button>
        )}
        {!isCompleted && (
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={showSnooze}
            onClick={() => setShowSnooze((open) => !open)}
          >
            <AlarmClock size={14} aria-hidden="true" />
            Lembrete
          </Button>
        )}

        <div className="flex-1" />

        {assignees.length > 0 && (
          <div className="flex items-center -space-x-2">
            {assignees.slice(0, 4).map((a) => (
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

        <Menu
          ariaLabel="Mais ações da tarefa"
          items={menuItems}
          trigger={(props) => (
            <Button variant="ghost" size="sm" iconOnly aria-label="Mais ações" {...props}>
              <MoreHorizontal size={16} aria-hidden="true" />
            </Button>
          )}
        />
      </div>

      {showSnooze && (
        <div className="flex flex-wrap items-end gap-2 px-4 py-2 bg-surface-sunken">
          <div className="flex-1 min-w-36">
            <Input type="date" aria-label="Data do lembrete" value={snoozeDate} onChange={(e) => setSnoozeDate(e.target.value)} />
          </div>
          <div className="w-28">
            <Input type="time" aria-label="Hora do lembrete" value={snoozeTime} onChange={(e) => setSnoozeTime(e.target.value)} />
          </div>
          <Button size="sm" onClick={() => void saveSnooze()} disabled={!snoozeDate}>
            Salvar
          </Button>
          <Button size="sm" variant="ghost" iconOnly aria-label="Fechar lembrete" onClick={closeSnooze}>
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
      )}
    </>
  );
}
