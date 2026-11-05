import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StepperStep {
  id: string;
  label: string;
}

export interface StepperProps {
  steps: StepperStep[];
  /** `id` do passo atual. */
  current: string;
  /** Ids dos passos concluídos; só estes aceitam clique. */
  completed?: string[];
  orientation?: "horizontal" | "vertical";
  onStepClick?: (id: string) => void;
  ariaLabel?: string;
  className?: string;
}

/** Indicador de etapas. No mobile (horizontal) resume em "Passo 2 de 5 · Nome". */
export function Stepper({
  steps,
  current,
  completed = [],
  orientation = "horizontal",
  onStepClick,
  ariaLabel = "Etapas",
  className,
}: StepperProps) {
  const vertical = orientation === "vertical";
  const currentIndex = Math.max(0, steps.findIndex((s) => s.id === current));

  return (
    <div className={className}>
      {!vertical && (
        <p className="text-sm font-medium text-text-primary sm:hidden mb-2" data-testid="stepper-summary">
          Passo {currentIndex + 1} de {steps.length} · {steps[currentIndex]?.label}
        </p>
      )}
      <ol aria-label={ariaLabel} className={cn("flex gap-1.5", vertical ? "flex-col" : "items-center")}>
        {steps.map((step, index) => {
          const done = completed.includes(step.id);
          const active = step.id === current;
          const clickable = done && !!onStepClick;
          const marker = (
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-micro font-semibold",
                done && "bg-brand-500/20 text-brand-400",
                active && "bg-brand-600 text-white",
                !done && !active && "border border-border bg-surface-overlay text-text-muted"
              )}
            >
              {done ? <Check size={12} aria-hidden="true" /> : index + 1}
            </span>
          );
          const label = (
            <span
              className={cn(
                "text-caption",
                !vertical && "hidden sm:block",
                active ? "font-medium text-text-primary" : "text-text-muted"
              )}
            >
              {step.label}
            </span>
          );
          return (
            <li
              key={step.id}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5",
                !vertical && "flex-1 last:flex-none",
                vertical && "flex-wrap"
              )}
            >
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onStepClick(step.id)}
                  className="flex items-center gap-1.5 rounded-full coarse:min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
                >
                  {marker}
                  {label}
                </button>
              ) : (
                <>
                  {marker}
                  {label}
                </>
              )}
              {!vertical && index < steps.length - 1 && (
                <span aria-hidden="true" className={cn("h-px flex-1", done ? "bg-brand-500/50" : "bg-border")} />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
