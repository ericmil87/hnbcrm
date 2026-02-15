import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface WizardStepIndicatorProps {
  currentStep: number; // 0-4
  totalSteps: number; // 5
}

const STEP_LABELS = ["Perfil", "Pipeline", "Dados", "Equipe", "Pronto"];

export function WizardStepIndicator({
  currentStep,
  totalSteps,
}: WizardStepIndicatorProps) {
  return (
    <div className="w-full max-w-2xl mx-auto">
      <div className="flex items-center justify-between">
        {Array.from({ length: totalSteps }).map((_, index) => {
          const isCompleted = index < currentStep;
          const isCurrent = index === currentStep;
          const isFuture = index > currentStep;

          return (
            <div key={index} className="flex items-center flex-1 last:flex-none">
              {/* Step circle and label */}
              <div className="flex flex-col items-center gap-2">
                <div
                  className={cn(
                    "w-8 h-8 md:w-10 md:h-10 rounded-full flex items-center justify-center transition-all duration-200 text-sm md:text-base font-semibold",
                    isCompleted &&
                      "bg-brand-500 text-white shadow-md shadow-brand-500/20",
                    isCurrent &&
                      "bg-brand-500 text-white shadow-lg shadow-brand-500/30 ring-4 ring-brand-500/20",
                    isFuture &&
                      "bg-surface-overlay text-text-muted border border-border"
                  )}
                >
                  {isCompleted ? (
                    <Check size={16} className="md:w-5 md:h-5" />
                  ) : (
                    index + 1
                  )}
                </div>
                {/* Label - hidden on mobile, visible on desktop */}
                <span
                  className={cn(
                    "hidden md:block text-xs font-medium transition-colors duration-200",
                    (isCompleted || isCurrent) && "text-text-primary",
                    isFuture && "text-text-muted"
                  )}
                >
                  {STEP_LABELS[index]}
                </span>
              </div>

              {/* Connecting line */}
              {index < totalSteps - 1 && (
                <div className="flex-1 h-0.5 mx-2 md:mx-3">
                  <div
                    className={cn(
                      "h-full transition-all duration-300",
                      index < currentStep ? "bg-brand-500" : "bg-border"
                    )}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
