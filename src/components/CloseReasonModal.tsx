import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { toast } from "sonner";

interface CloseReasonModalProps {
  open: boolean;
  onClose: () => void;
  leadId: Id<"leads">;
  stageId: Id<"stages">;
  isWon: boolean;
  currentValue: number;
}

export function CloseReasonModal({
  open,
  onClose,
  leadId,
  stageId,
  isWon,
  currentValue,
}: CloseReasonModalProps) {
  const [reason, setReason] = useState("");
  const [finalValue, setFinalValue] = useState(currentValue);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const moveLeadToStage = useMutation(api.leads.moveLeadToStage);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate: lost requires a reason
    if (!isWon && !reason.trim()) {
      toast.error("Motivo é obrigatório para leads perdidos");
      return;
    }

    setIsSubmitting(true);

    try {
      await toast.promise(
        moveLeadToStage({
          leadId,
          stageId,
          closedReason: reason.trim() || undefined,
          finalValue,
        }),
        {
          loading: isWon ? "Fechando como ganho…" : "Fechando como perdido…",
          success: isWon ? "Lead fechado como ganho" : "Lead fechado como perdido",
          error: "Não foi possível fechar o lead.",
        }
      );

      onClose();
    } catch (error) {
      console.error("Failed to close lead:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setReason("");
    setFinalValue(currentValue);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleCancel}
      title={isWon ? "Fechando como Ganho" : "Fechando como Perdido"}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Motivo {!isWon && <span className="text-semantic-error">*</span>}
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              isWon
                ? "Motivo da vitória (opcional)"
                : "Motivo da perda (obrigatório)"
            }
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
            required={!isWon}
          />
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Valor Final
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary text-sm">
              R$
            </span>
            <input
              type="number"
              value={finalValue}
              onChange={(e) => setFinalValue(Number(e.target.value))}
              min={0}
              step={0.01}
              className="w-full pl-10 pr-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 tabular-nums"
              style={{ fontSize: "16px" }}
            />
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <Button
            type="button"
            onClick={handleCancel}
            variant="secondary"
            size="md"
            className="flex-1"
            disabled={isSubmitting}
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            variant={isWon ? "primary" : "danger"}
            size="md"
            className="flex-1"
            disabled={isSubmitting}
          >
            Confirmar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
