import type { CSSProperties, ReactNode } from "react";
import { Check, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export type BubbleVariant = "in" | "out" | "ai" | "system";
export type BubbleSide = "start" | "end";
export type BubbleTicks = "sent" | "delivered" | "read";

export interface BubbleProps {
  /** `in` = cliente/visitante, `out` = equipe, `ai` = Atendente ou Copiloto, `system` = aviso centralizado. */
  variant: BubbleVariant;
  children: ReactNode;
  /** Lado da conversa. Padrão: `in` à esquerda, `out`/`ai` à direita (como em Conversas). O Copiloto falando com o visitante usa `start`. */
  side?: BubbleSide;
  /** Nome de quem fala, na primeira linha da bolha ("Copiloto", "Atendente IA"). */
  label?: string;
  /** Hora já formatada ("23:14"). */
  time?: string;
  /** Tiques de entrega (só para `out`/`ai`). */
  ticks?: BubbleTicks;
  /** Cauda da primeira bolha de um bloco. Padrão: `true`. */
  tail?: boolean;
  /** Entrada com fade + subida (desligada em movimento reduzido). */
  enter?: boolean;
  /** Atraso da entrada, em ms (bolhas em sequência). */
  enterDelayMs?: number;
  className?: string;
}

const VARIANT_CLASS: Record<Exclude<BubbleVariant, "system">, { bg: string; label: string; footer: string }> = {
  in: { bg: "bg-bubble-in text-text-primary", label: "text-text-secondary", footer: "text-text-muted" },
  out: { bg: "bg-bubble-out text-bubble-out-fg", label: "text-bubble-out-label", footer: "text-bubble-out-fg/75" },
  ai: { bg: "bg-bubble-ai text-bubble-out-fg", label: "text-bubble-ai-label", footer: "text-bubble-out-fg/75" },
};

const DEFAULT_SIDE: Record<Exclude<BubbleVariant, "system">, BubbleSide> = { in: "start", out: "end", ai: "end" };

const TICK_LABEL: Record<BubbleTicks, string> = { sent: "Enviada", delivered: "Entregue", read: "Lida" };

function enterStyle(enter: boolean | undefined, delay: number | undefined): CSSProperties | undefined {
  return enter && delay ? { animationDelay: `${delay}ms` } : undefined;
}

/**
 * Bolha de conversa estilo WhatsApp para cenas (landing e chat do onboarding).
 * Só apresentação: usa os tokens `bubble-*`, `.bubble-tail-*` e `shadow-bubble`.
 * Não é o `MessageBubble` de Conversas (sem ações, reações nem tipo `InboxMessage`).
 */
export function Bubble({
  variant,
  children,
  side,
  label,
  time,
  ticks,
  tail = true,
  enter,
  enterDelayMs,
  className,
}: BubbleProps) {
  if (variant === "system") {
    return (
      <div
        className={cn("flex justify-center", enter && "motion-safe:animate-scene-in", className)}
        style={enterStyle(enter, enterDelayMs)}
      >
        <p className="max-w-[90%] rounded-lg bg-bubble-system px-3 py-1 text-center text-caption text-bubble-system-fg shadow-bubble">
          {children}
        </p>
      </div>
    );
  }

  const v = VARIANT_CLASS[variant];
  const resolvedSide = side ?? DEFAULT_SIDE[variant];
  const showTicks = ticks && variant !== "in";

  return (
    <div
      className={cn(
        "flex",
        resolvedSide === "start" ? "justify-start" : "justify-end",
        // Calha da cauda sempre presente: bolhas seguidas (sem cauda) ficam alinhadas à primeira.
        resolvedSide === "start" ? "pl-2" : "pr-2",
        enter && "motion-safe:animate-scene-in",
        className
      )}
      style={enterStyle(enter, enterDelayMs)}
    >
      <div
        className={cn(
          "min-w-0 max-w-[85%] rounded-lg px-2.5 pb-1 pt-1.5 text-sm leading-snug shadow-bubble",
          v.bg,
          tail && (resolvedSide === "start" ? "bubble-tail-start" : "bubble-tail-end")
        )}
      >
        {label && <p className={cn("mb-0.5 text-caption font-semibold", v.label)}>{label}</p>}
        <div className="break-words">{children}</div>
        {(time || showTicks) && (
          <p className={cn("mt-0.5 flex items-center justify-end gap-1 text-micro tabular-nums", v.footer)}>
            {time && <span>{time}</span>}
            {showTicks &&
              (ticks === "sent" ? (
                <Check className="size-3.5 shrink-0" aria-label={TICK_LABEL.sent} />
              ) : (
                <CheckCheck
                  className={cn("size-3.5 shrink-0", ticks === "read" && "text-tick-read")}
                  aria-label={TICK_LABEL[ticks]}
                />
              ))}
          </p>
        )}
      </div>
    </div>
  );
}
