export type FieldType =
  | "text" | "email" | "phone" | "number" | "select" | "textarea" | "checkbox" | "date"
  | "radio" | "url" | "hidden" | "heading" | "divider" | "rating";

// Layout-only field types (no value submitted)
export const LAYOUT_FIELD_TYPES: FieldType[] = ["heading", "divider"];

// Field types that use options array
export const OPTIONS_FIELD_TYPES: FieldType[] = ["select", "radio"];

export interface ConditionalLogic {
  action: "show" | "hide";
  logic: "all" | "any";
  conditions: {
    fieldId: string;
    operator: "equals" | "not_equals" | "contains" | "not_contains" | "is_empty" | "is_not_empty" | "greater_than" | "less_than";
    value?: string;
  }[];
}

export interface FormField {
  id: string;
  type: FieldType;
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
  crmMapping?: {
    entity: "lead" | "contact";
    field: string;
  };
  conditionalLogic?: ConditionalLogic;
}

export interface FormStep {
  id: string;
  title: string;
  description?: string;
  fieldIds: string[];
}

export interface FormTheme {
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  borderRadius: "none" | "sm" | "md" | "lg" | "full";
  showBranding: boolean;
}

export interface FormSettings {
  submitButtonText: string;
  successMessage: string;
  redirectUrl?: string;
  notifyOnSubmission: boolean;
  notifyMemberIds?: string[];
  leadTitle: string;
  boardId?: string;
  stageId?: string;
  sourceId?: string;
  assignedTo?: string;
  assignmentMode: "specific" | "round_robin" | "none";
  defaultPriority: "low" | "medium" | "high" | "urgent";
  defaultTemperature: "cold" | "warm" | "hot";
  tags: string[];
  honeypotEnabled: boolean;
  submissionLimit?: number;
  // Phase 7: Custom thank you page
  successTitle?: string;
  successSubtitle?: string;
  successCta?: { label: string; url: string };
  // Phase 7: Confirmation email
  confirmationEmail?: {
    enabled: boolean;
    subject?: string;
    body?: string;
    replyTo?: string;
  };
}
