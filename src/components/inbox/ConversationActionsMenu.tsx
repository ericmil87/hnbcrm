import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { MoreVertical, Archive, ArchiveRestore, Check, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Menu "..." do header da conversa: arquivar/desarquivar + etiquetas (toggle,
// criar, excluir). Paleta fixa — a cor vive no doc da etiqueta.

export const LABEL_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#64748b",
] as const;

interface ConversationActionsMenuProps {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  archivedAt: number | undefined;
  labelIds: string[];
  /** Chamado após arquivar/desarquivar (ex.: voltar para a lista). */
  onArchivedChange?: (archived: boolean) => void;
}

export function ConversationActionsMenu({
  organizationId,
  conversationId,
  archivedAt,
  labelIds,
  onArchivedChange,
}: ConversationActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>(LABEL_COLORS[3]);
  const rootRef = useRef<HTMLDivElement>(null);

  const labels = useQuery(api.conversations.listLabels, { organizationId });
  const setArchived = useMutation(api.conversations.setConversationArchived);
  const toggleLabel = useMutation(api.conversations.toggleConversationLabel);
  const createLabel = useMutation(api.conversations.createLabel);
  const deleteLabel = useMutation(api.conversations.deleteLabel);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const archived = !!archivedAt;

  const handleArchive = async () => {
    try {
      await setArchived({ conversationId, archived: !archived });
      toast.success(archived ? "Conversa desarquivada" : "Conversa arquivada");
      setOpen(false);
      onArchivedChange?.(!archived);
    } catch {
      toast.error("Falha ao arquivar conversa");
    }
  };

  const handleToggleLabel = async (labelId: Id<"conversationLabels">) => {
    try {
      await toggleLabel({ conversationId, labelId });
    } catch {
      toast.error("Falha ao aplicar etiqueta");
    }
  };

  const handleCreateLabel = async () => {
    if (!newName.trim()) return;
    try {
      const labelId = await createLabel({ organizationId, name: newName, color: newColor });
      // Já aplica a etiqueta recém-criada nesta conversa.
      await toggleLabel({ conversationId, labelId });
      setNewName("");
      setCreating(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message.split("\n")[0].replace(/^.*Error: /, "") : "Falha ao criar etiqueta");
    }
  };

  const handleDeleteLabel = async (labelId: Id<"conversationLabels">, name: string) => {
    try {
      await deleteLabel({ labelId });
      toast.success(`Etiqueta "${name}" excluída`);
    } catch {
      toast.error("Falha ao excluir etiqueta");
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "p-2 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors",
          open && "text-text-primary bg-surface-overlay"
        )}
        aria-label="Ações da conversa"
        aria-expanded={open}
      >
        <MoreVertical size={18} />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 z-40 w-60 py-1 bg-surface-overlay border border-border rounded-xl shadow-elevated">
          <button
            type="button"
            onClick={handleArchive}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-raised transition-colors"
          >
            {archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
            {archived ? "Desarquivar conversa" : "Arquivar conversa"}
          </button>

          <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted border-t border-border mt-1">
            Etiquetas
          </p>
          {labels === undefined ? (
            <p className="px-3 py-1.5 text-xs text-text-muted">Carregando…</p>
          ) : (
            labels.map((label) => {
              const active = labelIds.includes(label._id);
              return (
                <div
                  key={label._id}
                  className="group flex items-center gap-2.5 px-3 py-1.5 hover:bg-surface-raised transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => handleToggleLabel(label._id)}
                    className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="flex-1 min-w-0 truncate text-sm text-text-primary">
                      {label.name}
                    </span>
                    {active && <Check size={14} className="shrink-0 text-brand-500" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteLabel(label._id, label.name)}
                    className="shrink-0 p-1 rounded-full text-text-muted opacity-0 group-hover:opacity-100 hover:text-semantic-error transition-all"
                    aria-label={`Excluir etiqueta ${label.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })
          )}

          {creating ? (
            <div className="px-3 py-2 space-y-2 border-t border-border mt-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleCreateLabel();
                  }
                }}
                placeholder="Nome da etiqueta"
                className="w-full h-8 px-2.5 rounded-lg text-sm bg-surface-sunken border border-border-strong text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
              />
              <div className="flex items-center gap-1.5">
                {LABEL_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setNewColor(color)}
                    className={cn(
                      "h-5 w-5 rounded-full transition-transform hover:scale-110",
                      newColor === color && "ring-2 ring-offset-1 ring-brand-500 ring-offset-surface-overlay"
                    )}
                    style={{ backgroundColor: color }}
                    aria-label={`Cor ${color}`}
                  />
                ))}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
            >
              <Plus size={13} />
              Nova etiqueta
            </button>
          )}
        </div>
      )}
    </div>
  );
}
