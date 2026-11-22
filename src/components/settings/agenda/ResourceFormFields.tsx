import { Users } from "lucide-react";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { WeeklyHoursEditor } from "@/components/agenda/WeeklyHoursEditor";
import type { ResourceErrorKey, ResourceForm, ResourceKind } from "@/lib/agendaConfigForms";
import type { FormErrors } from "@/lib/agendaConfigForms";
import { VOCAB } from "@/lib/vocab";

export interface MemberOption {
  value: string;
  label: string;
}

interface ResourceFormFieldsProps {
  value: ResourceForm;
  onChange: (next: ResourceForm) => void;
  errors?: FormErrors<ResourceErrorKey> & { weekDays?: Record<number, string> };
  disabled?: boolean;
  /** O tipo só se escolhe ao criar. */
  kindLocked?: boolean;
  memberOptions: MemberOption[];
}

const KINDS: ResourceKind[] = ["person", "room", "equipment"];

/** Campos de sala, profissional ou equipamento. Controlado e sem Convex. */
export function ResourceFormFields({ value, onChange, errors = {}, disabled, kindLocked, memberOptions }: ResourceFormFieldsProps) {
  const set = (patch: Partial<ResourceForm>) => onChange({ ...value, ...patch });
  const isPerson = value.kind === "person";
  const kindText = VOCAB.scheduling.config.kind[value.kind];
  return (
    <div className="space-y-5">
      <FormField label="Tipo" htmlFor="resource-kind">
        <Select
          id="resource-kind"
          value={value.kind}
          disabled={disabled || kindLocked}
          onValueChange={(kind) => set({ kind: kind as ResourceKind, capacity: "1", teamMemberId: "" })}
          options={KINDS.map((k) => ({ value: k, label: VOCAB.scheduling.resource[k].title }))}
        />
      </FormField>

      <FormField label="Nome" error={errors.name}>
        {(aria) => (
          <Input {...aria} value={value.name} disabled={disabled} maxLength={60} placeholder={isPerson ? "Ana" : value.kind === "room" ? "Sala 1" : "Maca elétrica"} onChange={(e) => set({ name: e.target.value })} />
        )}
      </FormField>

      {isPerson ? (
        <FormField label="Pessoa da equipe" hint="Opcional. Liga este profissional a quem usa o sistema, para ele ver a própria agenda." error={errors.teamMemberId}>
          {(aria) => (
            <Select {...aria} value={value.teamMemberId} disabled={disabled} onValueChange={(teamMemberId) => set({ teamMemberId })} options={[{ value: "", label: "Sem ligação" }, ...memberOptions]} />
          )}
        </FormField>
      ) : (
        <div className="space-y-2 rounded-card border border-border bg-surface-sunken p-3">
          <FormField label={VOCAB.scheduling.config.capacityLabel} error={errors.capacity}>
            {(aria) => (
              <Input {...aria} type="number" inputMode="numeric" min={1} max={50} value={value.capacity} disabled={disabled} onChange={(e) => set({ capacity: e.target.value })} />
            )}
          </FormField>
          <p className="flex items-start gap-2 text-sm text-text-secondary">
            <Users size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
            <span>{value.kind === "person" ? "" : VOCAB.scheduling.config.kind[value.kind as "room" | "equipment"].capacityExample}</span>
          </p>
        </div>
      )}

      <div className="space-y-2">
        <div>
          <p className="text-sm font-medium text-text-primary">Horário semanal</p>
          <p className="text-sm text-text-muted">{kindText.weeklyHint}</p>
        </div>
        <WeeklyHoursEditor value={value.week} onChange={(week) => set({ week })} errors={errors.weekDays} disabled={disabled} />
      </div>
    </div>
  );
}
