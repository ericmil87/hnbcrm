import { forwardRef } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Texto clicável à direita da caixa. */
  label?: React.ReactNode;
  /** Texto auxiliar opcional abaixo do label. */
  description?: React.ReactNode;
  /** Classe aplicada ao rótulo externo (wrapper clicável). */
  containerClassName?: string;
}

/**
 * Checkbox do design system HNBCRM. Usa um input nativo `sr-only` como peer
 * (acessível, foco por teclado) e desenha a caixa via CSS. Controlado por
 * `checked` + `onChange`, como um `<input type="checkbox">` comum.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  (
    { label, description, className, containerClassName, id, disabled, ...props },
    ref
  ) => {
    const inputId =
      id ??
      (typeof label === "string"
        ? `cb-${label.toLowerCase().replace(/\s+/g, "-")}`
        : undefined);

    return (
      <label
        htmlFor={inputId}
        className={cn(
          "inline-flex items-start gap-2.5",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
          containerClassName
        )}
      >
        <span className="relative mt-px inline-flex h-[18px] w-[18px] shrink-0">
          <input
            ref={ref}
            id={inputId}
            type="checkbox"
            disabled={disabled}
            className="peer sr-only"
            {...props}
          />
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 flex items-center justify-center rounded-[5px] border transition-colors duration-150",
              "border-border-strong bg-surface-sunken",
              "peer-checked:border-brand-600 peer-checked:bg-brand-600",
              "peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500/40",
              "peer-disabled:opacity-50",
              className
            )}
          />
          <Check
            aria-hidden="true"
            size={13}
            strokeWidth={3}
            className="pointer-events-none absolute inset-0 m-auto text-white opacity-0 transition-opacity duration-150 peer-checked:opacity-100"
          />
        </span>
        {(label || description) && (
          <span className={cn("min-w-0", disabled && "opacity-60")}>
            {label && (
              <span className="block text-sm leading-tight text-text-secondary">
                {label}
              </span>
            )}
            {description && (
              <span className="mt-0.5 block text-xs text-text-muted">
                {description}
              </span>
            )}
          </span>
        )}
      </label>
    );
  }
);

Checkbox.displayName = "Checkbox";
