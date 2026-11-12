import { cn } from "@/lib/utils";

export interface TypingDotsProps {
  /** Texto para leitor de tela. Padrão: "digitando…". */
  label?: string;
  /** Desenha os pontos dentro de uma bolha. Padrão: `true`. */
  bubble?: boolean;
  /** Quem está digitando: `in` (padrão) = bolha recebida, à esquerda; `ai` = bolha da IA, à direita. */
  variant?: "in" | "ai";
  className?: string;
}

// Atrasos fixos (classes estáticas, nada montado em runtime).
const DOT_DELAYS = ["[animation-delay:0ms]", "[animation-delay:160ms]", "[animation-delay:320ms]"] as const;

/** Três pontos de "digitando…". Em movimento reduzido ficam parados. */
export function TypingDots({ label = "digitando…", bubble = true, variant = "in", className }: TypingDotsProps) {
  const ai = variant === "ai";
  const dots = (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {DOT_DELAYS.map((delay) => (
        <span
          key={delay}
          className={cn("size-1.5 rounded-full bg-current opacity-60 motion-safe:animate-typing-dot", delay)}
        />
      ))}
    </span>
  );

  return (
    <div className={cn("flex", bubble && (ai ? "justify-end pr-2" : "justify-start pl-2"), className)}>
      <span
        className={cn(
          "inline-flex items-center",
          ai && bubble ? "text-bubble-out-fg" : "text-text-muted",
          bubble && "rounded-lg px-3 py-2.5 shadow-bubble",
          bubble && (ai ? "bubble-tail-end bg-bubble-ai" : "bubble-tail-start bg-bubble-in")
        )}
      >
        {dots}
        <span className="sr-only">{label}</span>
      </span>
    </div>
  );
}
