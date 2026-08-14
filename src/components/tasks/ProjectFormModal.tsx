import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Criação/edição de projeto de tarefas. Ao criar, o backend já provisiona as
// três colunas padrão (A fazer / Em andamento / Concluído).

export const PROJECT_COLORS = [
  "#FF6B00",
  "#EF4444",
  "#EAB308",
  "#22C55E",
  "#14B8A6",
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
  "#71717A",
] as const;

interface EditableProject {
  _id: Id<"taskProjects">;
  name: string;
  description?: string;
  color?: string;
}

interface ProjectFormModalProps {
  open: boolean;
  onClose: () => void;
  organizationId: Id<"organizations">;
  /** Ausente/nulo = criar um novo projeto. */
  project?: EditableProject | null;
  onCreated?: (projectId: Id<"taskProjects">) => void;
}

export function ProjectFormModal({
  open,
  onClose,
  organizationId,
  project,
  onCreated,
}: ProjectFormModalProps) {
  const createProject = useMutation(api.taskProjects.createProject);
  const updateProject = useMutation(api.taskProjects.updateProject);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>(PROJECT_COLORS[0]);
  const [saving, setSaving] = useState(false);

  const isEdit = !!project;

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setColor(project?.color ?? PROJECT_COLORS[0]);
    setSaving(false);
  }, [open, project]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Informe o nome do projeto");
      return;
    }

    setSaving(true);
    try {
      if (project) {
        await updateProject({
          projectId: project._id,
          name: trimmed,
          description: description.trim(),
          color,
        });
        toast.success("Projeto atualizado");
      } else {
        const projectId = await createProject({
          organizationId,
          name: trimmed,
          description: description.trim() || undefined,
          color,
        });
        toast.success("Projeto criado");
        onCreated?.(projectId);
      }
      onClose();
    } catch (error: any) {
      toast.error(error?.message || "Falha ao salvar projeto");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Editar projeto" : "Novo projeto"}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Nome"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Onboarding de clientes"
          maxLength={80}
          autoFocus
          required
        />

        <div className="w-full">
          <label
            htmlFor="project-description"
            className="block text-[13px] font-medium text-text-secondary mb-1.5"
          >
            Descrição
          </label>
          <textarea
            id="project-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Opcional — para que serve este projeto"
            className="w-full bg-surface-raised border border-border-strong rounded-field px-3 py-2 text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 resize-y"
            style={{ fontSize: "16px" }}
          />
        </div>

        <fieldset>
          <legend className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Cor
          </legend>
          <div className="flex flex-wrap gap-2">
            {PROJECT_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setColor(option)}
                aria-label={`Cor ${option}`}
                aria-pressed={color === option}
                className={cn(
                  "w-9 h-9 rounded-full transition-transform",
                  "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-overlay",
                  color === option
                    ? "ring-2 ring-brand-500 ring-offset-2 ring-offset-surface-overlay scale-110"
                    : "hover:scale-110"
                )}
                style={{ backgroundColor: option }}
              />
            ))}
          </div>
        </fieldset>

        <div className="flex gap-2 pt-2">
          <Button
            type="button"
            variant="secondary"
            size="md"
            className="flex-1"
            onClick={onClose}
            disabled={saving}
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            className="flex-1"
            disabled={saving}
          >
            {saving ? "Salvando..." : isEdit ? "Salvar" : "Criar projeto"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
