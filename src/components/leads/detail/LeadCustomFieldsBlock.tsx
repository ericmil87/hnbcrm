import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { TAB_ROUTES } from "@/lib/routes";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";

/* ------------------------------------------------------------------ */
/*  Custom Fields Section                                              */
/* ------------------------------------------------------------------ */

type FieldDefinition = {
  _id: string;
  name: string;
  key: string;
  type: "text" | "number" | "boolean" | "date" | "select" | "multiselect";
  entityType?: "lead" | "contact";
  options?: string[];
  isRequired: boolean;
  order: number;
};

// `customFields` guarda datas como timestamp (ms) OU string — aceita os dois
// na leitura; a escrita sempre grava timestamp (ms).
function toDateInputValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const d = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function CustomFieldEditor({
  field,
  value,
  onChange,
  onToggleOption,
}: {
  field: FieldDefinition;
  value: unknown;
  onChange: (v: unknown) => void;
  onToggleOption: (option: string) => void;
}) {
  const label = (
    <label className="block text-[13px] font-medium text-text-secondary mb-1">
      {field.name}
      {field.isRequired && <span className="text-semantic-error"> *</span>}
    </label>
  );

  if (field.type === "text") {
    return (
      <div>
        {label}
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
          style={{ fontSize: "16px" }}
        />
      </div>
    );
  }

  if (field.type === "number") {
    return (
      <div>
        {label}
        <input
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
          style={{ fontSize: "16px" }}
        />
      </div>
    );
  }

  if (field.type === "boolean") {
    return (
      <Checkbox
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        label={<span className="text-sm font-medium text-text-primary">{field.name}</span>}
      />
    );
  }

  if (field.type === "date") {
    return (
      <div>
        {label}
        <input
          type="date"
          value={toDateInputValue(value)}
          onChange={(e) => {
            if (!e.target.value) {
              onChange(undefined);
              return;
            }
            const [y, m, d] = e.target.value.split("-").map(Number);
            onChange(new Date(y, m - 1, d).getTime());
          }}
          className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
          style={{ fontSize: "16px" }}
        />
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div>
        {label}
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
          style={{ fontSize: "16px" }}
        >
          <option value="">—</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // multiselect
  const selected: string[] = Array.isArray(value) ? (value as string[]) : [];
  return (
    <div>
      {label}
      {(field.options ?? []).length === 0 ? (
        <p className="text-xs text-text-muted">Sem opções configuradas.</p>
      ) : (
        <div className="space-y-1.5">
          {(field.options ?? []).map((opt) => (
            <Checkbox
              key={opt}
              checked={selected.includes(opt)}
              onChange={() => onToggleOption(opt)}
              label={<span className="text-sm text-text-primary">{opt}</span>}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CustomFieldsSection({
  leadId,
  organizationId,
  customFields,
}: {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
  customFields: Record<string, unknown>;
}) {
  const navigate = useNavigate();
  // Sem entityType no filtro: traz "lead" + legado (fieldDefinitions antigas,
  // criadas sem entityType, que também valem para lead).
  const allFieldDefs = useQuery(api.fieldDefinitions.getFieldDefinitions, { organizationId }) as
    | FieldDefinition[]
    | undefined;
  const updateLead = useMutation(api.leads.updateLead);
  const [values, setValues] = useState<Record<string, unknown>>(customFields ?? {});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValues(customFields ?? {});
  }, [customFields]);

  const leadFieldDefs = (allFieldDefs ?? [])
    .filter((f) => f.entityType === "lead" || f.entityType === undefined)
    .sort((a, b) => a.order - b.order);

  const setFieldValue = (key: string, value: unknown) => {
    setValues((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const toggleMultiselectOption = (key: string, option: string) => {
    setValues((prev) => {
      const current = Array.isArray(prev[key]) ? (prev[key] as string[]) : [];
      const nextArr = current.includes(option)
        ? current.filter((o) => o !== option)
        : [...current, option];
      const next = { ...prev };
      if (nextArr.length > 0) next[key] = nextArr;
      else delete next[key];
      return next;
    });
  };

  const handleSaveCustomFields = async () => {
    setSaving(true);
    try {
      await updateLead({ leadId, customFields: values });
      toast.success("Campos personalizados atualizados");
    } catch (error: any) {
      toast.error(error?.message || "Não foi possível salvar campos personalizados.");
    } finally {
      setSaving(false);
    }
  };

  if (allFieldDefs === undefined) {
    return (
      <div>
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Campos personalizados
        </h3>
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      </div>
    );
  }

  if (leadFieldDefs.length === 0) {
    return (
      <div>
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Campos personalizados
        </h3>
        <button
          type="button"
          onClick={() => navigate(TAB_ROUTES.settings)}
          className="text-sm text-text-muted hover:text-brand-500 transition-colors"
        >
          Nenhum campo personalizado — criar em Configurações
        </button>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
        Campos personalizados
      </h3>
      <div className="space-y-4">
        {leadFieldDefs.map((field) => (
          <CustomFieldEditor
            key={field._id}
            field={field}
            value={values[field.key]}
            onChange={(v) => setFieldValue(field.key, v)}
            onToggleOption={(option) => toggleMultiselectOption(field.key, option)}
          />
        ))}
        <Button
          onClick={handleSaveCustomFields}
          disabled={saving}
          variant="primary"
          size="md"
          className="w-full"
        >
          {saving ? "Salvando..." : "Salvar Campos"}
        </Button>
      </div>
    </div>
  );
}
