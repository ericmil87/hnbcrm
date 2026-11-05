import { forwardRef, useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { FormField } from "./FormField";

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
  /** Cresce com o conteúdo em vez de mostrar barra de rolagem. */
  autoGrow?: boolean;
  showOptional?: boolean;
}

const TEXTAREA_CLASS = cn(
  "w-full bg-surface-raised border border-border-strong rounded-field",
  "px-3.5 py-2.5 text-base md:text-sm text-text-primary",
  "placeholder:text-text-muted transition-colors duration-150",
  "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
  "disabled:opacity-50 disabled:cursor-not-allowed"
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    { label, hint, error, autoGrow, maxLength, showOptional, className, id, value, defaultValue, onChange, required, rows = 3, ...props },
    ref
  ) => {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);
    const setRefs = useCallback(
      (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref]
    );

    const resize = useCallback(() => {
      const el = innerRef.current;
      if (!autoGrow || !el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }, [autoGrow]);

    useLayoutEffect(resize, [resize, value]);

    const [uncontrolledLength, setUncontrolledLength] = useState(
      typeof defaultValue === "string" ? defaultValue.length : 0
    );
    const currentLength = typeof value === "string" ? value.length : uncontrolledLength;
    const errorId = error && !label ? `${id ?? "textarea"}-error` : undefined;

    const renderControl = (aria: Record<string, unknown>, controlId: string | undefined) => (
      <>
        <textarea
          ref={setRefs}
          id={controlId}
          rows={rows}
          value={value}
          defaultValue={defaultValue}
          maxLength={maxLength}
          required={required}
          onChange={(e) => {
            resize();
            if (value === undefined) setUncontrolledLength(e.target.value.length);
            onChange?.(e);
          }}
          className={cn(
            TEXTAREA_CLASS,
            autoGrow && "resize-none overflow-hidden",
            error && "border-semantic-error focus:border-semantic-error focus:ring-semantic-error/20",
            className
          )}
          {...props}
          {...aria}
        />
        {maxLength !== undefined && (
          <p aria-live="off" className="mt-1 text-right text-xs tabular-nums text-text-muted">
            {currentLength}/{maxLength}
          </p>
        )}
      </>
    );

    if (!label) {
      const aria: Record<string, unknown> = error ? { "aria-invalid": true } : {};
      if (errorId) aria["aria-describedby"] = [errorId, props["aria-describedby"]].filter(Boolean).join(" ");
      return (
        <>
          {renderControl(aria, id)}
          {error && (
            <p id={errorId} role="alert" className="mt-1.5 text-[13px] text-semantic-error">
              {error}
            </p>
          )}
        </>
      );
    }

    return (
      <FormField
        label={label}
        htmlFor={id}
        hint={hint}
        error={error}
        required={required}
        showOptional={showOptional}
      >
        {(aria) => {
          const { id: controlId, ...rest } = aria;
          return renderControl(rest, controlId);
        }}
      </FormField>
    );
  }
);

Textarea.displayName = "Textarea";
