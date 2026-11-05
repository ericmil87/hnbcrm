import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Stage } from "./types";

// Stage Edit Popover Component
export function StageEditPopover({
  stage,
  anchor,
  onClose,
  onUpdate,
  onDelete,
}: {
  stage: Stage;
  anchor: { top: number; left: number };
  onClose: () => void;
  onUpdate: (stageId: Id<"stages">, updates: Record<string, unknown>) => void;
  onDelete: (stageId: Id<"stages">) => void;
}) {
  const [name, setName] = useState(stage.name);
  const [selectedColor, setSelectedColor] = useState(stage.color);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

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

  // Clamp to viewport so popover never overflows off-screen
  const popoverWidth = 288; // w-72
  const popoverHeight = 420; // approximate
  const top = Math.min(anchor.top, window.innerHeight - popoverHeight - 8);
  const left = Math.min(anchor.left, window.innerWidth - popoverWidth - 8);

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
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed w-72 bg-surface-overlay border border-border rounded-card shadow-elevated z-50 p-4 space-y-4"
        style={{ top, left }}
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
          <div className="grid grid-cols-6 gap-2">
            {PRESET_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => handleColorSelect(color)}
                className={cn(
                  "w-8 h-8 rounded-lg transition-all",
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
              className="w-8 h-8 rounded cursor-pointer border border-border-strong"
              title="Cor personalizada"
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
            className="w-full px-3 py-2 text-left text-sm text-semantic-error hover:bg-semantic-error/10 rounded-field transition-colors flex items-center gap-2"
          >
            <Trash2 size={14} />
            Excluir etapa
          </button>
        </div>

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
      </div>
    </>
  );
}
