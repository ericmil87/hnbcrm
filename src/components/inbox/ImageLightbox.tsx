import { useEffect, useCallback } from "react";
import { X, Download } from "lucide-react";

interface ImageLightboxProps {
  open: boolean;
  onClose: () => void;
  src: string;
  alt: string;
  /** Filename used for the download attribute. */
  downloadName?: string;
}

export function ImageLightbox({ open, onClose, src, alt, downloadName }: ImageLightboxProps) {
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

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <div className="absolute top-3 right-3 flex items-center gap-2">
        <a
          href={src}
          download={downloadName}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center justify-center h-11 w-11 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          aria-label="Baixar imagem"
        >
          <Download size={20} />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center h-11 w-11 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          aria-label="Fechar"
        >
          <X size={22} />
        </button>
      </div>

      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[92vw] max-h-[88vh] object-contain rounded-lg select-none"
      />
    </div>
  );
}
