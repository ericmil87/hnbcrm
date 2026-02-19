import { useState, useRef, useCallback } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { FormField, type FormFieldDefinition } from "./FormField";
import { FormSuccess } from "./FormSuccess";

const radiusMap: Record<string, string> = {
  none: "0px",
  sm: "4px",
  md: "8px",
  lg: "16px",
  full: "9999px",
};

interface FormTheme {
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  borderRadius: "none" | "sm" | "md" | "lg" | "full";
  showBranding: boolean;
}

interface FormSettings {
  submitButtonText: string;
  successMessage: string;
  redirectUrl?: string;
  honeypotEnabled: boolean;
}

interface FormRendererProps {
  form: {
    name: string;
    description?: string;
    fields: FormFieldDefinition[];
    theme: FormTheme;
    settings: FormSettings;
  };
  onSubmit?: (data: Record<string, string>) => Promise<void>;
  isPreview?: boolean;
  prefillData?: Record<string, string>;
}

/**
 * Derive initial values from field definitions, merging prefill data.
 */
function buildInitialValues(
  fields: FormFieldDefinition[],
  prefillData?: Record<string, string>
): Record<string, string> {
  const initial: Record<string, string> = {};
  for (const field of fields) {
    initial[field.id] = prefillData?.[field.id] ?? field.defaultValue ?? "";
  }
  return initial;
}

/**
 * Validate a single field value and return an error string or undefined.
 */
function validateField(
  field: FormFieldDefinition,
  value: string
): string | undefined {
  const trimmed = value.trim();

  // Checkbox uses "true"/"false"
  const isEmpty = field.type === "checkbox" ? value !== "true" : trimmed === "";

  if (field.isRequired && isEmpty) {
    return "Este campo é obrigatório";
  }

  if (!isEmpty) {
    if (field.type === "email") {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(trimmed)) {
        return "Informe um e-mail válido";
      }
    }

    const { validation } = field;

    if (validation?.minLength !== undefined && trimmed.length < validation.minLength) {
      return `Mínimo de ${validation.minLength} caracteres`;
    }

    if (validation?.maxLength !== undefined && trimmed.length > validation.maxLength) {
      return `Máximo de ${validation.maxLength} caracteres`;
    }

    if (field.type === "number") {
      const num = Number(value);
      if (validation?.min !== undefined && num < validation.min) {
        return `Valor mínimo: ${validation.min}`;
      }
      if (validation?.max !== undefined && num > validation.max) {
        return `Valor máximo: ${validation.max}`;
      }
    }

    if (validation?.pattern) {
      try {
        const regex = new RegExp(validation.pattern);
        if (!regex.test(trimmed)) {
          return "Formato inválido";
        }
      } catch {
        // Invalid regex — skip pattern validation silently
      }
    }
  }

  return undefined;
}

export function FormRenderer({
  form,
  onSubmit,
  isPreview = false,
  prefillData,
}: FormRendererProps) {
  const { theme, settings, fields } = form;

  const [values, setValues] = useState<Record<string, string>>(() =>
    buildInitialValues(fields, prefillData)
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [honeypot, setHoneypot] = useState("");

  // Ref for the first error field so we can focus it on validation failure
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});

  const handleChange = useCallback((fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
    // Clear error on change
    setErrors((prev) => {
      if (!prev[fieldId]) return prev;
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (isPreview) return;

    // Honeypot check — if filled, silently reject
    if (settings.honeypotEnabled && honeypot !== "") {
      // Pretend success to fool bots
      setIsSuccess(true);
      return;
    }

    // Validate all fields
    const nextErrors: Record<string, string> = {};
    for (const field of fields) {
      const err = validateField(field, values[field.id] ?? "");
      if (err) {
        nextErrors[field.id] = err;
      }
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);

      // Focus the first field with an error
      const firstErrorId = fields.find((f) => nextErrors[f.id])?.id;
      if (firstErrorId) {
        const el = document.getElementById(`field-${firstErrorId}`);
        el?.focus();
      }
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit?.(values);
      setIsSuccess(true);
    } catch {
      // Surface a generic error — real error handling is the caller's responsibility
      setErrors({ _form: "Ocorreu um erro ao enviar o formulário. Tente novamente." });
    } finally {
      setIsSubmitting(false);
    }
  };

  const cssVars = {
    "--form-primary": theme.primaryColor,
    "--form-bg": theme.backgroundColor,
    "--form-text": theme.textColor,
    "--form-radius": radiusMap[theme.borderRadius] ?? "8px",
  } as React.CSSProperties;

  if (isSuccess) {
    return (
      <div style={cssVars}>
        <FormSuccess
          message={settings.successMessage}
          redirectUrl={settings.redirectUrl}
        />
      </div>
    );
  }

  return (
    <div style={cssVars}>
      <form
        onSubmit={handleSubmit}
        noValidate
        aria-label={form.name}
      >
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-start gap-3">
            <h2
              className="text-xl font-semibold leading-tight flex-1"
              style={{ color: "var(--form-text)" }}
            >
              {form.name}
            </h2>
            {isPreview && (
              <Badge variant="warning" className="flex-shrink-0 mt-0.5">
                Visualização
              </Badge>
            )}
          </div>
          {form.description && (
            <p
              className="mt-2 text-sm leading-relaxed"
              style={{ color: "var(--form-text)", opacity: 0.6 }}
            >
              {form.description}
            </p>
          )}
        </div>

        {/* Honeypot — hidden from real users, visible to bots */}
        {settings.honeypotEnabled && (
          <div
            style={{ position: "absolute", left: "-9999px", opacity: 0 }}
            aria-hidden="true"
          >
            <input
              name="_hnb_hp"
              type="text"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
            />
          </div>
        )}

        {/* Field grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
          {fields.map((field) => (
            <FormField
              key={field.id}
              field={field}
              value={values[field.id] ?? ""}
              error={errors[field.id]}
              onChange={(value) => handleChange(field.id, value)}
              disabled={isSubmitting || isPreview}
            />
          ))}
        </div>

        {/* Form-level error (e.g. network failure) */}
        {errors._form && (
          <p className="mt-4 text-sm font-medium text-[#EF4444] animate-shake" role="alert" aria-live="assertive">
            {errors._form}
          </p>
        )}

        {/* Submit */}
        <div className="mt-6">
          <button
            type="submit"
            disabled={isSubmitting || isPreview}
            aria-disabled={isPreview}
            aria-label={isPreview ? "Envio desabilitado no modo de visualização" : undefined}
            style={{
              backgroundColor: "var(--form-primary)",
              borderRadius: "var(--form-radius)",
              color: "#ffffff",
            }}
            className={[
              "w-full h-12 px-6",
              "text-base font-bold",
              "flex items-center justify-center gap-2",
              "transition-all duration-150",
              "focus:outline-none focus:ring-2 focus:ring-offset-2",
              isSubmitting || isPreview
                ? "opacity-60 cursor-not-allowed"
                : "hover:brightness-110 active:brightness-90",
            ].join(" ")}
          >
            {isSubmitting ? (
              <>
                <Spinner size="sm" className="border-white border-t-transparent" />
                <span>Enviando...</span>
              </>
            ) : isPreview ? (
              <span>Enviar (desabilitado na visualização)</span>
            ) : (
              <span>{settings.submitButtonText}</span>
            )}
          </button>
        </div>

        {/* Branding */}
        {theme.showBranding && (
          <p className="mt-5 text-center text-xs" style={{ color: "var(--form-text)", opacity: 0.35 }}>
            Feito com{" "}
            <a
              href="https://hnbcrm.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:opacity-70 transition-opacity"
              style={{ color: "var(--form-text)" }}
            >
              HNBCRM
            </a>
          </p>
        )}
      </form>
    </div>
  );
}
