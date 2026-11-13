import { createPortal } from "react-dom";
import { Paperclip } from "lucide-react";

interface FileDropOverlayProps {
  /** Coluna da conversa (precisa ser contexto de posicionamento). */
  container: HTMLElement | null;
  active: boolean;
}

/** Realce "Solte para anexar" sobre a coluna; não captura ponteiro (o drop segue no alvo). */
export function FileDropOverlay({ container, active }: FileDropOverlayProps) {
  if (!container || !active) return null;
  return createPortal(
    <div
      role="status"
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-surface-base/70 p-4"
    >
      <div className="flex flex-col items-center gap-2 rounded-card border-2 border-dashed border-brand-500 bg-brand-500/10 px-8 py-6 text-center">
        <Paperclip size={28} className="text-brand-500" aria-hidden />
        <p className="text-sm font-medium text-text-primary">Solte para anexar</p>
      </div>
    </div>,
    container
  );
}
