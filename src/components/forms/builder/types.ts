export interface FormField {
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
  crmMapping?: {
    entity: "lead" | "contact";
    field: string;
  };
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
}
