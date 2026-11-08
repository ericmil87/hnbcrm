import { useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { lockBodyScroll } from "@/lib/scrollLock";
import { useKeyboardViewportBox } from "@/hooks/useKeyboardViewportBox";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
    if (!open) return;
    document.addEventListener("keydown", handleKeyDown);
    const unlock = lockBodyScroll();
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      unlock();
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  // Portal no <body>: aberto de dentro de um painel com stacking context próprio
  // (header do inbox, slide-over), o z-50 do modal valia só ALI DENTRO e a
  // folha inferior ficava atrás da tab bar do mobile (z-30) — o botão de
  // confirmar sumia (caso real: "Excluir lead" pela conversa, 03/10/2026).
  return createPortal(
    <ModalLayer onClose={onClose} title={title} className={className}>
      {children}
    </ModalLayer>,
    document.body
  );
}

/**
 * Camada do Modal (montada só aberta). Abaixo de `sm` é folha inferior; abaixo
 * de `sm` ou no toque, com o teclado aberto o container segue a área visível
 * (`useKeyboardViewportBox`) e a folha/diálogo cabe nela com rolagem interna
 * (campo e botões acima do teclado).
 */
function ModalLayer({ onClose, title, children, className }: Omit<ModalProps, "open">) {
  const isSheet = useMediaQuery("(max-width: 639px)");
  // Toque em tela larga (iPhone deitado, iPad): o teclado cobre o diálogo centralizado também.
  const isTouch = useMediaQuery("(pointer: coarse)");
  const dialogRef = useRef<HTMLDivElement>(null);
  // Focus: into the dialog on open (unless a child already took it, e.g. autoFocus), back to the trigger on close.
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
    return () => {
      if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  // Tab stays inside the dialog (events bubbling from portals outside it are ignored).
  const trapTab = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current;
    if (e.key !== "Tab" || !dialog || !(e.target instanceof Node) || !dialog.contains(e.target)) return;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const { style, keyboardOpen } = useKeyboardViewportBox(isSheet || isTouch, dialogRef);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
      style={style}
      data-keyboard={keyboardOpen ? "open" : "closed"}
    >
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={trapTab}
        className={cn(
          "outline-none",
          "relative z-10 w-full bg-surface-overlay border border-border",
          "max-h-[85vh] overflow-y-auto overscroll-contain",
          // Mobile: bottom sheet (cobre a tab bar; respeita a safe-area)
          "rounded-t-xl animate-slide-in-up sm:pb-0",
          // Teclado aberto: a safe-area de baixo fica atrás dele.
          keyboardOpen ? "pb-0" : "pb-safe",
          // Desktop: centered dialog
          "sm:rounded-xl sm:max-w-lg sm:mx-4 sm:animate-fade-in-up",
          className,
          // Teclado aberto (folha no celular): no máximo a área visível, mesmo
          // com um `max-h` vindo do chamador.
          keyboardOpen && "max-h-full"
        )}
      >
        {title && (
          <div className="flex items-center justify-between px-4 py-3 md:px-6 md:py-4 border-b border-border">
            <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
            <button
              onClick={onClose}
              className="inline-flex items-center justify-center p-1.5 coarse:min-h-11 coarse:min-w-11 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
              aria-label="Fechar"
            >
              <X size={20} />
            </button>
          </div>
        )}
        <div className="p-4 md:p-6">{children}</div>
      </div>
    </div>
  );
}
