import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { FlaskConical } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";

interface ExperimentSetupModalProps {
  open: boolean;
  onClose: () => void;
  formId: Id<"forms">;
  organizationId: Id<"organizations">;
  onCreated: (experimentId: Id<"formExperiments">) => void;
}

export function ExperimentSetupModal({
  open,
  onClose,
  formId,
  organizationId,
  onCreated,
}: ExperimentSetupModalProps) {
  const [name, setName] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const createExperiment = useMutation(api.formExperiments.createExperiment);

  function handleClose() {
    if (isCreating) return;
    setName("");
    setHypothesis("");
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) return;

    setIsCreating(true);

    const promise = createExperiment({
      organizationId,
      formId,
      name: trimmedName,
      hypothesis: hypothesis.trim() || undefined,
    });

    toast.promise(promise, {
      loading: "Criando experimento...",
      success: "Experimento criado com sucesso!",
      error: (err: unknown) => {
        const message = err instanceof Error ? err.message : "Erro ao criar experimento";
        return message;
      },
    });

    try {
      const experimentId = await promise;
      setName("");
      setHypothesis("");
      onCreated(experimentId);
    } catch {
      // Error already displayed by toast.promise
    } finally {
      setIsCreating(false);
    }
  }

  const isNameValid = name.trim().length > 0;

  return (
    <Modal open={open} onClose={handleClose} title="Criar Teste A/B">
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        {/* Name field */}
        <Input
          label="Nome do experimento"
          placeholder="Ex: Botão verde vs laranja"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          required
          disabled={isCreating}
        />

        {/* Hypothesis textarea */}
        <div className="w-full">
          <label
            htmlFor="hypothesis"
            className="block text-[13px] font-medium text-text-secondary mb-1.5"
          >
            Hipótese
            <span className="ml-1.5 text-text-muted font-normal">(opcional)</span>
          </label>
          <textarea
            id="hypothesis"
            placeholder="O que você espera que mude?"
            value={hypothesis}
            onChange={(e) => setHypothesis(e.target.value)}
            disabled={isCreating}
            rows={3}
            className={cn(
              "w-full bg-surface-raised border border-border-strong rounded-lg",
              "px-3.5 py-2.5 text-base md:text-sm text-text-primary",
              "placeholder:text-text-muted resize-none",
              "transition-colors duration-150",
              "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          />
        </div>

        {/* Info card */}
        <div
          className={cn(
            "flex gap-3 items-start",
            "bg-surface-overlay border border-border rounded-card p-3"
          )}
        >
          <FlaskConical
            size={16}
            className="text-text-muted shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <p className="text-xs text-text-muted leading-relaxed">
            Uma cópia do formulário será criada como Variante B. Edite-a separadamente.
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3 pt-1">
          <Button
            type="button"
            variant="secondary"
            onClick={handleClose}
            disabled={isCreating}
            className="w-full sm:w-auto"
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!isNameValid || isCreating}
            className="w-full sm:w-auto"
          >
            {isCreating ? "Criando..." : "Criar Experimento"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
