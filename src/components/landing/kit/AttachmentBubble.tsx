import { FileText, Image as ImageIcon, Link2, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { Bubble, type BubbleSide, type BubbleTicks } from "./Bubble";

export type AttachmentKind = "pdf" | "image" | "link" | "file";

export interface AttachmentBubbleProps {
  variant: "in" | "out" | "ai";
  /** Nome do arquivo ou endereço ("cardapio.pdf", "instagram.com/minhaloja"). */
  name: string;
  /** Linha de apoio ("PDF · 2 páginas"). */
  meta?: string;
  /** Define o ícone. Padrão: `file`. */
  kind?: AttachmentKind;
  side?: BubbleSide;
  label?: string;
  time?: string;
  ticks?: BubbleTicks;
  tail?: boolean;
  enter?: boolean;
  enterDelayMs?: number;
  className?: string;
}

const ICONS = { pdf: FileText, image: ImageIcon, link: Link2, file: Paperclip } as const;

/** Anexo ilustrativo: ícone + nome (+ linha de apoio). Não abre nem baixa nada. */
export function AttachmentBubble({ variant, name, meta, kind = "file", ...bubble }: AttachmentBubbleProps) {
  const Icon = ICONS[kind];
  const outbound = variant !== "in";
  return (
    <Bubble variant={variant} {...bubble}>
      <div
        className={cn(
          "flex min-w-[11rem] items-center gap-2.5 rounded-md p-2",
          outbound ? "bg-bubble-out-fg/5" : "bg-text-primary/5"
        )}
      >
        <span
          aria-hidden="true"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-brand-600 text-white"
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium" title={name}>
            {name}
          </span>
          {meta && <span className="block text-caption opacity-80">{meta}</span>}
        </span>
      </div>
    </Bubble>
  );
}
