import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";

// Quick Add Form Component
export function QuickAddLead({
  stageId,
  boardId,
  organizationId,
  onClose,
}: {
  stageId: Id<"stages">;
  boardId: Id<"boards">;
  organizationId: Id<"organizations">;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [value, setValue] = useState(0);
  const createLead = useMutation(api.leads.createLead);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    try {
      await toast.promise(
        createLead({
          organizationId,
          boardId,
          stageId,
          title: title.trim(),
          value,
          priority: "medium",
          temperature: "cold",
        }),
        {
          loading: "Criando lead…",
          success: "Lead criado",
          error: "Não foi possível criar o lead.",
        }
      );
      onClose();
    } catch (error) {
      console.error("Failed to create lead:", error);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-surface-raised p-3 rounded-card border border-border mb-3">
      <div className="space-y-2">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Título do lead…"
          className="w-full px-3 py-2 bg-surface-sunken border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted text-sm"
          style={{ fontSize: "16px" }}
          autoFocus
        />
        <input
          type="number"
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          placeholder="Valor (R$)"
          min={0}
          className="w-full px-3 py-2 bg-surface-sunken border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted text-sm"
          style={{ fontSize: "16px" }}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" className="flex-1">
            Criar
          </Button>
          <Button type="button" onClick={onClose} variant="secondary" size="sm">
            <X size={16} />
          </Button>
        </div>
      </div>
    </form>
  );
}
