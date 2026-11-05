import { Button } from "@/components/ui/Button";
import type { ConfigFormProps, ScheduleForm } from "@/lib/attendantConfig";
import { NumberField } from "./fields";

export interface HoursPreset {
  id: string;
  label: string;
  value: ScheduleForm;
}

export interface AttendantHoursFormProps extends ConfigFormProps<ScheduleForm> {
  /** Atalhos de horário (a lista vem de fora; o fv2-22 define os presets). */
  presets?: ReadonlyArray<HoursPreset>;
}

const toHour = (raw: string) => (raw.trim() === "" ? Number.NaN : Number(raw));
const fromHour = (n: number) => (Number.isNaN(n) ? "" : String(n));

/** Horário de atendimento (início e fim, em horas cheias). Campo controlado, sem dados. */
export function AttendantHoursForm({
  value,
  onChange,
  disabled,
  errors,
  variant = "panel",
  presets,
}: AttendantHoursFormProps) {
  return (
    <div className="space-y-3">
      {presets && presets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Button key={p.id} variant="secondary" size="sm" disabled={disabled} onClick={() => onChange(p.value)}>
              {p.label}
            </Button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-4">
        <NumberField
          className="w-28"
          label="Início (h)"
          min={0}
          max={23}
          value={fromHour(value.startHour)}
          disabled={disabled}
          error={errors?.startHour}
          onChange={(raw) => onChange({ ...value, startHour: toHour(raw) })}
        />
        <NumberField
          className="w-28"
          label="Fim (h)"
          min={1}
          max={24}
          value={fromHour(value.endHour)}
          disabled={disabled}
          error={errors?.endHour}
          onChange={(raw) => onChange({ ...value, endHour: toHour(raw) })}
        />
      </div>
      {variant === "panel" && (
        <p className="text-xs text-text-muted">
          Fora dessa janela a IA não responde: a conversa espera por alguém da equipe.
        </p>
      )}
    </div>
  );
}
