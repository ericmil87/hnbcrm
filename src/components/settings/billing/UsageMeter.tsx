import { formatCount } from "@/lib/format";
import { meterStateText, type MeterView } from "@/lib/billingPanel";
import type { MeterState } from "@/lib/usageProjection";
import { cn } from "@/lib/utils";

const BAR: Record<MeterState, string> = {
  ok: "bg-semantic-success",
  warn80: "bg-semantic-warning",
  limit100: "bg-semantic-error",
};

interface UsageMeterProps {
  meter: MeterView;
  /** Linhas extras abaixo da barra (crédito, excedente, estimativa). */
  children?: React.ReactNode;
  /** Limite de canais/grupos pode estar truncado no servidor. */
  approximate?: boolean;
}

/** Barra de uso com `role="meter"`; o estado também sai em texto (a cor não é o único sinal). */
export function UsageMeter({ meter, children, approximate }: UsageMeterProps) {
  const { label, used, limit, percent, state } = meter;
  const width = percent === null ? 0 : Math.min(100, percent);
  const numbers =
    limit === null
      ? `${formatCount(used)}${approximate ? "+" : ""} (sem limite)`
      : `${formatCount(used)}${approximate ? "+" : ""} de ${formatCount(limit)}`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="text-sm tabular-nums text-text-secondary">{numbers}</p>
      </div>
      {limit !== null && (
        <div
          role="meter"
          aria-label={`${label}: ${numbers}`}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(used, limit)}
          className="h-2 overflow-hidden rounded-full bg-surface-sunken"
        >
          <div className={cn("h-full rounded-full", BAR[state])} style={{ width: `${width}%` }} />
        </div>
      )}
      {limit !== null && (
        <p className="text-caption tabular-nums text-text-muted">
          {percent}% · {meterStateText(state)}
        </p>
      )}
      {children}
    </div>
  );
}
