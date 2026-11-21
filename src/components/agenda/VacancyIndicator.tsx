import { cn } from "@/lib/utils";
import { vacancyOf } from "@/lib/agendaStatus";

interface VacancyIndicatorProps {
  used: number;
  capacity: number;
  className?: string;
}

/** Vagas de um recurso num horário ("1/2"). Cheio fica em aviso; capacidade 1 mostra "0/1" ou "1/1". */
export function VacancyIndicator({ used, capacity, className }: VacancyIndicatorProps) {
  const v = vacancyOf(used, capacity);
  return (
    <span
      role="img"
      aria-label={v.a11y}
      title={v.a11y}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
        v.over
          ? "bg-semantic-error/10 text-semantic-error"
          : v.full
            ? "bg-semantic-warning/10 text-semantic-warning"
            : "bg-surface-overlay text-text-secondary",
        className
      )}
    >
      {v.label}
    </span>
  );
}
