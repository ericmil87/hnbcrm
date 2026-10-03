import { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, className }: ModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  // Portal no <body>: aberto de dentro de um painel com stacking context próprio
  // (header do inbox, slide-over), o z-50 do modal valia só ALI DENTRO e a
  // folha inferior ficava atrás da tab bar do mobile (z-30) — o botão de
  // confirmar sumia (caso real: "Excluir lead" pela conversa, 03/10/2026).
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "relative z-10 w-full bg-surface-overlay border border-border",
          "max-h-[85vh] overflow-y-auto",
          // Mobile: bottom sheet (cobre a tab bar; respeita a safe-area)
          "rounded-t-xl animate-slide-in-up pb-safe sm:pb-0",
          // Desktop: centered dialog
          "sm:rounded-xl sm:max-w-lg sm:mx-4 sm:animate-fade-in-up",
          className
        )}
      >
        {title && (
          <div className="flex items-center justify-between px-4 py-3 md:px-6 md:py-4 border-b border-border">
            <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
            <button
              onClick={onClose}
              className="p-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
              aria-label="Fechar"
            >
              <X size={20} />
            </button>
          </div>
        )}
        <div className="p-4 md:p-6">{children}</div>
      </div>
    </div>,
    document.body
  );
}
