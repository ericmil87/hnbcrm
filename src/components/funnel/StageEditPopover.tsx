import { useState, type RefObject } from "react";
import { Trash2 } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Popover } from "@/components/ui/Popover";
import { cn } from "@/lib/utils";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Stage } from "./types";

// Stage Edit Popover Component
// Cores sugeridas: são dado da etapa (o usuário escolhe), por isso hex.
const PRESET_COLORS = [
  "#71717A", // zinc
  "#EF4444", // red
  "#F97316", // orange
  "#EAB308", // yellow
  "#22C55E", // green
  "#14B8A6", // teal
  "#3B82F6", // blue
  "#8B5CF6", // violet
  "#EC4899", // pink
  "#6366F1", // indigo
  "#06B6D4", // cyan
  "#A855F7", // purple
];

export function StageEditPopover({
  stage,
  anchor,
  onClose,
  onUpdate,
  onDelete,
}: {
  stage: Stage;
  /** Botão "Menu da etapa" que abriu o popover. */
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  onUpdate: (stageId: Id<"stages">, updates: Record<string, unknown>) => void;
  onDelete: (stageId: Id<"stages">) => void;
}) {
  const [name, setName] = useState(stage.name);
  const [selectedColor, setSelectedColor] = useState(stage.color);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleSaveName = () => {
    if (name.trim() && name.trim() !== stage.name) {
      onUpdate(stage._id, { name: name.trim() });
    }
  };

  const handleColorSelect = (color: string) => {
    setSelectedColor(color);
    onUpdate(stage._id, { color });
  };

  return (
    <>
    {/* Com a confirmação aberta o popover some; o diálogo fica fora dele (Esc e foco do Modal funcionam). */}
    <Popover
      open={!showDeleteConfirm}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      anchor={anchor}
      side="bottom"
      align="end"
      role="dialog"
      aria-label={`Editar etapa ${stage.name}`}
      className="w-72 max-w-[calc(100vw-1rem)] rounded-card p-4 space-y-4"
    >
      {/* Name field */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">Nome</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); }}
          onBlur={handleSaveName}
          className="w-full px-3 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm"
          style={{ fontSize: "16px" }}
        />
      </div>

      {/* Color picker */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">Cor</label>
        <div className="grid grid-cols-6 coarse:grid-cols-4 gap-2">
          {PRESET_COLORS.map((color) => (
            <button
              key={color}
              onClick={() => handleColorSelect(color)}
              className={cn(
                "w-8 h-8 coarse:w-11 coarse:h-11 rounded-lg transition-all",
                selectedColor === color
                  ? "ring-2 ring-brand-500 ring-offset-2 ring-offset-surface-overlay scale-110"
                  : "hover:scale-110"
              )}
              style={{ backgroundColor: color }}
              aria-label={`Cor ${color}`}
            />
          ))}
        </div>
        {/* Custom color input */}
        <div className="flex items-center gap-2 mt-2">
          <input
            type="color"
            value={selectedColor}
            onChange={(e) => handleColorSelect(e.target.value)}
            className="w-8 h-8 coarse:w-11 coarse:h-11 rounded cursor-pointer border border-border-strong"
            aria-label="Cor personalizada"
          />
          <span className="text-xs text-text-muted">Personalizada</span>
        </div>
      </div>

      {/* Won/Lost toggles */}
      <div className="space-y-2">
        <Checkbox
          checked={stage.isClosedWon || false}
          onChange={(e) => {
            onUpdate(stage._id, { isClosedWon: e.target.checked, isClosedLost: false });
          }}
          label={<span className="text-xs">Fechado - ganho</span>}
        />
        <Checkbox
          checked={stage.isClosedLost || false}
          onChange={(e) => {
            onUpdate(stage._id, { isClosedLost: e.target.checked, isClosedWon: false });
          }}
          label={<span className="text-xs">Fechado - perdido</span>}
        />
      </div>

      {/* Divider + Delete */}
      <div className="pt-2 border-t border-border">
        <button
          onClick={() => setShowDeleteConfirm(true)}
          className="w-full min-h-11 px-3 py-2 text-left text-sm text-semantic-error hover:bg-semantic-error/10 rounded-field transition-colors flex items-center gap-2"
        >
          <Trash2 size={14} />
          Excluir etapa
        </button>
      </div>
    </Popover>
    <ConfirmDialog
      open={showDeleteConfirm}
      onClose={() => setShowDeleteConfirm(false)}
      onConfirm={() => {
        onDelete(stage._id);
        onClose();
      }}
      title="Excluir etapa"
      description={`Tem certeza que deseja excluir a etapa "${stage.name}"? Leads vinculados precisarão ser movidos primeiro.`}
      confirmLabel="Excluir"
      variant="danger"
    />
    </>
  );
}
