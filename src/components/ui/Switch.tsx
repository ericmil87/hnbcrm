import { useId } from "react";
import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Nome acessível; visível ao lado do controle, a menos que `hideLabel`. */
  label: string;
  /** Mantém o rótulo só para leitores de tela (o texto visível fica fora do componente). */
  hideLabel?: boolean;
  description?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  id?: string;
  /** Aplicada ao elemento raiz (o botão, ou o contêiner quando há rótulo visível). */
  className?: string;
}

const TRACK = {
  // O pseudo-elemento amplia a área de toque para >= 44 px sem mexer no layout.
  // O estado desligado usa ring inset (não borda), que não encolhe a área de toque.
  sm: { track: "h-5 w-9 before:-inset-x-1.5 before:-inset-y-3", thumb: "h-4 w-4", on: "translate-x-4" },
  md: { track: "h-6 w-11 before:-inset-x-0.5 before:-inset-y-2.5", thumb: "h-5 w-5", on: "translate-x-5" },
} as const;

/** Interruptor ligar/desligar (`role="switch"`). */
export function Switch({
  checked,
  onCheckedChange,
  label,
  hideLabel,
  description,
  disabled,
  size = "md",
  id,
  className,
}: SwitchProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  const descId = description && !hideLabel ? `${switchId}-desc` : undefined;
  const s = TRACK[size];

  const control = (
    <button
      type="button"
      role="switch"
      id={switchId}
      aria-checked={checked}
      aria-label={hideLabel ? label : undefined}
      aria-describedby={descId}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 rounded-full motion-safe:transition-colors motion-safe:duration-200",
        "before:absolute before:content-['']",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
        s.track,
        checked ? "bg-brand-600" : "bg-surface-overlay ring-1 ring-inset ring-border-strong focus-visible:ring-brand-500",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        hideLabel && className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-0.5 top-1/2 -translate-y-1/2 rounded-full bg-white shadow-sm motion-safe:transition-transform motion-safe:duration-200",
          s.thumb,
          checked && s.on,
          !checked && "translate-x-0"
        )}
      />
    </button>
  );

  if (hideLabel) return control;

  return (
    <div className={cn("flex items-start gap-3", className)}>
      {control}
      <div className="min-w-0">
        <label
          htmlFor={switchId}
          className={cn(
            "block text-sm font-medium text-text-primary",
            disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
          )}
        >
          {label}
        </label>
        {description && (
          <p id={descId} className="mt-0.5 text-xs text-text-muted">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
