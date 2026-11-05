import { useId } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Props repassadas ao controle quando `children` é uma função. */
export interface FormFieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

interface FormFieldProps {
  label: string;
  /** Id do controle. Se omitido, é gerado e entregue a `children` (função). */
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Mostra "(opcional)" ao lado do rótulo quando o campo não é obrigatório. */
  showOptional?: boolean;
  className?: string;
  children: ReactNode | ((props: FormFieldControlProps) => ReactNode);
}

/**
 * Rótulo + dica + erro ligados ao controle por id. Aceita um nó comum (use
 * `htmlFor`) ou uma função que recebe `id` e os `aria-*` prontos.
 */
export function FormField({
  label,
  htmlFor,
  hint,
  error,
  required,
  showOptional,
  className,
  children,
}: FormFieldProps) {
  const generatedId = useId();
  const controlId = htmlFor ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("w-full", className)}>
      <label
        htmlFor={controlId}
        className="mb-1.5 block text-[13px] font-medium text-text-secondary"
      >
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-semantic-error">
            *
          </span>
        )}
        {!required && showOptional && (
          <span className="ml-1 font-normal text-text-muted">(opcional)</span>
        )}
      </label>
      {typeof children === "function"
        ? children({
            id: controlId,
            "aria-describedby": describedBy,
            "aria-invalid": error ? true : undefined,
            "aria-required": required ? true : undefined,
          })
        : children}
      {hint && (
        <p id={hintId} className="mt-1.5 text-xs text-text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-[13px] text-semantic-error">
          {error}
        </p>
      )}
    </div>
  );
}
