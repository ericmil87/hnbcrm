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

/** Citação dentro da bolha, como no WhatsApp: caixa arredondada, barra colorida, autor em destaque, 2 linhas. */
export function QuotedBlock({ quoted, contactName, variant, onJump }: QuotedBlockProps) {
  const outbound = variant === "outbound";
  const author = quoted.fromMe ? "Você" : contactName || "Contato";
  const rawPreview = quoted.preview?.trim() || "Mídia";
  const preview = rawPreview === "[mensagem não suportada]" ? "Mensagem de tipo não suportado" : rawPreview;

  const content = (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col gap-0.5 rounded-md border-l-4 py-1 pl-2 pr-2.5 text-left",
        outbound
          ? "border-bubble-out-label bg-bubble-out-fg/10"
          : "border-bubble-in-link bg-text-primary/5",
        onJump && "cursor-pointer transition-colors",
        onJump && (outbound ? "hover:bg-bubble-out-fg/15" : "hover:bg-text-primary/10")
      )}
    >
      <span
        className={`truncate font-semibold text-caption ${outbound ? "text-bubble-out-label" : "text-bubble-in-link"}`}
      >
        {author}
      </span>
      <span
        className={`line-clamp-2 break-words text-caption ${outbound ? "text-bubble-out-fg/85" : "text-text-secondary"}`}
      >
        {preview}
      </span>
    </div>
  );

  if (!onJump) return content;

  return (
    <button
      type="button"
      onClick={onJump}
      className="block w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      aria-label={`Ir para a mensagem citada de ${author}`}
    >
      {content}
    </button>
  );
}
