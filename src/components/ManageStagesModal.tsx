import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { ChevronUp, ChevronDown, X, Plus } from "lucide-react";
import { toast } from "sonner";

interface ManageStagesModalProps {
  boardId: Id<"boards">;
  organizationId: Id<"organizations">;
  onClose: () => void;
}

interface LocalStage {
  _id: Id<"stages">;
  name: string;
  color: string;
  isClosedWon?: boolean;
  isClosedLost?: boolean;
  order: number;
  editing?: boolean;
}

export function ManageStagesModal({ boardId, organizationId, onClose }: ManageStagesModalProps) {
  const stages = useQuery(api.boards.getStages, { boardId });
  const [localStages, setLocalStages] = useState<LocalStage[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newStageName, setNewStageName] = useState("");
  const [newStageColor, setNewStageColor] = useState("#3B82F6");
  const [confirmDeleteStageId, setConfirmDeleteStageId] = useState<Id<"stages"> | null>(null);

  const updateStage = useMutation(api.boards.updateStage);
  const deleteStage = useMutation(api.boards.deleteStage);
  const createStage = useMutation(api.boards.createStage);
  const reorderStages = useMutation(api.boards.reorderStages);

  // Initialize local stages when query loads
  useState(() => {
    if (stages && localStages.length === 0) {
      setLocalStages(
        stages.map((stage, idx) => ({
          _id: stage._id,
          name: stage.name,
          color: stage.color,
          isClosedWon: stage.isClosedWon,
          isClosedLost: stage.isClosedLost,
          order: idx,
        }))
      );
    }
  });

  // Sync when stages change
  useState(() => {
    if (stages) {
      setLocalStages((prev) => {
        if (prev.length === 0) {
          return stages.map((stage, idx) => ({
            _id: stage._id,
            name: stage.name,
            color: stage.color,
            isClosedWon: stage.isClosedWon,
            isClosedLost: stage.isClosedLost,
            order: idx,
          }));
        }
        return prev;
      });
    }
  });

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const newStages = [...localStages];
    [newStages[index - 1], newStages[index]] = [newStages[index], newStages[index - 1]];
    setLocalStages(newStages.map((s, i) => ({ ...s, order: i })));
  };

  const handleMoveDown = (index: number) => {
    if (index === localStages.length - 1) return;
    const newStages = [...localStages];
    [newStages[index], newStages[index + 1]] = [newStages[index + 1], newStages[index]];
    setLocalStages(newStages.map((s, i) => ({ ...s, order: i })));
  };

  const handleUpdateStage = async (stageId: Id<"stages">, updates: Partial<LocalStage>) => {
    try {
      await updateStage({
        stageId,
        name: updates.name,
        color: updates.color,
        isClosedWon: updates.isClosedWon,
        isClosedLost: updates.isClosedLost,
      });
      setLocalStages((prev) =>
        prev.map((s) => (s._id === stageId ? { ...s, ...updates, editing: false } : s))
      );
      toast.success("Etapa atualizada!");
    } catch (error) {
      toast.error("Falha ao atualizar etapa");
    }
  };

  const handleDeleteStage = async (stageId: Id<"stages">) => {
    try {
      await deleteStage({ stageId });
      setLocalStages((prev) => prev.filter((s) => s._id !== stageId));
      toast.success("Etapa excluída!");
    } catch (error) {
      toast.error(
        error instanceof Error && error.message.includes("leads")
          ? "Não é possível excluir uma etapa com leads. Mova ou exclua todos os leads primeiro."
          : "Falha ao excluir etapa"
      );
    }
  };

  const handleCreateStage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStageName.trim()) return;

    try {
      await toast.promise(
        createStage({
          boardId,
          name: newStageName.trim(),
          color: newStageColor,
        }),
        {
          loading: "Criando etapa...",
          success: "Etapa criada!",
          error: "Falha ao criar etapa",
        }
      );
      setNewStageName("");
      setNewStageColor("#3B82F6");
      setShowAddForm(false);
    } catch (error) {
      console.error("Failed to create stage:", error);
    }
  };

  const handleSaveOrder = async () => {
    try {
      await toast.promise(
        reorderStages({
          boardId,
          stageIds: localStages.map((s) => s._id),
        }),
        {
          loading: "Salvando ordem...",
          success: "Ordem salva!",
          error: "Falha ao salvar ordem",
        }
      );
    } catch (error) {
      console.error("Failed to reorder stages:", error);
    }
  };

  if (!stages) {
    return null;
  }

  return (
    <Modal open={true} onClose={onClose} title="Gerenciar Etapas">
      <div className="space-y-3">
        {localStages.map((stage, index) => (
          <div
            key={stage._id}
            className="bg-surface-sunken border border-border rounded-card p-3 space-y-3"
          >
            <div className="flex items-center gap-3">
              {/* Color Indicator */}
              <input
                type="color"
                value={stage.color}
                onChange={(e) => {
                  const newColor = e.target.value;
                  setLocalStages((prev) =>
                    prev.map((s) => (s._id === stage._id ? { ...s, color: newColor } : s))
                  );
                  handleUpdateStage(stage._id, { color: newColor });
                }}
                className="w-8 h-8 rounded cursor-pointer border border-border-strong"
                title="Cor da etapa"
              />

              {/* Name Input */}
              <input
                type="text"
                value={stage.name}
                onChange={(e) =>
                  setLocalStages((prev) =>
                    prev.map((s) => (s._id === stage._id ? { ...s, name: e.target.value } : s))
                  )
                }
                onBlur={() => handleUpdateStage(stage._id, { name: stage.name })}
                className="flex-1 px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm"
                style={{ fontSize: "16px" }}
              />

              {/* Move Buttons */}
              <div className="flex flex-col gap-1">
                <button
                  onClick={() => handleMoveUp(index)}
                  disabled={index === 0}
                  className={cn(
                    "p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors",
                    index === 0 && "opacity-30 cursor-not-allowed"
                  )}
                  aria-label="Mover para cima"
                >
                  <ChevronUp size={16} />
                </button>
                <button
                  onClick={() => handleMoveDown(index)}
                  disabled={index === localStages.length - 1}
                  className={cn(
                    "p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors",
                    index === localStages.length - 1 && "opacity-30 cursor-not-allowed"
                  )}
                  aria-label="Mover para baixo"
                >
                  <ChevronDown size={16} />
                </button>
              </div>

              {/* Delete Button */}
              <button
                onClick={() => setConfirmDeleteStageId(stage._id)}
                className="p-1.5 rounded text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors"
                aria-label="Excluir etapa"
              >
                <X size={18} />
              </button>
            </div>

            {/* Closed Won/Lost Toggles */}
            <div className="flex items-center gap-4 pl-11">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={stage.isClosedWon || false}
                  onChange={(e) => {
                    const newValue = e.target.checked;
                    setLocalStages((prev) =>
                      prev.map((s) =>
                        s._id === stage._id
                          ? { ...s, isClosedWon: newValue, isClosedLost: false }
                          : s
                      )
                    );
                    handleUpdateStage(stage._id, { isClosedWon: newValue, isClosedLost: false });
                  }}
                  className="w-4 h-4 text-brand-600 bg-surface-raised border-border-strong rounded focus:ring-2 focus:ring-brand-500"
                />
                <span className="text-xs text-text-secondary">Fechado - Ganho</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={stage.isClosedLost || false}
                  onChange={(e) => {
                    const newValue = e.target.checked;
                    setLocalStages((prev) =>
                      prev.map((s) =>
                        s._id === stage._id
                          ? { ...s, isClosedLost: newValue, isClosedWon: false }
                          : s
                      )
                    );
                    handleUpdateStage(stage._id, { isClosedLost: newValue, isClosedWon: false });
                  }}
                  className="w-4 h-4 text-brand-600 bg-surface-raised border-border-strong rounded focus:ring-2 focus:ring-brand-500"
                />
                <span className="text-xs text-text-secondary">Fechado - Perdido</span>
              </label>
            </div>
          </div>
        ))}

        {/* Add Stage Form */}
        {showAddForm ? (
          <form onSubmit={handleCreateStage} className="bg-surface-sunken border border-border rounded-card p-3">
            <div className="flex items-center gap-3 mb-2">
              <input
                type="color"
                value={newStageColor}
                onChange={(e) => setNewStageColor(e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border border-border-strong"
              />
              <input
                type="text"
                value={newStageName}
                onChange={(e) => setNewStageName(e.target.value)}
                placeholder="Nome da etapa..."
                className="flex-1 px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm"
                style={{ fontSize: "16px" }}
                autoFocus
                required
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" size="sm" className="flex-1">
                Adicionar
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setShowAddForm(false);
                  setNewStageName("");
                  setNewStageColor("#3B82F6");
                }}
                variant="secondary"
                size="sm"
              >
                Cancelar
              </Button>
            </div>
          </form>
        ) : (
          <Button
            onClick={() => setShowAddForm(true)}
            variant="ghost"
            size="md"
            className="w-full"
          >
            <Plus size={18} />
            Adicionar Etapa
          </Button>
        )}

        {/* Save Order Button */}
        <div className="pt-4 border-t border-border">
          <Button onClick={handleSaveOrder} variant="primary" size="md" className="w-full">
            Salvar Ordem
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmDeleteStageId}
        onClose={() => setConfirmDeleteStageId(null)}
        onConfirm={() => {
          if (confirmDeleteStageId) handleDeleteStage(confirmDeleteStageId);
        }}
        title="Excluir Etapa"
        description="Tem certeza que deseja excluir esta etapa? Leads vinculados precisarão ser movidos primeiro."
        confirmLabel="Excluir"
        variant="danger"
      />
    </Modal>
  );
}
