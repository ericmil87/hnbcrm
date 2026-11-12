import type { ReactNode } from "react";
import { LifeBuoy } from "lucide-react";
import { useInView } from "@/hooks/useInView";
import { cn } from "@/lib/utils";

/**
 * Peças compartilhadas pelas cenas de S3 e S4 (microcenas curtas, não em loop).
 * As animações são as do kit (`enter` nas bolhas, CSS puro); aqui só se segura
 * o início até a cena entrar na tela (IntersectionObserver). Com movimento
 * reduzido o kit não anima nada (`motion-safe:`), então vale o estado final.
 */

/** Segura as animações filhas (pausadas em opacidade 0) até o bloco aparecer. Sem IntersectionObserver, roda direto. */
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const { ref, isInView } = useInView<HTMLDivElement>({ rootMargin: "0px 0px -10% 0px" });
  return (
    <div
      ref={ref}
      data-revealed={isInView ? "true" : "false"}
      className={cn(!isInView && "[&_*]:![animation-play-state:paused]", className)}
    >
      {children}
    </div>
  );
}

/** Moldura de uma microcena: papel de parede de conversa, bolhas empilhadas. */
export function SceneBox({
  label,
  children,
  className,
}: {
  /** Nome acessível da cena. */
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      {...(label ? { role: "group", "aria-label": label } : {})}
      className={cn("chat-wallpaper flex flex-col gap-1.5 rounded-card border border-border-subtle p-3", className)}
    >
      {children}
    </div>
  );
}

/** Aviso de pedido de ajuda (a IA passa para a equipe com o resumo pronto). */
export function HelpRequest({
  title,
  body,
  enter,
  enterDelayMs,
}: {
  title: string;
  body?: string;
  enter?: boolean;
  enterDelayMs?: number;
}) {
  return (
    <div
      className={cn(
        "rounded-card border border-border bg-surface-raised p-3 shadow-card",
        enter && "motion-safe:animate-scene-in"
      )}
      style={enter && enterDelayMs ? { animationDelay: `${enterDelayMs}ms` } : undefined}
    >
      <p className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-semantic-warning">
        <LifeBuoy className="size-3.5" aria-hidden="true" />
        Pedido de ajuda
      </p>
      <p className="mt-1 text-sm font-semibold text-text-primary">{title}</p>
      {body && <p className="text-sm text-text-secondary">{body}</p>}
    </div>
  );
}

/** Pequeno selo de rótulo dentro de uma cena ("Aprovar", "Sai em inglês"). Desenho, não botão. */
export function SceneTag({ children }: { children: ReactNode }) {
  return (
    <span className="mt-1 inline-flex rounded-full bg-bubble-out-fg/10 px-2 py-0.5 text-caption font-semibold">
      {children}
    </span>
  );
}
