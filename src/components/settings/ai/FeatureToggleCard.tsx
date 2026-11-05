import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/utils";

export interface FeatureToggleCardProps {
  icon?: LucideIcon;
  title: string;
  description: string;
  /** Custo em uma linha, ex.: "Cerca de US$ 0,0003 por imagem". */
  costLabel?: string;
  /** `false` trava o interruptor e mostra `unavailableReason`. */
  available?: boolean;
  unavailableReason?: string;
  checked?: boolean;
  /** Sem `onChange` o cartão não tem interruptor próprio (o detalhe decide). */
  onChange?: (next: boolean) => void;
  /** Interruptor travado por falta de permissão ou durante o salvamento. */
  disabled?: boolean;
  /** Aviso destacado (risco, custo). */
  warning?: string;
  /** Slot de detalhe (listas, links, ajustes). */
  children?: ReactNode;
  className?: string;
}

/** Cartão de um recurso da IA: ícone, título, descrição, interruptor e detalhe. */
export function FeatureToggleCard({
  icon: Icon,
  title,
  description,
  costLabel,
  available = true,
  unavailableReason,
  checked = false,
  onChange,
  disabled,
  warning,
  children,
  className,
}: FeatureToggleCardProps) {
  return (
    <section className={cn("rounded-card border border-border bg-surface-raised p-4 md:p-5", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {Icon && <Icon size={20} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
            <p className="mt-0.5 text-xs text-text-muted">{description}</p>
            {costLabel && <p className="mt-1 text-xs text-text-secondary">{costLabel}</p>}
            {!available && unavailableReason && <p className="mt-1 text-xs text-text-muted">{unavailableReason}</p>}
          </div>
        </div>
        {onChange && (
          <Switch
            checked={checked}
            onCheckedChange={onChange}
            label={title}
            hideLabel
            disabled={disabled || !available}
          />
        )}
      </div>
      {warning && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-semantic-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          {warning}
        </p>
      )}
      {children && <div className="mt-3 space-y-3">{children}</div>}
    </section>
  );
}
