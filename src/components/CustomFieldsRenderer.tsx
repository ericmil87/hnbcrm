import { Badge } from "@/components/ui/Badge";

interface FieldDefinition {
  _id: string;
  name: string;
  key: string;
  type: "text" | "number" | "boolean" | "date" | "select" | "multiselect";
  options?: string[];
  isRequired: boolean;
  order: number;
}

interface CustomFieldsRendererProps {
  fieldDefinitions: FieldDefinition[];
  customFields: Record<string, any>;
  editing: boolean;
  onChange: (key: string, value: any) => void;
}

export function CustomFieldsRenderer({
  fieldDefinitions,
  customFields,
  editing,
  onChange,
}: CustomFieldsRendererProps) {
  const sorted = [...fieldDefinitions].sort((a, b) => a.order - b.order);

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-text-muted">Nenhum campo personalizado definido.</p>
    );
  }

  return (
    <div className="space-y-3">
      {sorted.map((field) => {
        const value = customFields[field.key];

        if (!editing) {
          return (
            <div key={field.key}>
              <div className="text-xs font-medium text-text-secondary mb-1">
                {field.name}
                {field.isRequired && <span className="text-semantic-error ml-1">*</span>}
              </div>
              <div className="text-sm text-text-primary">
                {renderViewValue(field, value)}
              </div>
            </div>
          );
        }

        return (
          <div key={field.key}>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              {field.name}
              {field.isRequired && <span className="text-semantic-error ml-1">*</span>}
            </label>
            {renderEditField(field, value, onChange)}
          </div>
        );
      })}
    </div>
  );
}

function renderViewValue(field: FieldDefinition, value: any): React.ReactNode {
  if (value === undefined || value === null || value === "") return "—";

  switch (field.type) {
    case "boolean":
      return value ? "Sim" : "Nao";
    case "date":
      return new Date(value).toLocaleDateString("pt-BR");
    case "multiselect":
      if (Array.isArray(value) && value.length > 0) {
        return (
          <div className="flex flex-wrap gap-1">
            {value.map((v: string, i: number) => (
              <Badge key={i} variant="default">{v}</Badge>
            ))}
          </div>
        );
      }
      return "—";
    default:
      return String(value);
  }
}

const inputClass =
  "w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-sm";

function renderEditField(
  field: FieldDefinition,
  value: any,
  onChange: (key: string, value: any) => void
) {
  switch (field.type) {
    case "text":
      return (
        <input
          type="text"
          value={value || ""}
          onChange={(e) => onChange(field.key, e.target.value)}
          className={inputClass}
          style={{ fontSize: "16px" }}
        />
      );
    case "number":
      return (
        <input
          type="number"
          value={value ?? ""}
          onChange={(e) => onChange(field.key, e.target.value ? Number(e.target.value) : undefined)}
          className={inputClass}
          style={{ fontSize: "16px" }}
        />
      );
    case "boolean":
      return (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(field.key, e.target.checked)}
            className="rounded border-border-strong bg-surface-raised text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm text-text-secondary">{value ? "Sim" : "Nao"}</span>
        </label>
      );
    case "date":
      return (
        <input
          type="date"
          value={value || ""}
          onChange={(e) => onChange(field.key, e.target.value)}
          className={inputClass}
          style={{ fontSize: "16px" }}
        />
      );
    case "select":
      return (
        <select
          value={value || ""}
          onChange={(e) => onChange(field.key, e.target.value)}
          className={inputClass}
        >
          <option value="">Selecionar...</option>
          {field.options?.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );
    case "multiselect": {
      const selected: string[] = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-2">
          {field.options?.map((opt) => {
            const isSelected = selected.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  const next = isSelected
                    ? selected.filter((s) => s !== opt)
                    : [...selected, opt];
                  onChange(field.key, next);
                }}
                className={`px-2.5 py-1 text-sm rounded-full border transition-colors ${
                  isSelected
                    ? "bg-brand-600 text-white border-brand-600"
                    : "bg-surface-raised text-text-secondary border-border-strong hover:border-brand-500"
                }`}
              >
                {opt}
              </button>
            );
          })}
        </div>
      );
    }
    default:
      return null;
  }
}
