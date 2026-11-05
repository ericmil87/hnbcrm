import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { TAB_ROUTES } from "@/lib/routes";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { mutationErrorMessage } from "@/lib/errors";
import {
  fromDateInputValue,
  leadFieldDefinitions,
  setCustomFieldValue,
  toDateInputValue,
  toggleCustomFieldOption,
  type LeadFieldDefinition,
} from "@/lib/leadFields";
import { LeadBlockHeading } from "./LeadBlockHeading";

function CustomFieldEditor({
  field,
  value,
  onChange,
  onToggleOption,
}: {
  field: LeadFieldDefinition;
  value: unknown;
  onChange: (v: unknown) => void;
  onToggleOption: (option: string) => void;
}) {
  const label = field.isRequired ? `${field.name} *` : field.name;

  if (field.type === "text") {
    return (
      <Input
        label={label}
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      />
    );
  }

  if (field.type === "number") {
    return (
      <Input
        label={label}
        type="number"
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
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
      <Input
        label={label}
        type="date"
        value={toDateInputValue(value)}
        onChange={(e) => onChange(fromDateInputValue(e.target.value))}
      />
    );
  }

  if (field.type === "select") {
    return (
      <Select
        label={label}
        value={typeof value === "string" ? value : ""}
        onValueChange={(v) => onChange(v === "" ? undefined : v)}
        options={[{ value: "", label: "—" }, ...(field.options ?? []).map((opt) => ({ value: opt, label: opt }))]}
      />
    );
  }

  // multiselect
  const selected: string[] = Array.isArray(value) ? (value as string[]) : [];
  return (
    <fieldset>
      <legend className="block text-[13px] font-medium text-text-secondary mb-1">{label}</legend>
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
    </fieldset>
  );
}

/** "Campos personalizados" do lead (definições da org para lead, mais o legado sem tipo de entidade). */
export function LeadCustomFieldsBlock({
  leadId,
  organizationId,
  customFields,
}: {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
  customFields: Record<string, unknown>;
}) {
  const navigate = useNavigate();
  // Sem entityType no filtro: traz "lead" + legado (definições antigas, criadas
  // sem entityType, que também valem para lead).
  const allFieldDefs = useQuery(api.fieldDefinitions.getFieldDefinitions, { organizationId }) as
    | LeadFieldDefinition[]
    | undefined;
  const updateLead = useMutation(api.leads.updateLead);
  const [values, setValues] = useState<Record<string, unknown>>(customFields ?? {});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValues(customFields ?? {});
  }, [customFields]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateLead({ leadId, customFields: values });
      toast.success("Campos personalizados atualizados");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível salvar os campos personalizados."));
    } finally {
      setSaving(false);
    }
  };

  if (allFieldDefs === undefined) {
    return (
      <div>
        <LeadBlockHeading>Campos personalizados</LeadBlockHeading>
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      </div>
    );
  }

  const defs = leadFieldDefinitions(allFieldDefs);

  if (defs.length === 0) {
    return (
      <div>
        <LeadBlockHeading>Campos personalizados</LeadBlockHeading>
        <button
          type="button"
          onClick={() => navigate(TAB_ROUTES.settings)}
          className="min-h-11 text-sm text-text-muted hover:text-brand-500 transition-colors"
        >
          Nenhum campo personalizado. Criar em Configurações
        </button>
      </div>
    );
  }

  return (
    <div>
      <LeadBlockHeading>Campos personalizados</LeadBlockHeading>
      <div className="space-y-4">
        {defs.map((field) => (
          <CustomFieldEditor
            key={field._id}
            field={field}
            value={values[field.key]}
            onChange={(v) => setValues((prev) => setCustomFieldValue(prev, field.key, v))}
            onToggleOption={(option) => setValues((prev) => toggleCustomFieldOption(prev, field.key, option))}
          />
        ))}
        <Button onClick={() => void handleSave()} loading={saving} variant="primary" size="md" className="w-full">
          {saving ? "Salvando…" : "Salvar campos"}
        </Button>
      </div>
    </div>
  );
}
