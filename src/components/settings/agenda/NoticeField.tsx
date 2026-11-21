import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { NOTICE_UNIT_LABELS, type NoticeForm, type NoticeUnit } from "@/lib/agendaConfigForms";

interface NoticeFieldProps {
  label: string;
  value: NoticeForm;
  onChange: (next: NoticeForm) => void;
  hint?: string;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
}

/** Número + unidade (minutos, horas, dias) para antecedências; o servidor guarda em minutos. */
export function NoticeField({ label, value, onChange, hint, error, placeholder, disabled }: NoticeFieldProps) {
  return (
    <FormField label={label} hint={hint} error={error}>
      {(aria) => (
        <div className="flex gap-2">
          <Input {...aria} type="number" inputMode="numeric" min={0} value={value.value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange({ ...value, value: e.target.value })} />
          <div className="w-32 shrink-0">
            <Select
              aria-label={`${label}: unidade`}
              value={value.unit}
              disabled={disabled}
              onValueChange={(unit) => onChange({ ...value, unit: unit as NoticeUnit })}
              options={(Object.keys(NOTICE_UNIT_LABELS) as NoticeUnit[]).map((u) => ({ value: u, label: NOTICE_UNIT_LABELS[u] }))}
            />
          </div>
        </div>
      )}
    </FormField>
  );
}
