import { Mic, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { Bubble, type BubbleSide, type BubbleTicks } from "./Bubble";

export interface AudioBubbleProps {
  variant: "in" | "out" | "ai";
  /** Duração já formatada ("0:14"). */
  duration: string;
  side?: BubbleSide;
  label?: string;
  time?: string;
  ticks?: BubbleTicks;
  tail?: boolean;
  /** Transcrição mostrada sob a onda (a IA entendeu o áudio). */
  transcript?: string;
  /** Rótulo da transcrição. Padrão: "Transcrição". */
  transcriptLabel?: string;
  enter?: boolean;
  enterDelayMs?: number;
  className?: string;
}

// Forma de onda estática: alturas fixas, classes literais.
const BARS = [
  "h-2", "h-3", "h-5", "h-4", "h-6", "h-3", "h-5", "h-7", "h-4", "h-3",
  "h-6", "h-5", "h-2", "h-4", "h-6", "h-3", "h-5", "h-4", "h-2", "h-3",
] as const;

/**
 * Nota de voz ilustrativa: botão de play desenhado (não toca nada), forma de
 * onda parada e duração. Para leitor de tela vira "Mensagem de voz, 0:14".
 */
export function AudioBubble({
  variant,
  duration,
  transcript,
  transcriptLabel = "Transcrição",
  ...bubble
}: AudioBubbleProps) {
  const outbound = variant !== "in";
  return (
    <Bubble variant={variant} {...bubble}>
      <div className="flex min-w-[11rem] items-center gap-2 py-0.5">
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-full",
            outbound ? "bg-bubble-out-fg/10" : "bg-text-primary/5"
          )}
        >
          <Play className="size-4 translate-x-px" fill="currentColor" />
        </span>
        <span aria-hidden="true" className="flex h-7 flex-1 items-center gap-[2px]">
          {BARS.map((h, i) => (
            <span key={`bar:${i}`} className={cn("w-[3px] shrink-0 rounded-full bg-current opacity-60", h)} />
          ))}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-caption tabular-nums opacity-80">
          <Mic className="size-3.5" aria-hidden="true" />
          <span aria-hidden="true">{duration}</span>
          <span className="sr-only">Mensagem de voz, {duration}</span>
        </span>
      </div>
      {transcript && (
        <p className="mt-1 border-t border-text-muted/20 pt-1 text-caption">
          <span className="font-semibold">{transcriptLabel}: </span>
          <span className="italic">“{transcript}”</span>
        </p>
      )}
    </Bubble>
  );
}
