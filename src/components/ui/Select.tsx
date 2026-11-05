import { forwardRef } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { FormField } from "./FormField";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectGroup {
  label: string;
  options: SelectOption[];
}

interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange" | "size" | "children"> {
  value: string;
  onValueChange: (value: string) => void;
  options?: SelectOption[];
  groups?: SelectGroup[];
  /** Opção inicial desabilitada, exibida quando `value` é vazio. */
  placeholder?: string;
  label?: string;
  hint?: string;
  error?: string;
  showOptional?: boolean;
  size?: "sm" | "md";
}

function renderOptions(options: SelectOption[]) {
  return options.map((o) => (
    <option key={o.value} value={o.value} disabled={o.disabled}>
      {o.label}
    </option>
  ));
}

/** `<select>` nativo estilizado (seletor do sistema no celular, sem zoom no iOS). */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    { value, onValueChange, options, groups, placeholder, label, hint, error, showOptional, size = "md", className, id, required, ...props },
    ref
  ) => {
    const renderControl = (controlId: string | undefined, aria: Record<string, unknown>) => (
      <div className="relative">
        <select
          ref={ref}
          id={controlId}
          value={value}
          required={required}
          onChange={(e) => onValueChange(e.target.value)}
          className={cn(
            "w-full appearance-none bg-surface-raised border border-border-strong rounded-field",
            "pl-3.5 pr-10 text-base md:text-sm text-text-primary",
            size === "md" ? "min-h-11 py-2.5" : "min-h-9 py-1.5",
            "transition-colors duration-150",
            "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            error && "border-semantic-error focus:border-semantic-error focus:ring-semantic-error/20",
            className
          )}
          {...props}
          {...aria}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options && renderOptions(options)}
          {groups?.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {renderOptions(g.options)}
            </optgroup>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          size={16}
          className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-text-muted"
        />
      </div>
    );

    if (!label) {
      const errorId = error ? `${id ?? "select"}-error` : undefined;
      const describedBy = [errorId, props["aria-describedby"]].filter(Boolean).join(" ") || undefined;
      return (
        <>
          {renderControl(id, { ...(error ? { "aria-invalid": true } : {}), "aria-describedby": describedBy })}
          {error && (
            <p id={errorId} role="alert" className="mt-1.5 text-[13px] text-semantic-error">
              {error}
            </p>
          )}
        </>
      );
    }

    return (
      <FormField label={label} htmlFor={id} hint={hint} error={error} required={required} showOptional={showOptional}>
        {({ id: controlId, ...aria }) =>
          renderControl(controlId, {
            ...aria,
            "aria-describedby":
              [aria["aria-describedby"], props["aria-describedby"]].filter(Boolean).join(" ") || undefined,
          })
        }
      </FormField>
    );
  }
);

Select.displayName = "Select";
