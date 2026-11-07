import { useEffect, useCallback, useRef } from "react";
import { lockBodyScroll } from "@/lib/scrollLock";
import { useKeyboardViewportBox } from "@/hooks/useKeyboardViewportBox";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import { X, ArrowLeft } from "lucide-react";

interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Optional icon rendered immediately before the title text. */
  titleIcon?: React.ReactNode;
  /** Optional extra actions rendered in the header, before the close button. */
  headerActions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /**
   * Overrides the body wrapper classes. Defaults to a vertical scroll
   * container. Pass e.g. "flex-1 min-h-0 flex flex-col overflow-hidden" to let
   * the content own its layout (fixed footer + inner scroll).
   */
  bodyClassName?: string;
}

export function SlideOver({
  open,
  onClose,
  title,
  titleIcon,
  headerActions,
  children,
  className,
  bodyClassName,
}: SlideOverProps) {
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

  return (
    <SlideOverLayer
      onClose={onClose}
      title={title}
      titleIcon={titleIcon}
      headerActions={headerActions}
      className={className}
      bodyClassName={bodyClassName}
    >
      {children}
    </SlideOverLayer>
  );
}

/**
 * Camada do SlideOver (montada só aberta). Abaixo de `md` é tela cheia. Abaixo
 * de `md` ou no toque, com o teclado aberto o painel segue a área visível (`useKeyboardViewportBox`), o
 * corpo rola por dentro e um rodapé fixo (composer do Copiloto, comentários)
 * fica logo acima do teclado.
 */
function SlideOverLayer({
  onClose,
  title,
  titleIcon,
  headerActions,
  children,
  className,
  bodyClassName,
}: Omit<SlideOverProps, "open">) {
  const isFullScreen = useMediaQuery("(max-width: 767px)");
  // Toque em tela larga (iPad, iPhone deitado): o painel lateral também encolhe com o teclado.
  const isTouch = useMediaQuery("(pointer: coarse)");
  const panelRef = useRef<HTMLDivElement>(null);
  const { style, keyboardOpen } = useKeyboardViewportBox(isFullScreen || isTouch, panelRef);
  return (
    <div className="fixed inset-0 z-50">
      {/* Overlay (desktop only) */}
      <div
        className="hidden md:block fixed inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={style}
        data-keyboard={keyboardOpen ? "open" : "closed"}
        className={cn(
          "fixed bg-surface-raised border-l border-border flex flex-col",
          // Mobile: full screen
          "inset-0 animate-fade-in",
          // Desktop: side panel
          "md:left-auto md:w-[480px] md:animate-slide-in-right",
          className
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 md:px-6 md:py-4 border-b border-border shrink-0">
          {/* Mobile: back arrow */}
          <button
            onClick={onClose}
            className="md:hidden p-1.5 -ml-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
            aria-label="Voltar"
          >
            <ArrowLeft size={20} />
          </button>

          {titleIcon}

          {title && (
            <h2 className="text-lg font-semibold text-text-primary flex-1">{title}</h2>
          )}

          {headerActions}

          {/* Desktop: close X */}
          <button
            onClick={onClose}
            className="hidden md:block p-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors ml-auto"
            aria-label="Fechar"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className={cn("flex-1 overflow-y-auto", bodyClassName)}>{children}</div>
      </div>
    </div>
  );
}
