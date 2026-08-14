import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { Check, Plus, Tag, X } from "lucide-react";

// Paleta fixa para novas etiquetas de tarefa (independente da paleta de
// etiquetas de conversa em ConversationActionsMenu.tsx).
const LABEL_COLOR_PALETTE = [
  "#EF4444",
  "#F59E0B",
  "#EAB308",
  "#22C55E",
  "#10B981",
  "#14B8A6",
  "#3B82F6",
  "#6366F1",
  "#8B5CF6",
  "#EC4899",
] as const;

interface LabelPickerProps {
  organizationId: Id<"organizations">;
  selectedIds: Id<"taskLabels">[];
  onChange: (ids: Id<"taskLabels">[]) => void;
  className?: string;
}

export function LabelPicker({ organizationId, selectedIds, onChange, className }: LabelPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>(LABEL_COLOR_PALETTE[0]);
  const rootRef = useRef<HTMLDivElement>(null);

  const labels = useQuery(api.taskLabels.getLabels, { organizationId });
  const createLabel = useMutation(api.taskLabels.createLabel);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
    };
  }, [open]);

  // Esc fecha só este popover. Precisa ser um handler React (não um listener
  // em `document`) e chamar stopPropagation ANTES de o evento nativo
  // borbulhar até o `document`, senão o Escape também dispara o handler do
  // Modal/SlideOver por trás e fecha tudo junto.
  const handlePopoverKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (creating) {
        setCreating(false);
      } else {
        setOpen(false);
      }
    }
  };

  const selectedSet = new Set(selectedIds);
  const allLabels = labels ?? [];
  const selectedLabels = allLabels.filter((l) => selectedSet.has(l._id));
  const filtered = allLabels.filter((l) =>
    l.name.toLowerCase().includes(search.trim().toLowerCase())
  );

  const toggle = (id: Id<"taskLabels">) => {
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const labelId = await createLabel({ organizationId, name, color: newColor });
      onChange([...selectedIds, labelId]);
      setNewName("");
      setCreating(false);
      toast.success("Etiqueta criada");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao criar etiqueta");
    }
  };

  return (
    <div className={cn("relative", className)} ref={rootRef}>
      <div className="flex flex-wrap items-center gap-1.5">
        {selectedLabels.map((label) => (
          <span
            key={label._id}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium min-h-[24px]"
            style={{ backgroundColor: `${label.color}22`, color: label.color }}
          >
            <Tag size={10} />
            {label.name}
            <button
              type="button"
              onClick={() => toggle(label._id)}
              aria-label={`Remover etiqueta ${label.name}`}
              className="p-0.5 rounded-full hover:bg-black/10 transition-colors"
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-surface-raised border border-border-strong text-text-secondary hover:border-brand-500 hover:text-text-primary transition-colors min-h-[28px]"
          aria-label="Adicionar etiqueta"
          aria-expanded={open}
        >
          <Plus size={12} />
          Etiqueta
        </button>
      </div>

      {open && (
        <div
          className="absolute z-50 mt-2 w-64 max-w-[85vw] bg-surface-overlay border border-border rounded-xl shadow-elevated p-2"
          onKeyDown={handlePopoverKeyDown}
        >
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar etiqueta..."
            className="w-full px-2.5 py-1.5 mb-2 bg-surface-raised border border-border-strong rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500"
            style={{ fontSize: "16px" }}
            autoFocus
          />

          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {allLabels.length === 0 && labels !== undefined && (
              <p className="px-2 py-2 text-xs text-text-muted">
                Nenhuma etiqueta ainda. Crie a primeira abaixo.
              </p>
            )}
            {filtered.length === 0 && allLabels.length > 0 && (
              <p className="px-2 py-2 text-xs text-text-muted">Nenhuma etiqueta encontrada.</p>
            )}
            {filtered.map((label) => (
              <button
                key={label._id}
                type="button"
                onClick={() => toggle(label._id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-raised text-sm text-text-primary transition-colors"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: label.color }}
                  aria-hidden="true"
                />
                <span className="flex-1 text-left truncate">{label.name}</span>
                {selectedSet.has(label._id) && (
                  <Check size={14} className="text-brand-500 shrink-0" />
                )}
              </button>
            ))}
          </div>

          <div className="border-t border-border mt-2 pt-2">
            {creating ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreate();
                    }
                  }}
                  placeholder="Nome da etiqueta"
                  className="w-full px-2.5 py-1.5 bg-surface-raised border border-border-strong rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500"
                  style={{ fontSize: "16px" }}
                  autoFocus
                />
                <div className="flex flex-wrap gap-1.5">
                  {LABEL_COLOR_PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setNewColor(color)}
                      className={cn(
                        "w-6 h-6 rounded-full transition-transform",
                        newColor === color &&
                          "ring-2 ring-offset-2 ring-offset-surface-overlay ring-brand-500 scale-110"
                      )}
                      style={{ backgroundColor: color }}
                      aria-label={`Cor ${color}`}
                      aria-pressed={newColor === color}
                    />
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    onClick={handleCreate}
                    disabled={!newName.trim()}
                    className="flex-1"
                  >
                    Criar
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setCreating(false);
                      setNewName("");
                    }}
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-raised text-sm text-brand-400 font-medium transition-colors"
              >
                <Plus size={14} />
                Nova etiqueta
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
