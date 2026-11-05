import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { Id } from "../../../convex/_generated/dataModel";

// Add Stage Column Component
export function AddStageColumn({
  boardId,
  onAddStage,
}: {
  boardId: Id<"boards">;
  onAddStage: (name: string, color: string) => void;
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3B82F6");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    onAddStage(name.trim(), color);
    setName("");
    setColor("#3B82F6");
    setIsAdding(false);
  };

  if (!isAdding) {
    return (
      <div className="flex-shrink-0 w-80">
        <button
          onClick={() => setIsAdding(true)}
          className="w-full h-32 bg-surface-sunken rounded-card border-2 border-dashed border-border hover:border-brand-500 text-text-muted hover:text-brand-500 transition-all flex flex-col items-center justify-center gap-2"
        >
          <Plus size={24} />
          <span className="text-sm font-medium">Adicionar etapa</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 w-80">
      <form onSubmit={handleSubmit} className="bg-surface-sunken rounded-card p-4 border border-border">
        <h4 className="text-sm font-semibold text-text-primary mb-3">Nova etapa</h4>
        <div className="space-y-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome da etapa"
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted text-sm"
            style={{ fontSize: "16px" }}
            autoFocus
            required
          />
          <div>
            <label className="block text-xs text-text-muted mb-1">Cor</label>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-full h-8 bg-surface-raised border border-border-strong rounded-field cursor-pointer"
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" size="sm" className="flex-1">
              Criar
            </Button>
            <Button
              type="button"
              onClick={() => {
                setIsAdding(false);
                setName("");
                setColor("#3B82F6");
              }}
              variant="secondary"
              aria-label="Cancelar"
              size="sm"
            >
              <X size={16} aria-hidden />
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
