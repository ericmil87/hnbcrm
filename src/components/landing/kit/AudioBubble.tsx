import { Mic, Pause, Play } from "lucide-react";
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
  /** A nota está "tocando": a onda se mexe e o botão vira pausa (só desenho, não toca nada). */
  playing?: boolean;
  /** Rótulo da transcrição. Padrão: "Transcrição". */
  transcriptLabel?: string;
  enter?: boolean;
  enterDelayMs?: number;
  className?: string;
}

// Forma de onda: alturas fixas, classes literais.
const BARS = [
  "h-2", "h-3", "h-5", "h-4", "h-6", "h-3", "h-5", "h-7", "h-4", "h-3",
  "h-6", "h-5", "h-2", "h-4", "h-6", "h-3", "h-5", "h-4", "h-2", "h-3",
] as const;

// Atrasos literais para a onda "tocando" (as barras não sobem juntas).
const BAR_DELAYS = [
  "[animation-delay:0ms]", "[animation-delay:-150ms]", "[animation-delay:-300ms]", "[animation-delay:-450ms]",
  "[animation-delay:-600ms]", "[animation-delay:-750ms]",
] as const;

/**
 * Nota de voz ilustrativa: botão de play desenhado (não toca nada), forma de
 * onda (parada, ou ondulando com `playing`) e duração. Para leitor de tela vira "Mensagem de voz, 0:14".
 */
export function AudioBubble({
  variant,
  duration,
  transcript,
  playing = false,
  transcriptLabel = "Transcrição",
  ...bubble
}: AudioBubbleProps) {
  const outbound = variant !== "in";
  const Icon = playing ? Pause : Play;
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
          <Icon className={cn("size-4", !playing && "translate-x-px")} fill="currentColor" />
        </span>
        <span aria-hidden="true" data-playing={playing ? "true" : undefined} className="flex h-7 flex-1 items-center gap-[2px]">
          {BARS.map((h, i) => (
            <span
              key={`bar:${i}`}
              className={cn(
                "w-[3px] shrink-0 rounded-full bg-current opacity-60",
                h,
                playing && "motion-safe:animate-wave-bar",
                playing && BAR_DELAYS[(i * 5) % BAR_DELAYS.length]
              )}
            />
          ))}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-caption tabular-nums opacity-80">
          <Mic className="size-3.5" aria-hidden="true" />
          <span aria-hidden="true">{duration}</span>
          <span className="sr-only">Mensagem de voz, {duration}</span>
        </span>
      </div>
      {transcript && (
        <p className={cn("mt-1 border-t border-text-muted/20 pt-1 text-caption", bubble.enter && "motion-safe:animate-fade-in")}>
          <span className="font-semibold">{transcriptLabel}: </span>
          <span className="italic">“{transcript}”</span>
        </p>
      )}
    </Bubble>
  );
}
