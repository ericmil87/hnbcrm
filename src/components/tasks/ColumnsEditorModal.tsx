import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { TaskColumnDoc } from "./TaskKanbanBoard";

// Editor das colunas do kanban de um projeto: renomear, reordenar, definir
// limite de WIP, marcar a coluna de conclusão e excluir (o backend move as
// tarefas da coluna excluída para a primeira coluna do projeto).

interface ColumnsEditorModalProps {
  open: boolean;
  onClose: () => void;
  projectId: Id<"taskProjects"> | null;
  projectName?: string;
}

export function ColumnsEditorModal({
  open,
  onClose,
  projectId,
  projectName,
}: ColumnsEditorModalProps) {
  const columns = useQuery(
    api.taskProjects.getColumns,
    open && projectId ? { projectId } : "skip"
  ) as TaskColumnDoc[] | undefined;

  const createColumn = useMutation(api.taskProjects.createColumn);
  const reorderColumn = useMutation(api.taskProjects.reorderColumn);

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) {
      setNewName("");
      setCreating(false);
    }
  }, [open]);

  const sorted = [...(columns ?? [])].sort((a, b) => a.order - b.order);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || !projectId) return;
    setCreating(true);
    try {
      await createColumn({ projectId, name });
      setNewName("");
      toast.success("Coluna criada");
    } catch (error: any) {
      toast.error(error?.message || "Falha ao criar coluna");
    } finally {
      setCreating(false);
    }
  };

  // Reordenar = trocar o `order` com o vizinho, mantendo os demais intactos.
  const handleMove = async (index: number, direction: -1 | 1) => {
    const current = sorted[index];
    const neighbor = sorted[index + direction];
    if (!current || !neighbor) return;
    try {
      await reorderColumn({ columnId: current._id, order: neighbor.order });
      await reorderColumn({ columnId: neighbor._id, order: current.order });
    } catch (error: any) {
      toast.error(error?.message || "Falha ao reordenar colunas");
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={projectName ? `Colunas — ${projectName}` : "Colunas do projeto"}
    >
      <div className="space-y-4">
        {columns === undefined ? (
          <div className="flex justify-center py-8">
            <Spinner size="md" />
          </div>
        ) : (
          <ul className="space-y-2">
            {sorted.map((column, index) => (
              <ColumnRow
                key={column._id}
                column={column}
                isFirst={index === 0}
                isLast={index === sorted.length - 1}
                isOnly={sorted.length === 1}
                onMoveUp={() => handleMove(index, -1)}
                onMoveDown={() => handleMove(index, 1)}
              />
            ))}
          </ul>
        )}

        <div className="border-t border-border pt-4">
          <label
            htmlFor="new-column-name"
            className="block text-[13px] font-medium text-text-secondary mb-1.5"
          >
            Nova coluna
          </label>
          <div className="flex gap-2">
            <input
              id="new-column-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
              placeholder="Ex.: Em revisão"
              maxLength={40}
              className="flex-1 min-w-0 bg-surface-raised border border-border-strong rounded-field px-3 py-2 text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
              style={{ fontSize: "16px" }}
            />
            <Button
              type="button"
              variant="primary"
              size="md"
              onClick={() => void handleCreate()}
              disabled={creating || !newName.trim()}
            >
              <Plus size={16} />
              Adicionar
            </Button>
          </div>
        </div>

        <p className="text-xs text-text-muted">
          Mover uma tarefa para a coluna de conclusão marca a tarefa como
          concluída. O limite de WIP é apenas informativo.
        </p>
      </div>
    </Modal>
  );
}

// ============================================================================
// ColumnRow
// ============================================================================

function ColumnRow({
  column,
  isFirst,
  isLast,
  isOnly,
  onMoveUp,
  onMoveDown,
}: {
  column: TaskColumnDoc;
  isFirst: boolean;
  isLast: boolean;
  isOnly: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const updateColumn = useMutation(api.taskProjects.updateColumn);
  const deleteColumn = useMutation(api.taskProjects.deleteColumn);

  const [name, setName] = useState(column.name);
  const [wip, setWip] = useState(
    column.wipLimit && column.wipLimit > 0 ? String(column.wipLimit) : ""
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    setName(column.name);
  }, [column.name]);

  useEffect(() => {
    setWip(column.wipLimit && column.wipLimit > 0 ? String(column.wipLimit) : "");
  }, [column.wipLimit]);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === column.name) {
      setName(column.name);
      return;
    }
    try {
      await updateColumn({ columnId: column._id, name: trimmed });
    } catch (error: any) {
      setName(column.name);
      toast.error(error?.message || "Falha ao renomear coluna");
    }
  };

  const saveWip = async () => {
    const parsed = Number.parseInt(wip, 10);
    const next = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    if (next === (column.wipLimit ?? 0)) return;
    try {
      await updateColumn({ columnId: column._id, wipLimit: next });
    } catch (error: any) {
      toast.error(error?.message || "Falha ao salvar limite");
    }
  };

  const toggleDone = async () => {
    try {
      await updateColumn({
        columnId: column._id,
        isDoneColumn: !column.isDoneColumn,
      });
    } catch (error: any) {
      toast.error(error?.message || "Falha ao definir coluna de conclusão");
    }
  };

  const handleDelete = async () => {
    try {
      await deleteColumn({ columnId: column._id });
      toast.success("Coluna excluída");
    } catch (error: any) {
      toast.error(error?.message || "Falha ao excluir coluna");
    } finally {
      setConfirmingDelete(false);
    }
  };

  return (
    <li className="rounded-lg border border-border bg-surface-raised p-3 space-y-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => void saveName()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        maxLength={40}
        aria-label={`Nome da coluna ${column.name}`}
        className="w-full bg-surface-sunken border border-border-strong rounded-field px-3 py-2 text-base md:text-sm font-medium text-text-primary focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
        style={{ fontSize: "16px" }}
      />

      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          Limite
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={wip}
            onChange={(e) => setWip(e.target.value)}
            onBlur={() => void saveWip()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            placeholder="—"
            aria-label={`Limite de WIP da coluna ${column.name}`}
            className="w-16 bg-surface-sunken border border-border-strong rounded-field px-2 py-1.5 text-base md:text-sm text-text-primary tabular-nums focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            style={{ fontSize: "16px" }}
          />
        </label>

        <div className="flex items-center gap-1 ml-auto">
          <IconAction
            icon={ArrowUp}
            label={`Mover ${column.name} para a esquerda`}
            onClick={onMoveUp}
            disabled={isFirst}
          />
          <IconAction
            icon={ArrowDown}
            label={`Mover ${column.name} para a direita`}
            onClick={onMoveDown}
            disabled={isLast}
          />
          <IconAction
            icon={Check}
            label={
              column.isDoneColumn
                ? `${column.name} é a coluna de conclusão`
                : `Definir ${column.name} como coluna de conclusão`
            }
            onClick={() => void toggleDone()}
            pressed={column.isDoneColumn === true}
            activeClassName="text-semantic-success bg-semantic-success/10"
          />
          <IconAction
            icon={Trash2}
            label={`Excluir coluna ${column.name}`}
            onClick={() => setConfirmingDelete(true)}
            disabled={isOnly}
            danger
          />
        </div>
      </div>

      {confirmingDelete && (
        <div className="rounded-lg border border-semantic-error/40 bg-semantic-error/5 p-3 space-y-2">
          <p className="text-xs text-text-secondary">
            Excluir “{column.name}”? As tarefas desta coluna vão para a primeira
            coluna do projeto.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => void handleDelete()}
            >
              Excluir
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingDelete(false)}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function IconAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  pressed,
  danger,
  activeClassName,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  danger?: boolean;
  activeClassName?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        "flex items-center justify-center min-w-[40px] min-h-[40px] rounded-lg transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-raised",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        danger
          ? "text-text-muted hover:text-semantic-error hover:bg-semantic-error/10"
          : "text-text-muted hover:text-text-primary hover:bg-surface-overlay",
        pressed && activeClassName
      )}
    >
      <Icon size={16} />
    </button>
  );
}
