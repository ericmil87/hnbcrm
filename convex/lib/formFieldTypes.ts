// Shared field type constants used by both backend and frontend

// Layout-only field types (no value submitted)
export const LAYOUT_FIELD_TYPES = ["heading", "divider"] as const;

// Field types that use options array
export const OPTIONS_FIELD_TYPES = ["select", "radio"] as const;

export type FieldType =
  | "text" | "email" | "phone" | "number" | "select" | "textarea" | "checkbox" | "date"
  | "radio" | "url" | "hidden" | "heading" | "divider" | "rating";
