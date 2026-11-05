import { useState } from "react";
import { useMutation } from "convex/react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";

export interface ChecklistItem {
  id: string;
  title: string;
  completed: boolean;
}

interface TaskChecklistProps {
  taskId: Id<"tasks">;
  checklist: ChecklistItem[] | null | undefined;
}

/** Checklist da tarefa com barra de progresso e adição de itens. */
export function TaskChecklist({ taskId, checklist }: TaskChecklistProps) {
  const toggleItem = useMutation(api.tasks.toggleChecklistItem);
  const updateChecklist = useMutation(api.tasks.updateChecklist);
  const [newItem, setNewItem] = useState("");

  const items = checklist ?? [];
  const total = items.length;
  const done = items.filter((i) => i.completed).length;

  const handleToggle = async (itemId: string) => {
    try {
      await toggleItem({ taskId, itemId });
    } catch {
      toast.error("Não foi possível atualizar o item.");
    }
  };

  const handleAdd = async () => {
    const title = newItem.trim();
    if (!title) return;
    try {
      await updateChecklist({ taskId, checklist: [...items, { id: crypto.randomUUID(), title, completed: false }] });
      setNewItem("");
    } catch {
      toast.error("Não foi possível adicionar o item.");
    }
  };

  const handleRemove = async (itemId: string) => {
    try {
      await updateChecklist({ taskId, checklist: items.filter((i) => i.id !== itemId) });
    } catch {
      toast.error("Não foi possível remover o item.");
    }
  };

  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-text-primary">Checklist</h4>
        {total > 0 && (
          <span className="text-xs text-text-muted tabular-nums">
            {done}/{total}
          </span>
        )}
      </div>

      {total > 0 && (
        <div className="w-full bg-surface-sunken rounded-full h-1.5 mb-3">
          <div
            className="h-1.5 rounded-full bg-brand-500 transition-all duration-300"
            style={{ width: `${(done / total) * 100}%` }}
          />
        </div>
      )}

      {total > 0 && (
        <div className="space-y-1 mb-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-sunken transition-colors group"
            >
              <Checkbox checked={item.completed} onChange={() => void handleToggle(item.id)} containerClassName="shrink-0" />
              <span className={cn("flex-1 text-sm", item.completed ? "text-text-muted line-through" : "text-text-primary")}>
                {item.title}
              </span>
              <button
                type="button"
                onClick={() => void handleRemove(item.id)}
                className="flex min-h-6 min-w-6 coarse:min-h-11 coarse:min-w-11 items-center justify-center text-text-muted opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 hover:text-semantic-error transition-all"
                aria-label={`Remover o item ${item.title}`}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <div className="flex-1">
          <Input
            type="text"
            aria-label="Novo item do checklist"
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleAdd();
              }
            }}
            placeholder="Adicionar item…"
          />
        </div>
        <Button variant="ghost" size="md" iconOnly onClick={() => void handleAdd()} aria-label="Adicionar item ao checklist">
          <Plus size={16} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
