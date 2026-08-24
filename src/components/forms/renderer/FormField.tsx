import { useState } from "react";
import { cn } from "@/lib/utils";

export interface FormFieldDefinition {
  id: string;
  type: "text" | "email" | "phone" | "number" | "select" | "textarea" | "checkbox" | "date"
    | "radio" | "url" | "hidden" | "heading" | "divider" | "rating";
  label: string;
  placeholder?: string;
  helpText?: string;
  isRequired: boolean;
  validation?: {
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    pattern?: string;
  };
  options?: string[];
  defaultValue?: string;
  width?: "full" | "half";
}

export interface FormFieldProps {
  field: FormFieldDefinition;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
}

const inputBaseStyle = [
  "w-full min-h-[48px] px-3.5 py-3",
  "text-base",
  "rounded-[var(--form-radius)]",
  "border border-[rgba(var(--form-text-rgb,250,250,250),0.2)]",
  "bg-[rgba(var(--form-bg-rgb,15,15,17),0.6)]",
  "text-[var(--form-text)]",
  "placeholder:text-[var(--form-text)] placeholder:opacity-40",
  "transition-colors duration-150",
  "outline-none",
  "focus:border-[var(--form-primary)]",
  "focus:ring-2 focus:ring-[var(--form-primary)] focus:ring-opacity-20",
  "disabled:opacity-50 disabled:cursor-not-allowed",
].join(" ");

const inputErrorStyle = "border-[#EF4444] focus:border-[#EF4444] focus:ring-[#EF4444]";

export function FormField({ field, value, error, onChange, onBlur, disabled }: FormFieldProps) {
  const inputId = `field-${field.id}`;

  const labelEl = (
    <label
      htmlFor={inputId}
      className="block text-[13px] font-medium mb-1.5"
      style={{ color: "var(--form-text)", opacity: 0.85 }}
    >
      {field.label}
      {field.isRequired && (
        <span className="ml-1 text-[#EF4444]" aria-hidden="true">
          *
        </span>
      )}
    </label>
  );

  const helpTextEl = field.helpText ? (
    <p
      id={`${inputId}-help`}
      className="mt-1.5 text-[13px]"
      style={{ color: "var(--form-text)", opacity: 0.5 }}
    >
      {field.helpText}
    </p>
  ) : null;

  const errorEl = error ? (
    <p
      id={`${inputId}-error`}
      className="mt-1.5 text-[13px] font-medium animate-shake text-[#EF4444]"
      role="alert"
      aria-live="polite"
    >
      {error}
    </p>
  ) : null;

  const wrapperClass = cn(
    field.width === "half" ? "col-span-1" : "col-span-1 md:col-span-2"
  );

  // --- Hidden field ---
  if (field.type === "hidden") {
    return (
      <input
        type="hidden"
        id={inputId}
        name={field.id}
        value={value || field.defaultValue || ""}
      />
    );
  }

  // --- Heading ---
  if (field.type === "heading") {
    return (
      <div className={cn("col-span-1 md:col-span-2", "pt-2")}>
        <h3
          className="text-lg font-semibold"
          style={{ color: "var(--form-text)" }}
        >
          {field.label}
        </h3>
        {field.helpText && (
          <p
            className="mt-1 text-sm"
            style={{ color: "var(--form-text)", opacity: 0.6 }}
          >
            {field.helpText}
          </p>
        )}
      </div>
    );
  }

  // --- Divider ---
  if (field.type === "divider") {
    return (
      <div className="col-span-1 md:col-span-2 py-2">
        <hr
          className="border-t"
          style={{ borderColor: "rgba(var(--form-text-rgb,250,250,250),0.15)" }}
        />
      </div>
    );
  }

  // --- Rating ---
  if (field.type === "rating") {
    return (
      <div className={wrapperClass}>
        {labelEl}
        <RatingInput
          inputId={inputId}
          value={value}
          onChange={onChange}
          disabled={disabled}
          error={!!error}
          isRequired={field.isRequired}
          helpTextId={field.helpText ? `${inputId}-help` : undefined}
          errorId={error ? `${inputId}-error` : undefined}
        />
        {helpTextEl}
        {errorEl}
      </div>
    );
  }

  // --- Checkbox ---
  if (field.type === "checkbox") {
    return (
      <div className={wrapperClass}>
        <label
          htmlFor={inputId}
          className="flex items-center gap-3 cursor-pointer select-none"
        >
          <div className="relative flex-shrink-0">
            <input
              id={inputId}
              type="checkbox"
              checked={value === "true"}
              onChange={(e) => onChange(e.target.checked ? "true" : "false")}
              onBlur={onBlur}
              disabled={disabled}
              aria-required={field.isRequired}
              aria-invalid={!!error}
              aria-describedby={error ? `${inputId}-error` : field.helpText ? `${inputId}-help` : undefined}
              className="sr-only"
            />
            {/* Custom checkbox */}
            <div
              className={cn(
                "w-[22px] h-[22px] rounded-[4px] border-2 transition-all duration-150",
                "flex items-center justify-center flex-shrink-0",
                value === "true"
                  ? "border-[var(--form-primary)] bg-[var(--form-primary)]"
                  : "border-[rgba(var(--form-text-rgb,250,250,250),0.3)] bg-transparent",
                error && "border-[#EF4444]",
                disabled && "opacity-50 cursor-not-allowed"
              )}
              aria-hidden="true"
            >
              {value === "true" && (
                <svg
                  width="12"
                  height="10"
                  viewBox="0 0 12 10"
                  fill="none"
                  className="text-white"
                >
                  <path
                    d="M1 5L4.5 8.5L11 1.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
          </div>
          <span className="text-base" style={{ color: "var(--form-text)" }}>
            {field.label}
            {field.isRequired && (
              <span className="ml-1 text-[#EF4444]" aria-hidden="true">
                *
              </span>
            )}
          </span>
        </label>
        {field.helpText && (
          <p
            id={`${inputId}-help`}
            className="mt-1.5 text-[13px] pl-[34px]"
            style={{ color: "var(--form-text)", opacity: 0.5 }}
          >
            {field.helpText}
          </p>
        )}
        {error && (
          <p
            id={`${inputId}-error`}
            className="mt-1.5 text-[13px] font-medium animate-shake text-[#EF4444] pl-[34px]"
            role="alert"
            aria-live="polite"
          >
            {error}
          </p>
        )}
      </div>
    );
  }

  // --- Radio ---
  if (field.type === "radio") {
    return (
      <div className={wrapperClass}>
        <fieldset>
          <legend
            className="block text-[13px] font-medium mb-2"
            style={{ color: "var(--form-text)", opacity: 0.85 }}
          >
            {field.label}
            {field.isRequired && (
              <span className="ml-1 text-[#EF4444]" aria-hidden="true">*</span>
            )}
          </legend>
          <div className="space-y-2">
            {field.options?.map((opt) => (
              <label
                key={opt}
                className="flex items-center gap-3 cursor-pointer select-none"
              >
                <div className="relative flex-shrink-0">
                  <input
                    type="radio"
                    name={inputId}
                    value={opt}
                    checked={value === opt}
                    onChange={() => onChange(opt)}
                    onBlur={onBlur}
                    disabled={disabled}
                    className="sr-only"
                  />
                  <div
                    className={cn(
                      "w-[20px] h-[20px] rounded-full border-2 transition-all duration-150",
                      "flex items-center justify-center flex-shrink-0",
                      value === opt
                        ? "border-[var(--form-primary)]"
                        : "border-[rgba(var(--form-text-rgb,250,250,250),0.3)]",
                      error && "border-[#EF4444]",
                      disabled && "opacity-50 cursor-not-allowed"
                    )}
                    aria-hidden="true"
                  >
                    {value === opt && (
                      <div
                        className="w-[10px] h-[10px] rounded-full"
                        style={{ backgroundColor: "var(--form-primary)" }}
                      />
                    )}
                  </div>
                </div>
                <span className="text-base" style={{ color: "var(--form-text)" }}>
                  {opt}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {helpTextEl}
        {errorEl}
      </div>
    );
  }

  // --- Select ---
  if (field.type === "select") {
    return (
      <div className={wrapperClass}>
        {labelEl}
        <div className="relative">
          <select
            id={inputId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            disabled={disabled}
            aria-required={field.isRequired}
            aria-invalid={!!error}
            aria-describedby={
              error
                ? `${inputId}-error`
                : field.helpText
                  ? `${inputId}-help`
                  : undefined
            }
            className={cn(
              inputBaseStyle,
              "appearance-none pr-10 cursor-pointer",
              error && inputErrorStyle
            )}
            style={{
              color: value ? "var(--form-text)" : undefined,
            }}
          >
            <option value="" disabled style={{ color: "#71717A" }}>
              {field.placeholder ?? "Selecione uma opção"}
            </option>
            {field.options?.map((opt) => (
              <option key={opt} value={opt} style={{ color: "inherit", background: "var(--form-bg)" }}>
                {opt}
              </option>
            ))}
          </select>
          {/* Chevron icon */}
          <div
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
            style={{ color: "var(--form-text)", opacity: 0.5 }}
            aria-hidden="true"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </div>
        {helpTextEl}
        {errorEl}
      </div>
    );
  }

  // --- Textarea ---
  if (field.type === "textarea") {
    return (
      <div className={wrapperClass}>
        {labelEl}
        <textarea
          id={inputId}
          rows={4}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={field.placeholder}
          disabled={disabled}
          aria-required={field.isRequired}
          aria-invalid={!!error}
          aria-describedby={
            error
              ? `${inputId}-error`
              : field.helpText
                ? `${inputId}-help`
                : undefined
          }
          className={cn(
            inputBaseStyle,
            "min-h-[120px] resize-y",
            error && inputErrorStyle
          )}
        />
        {helpTextEl}
        {errorEl}
      </div>
    );
  }

  // --- Text, Email, Phone, Number, Date, URL ---
  const typeMap: Record<string, React.HTMLInputTypeAttribute> = {
    text: "text",
    email: "email",
    phone: "tel",
    number: "number",
    date: "date",
    url: "url",
  };

  const inputModeMap: Record<string, React.HTMLAttributes<HTMLInputElement>["inputMode"]> = {
    text: "text",
    email: "email",
    phone: "tel",
    number: "numeric",
    date: "none",
    url: "url",
  };

  return (
    <div className={wrapperClass}>
      {labelEl}
      <input
        id={inputId}
        type={typeMap[field.type] ?? "text"}
        inputMode={inputModeMap[field.type] ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={field.placeholder}
        disabled={disabled}
        aria-required={field.isRequired}
        aria-invalid={!!error}
        aria-describedby={
          error
            ? `${inputId}-error`
            : field.helpText
              ? `${inputId}-help`
              : undefined
        }
        minLength={field.validation?.minLength}
        maxLength={field.validation?.maxLength}
        min={field.validation?.min !== undefined ? String(field.validation.min) : undefined}
        max={field.validation?.max !== undefined ? String(field.validation.max) : undefined}
        className={cn(inputBaseStyle, error && inputErrorStyle)}
      />
      {helpTextEl}
      {errorEl}
    </div>
  );
}

// --- Rating Stars Component ---
function RatingInput({
  inputId,
  value,
  onChange,
  disabled,
  error,
  isRequired,
  helpTextId,
  errorId,
}: {
  inputId: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  error: boolean;
  isRequired: boolean;
  helpTextId?: string;
  errorId?: string;
}) {
  const [hovered, setHovered] = useState(0);
  const currentValue = parseInt(value) || 0;

  return (
    <div
      role="radiogroup"
      aria-label="Avaliação"
      aria-required={isRequired}
      aria-invalid={error}
      aria-describedby={error ? errorId : helpTextId}
      className="flex gap-1"
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const isFilled = star <= (hovered || currentValue);
        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={star === currentValue}
            aria-label={`${star} estrela${star > 1 ? "s" : ""}`}
            disabled={disabled}
            onClick={() => onChange(String(star))}
            onMouseEnter={() => setHovered(star)}
            onMouseLeave={() => setHovered(0)}
            className={cn(
              "p-1 transition-all duration-150 rounded",
              "focus:outline-none focus:ring-2 focus:ring-[var(--form-primary)] focus:ring-opacity-50",
              disabled && "opacity-50 cursor-not-allowed"
            )}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill={isFilled ? "var(--form-primary)" : "none"}
              stroke={isFilled ? "var(--form-primary)" : "rgba(var(--form-text-rgb,250,250,250),0.3)"}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-colors duration-150"
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
        );
      })}
    </div>
  );
}
