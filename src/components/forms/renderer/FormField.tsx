import { cn } from "@/lib/utils";

export interface FormFieldDefinition {
  id: string;
  type: "text" | "email" | "phone" | "number" | "select" | "textarea" | "checkbox" | "date";
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

export function FormField({ field, value, error, onChange, disabled }: FormFieldProps) {
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
    <p className="mt-1.5 text-[13px]" style={{ color: "var(--form-text)", opacity: 0.5 }}>
      {field.helpText}
    </p>
  ) : null;

  const errorEl = error ? (
    <p
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
        {helpTextEl && (
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
        {field.helpText && (
          <p
            id={`${inputId}-help`}
            className="mt-1.5 text-[13px]"
            style={{ color: "var(--form-text)", opacity: 0.5 }}
          >
            {field.helpText}
          </p>
        )}
        {error && (
          <p
            id={`${inputId}-error`}
            className="mt-1.5 text-[13px] font-medium animate-shake text-[#EF4444]"
            role="alert"
            aria-live="polite"
          >
            {error}
          </p>
        )}
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
        {field.helpText && (
          <p
            id={`${inputId}-help`}
            className="mt-1.5 text-[13px]"
            style={{ color: "var(--form-text)", opacity: 0.5 }}
          >
            {field.helpText}
          </p>
        )}
        {error && (
          <p
            id={`${inputId}-error`}
            className="mt-1.5 text-[13px] font-medium animate-shake text-[#EF4444]"
            role="alert"
            aria-live="polite"
          >
            {error}
          </p>
        )}
      </div>
    );
  }

  // --- Text, Email, Phone, Number, Date ---
  const typeMap: Record<FormFieldDefinition["type"], React.HTMLInputTypeAttribute> = {
    text: "text",
    email: "email",
    phone: "tel",
    number: "number",
    select: "text",
    textarea: "text",
    checkbox: "checkbox",
    date: "date",
  };

  const inputModeMap: Record<FormFieldDefinition["type"], React.HTMLAttributes<HTMLInputElement>["inputMode"]> = {
    text: "text",
    email: "email",
    phone: "tel",
    number: "numeric",
    select: "text",
    textarea: "text",
    checkbox: "none",
    date: "none",
  };

  return (
    <div className={wrapperClass}>
      {labelEl}
      <input
        id={inputId}
        type={typeMap[field.type]}
        inputMode={inputModeMap[field.type]}
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
      {field.helpText && (
        <p
          id={`${inputId}-help`}
          className="mt-1.5 text-[13px]"
          style={{ color: "var(--form-text)", opacity: 0.5 }}
        >
          {field.helpText}
        </p>
      )}
      {error && (
        <p
          id={`${inputId}-error`}
          className="mt-1.5 text-[13px] font-medium animate-shake text-[#EF4444]"
          role="alert"
          aria-live="polite"
        >
          {error}
        </p>
      )}
    </div>
  );
}
