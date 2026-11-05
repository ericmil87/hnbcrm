import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { toast } from "sonner";

interface EditBoardModalProps {
  board: {
    _id: Id<"boards">;
    name: string;
    description?: string;
    color: string;
  };
  onClose: () => void;
}

export function EditBoardModal({ board, onClose }: EditBoardModalProps) {
  const [name, setName] = useState(board.name);
  const [description, setDescription] = useState(board.description || "");
  const [color, setColor] = useState(board.color);
  const [submitting, setSubmitting] = useState(false);

  const updateBoard = useMutation(api.boards.updateBoard);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setSubmitting(true);

    try {
      await toast.promise(
        updateBoard({
          boardId: board._id,
          name: name.trim(),
          description: description.trim() || undefined,
          color,
        }),
        {
          loading: "Atualizando funil…",
          success: "Funil atualizado",
          error: "Não foi possível atualizar o funil.",
        }
      );
      onClose();
    } catch (error) {
      console.error("Failed to update board:", error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={true} onClose={onClose} title="Editar funil">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Nome <span className="text-semantic-error">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
            required
          />
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Descrição
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Opcional: descrição do funil…"
            rows={3}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted resize-none"
            style={{ fontSize: "16px" }}
          />
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">Cor</label>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-12 h-10 bg-surface-raised border border-border-strong rounded-field cursor-pointer"
            />
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="flex-1 px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 font-mono text-sm"
              style={{ fontSize: "16px" }}
              pattern="^#[0-9A-Fa-f]{6}$"
              placeholder="#FF6B00"
            />
          </div>
        </div>

        <div className="flex gap-2 pt-4">
          <Button
            type="button"
            onClick={onClose}
            variant="secondary"
            size="md"
            className="flex-1"
            disabled={submitting}
          >
            Cancelar
          </Button>
          <Button type="submit" variant="primary" size="md" className="flex-1" disabled={submitting}>
            {submitting ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
