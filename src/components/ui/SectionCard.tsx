import { useId } from "react";
import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SectionCardProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Elemento raiz (padrão `section`). */
  as?: ElementType;
  className?: string;
}

/** Bloco de conteúdo com título `h2`, descrição e ações; `aria-labelledby` aponta para o título. */
export function SectionCard({
  title,
  description,
  icon,
  actions,
  children,
  as: Root = "section",
  className,
}: SectionCardProps) {
  const titleId = useId();
  return (
    <Root aria-labelledby={titleId} className={cn("rounded-card border border-border bg-surface-raised p-4 md:p-5", className)}>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {icon && <span className="mt-0.5 shrink-0 text-brand-500">{icon}</span>}
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-text-primary">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-text-secondary">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
      </div>
      {children}
    </Root>
  );
}
