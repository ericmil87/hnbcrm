import { cn } from "@/lib/utils";
import type { QuotedMeta } from "./types";

interface QuotedBlockProps {
  quoted: QuotedMeta;
  /** Contact display name, used when the quote isn't from us. */
  contactName?: string;
  /** Reads on outbound (colored) vs inbound (surface) bubbles. */
  variant: "inbound" | "outbound";
  /** When the original is on screen, clicking scrolls to it. */
  onJump?: () => void;
}

export function QuotedBlock({ quoted, contactName, variant, onJump }: QuotedBlockProps) {
  const outbound = variant === "outbound";
  const author = quoted.fromMe ? "Você" : contactName || "Contato";
  const rawPreview = quoted.preview?.trim() || "Mídia";
  const preview = rawPreview === "[mensagem não suportada]" ? "Mensagem de tipo não suportado" : rawPreview;

  const content = (
    <div
      className={cn(
        "flex flex-col gap-0.5 border-l-2 pl-2 py-1 rounded-r text-left",
        outbound ? "border-bubble-out-fg/70 bg-bubble-out-fg/10" : "border-brand-500",
        onJump && "cursor-pointer transition-colors",
        onJump && (outbound ? "hover:bg-bubble-out-fg/20" : "hover:bg-surface-sunken")
      )}
    >
      <span
        className={cn(
          "text-caption font-semibold",
          outbound ? "text-bubble-out-fg/90" : "text-bubble-in-link"
        )}
      >
        {author}
      </span>
      <span
        className={cn(
          "text-xs truncate max-w-[240px]",
          outbound ? "text-bubble-out-fg/80" : "text-text-secondary"
        )}
      >
        {preview}
      </span>
    </div>
  );

  if (!onJump) return content;

  return (
    <button type="button" onClick={onJump} className="block w-full" aria-label="Ir para a mensagem citada">
      {content}
    </button>
  );
}
