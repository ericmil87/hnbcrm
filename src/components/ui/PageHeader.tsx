import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PageHeaderBack = { to: string } | { onClick: () => void };

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  back?: PageHeaderBack;
  badge?: ReactNode;
  className?: string;
}

const backClass =
  "flex h-10 w-10 coarse:h-11 coarse:w-11 shrink-0 items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base";

/** Cabeçalho de página: o único `<h1>` da tela, com voltar, selo e ações (quebram para baixo no mobile). */
export function PageHeader({ title, subtitle, actions, back, badge, className }: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {back &&
          ("to" in back ? (
            <Link to={back.to} aria-label="Voltar" className={backClass}>
              <ArrowLeft size={20} aria-hidden="true" />
            </Link>
          ) : (
            <button type="button" onClick={back.onClick} aria-label="Voltar" className={backClass}>
              <ArrowLeft size={20} aria-hidden="true" />
            </button>
          ))}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl md:text-2xl font-bold text-text-primary">{title}</h1>
            {badge}
          </div>
          {subtitle && <p className="text-sm text-text-secondary">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
    </header>
  );
}
