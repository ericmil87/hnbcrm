import { cn } from "@/lib/utils";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";

export type CentralDashboard = NonNullable<FunctionReturnType<typeof api.centralAnalytics.getCentralDashboard>>;

interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ElementType;
  emphasis?: boolean;
}

/** Número grande + rótulo curto + contexto em uma linha. */
export function KpiCard({ label, value, hint, icon: Icon, emphasis }: KpiCardProps) {
  return (
    <div
      className={cn(
        "rounded-card border bg-surface-raised p-3 md:p-4 min-w-0",
        emphasis ? "border-brand-500/40" : "border-border"
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
        {Icon && <Icon size={14} className={cn("shrink-0", emphasis && "text-brand-500")} aria-hidden="true" />}
        <span className="truncate">{label}</span>
      </div>
      <p
        className={cn(
          "mt-1 text-xl md:text-2xl font-bold tabular-nums truncate",
          emphasis ? "text-brand-500" : "text-text-primary"
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-text-muted line-clamp-2">{hint}</p>}
    </div>
  );
}

export function SectionCard({
  title,
  subtitle,
  children,
  className,
  action,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <section className={cn("rounded-card border border-border bg-surface-raised p-4 md:p-5 min-w-0", className)}>
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-text-muted">{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
