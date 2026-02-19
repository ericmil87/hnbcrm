import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";

interface CrmMappingValue {
  entity: "lead" | "contact";
  field: string;
}

interface CrmMappingSelectProps {
  value?: CrmMappingValue;
  onChange: (mapping?: CrmMappingValue) => void;
  organizationId: string;
}

const CONTACT_FIELDS: { field: string; label: string }[] = [
  { field: "firstName", label: "Nome" },
  { field: "lastName", label: "Sobrenome" },
  { field: "email", label: "Email" },
  { field: "phone", label: "Telefone" },
  { field: "company", label: "Empresa" },
  { field: "title", label: "Cargo" },
  { field: "whatsappNumber", label: "WhatsApp" },
  { field: "city", label: "Cidade" },
  { field: "state", label: "Estado" },
  { field: "country", label: "Pais" },
];

const LEAD_FIELDS: { field: string; label: string }[] = [
  { field: "title", label: "Titulo" },
  { field: "value", label: "Valor" },
];

function encodeMapping(mapping: CrmMappingValue): string {
  return `${mapping.entity}:${mapping.field}`;
}

function decodeMapping(val: string): CrmMappingValue | undefined {
  if (!val || val === "none") return undefined;
  const colonIdx = val.indexOf(":");
  if (colonIdx === -1) return undefined;
  const entity = val.slice(0, colonIdx) as "lead" | "contact";
  const field = val.slice(colonIdx + 1);
  return { entity, field };
}

export function CrmMappingSelect({ value, onChange, organizationId }: CrmMappingSelectProps) {
  const customFields = useQuery(
    api.fieldDefinitions.getFieldDefinitions,
    organizationId
      ? { organizationId: organizationId as Id<"organizations"> }
      : "skip"
  );

  const currentValue = value ? encodeMapping(value) : "none";

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    onChange(decodeMapping(e.target.value));
  }

  const contactCustomFields = customFields?.filter((f: any) => f.entityType === "contact") ?? [];
  const leadCustomFields = customFields?.filter((f: any) => f.entityType === "lead") ?? [];

  return (
    <div className="w-full">
      <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
        Mapeamento CRM
      </label>
      <select
        value={currentValue}
        onChange={handleChange}
        aria-label="Mapeamento CRM"
        className={cn(
          "w-full bg-surface-raised border border-border-strong rounded-field",
          "px-3.5 py-2.5 text-base md:text-sm text-text-primary",
          "transition-colors duration-150",
          "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
          "appearance-none"
        )}
      >
        <option value="none">Sem mapeamento</option>

        <optgroup label="Contato">
          {CONTACT_FIELDS.map(({ field, label }) => (
            <option key={`contact:${field}`} value={`contact:${field}`}>
              {label}
            </option>
          ))}
          {contactCustomFields.map((f: any) => (
            <option key={`contact:custom_${f.key}`} value={`contact:custom_${f.key}`}>
              {f.name} (personalizado)
            </option>
          ))}
        </optgroup>

        <optgroup label="Lead">
          {LEAD_FIELDS.map(({ field, label }) => (
            <option key={`lead:${field}`} value={`lead:${field}`}>
              {label}
            </option>
          ))}
          {leadCustomFields.map((f: any) => (
            <option key={`lead:custom_${f.key}`} value={`lead:custom_${f.key}`}>
              {f.name} (personalizado)
            </option>
          ))}
        </optgroup>
      </select>
      {value && (
        <p className="mt-1 text-[12px] text-text-muted">
          Mapeado para{" "}
          <span className="text-brand-500 font-medium">
            {value.entity === "contact" ? "Contato" : "Lead"} &rarr; {value.field}
          </span>
        </p>
      )}
    </div>
  );
}
