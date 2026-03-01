import { useState, useRef, useCallback, useMemo } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { FormField, type FormFieldDefinition } from "./FormField";
import { FormSuccess } from "./FormSuccess";
import type { ConditionalLogic } from "@/components/forms/builder/types";

const radiusMap: Record<string, string> = {
  none: "0px",
  sm: "4px",
  md: "8px",
  lg: "16px",
  full: "9999px",
};

// Layout-only fields that don't collect values
const LAYOUT_TYPES = new Set(["heading", "divider"]);

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
  successTitle?: string;
  successSubtitle?: string;
  successCta?: { label: string; url: string };
}

interface FormStep {
  id: string;
  title: string;
  description?: string;
  fieldIds: string[];
}

interface FieldWithLogic extends FormFieldDefinition {
  conditionalLogic?: ConditionalLogic;
}

interface FormRendererProps {
  form: {
    name: string;
    description?: string;
    fields: FieldWithLogic[];
    steps?: FormStep[];
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
  fields: FieldWithLogic[],
  prefillData?: Record<string, string>
): Record<string, string> {
  const initial: Record<string, string> = {};
  for (const field of fields) {
    if (LAYOUT_TYPES.has(field.type)) continue;
    initial[field.id] = prefillData?.[field.id] ?? field.defaultValue ?? "";
  }
  return initial;
}

/**
 * Evaluate conditional logic for a field given current form values.
 * Returns true if the field should be visible.
 */
function evaluateFieldVisibility(
  field: FieldWithLogic,
  values: Record<string, string>
): boolean {
  const logic = field.conditionalLogic;
  if (!logic || logic.conditions.length === 0) return true;

  const results = logic.conditions.map((condition) => {
    const fieldValue = values[condition.fieldId] ?? "";
    const condValue = condition.value ?? "";

    switch (condition.operator) {
      case "equals":
        return fieldValue === condValue;
      case "not_equals":
        return fieldValue !== condValue;
      case "contains":
        return fieldValue.toLowerCase().includes(condValue.toLowerCase());
      case "not_contains":
        return !fieldValue.toLowerCase().includes(condValue.toLowerCase());
      case "is_empty":
        return fieldValue.trim() === "";
      case "is_not_empty":
        return fieldValue.trim() !== "";
      case "greater_than":
        return Number(fieldValue) > Number(condValue);
      case "less_than":
        return Number(fieldValue) < Number(condValue);
      default:
        return true;
    }
  });

  const conditionsMet =
    logic.logic === "all"
      ? results.every(Boolean)
      : results.some(Boolean);

  return logic.action === "show" ? conditionsMet : !conditionsMet;
}

/**
 * Validate a single field value and return an error string or undefined.
 */
function validateField(
  field: FormFieldDefinition,
  value: string
): string | undefined {
  // Layout fields have no validation
  if (LAYOUT_TYPES.has(field.type)) return undefined;

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

    if (field.type === "url") {
      try {
        new URL(trimmed);
      } catch {
        return "Informe uma URL válida (ex: https://exemplo.com)";
      }
    }

    if (field.type === "rating") {
      const num = parseInt(trimmed);
      if (isNaN(num) || num < 1 || num > 5) {
        return "Selecione uma avaliação de 1 a 5";
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
  const { theme, settings, fields, steps } = form;

  const [values, setValues] = useState<Record<string, string>>(() =>
    buildInitialValues(fields, prefillData)
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [currentStep, setCurrentStep] = useState(0);
  const [submittedValues, setSubmittedValues] = useState<Record<string, string>>({});

  // Ref for the first error field so we can focus it on validation failure
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});

  // Compute visibility for all fields
  const fieldVisibility = useMemo(() => {
    const vis: Record<string, boolean> = {};
    for (const field of fields) {
      vis[field.id] = evaluateFieldVisibility(field, values);
    }
    return vis;
  }, [fields, values]);

  const isMultiStep = steps && steps.length > 1;
  const totalSteps = steps?.length ?? 1;

  // Get fields for current step
  const currentStepFields = useMemo(() => {
    if (!isMultiStep || !steps) return fields;
    const step = steps[currentStep];
    if (!step) return fields;
    const fieldIdSet = new Set(step.fieldIds);
    return fields.filter((f) => fieldIdSet.has(f.id));
  }, [fields, steps, currentStep, isMultiStep]);

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

  // Validate a set of fields
  const validateFields = useCallback((fieldsToValidate: FieldWithLogic[]): Record<string, string> => {
    const nextErrors: Record<string, string> = {};
    for (const field of fieldsToValidate) {
      // Skip invisible fields
      if (!fieldVisibility[field.id]) continue;
      // Skip hidden fields from user validation
      if (field.type === "hidden") continue;

      const err = validateField(field, values[field.id] ?? "");
      if (err) {
        nextErrors[field.id] = err;
      }
    }
    return nextErrors;
  }, [values, fieldVisibility]);

  const handleNextStep = useCallback(() => {
    const stepErrors = validateFields(currentStepFields);
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      const firstErrorId = currentStepFields.find((f) => stepErrors[f.id])?.id;
      if (firstErrorId) {
        document.getElementById(`field-${firstErrorId}`)?.focus();
      }
      return;
    }
    setErrors({});
    setCurrentStep((prev) => Math.min(prev + 1, totalSteps - 1));
  }, [currentStepFields, validateFields, totalSteps]);

  const handlePrevStep = useCallback(() => {
    setErrors({});
    setCurrentStep((prev) => Math.max(prev - 1, 0));
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

    // For multi-step, only validate current step fields
    // For single page, validate all visible fields
    const fieldsToValidate = isMultiStep ? currentStepFields : fields;
    const nextErrors = validateFields(fieldsToValidate);

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);

      // Focus the first field with an error
      const firstErrorId = fieldsToValidate.find((f) => nextErrors[f.id])?.id;
      if (firstErrorId) {
        const el = document.getElementById(`field-${firstErrorId}`);
        el?.focus();
      }
      return;
    }

    // Build submission data: exclude invisible fields and layout fields
    const submitData: Record<string, string> = {};
    for (const field of fields) {
      if (LAYOUT_TYPES.has(field.type)) continue;
      if (!fieldVisibility[field.id]) continue;
      // Include hidden fields with their default value
      if (field.type === "hidden") {
        submitData[field.id] = field.defaultValue ?? "";
        continue;
      }
      submitData[field.id] = values[field.id] ?? "";
    }

    setIsSubmitting(true);
    try {
      await onSubmit?.(submitData);
      setSubmittedValues(submitData);
      setIsSuccess(true);
    } catch (err: any) {
      // Check for structured error responses
      const message = err?.message || "";
      if (message.includes("duplicate")) {
        setErrors({ _form: "Você já enviou este formulário recentemente." });
      } else if (message.includes("validation")) {
        setErrors({ _form: "Alguns campos possuem dados inválidos. Verifique e tente novamente." });
      } else {
        setErrors({ _form: "Ocorreu um erro ao enviar o formulário. Tente novamente." });
      }
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
          title={settings.successTitle}
          subtitle={settings.successSubtitle}
          cta={settings.successCta}
          submittedValues={submittedValues}
          fields={fields}
        />
      </div>
    );
  }

  const currentStepData = isMultiStep && steps ? steps[currentStep] : null;
  const isLastStep = currentStep === totalSteps - 1;

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

        {/* Multi-step progress bar */}
        {isMultiStep && steps && (
          <StepProgressBar
            steps={steps}
            currentStep={currentStep}
          />
        )}

        {/* Step title */}
        {currentStepData && (
          <div className="mb-4">
            <h3
              className="text-base font-semibold"
              style={{ color: "var(--form-text)" }}
            >
              {currentStepData.title}
            </h3>
            {currentStepData.description && (
              <p
                className="mt-1 text-sm"
                style={{ color: "var(--form-text)", opacity: 0.6 }}
              >
                {currentStepData.description}
              </p>
            )}
          </div>
        )}

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
          {currentStepFields.map((field) => {
            // Handle conditional visibility
            if (!fieldVisibility[field.id]) {
              return (
                <div key={field.id} style={{ display: "none" }}>
                  <FormField
                    field={field}
                    value={values[field.id] ?? ""}
                    onChange={(value) => handleChange(field.id, value)}
                    disabled={true}
                  />
                </div>
              );
            }

            return (
              <FormField
                key={field.id}
                field={field}
                value={values[field.id] ?? ""}
                error={errors[field.id]}
                onChange={(value) => handleChange(field.id, value)}
                disabled={isSubmitting || isPreview}
              />
            );
          })}
        </div>

        {/* Form-level error (e.g. network failure) */}
        {errors._form && (
          <p className="mt-4 text-sm font-medium text-[#EF4444] animate-shake" role="alert" aria-live="assertive">
            {errors._form}
          </p>
        )}

        {/* Navigation buttons */}
        <div className="mt-6 flex gap-3">
          {/* Previous step button */}
          {isMultiStep && currentStep > 0 && (
            <button
              type="button"
              onClick={handlePrevStep}
              style={{
                borderRadius: "var(--form-radius)",
                color: "var(--form-text)",
                borderColor: "rgba(var(--form-text-rgb,250,250,250),0.2)",
              }}
              className={[
                "flex-1 h-12 px-6",
                "text-base font-medium",
                "flex items-center justify-center",
                "border",
                "transition-all duration-150",
                "hover:brightness-110",
                "focus:outline-none focus:ring-2 focus:ring-offset-2",
              ].join(" ")}
            >
              Anterior
            </button>
          )}

          {/* Next / Submit button */}
          {isMultiStep && !isLastStep ? (
            <button
              type="button"
              onClick={handleNextStep}
              style={{
                backgroundColor: "var(--form-primary)",
                borderRadius: "var(--form-radius)",
                color: "#ffffff",
              }}
              className={[
                "flex-1 h-12 px-6",
                "text-base font-bold",
                "flex items-center justify-center gap-2",
                "transition-all duration-150",
                "focus:outline-none focus:ring-2 focus:ring-offset-2",
                "hover:brightness-110 active:brightness-90",
              ].join(" ")}
            >
              Próximo
            </button>
          ) : (
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
                "flex-1 h-12 px-6",
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
          )}
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

// --- Step Progress Bar ---
function StepProgressBar({
  steps,
  currentStep,
}: {
  steps: FormStep[];
  currentStep: number;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2">
        {steps.map((step, index) => (
          <div key={step.id} className="flex items-center flex-1 last:flex-none">
            {/* Dot */}
            <div
              className="flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold flex-shrink-0 transition-all duration-300"
              style={{
                backgroundColor: index <= currentStep ? "var(--form-primary)" : "transparent",
                color: index <= currentStep ? "#ffffff" : "var(--form-text)",
                border: index <= currentStep ? "none" : "2px solid rgba(var(--form-text-rgb,250,250,250),0.2)",
                opacity: index <= currentStep ? 1 : 0.5,
              }}
            >
              {index + 1}
            </div>
            {/* Line between dots */}
            {index < steps.length - 1 && (
              <div
                className="flex-1 h-0.5 mx-2 transition-all duration-300"
                style={{
                  backgroundColor: index < currentStep
                    ? "var(--form-primary)"
                    : "rgba(var(--form-text-rgb,250,250,250),0.15)",
                }}
              />
            )}
          </div>
        ))}
      </div>
      {/* Step labels (desktop only) */}
      <div className="hidden md:flex items-center gap-2 mt-2">
        {steps.map((step, index) => (
          <div
            key={step.id}
            className="flex-1 last:flex-none text-[12px] font-medium truncate"
            style={{
              color: "var(--form-text)",
              opacity: index <= currentStep ? 0.7 : 0.35,
            }}
          >
            {step.title}
          </div>
        ))}
      </div>
    </div>
  );
}
