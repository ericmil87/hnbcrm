import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { AlertTriangle } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "default";
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  variant = "default",
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        {description && (
          <div className="flex gap-3">
            {variant === "danger" && (
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-semantic-error/10 flex items-center justify-center">
                <AlertTriangle size={20} className="text-semantic-error" />
              </div>
            )}
            <p className="text-sm text-text-secondary leading-relaxed pt-2">
              {description}
            </p>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <Button
            variant="secondary"
            onClick={onClose}
            className="flex-1"
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "danger" ? "danger" : "primary"}
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className="flex-1"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
