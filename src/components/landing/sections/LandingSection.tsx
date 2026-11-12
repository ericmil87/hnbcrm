import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface LandingSectionProps {
  /** Âncora (`LANDING_ANCHORS`); o título recebe `${id}-titulo`. */
  id: string;
  /** Rótulo pequeno acima do título. */
  eyebrow?: string;
  title: string;
  subtitle?: string;
  children?: ReactNode;
  /** Fundo alternado entre seções. */
  tone?: "base" | "raised";
  className?: string;
}

/**
 * Casca comum de uma seção da landing: `<section>` com âncora, `aria-labelledby`
 * e cabeçalho (rótulo, `<h2>` em `font-display`, subtítulo). `scroll-mt` compensa
 * o cabeçalho fixo ao seguir uma âncora.
 */
export function LandingSection({ id, eyebrow, title, subtitle, children, tone = "base", className }: LandingSectionProps) {
  const titleId = `${id}-titulo`;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={cn(
        "scroll-mt-28 px-4 py-14 md:scroll-mt-20 md:py-20",
        tone === "raised" ? "bg-surface-raised" : "bg-surface-base",
        className
      )}
    >
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl">
          {eyebrow && <p className="text-caption font-semibold uppercase tracking-wide text-brand-600">{eyebrow}</p>}
          <h2 id={titleId} className="mt-1 font-display text-2xl font-bold text-text-primary md:text-4xl">
            {title}
          </h2>
          {subtitle && <p className="mt-3 text-base text-text-secondary md:text-lg">{subtitle}</p>}
        </div>
        {children && <div className="mt-8">{children}</div>}
      </div>
    </section>
  );
}
